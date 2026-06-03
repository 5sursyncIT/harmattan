#!/usr/bin/env node
/**
 * Reclasser en « Payée » les factures restées « Commencée » alors qu'elles
 * sont intégralement réglées (paye=0 mais somme des règlements + avoirs/acomptes
 * >= total_ttc).
 *
 * Cause racine : règlements (souvent un chèque/OM groupé couvrant plusieurs
 * factures) saisis manuellement dans Dolibarr sans cocher « Classer payée ».
 * Le statut reste donc bloqué sur « Commencée » bien que remaintopay = 0.
 *
 * La correction passe par l'API REST `POST /invoices/{id}/settopaid`
 * (exactement le canal utilisé par le POS) — et NON par un UPDATE SQL brut —
 * afin de déclencher le trigger BILL_PAYED (cohérence comptable native,
 * date_closing, fk_user_closing).
 *
 * Sécurités :
 *  - Mode --dry-run par défaut : aucune écriture, juste le rapport.
 *  - --apply : exécute les settopaid.
 *  - Re-vérifie remaintopay via l'API JUSTE avant de classer payée : ne ferme
 *    JAMAIS une facture qui n'est pas réellement soldée (anti-régression).
 *  - Signale séparément les trop-perçus (réglé > total_ttc) sans rien fermer
 *    indûment (la facture EST couverte, mais le trop-perçu est à traiter à part).
 *
 * Usage :
 *   node scripts/fix-commencee-payees.mjs            # dry-run
 *   node scripts/fix-commencee-payees.mjs --apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import axios from 'axios';

const apply = process.argv.includes('--apply');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

const api = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: {
    DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity',
  },
  timeout: 30000,
});

const fmt = (n) => Number(n).toLocaleString('fr-FR');

// Factures validées (fk_statut=1), non classées payées (paye=0), mais dont la
// somme règlements + avoirs/acomptes couvre le total TTC.
const CANDIDATES_SQL = `
  SELECT f.rowid, f.ref, DATE(f.datef) AS datef, f.total_ttc,
         COALESCE(p.paid,0)  AS paid,
         COALESCE(d.disc,0)  AS disc
  FROM llx_facture f
  LEFT JOIN (SELECT fk_facture, SUM(amount) paid
             FROM llx_paiement_facture GROUP BY fk_facture) p ON p.fk_facture = f.rowid
  LEFT JOIN (SELECT fk_facture, SUM(amount_ttc) disc
             FROM llx_societe_remise_except WHERE fk_facture IS NOT NULL
             GROUP BY fk_facture) d ON d.fk_facture = f.rowid
  WHERE f.fk_statut = 1 AND f.paye = 0 AND f.total_ttc > 0
    AND COALESCE(p.paid,0) + COALESCE(d.disc,0) >= f.total_ttc - 0.01
  ORDER BY f.datef`;

async function main() {
  console.log(`\n=== Reclassement « Commencée » → « Payée » ===`);
  console.log(apply ? '*** MODE --apply : écritures réelles ***\n' : '(dry-run : aucune écriture)\n');

  const [rows] = await pool.query(CANDIDATES_SQL);
  console.log(`${rows.length} facture(s) candidate(s) (soldées mais paye=0).\n`);

  let done = 0, skipped = 0, overpaid = 0, errors = 0;

  for (const f of rows) {
    const over = Number(f.paid) > Number(f.total_ttc) + 1;
    const tag = over ? `  ⚠ TROP-PERÇU (réglé ${fmt(f.paid)} > ttc ${fmt(f.total_ttc)})` : '';

    // Garde-fou final : on relit remaintopay calculé par Dolibarr lui-même.
    let remain;
    try {
      const { data } = await api.get(`/invoices/${f.rowid}`);
      remain = parseFloat(data.remaintopay);
    } catch (e) {
      console.log(`✗ ${f.ref} : lecture API impossible (${e.response?.status || e.message})`);
      errors++; continue;
    }
    if (!(remain <= 0.01)) {
      console.log(`• ${f.ref} : remaintopay=${fmt(remain)} > 0 → IGNORÉE (non réellement soldée)`);
      skipped++; continue;
    }

    if (!apply) {
      console.log(`→ ${f.ref.padEnd(24)} ${String(f.datef)}  ${fmt(f.total_ttc).padStart(11)}  À CLASSER PAYÉE${tag}`);
      done++; if (over) overpaid++;
      continue;
    }

    try {
      await api.post(`/invoices/${f.rowid}/settopaid`, { close_code: '', close_note: 'Reclassement: facture soldée restée Commencée (regul. lot)' });
      console.log(`✓ ${f.ref.padEnd(24)} classée PAYÉE${tag}`);
      done++; if (over) overpaid++;
    } catch (e) {
      console.log(`✗ ${f.ref} : settopaid échoué (${e.response?.status || ''} ${JSON.stringify(e.response?.data || e.message)})`);
      errors++;
    }
  }

  console.log(`\n--- Récapitulatif ---`);
  console.log(`${apply ? 'Classées payées' : 'À classer payées'} : ${done}`);
  if (overpaid) console.log(`dont trop-perçus à examiner    : ${overpaid}`);
  if (skipped)  console.log(`Ignorées (non soldées via API) : ${skipped}`);
  if (errors)   console.log(`Erreurs                        : ${errors}`);
  if (!apply)   console.log(`\nDRY-RUN : relancer avec --apply pour exécuter.\n`);

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
