// Remédiation one-off — paiement fantôme du 15/06/2026 (timeout POS à 14:25).
//
// Contexte : une vente POS (CLIENT LIBRAIRE, 4 articles, 77 000 F) a dépassé le
// timeout Dolibarr (30 s). Le rollback a remis la facture LIBFAC20260615-022045
// (rowid 40332) en brouillon mais n'a pas pu la supprimer. Le caissier a refait la
// vente → 022046 (rowid 40333), validée et payée 77 000. La cliente n'a payé qu'UNE
// fois 77 000 (sur 022046), mais un paiement Cash de 40 000 (id 31491) est resté
// accroché au brouillon 022045 → caisse surévaluée de 40 000 F.
//
// Action : supprimer le seul paiement fantôme 31491 (paiement + ligne banque + liens),
// ce qui ramène la caisse au bon montant. La facture 022045 reste un brouillon impayé
// (regle 40 000 → 0) ; on NE LA TOUCHE PAS ici (demande explicite : étape paiement seule).
// Stock déjà équilibré (022045 a restitué ses -1 au rollback), aucune action stock.
//
//   node scripts/fix-phantom-payment-31491.mjs           → DRY-RUN (n'écrit rien)
//   node scripts/fix-phantom-payment-31491.mjs --apply    → applique en transaction
//
// Garde-fous : montant == 40 000, imputé EXCLUSIVEMENT sur 40332, ligne banque non
// rapprochée (rappro=0), aucune écriture comptable réelle. Backup + undo.sql avant tout.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dir = dirname(fileURLToPath(import.meta.url));
const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));

// --- Identifiants vérifiés par inspection lecture seule -------------------
const PAY = 31491;          // llx_paiement à supprimer
const PF = 32632;           // llx_paiement_facture (lien paiement↔facture)
const BANK = 31132;         // llx_bank (ligne de caisse, compte 3)
const BANK_URL = [64042, 64043]; // liens 'payment' + 'company' de la ligne banque
const FACTURE = 40332;      // LIBFAC20260615-022045 (brouillon — non modifiée)
const EXPECT_AMOUNT = 40000;

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

function buildInsert(table, row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

const conn = await pool.getConnection();
try {
  // ---------- PRÉ-CONTRÔLES (lecture) ----------
  const errors = [];
  const [[p]] = await conn.query('SELECT amount FROM llx_paiement WHERE rowid=?', [PAY]);
  if (!p) {
    console.log(`Paiement ${PAY} introuvable — déjà supprimé ? Rien à faire.`);
    process.exit(0);
  }
  if (Number(p.amount) !== EXPECT_AMOUNT) errors.push(`paiement ${PAY} montant=${p.amount} ≠ attendu ${EXPECT_AMOUNT}`);

  const [links] = await conn.query('SELECT rowid, fk_facture, amount FROM llx_paiement_facture WHERE fk_paiement=?', [PAY]);
  if (links.length !== 1 || Number(links[0].fk_facture) !== FACTURE || Number(links[0].rowid) !== PF) {
    errors.push(`paiement ${PAY} non imputé exclusivement sur facture ${FACTURE} (pf ${PF}) — vérif manuelle`);
  }

  const [[b]] = await conn.query('SELECT amount, rappro, num_releve FROM llx_bank WHERE rowid=?', [BANK]);
  if (!b) errors.push(`ligne banque ${BANK} introuvable`);
  else {
    if (Number(b.amount) !== EXPECT_AMOUNT) errors.push(`banque ${BANK} montant=${b.amount} ≠ ${EXPECT_AMOUNT}`);
    if (Number(b.rappro) !== 0) errors.push(`banque ${BANK} RAPPROCHÉE (rappro=${b.rappro}) — abandon`);
    if (b.num_releve) errors.push(`banque ${BANK} sur relevé ${b.num_releve} — abandon`);
  }

  // Aucune écriture comptable réelle (convention moteur maison : doc_type='bank' + fk_doc=rowid paiement).
  const [[bk]] = await conn.query("SELECT COUNT(*) AS nb FROM llx_accounting_bookkeeping WHERE doc_type='bank' AND fk_doc=?", [PAY]);
  if (bk && Number(bk.nb) > 0) errors.push(`paiement ${PAY} a ${bk.nb} écriture(s) comptable(s) — traitement compta requis`);

  if (errors.length) {
    console.error('⛔ Pré-contrôles échoués (données déjà modifiées ?) :');
    errors.forEach((e) => console.error('   - ' + e));
    process.exit(1);
  }

  // ---------- SAUVEGARDE + SQL D'ANNULATION ----------
  const [bkP] = await conn.query('SELECT * FROM llx_paiement WHERE rowid=?', [PAY]);
  const [bkPf] = await conn.query('SELECT * FROM llx_paiement_facture WHERE rowid=?', [PF]);
  const [bkB] = await conn.query('SELECT * FROM llx_bank WHERE rowid=?', [BANK]);
  const [bkBu] = await conn.query('SELECT * FROM llx_bank_url WHERE rowid IN (?)', [BANK_URL]);

  const undo = [];
  bkBu.forEach((r) => undo.push(buildInsert('llx_bank_url', r)));
  bkB.forEach((r) => undo.push(buildInsert('llx_bank', r)));
  bkP.forEach((r) => undo.push(buildInsert('llx_paiement', r)));
  bkPf.forEach((r) => undo.push(buildInsert('llx_paiement_facture', r)));

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  const jsonPath = join(bkDir, `phantom-payment-31491-${ts}.json`);
  const undoPath = join(bkDir, `phantom-payment-31491-${ts}.undo.sql`);
  writeFileSync(jsonPath, JSON.stringify({ paiement: bkP, paiement_facture: bkPf, bank: bkB, bank_url: bkBu }, null, 2));
  writeFileSync(undoPath, '-- Annulation de fix-phantom-payment-31491 (ré-insère les 4 lignes supprimées)\n' + undo.join('\n') + '\n');
  console.log(`💾 Sauvegarde : ${jsonPath}`);
  console.log(`↩️  Annulation : ${undoPath}\n`);

  console.log('SUPPRESSION :');
  console.log(`   paiement fantôme ${PAY} (${fmt(EXPECT_AMOUNT)} F Cash) + ligne banque ${BANK} + liens ${BANK_URL.join(', ')}`);
  console.log(`   facture ${FACTURE} (022045) reste brouillon impayé (regle ${fmt(EXPECT_AMOUNT)} → 0) — non modifiée\n`);

  if (!APPLY) {
    console.log('🔍 DRY-RUN — aucune écriture. Relancez avec --apply pour appliquer.');
    process.exit(0);
  }

  // ---------- APPLICATION (transaction) ----------
  await conn.beginTransaction();
  await conn.query('DELETE FROM llx_paiement_facture WHERE rowid=?', [PF]);
  await conn.query('DELETE FROM llx_bank_url WHERE rowid IN (?)', [BANK_URL]);
  await conn.query('DELETE FROM llx_bank WHERE rowid=?', [BANK]);
  await conn.query('DELETE FROM llx_paiement WHERE rowid=?', [PAY]);

  // ---------- VÉRIFICATION FINALE (avant COMMIT) ----------
  const [[after]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS regle FROM llx_paiement_facture WHERE fk_facture=?', [FACTURE]);
  const [[stillPay]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_paiement WHERE rowid=?', [PAY]);
  const [[stillBank]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_bank WHERE rowid=?', [BANK]);
  const ok = Number(after.regle) === 0 && Number(stillPay.nb) === 0 && Number(stillBank.nb) === 0;
  console.log(`   ${ok ? '✅' : '❌'} facture ${FACTURE} réglé ${fmt(after.regle)} ; paiement supprimé=${stillPay.nb === 0} ; banque supprimée=${stillBank.nb === 0}`);
  if (!ok) {
    await conn.rollback();
    console.error('\n⛔ ROLLBACK — état final inattendu. Aucune modification appliquée.');
    process.exit(1);
  }
  await conn.commit();
  console.log('\n✅ COMMIT — paiement fantôme supprimé, caisse corrigée de 40 000 F. (Annulation possible via le .undo.sql)');
} catch (e) {
  try { await conn.rollback(); } catch { /* ignore */ }
  console.error('Erreur — ROLLBACK :', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
