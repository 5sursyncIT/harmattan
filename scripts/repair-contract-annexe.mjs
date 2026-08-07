/**
 * Rattrapage de l'ANNEXE « Engagement d'achat de l'Auteur » des contrats.
 *
 * CONTEXTE — Le devis de contribution recopiait sur le contrat la seule quantité
 * d'exemplaires (`author_purchase_qty`), jamais la remise (`author_purchase_discount`),
 * et ne régénérait pas le document. Or l'annexe imprime LES DEUX :
 *
 *   « L'Auteur s'engage à acheter {qty} exemplaires de son ouvrage,
 *     sur la base du prix public moins {discount} %. »
 *
 * D'où des annexes annonçant « 0 exemplaires » ou « moins 0.00 % » alors que le
 * devis facturait 50 exemplaires avec 30 % de remise. Le correctif est en place
 * (persistPurchaseTerms + refreshContractDocumentIfAny) ; ce script répare
 * l'existant.
 *
 * GARDE-FOUS — un contrat est IGNORÉ si :
 *   - il est signé (signed_status > 0, signature en ligne, ou attestation papier
 *     archivée) : régénérer son PDF romprait la concordance avec la preuve signée ;
 *   - le contrat porte déjà une valeur NON NULLE différente du devis : c'est une
 *     négociation à arbitrer par la direction, pas une valeur manquante à combler.
 *
 * Usage :  node scripts/repair-contract-annexe.mjs                 (simulation)
 *          node scripts/repair-contract-annexe.mjs --apply          (applique)
 *          node scripts/repair-contract-annexe.mjs --apply --only=102
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import axios from 'axios';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { compareSpecs, specFromContractRow, specFromQuote } from '../src/utils/contractConformity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Chemins ancrés sur le script, jamais sur le répertoire courant : `dotenv/config`
// lit le .env du cwd, ce qui ferait tourner le rattrapage avec les identifiants
// d'un autre projet (ou sans identifiants du tout) selon l'endroit d'où on l'appelle.
dotenv.config({ path: join(__dirname, '..', '.env') });
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1];
const onlyIds = ONLY ? new Set(ONLY.split(',').map(n => parseInt(n, 10))) : null;

const BUILDDOC_URL = 'http://localhost/dolibarr/htdocs/custom/senharmattansync/contract-builddoc.php';
const SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';
if (!SECRET) { console.error('DOLIBARR_WEBHOOK_SECRET absent — impossible de régénérer les documents.'); process.exit(1); }

const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
});
const db = new Database(join(__dirname, '..', 'newsletter.sqlite'), { readonly: true });

// Devis le plus récent par contrat : c'est lui qui porte les conditions en vigueur.
const latestQuote = new Map();
for (const q of db.prepare('SELECT * FROM contract_quotes ORDER BY contract_id, created_at DESC').all()) {
  if (!latestQuote.has(q.contract_id)) {
    try { q.items = JSON.parse(q.items_json); } catch { q.items = null; }
    latestQuote.set(q.contract_id, q);
  }
}
const signedLocally = new Set(db.prepare('SELECT contract_id FROM contract_signatures').all().map(r => r.contract_id));

const report = { repares: [], signes: [], arbitrage: [], conformes: [], echecs: [] };

for (const [contractId, quote] of latestQuote) {
  if (onlyIds && !onlyIds.has(contractId)) continue;

  const [[c]] = await pool.query(
    `SELECT c.rowid, c.ref, c.statut, c.signed_status, c.online_sign_name,
            ce.nombre_pages_estime, ce.format_ouvrage, ce.prix_public_previsionnel,
            ce.author_purchase_discount, ce.author_purchase_qty
       FROM llx_contrat c LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
      WHERE c.rowid = ?`, [contractId]);
  if (!c) continue; // devis orphelin (contrat supprimé)

  // On ne traite QUE les deux champs imprimés dans l'annexe.
  const diffs = compareSpecs(specFromContractRow(c), specFromQuote(quote)).diffs.filter(d => d.annexe);
  if (diffs.length === 0) { report.conformes.push(c.ref); continue; }

  if (Number(c.signed_status) > 0 || c.online_sign_name || signedLocally.has(contractId)) {
    report.signes.push({ ref: c.ref, id: contractId, detail: diffs.map(fmt).join(' ; ') });
    continue;
  }

  // Valeur déjà renseignée au contrat et différente → décision commerciale, pas un trou.
  const deliberate = diffs.filter(d => d.contract !== null && d.contract !== 0);
  if (deliberate.length > 0) {
    report.arbitrage.push({ ref: c.ref, id: contractId, detail: deliberate.map(fmt).join(' ; ') });
    continue;
  }

  const arrayOptions = {};
  for (const d of diffs) {
    if (d.field === 'copies') {
      arrayOptions.options_author_purchase_qty = d.quote;
      arrayOptions.options_author_purchase_enabled = d.quote > 0 ? 1 : 0;
    }
    if (d.field === 'discount') arrayOptions.options_author_purchase_discount = d.quote;
  }

  if (!APPLY) {
    report.repares.push({ ref: c.ref, id: contractId, detail: diffs.map(fmt).join(' ; '), simule: true });
    continue;
  }

  try {
    await axios.put(
      `${process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php'}/contracts/${contractId}`,
      { array_options: arrayOptions },
      { headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' }, timeout: 30000 },
    );
    const { data } = await axios.post(BUILDDOC_URL, { contract_id: contractId }, {
      headers: { 'X-Dolibarr-Secret': SECRET, 'Content-Type': 'application/json' }, timeout: 60000,
    });
    report.repares.push({ ref: c.ref, id: contractId, detail: diffs.map(fmt).join(' ; '), doc: data?.file || 'régénéré' });
  } catch (err) {
    report.echecs.push({ ref: c.ref, id: contractId, erreur: err.response?.data?.error || err.message });
  }
}

function fmt(d) { return `${d.label} ${d.contractDisplay} → ${d.quoteDisplay}`; }

const head = APPLY ? '=== RATTRAPAGE APPLIQUÉ ===' : '=== SIMULATION (ajouter --apply pour exécuter) ===';
console.log(`\n${head}\n`);
console.log(`Réparés            : ${report.repares.length}`);
for (const r of report.repares) console.log(`   #${r.id} ${r.ref} — ${r.detail}${r.doc ? ` [${r.doc}]` : ''}`);
console.log(`\nIgnorés — signés   : ${report.signes.length}  (la signature archivée fait foi)`);
for (const r of report.signes) console.log(`   #${r.id} ${r.ref} — ${r.detail}`);
console.log(`\nIgnorés — arbitrage: ${report.arbitrage.length}  (valeur contrat délibérée ≠ devis)`);
for (const r of report.arbitrage) console.log(`   #${r.id} ${r.ref} — ${r.detail}`);
if (report.echecs.length) {
  console.log(`\nÉCHECS             : ${report.echecs.length}`);
  for (const r of report.echecs) console.log(`   #${r.id} ${r.ref} — ${r.erreur}`);
}
console.log(`\nDéjà conformes     : ${report.conformes.length}\n`);

await pool.end();
