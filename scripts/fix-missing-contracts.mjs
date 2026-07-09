#!/usr/bin/env node
/**
 * Rattrapage des contrats jamais créés — bug v21 « commercial_signature_id missing ».
 *
 * Contexte (09/07/2026) : depuis la migration Dolibarr v13→v21, l'auto-création
 * du contrat à l'évaluation favorable (createContractDraft, server/index.js)
 * échouait à 100 % (champ commercial_signature_id manquant, erreur avalée).
 * Résultat : des manuscrits bloqués en `evaluation_positive` sans contrat.
 *
 * Ce script rejoue la création pour chaque manuscrit en `evaluation_positive`
 * SANS contract_id, à l'identique du hook serveur (même payload, mêmes défauts,
 * même dédup de tiers, même transition system → contract_pending).
 *
 * Usage :
 *   node scripts/fix-missing-contracts.mjs            # dry-run (aucune écriture)
 *   node scripts/fix-missing-contracts.mjs --apply    # exécute réellement
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { adminApi } from '../server/dolibarr-admin-client.js';
import { findExistingTier } from '../server/tier-dedup.js';
import { transition } from '../server/manuscript-workflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');

const db = new Database(join(__dirname, '..', 'newsletter.sqlite'));
const dolibarrPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 2,
});

// Mêmes constantes que createContractDraft (server/index.js) — ne pas dériver.
const CONTRACT_TYPE = 'harmattan_2024';
const TEMPLATE_FILE = 'template_harmattan_2024';
const MODEL_PDF = `generic_contract_odt:/var/www/html/dolibarr/documents/doctemplates/contracts/${TEMPLATE_FILE}.odt`;
const COMMERCIAL_SIGNATURE_ID = parseInt(process.env.CONTRACT_COMMERCIAL_SIGNATURE_ID, 10) || 1;
const COMMERCIAL_SUIVI_ID = parseInt(process.env.CONTRACT_COMMERCIAL_SUIVI_ID, 10) || 1;

async function resolveThirdparty(author) {
  if (author.dolibarr_thirdparty_id) {
    return { id: author.dolibarr_thirdparty_id, how: 'déjà lié' };
  }
  const existing = await findExistingTier(dolibarrPool, { email: author.email, phone: author.phone });
  if (existing) return { id: existing.id, how: `dédup (${existing.matchedBy})`, needsLink: true };
  return { id: null, how: 'À CRÉER', needsCreate: true };
}

async function createContractFor(ms, thirdpartyId) {
  const res = await adminApi.post('/contracts', {
    socid: parseInt(thirdpartyId, 10),
    date_contrat: Math.floor(Date.now() / 1000),
    commercial_signature_id: COMMERCIAL_SIGNATURE_ID,
    commercial_suivi_id: COMMERCIAL_SUIVI_ID,
    model_pdf: MODEL_PDF,
    array_options: {
      options_contract_type: CONTRACT_TYPE,
      options_book_title: ms.title,
      options_royalty_rate_print: 10,
      options_royalty_rate_digital: 10,
      options_royalty_threshold: 500,
      options_free_author_copies: 5,
      options_tirage_initial: 100,
      options_format_ouvrage: '15 × 21 cm',
      options_prix_public_previsionnel: 15,
      options_nombre_pages_estime: 200,
      options_exemplaires_sp: 5,
    },
  });
  return res.data; // contractId
}

async function main() {
  console.log(APPLY ? '⚠️  MODE APPLY — écritures réelles\n' : '🔍 DRY-RUN (aucune écriture) — relancer avec --apply pour exécuter\n');

  const candidates = db.prepare(`
    SELECT m.*, a.firstname, a.lastname, a.email AS author_email, a.phone AS author_phone,
           a.dolibarr_thirdparty_id, a.id AS aid
    FROM manuscripts m JOIN authors a ON a.id = m.author_id
    WHERE m.current_stage = 'evaluation_positive' AND m.contract_id IS NULL
    ORDER BY m.id
  `).all();

  console.log(`${candidates.length} manuscrit(s) en « évaluation favorable » sans contrat.\n`);
  let ok = 0, ko = 0;

  for (const ms of candidates) {
    const author = { id: ms.aid, firstname: ms.firstname, lastname: ms.lastname, email: ms.author_email, phone: ms.author_phone, dolibarr_thirdparty_id: ms.dolibarr_thirdparty_id };
    const label = `ms#${ms.id} ${ms.ref} « ${(ms.title || '').slice(0, 45)} » — ${author.firstname} ${author.lastname}`;
    try {
      const tp = await resolveThirdparty(author);
      if (!APPLY) {
        console.log(`  [DRY] ${label}\n        tiers: ${tp.id ?? '(nouveau)'} [${tp.how}] → contrat ${CONTRACT_TYPE} + transition contract_pending`);
        ok++;
        continue;
      }

      let thirdpartyId = tp.id;
      if (tp.needsCreate) {
        const r = await adminApi.post('/thirdparties', {
          name: `${author.firstname} ${author.lastname}`,
          email: author.email,
          phone: author.phone || '',
          client: 1,
          code_client: -1,
        });
        thirdpartyId = r.data;
      }
      if (tp.needsCreate || tp.needsLink) {
        db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ?').run(thirdpartyId, author.id);
      }

      const contractId = await createContractFor(ms, thirdpartyId);

      db.exec(`CREATE TABLE IF NOT EXISTS contract_manuscript_links (
        contract_id INTEGER, manuscript_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (contract_id, manuscript_id)
      )`);
      db.prepare('INSERT OR IGNORE INTO contract_manuscript_links (contract_id, manuscript_id) VALUES (?, ?)')
        .run(contractId, ms.id);

      transition(db, ms.id, 'contract_pending',
        { role: 'system', label: 'rattrapage-contrats' },
        { note: `Contrat Dolibarr #${contractId} créé (${CONTRACT_TYPE}) — rattrapage bug v21 commercial_signature_id`, updates: { contract_id: contractId } });

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run('system', 'contract_autocreate_backfill', `Contrat #${contractId} créé pour ${ms.ref} (rattrapage bug v21)`);

      console.log(`  ✅ ${label}\n     tiers ${thirdpartyId} [${tp.how}] → contrat #${contractId} → stage contract_pending`);
      ok++;
    } catch (err) {
      console.error(`  ❌ ${label}\n     ${JSON.stringify(err.response?.data || err.message).slice(0, 300)}`);
      ko++;
    }
  }

  console.log(`\nBilan : ${ok} OK, ${ko} échec(s)${APPLY ? '' : ' (dry-run)'}.`);
  await dolibarrPool.end();
  db.close();
}

main().catch((e) => { console.error('Erreur fatale:', e); process.exit(1); });
