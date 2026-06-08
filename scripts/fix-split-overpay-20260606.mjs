// Correction des factures sur-payées par le bug du paiement fractionné —
// LOT du 2026-06-06 (récidive : l'endpoint /invoices/{id}/payments ignore le
// montant et impute le reste-à-payer complet → chaque méthode imputait le
// total TTC entier). Le correctif code bascule sur /invoices/paymentsdistributed.
//
//   node scripts/fix-split-overpay-20260606.mjs           → DRY-RUN (n'écrit rien)
//   node scripts/fix-split-overpay-20260606.mjs --apply    → applique en transaction
//
// Stratégie : ADJUST — remet le vrai montant de chaque split (saisi par le
// caissier, lu dans pos_sale_idempotency et confirmé par l'utilisateur),
// dans llx_paiement, llx_paiement_facture et llx_bank.
// Garde-fous : montant courant == attendu, rappro=0, et Σ paiements == total_ttc
// après coup (sinon ROLLBACK). Sauvegarde + SQL d'annulation écrits avant tout.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dir = dirname(fileURLToPath(import.meta.url));
const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));

// --- Opérations (IDs vérifiés par inspection lecture seule) ---------------
const ADJUST = [
  // LIBFAC20260606-021904 (SALON DU LIVRE, facture 40189) — total 125 000
  // Split voulu : Wave 69 500 + Espèces 55 500 (confirmé par l'utilisateur).
  { p: 31352, pf: 32493, bank: 30993, from: 125000, to: 69500, label: 'Wave',    fac: 40189 },
  { p: 31353, pf: 32494, bank: 30994, from: 125000, to: 55500, label: 'Espèces', fac: 40189 },
  // LIBFAC20260606-021877 (CLIENT LIBRAIRE, facture 40162) — total 20 000
  // Split voulu : Wave 15 000 + Espèces 5 000.
  { p: 31324, pf: 32465, bank: 30965, from: 20000,  to: 15000, label: 'Wave',    fac: 40162 },
  { p: 31325, pf: 32466, bank: 30966, from: 20000,  to: 5000,  label: 'Espèces', fac: 40162 },
];
const DELETE = []; // aucun doublon strict ce lot — tout est ADJUST.
const FACTURES = [40189, 40162]; // à vérifier en fin de transaction

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

const conn = await pool.getConnection();
try {
  const [bankCols] = await conn.query("SHOW COLUMNS FROM llx_bank");
  const bankHasMc = bankCols.some((c) => c.Field === 'multicurrency_amount');

  // ---------- PRÉ-CONTRÔLES (lecture) ----------
  const errors = [];
  for (const a of ADJUST) {
    const [[p]] = await conn.query('SELECT amount FROM llx_paiement WHERE rowid=?', [a.p]);
    const [[pf]] = await conn.query('SELECT amount FROM llx_paiement_facture WHERE rowid=?', [a.pf]);
    const [[b]] = await conn.query('SELECT amount, rappro FROM llx_bank WHERE rowid=?', [a.bank]);
    if (!p || Number(p.amount) !== a.from) errors.push(`ADJUST p=${a.p} amount=${p?.amount} ≠ attendu ${a.from}`);
    if (!pf || Number(pf.amount) !== a.from) errors.push(`ADJUST pf=${a.pf} amount=${pf?.amount} ≠ attendu ${a.from}`);
    if (!b || Number(b.amount) !== a.from) errors.push(`ADJUST bank=${a.bank} amount=${b?.amount} ≠ attendu ${a.from}`);
    if (b && Number(b.rappro) !== 0) errors.push(`ADJUST bank=${a.bank} RAPPROCHÉ (rappro=${b.rappro}) — abandon`);
  }
  if (errors.length) {
    console.error('⛔ Pré-contrôles échoués (données déjà modifiées ?) :');
    errors.forEach((e) => console.error('   - ' + e));
    process.exit(1);
  }

  // ---------- SAUVEGARDE + SQL D'ANNULATION ----------
  const idsP = ADJUST.map((x) => x.p);
  const idsPf = ADJUST.map((x) => x.pf);
  const idsBank = ADJUST.map((x) => x.bank);
  const [bkP] = await conn.query('SELECT * FROM llx_paiement WHERE rowid IN (?)', [idsP]);
  const [bkPf] = await conn.query('SELECT * FROM llx_paiement_facture WHERE rowid IN (?)', [idsPf]);
  const [bkB] = await conn.query('SELECT * FROM llx_bank WHERE rowid IN (?)', [idsBank]);

  const undo = [];
  for (const a of ADJUST) {
    undo.push(`UPDATE llx_paiement SET amount=${a.from}, multicurrency_amount=${a.from} WHERE rowid=${a.p};`);
    undo.push(`UPDATE llx_paiement_facture SET amount=${a.from}, multicurrency_amount=${a.from} WHERE rowid=${a.pf};`);
    undo.push(`UPDATE llx_bank SET amount=${a.from}${bankHasMc ? `, multicurrency_amount=${a.from}` : ''} WHERE rowid=${a.bank};`);
  }

  const ts = '20260606-' + (APPLY ? 'apply' : 'dryrun');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  const jsonPath = join(bkDir, `split-overpay-${ts}.json`);
  const undoPath = join(bkDir, `split-overpay-${ts}.undo.sql`);
  writeFileSync(jsonPath, JSON.stringify({ paiement: bkP, paiement_facture: bkPf, bank: bkB }, null, 2));
  writeFileSync(undoPath, '-- Annulation de fix-split-overpay-20260606\n' + undo.join('\n') + '\n');
  console.log(`💾 Sauvegarde : ${jsonPath}`);
  console.log(`↩️  Annulation : ${undoPath}\n`);

  // ---------- APERÇU ----------
  console.log('AJUSTEMENTS :');
  for (const a of ADJUST) console.log(`   facture ${a.fac} · ${a.label.padEnd(8)} p=${a.p}  ${fmt(a.from)} → ${fmt(a.to)}`);

  if (!APPLY) {
    console.log('\n🔍 DRY-RUN — aucune écriture. Relancez avec --apply pour appliquer.');
    process.exit(0);
  }

  // ---------- APPLICATION (transaction) ----------
  await conn.beginTransaction();
  for (const a of ADJUST) {
    await conn.query('UPDATE llx_paiement SET amount=?, multicurrency_amount=? WHERE rowid=?', [a.to, a.to, a.p]);
    await conn.query('UPDATE llx_paiement_facture SET amount=?, multicurrency_amount=? WHERE rowid=?', [a.to, a.to, a.pf]);
    if (bankHasMc) await conn.query('UPDATE llx_bank SET amount=?, multicurrency_amount=? WHERE rowid=?', [a.to, a.to, a.bank]);
    else await conn.query('UPDATE llx_bank SET amount=? WHERE rowid=?', [a.to, a.bank]);
  }

  // ---------- VÉRIFICATION FINALE (avant COMMIT) ----------
  const bad = [];
  for (const fac of FACTURES) {
    const [[f]] = await conn.query('SELECT ref, total_ttc, paye FROM llx_facture WHERE rowid=?', [fac]);
    const [[s]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS paid FROM llx_paiement_facture WHERE fk_facture=?', [fac]);
    const ok = Math.abs(Number(f.total_ttc) - Number(s.paid)) < 1;
    console.log(`   ${ok ? '✅' : '❌'} ${f.ref} : payé ${fmt(s.paid)} / TTC ${fmt(f.total_ttc)} (paye=${f.paye})`);
    if (!ok) bad.push(f.ref);
  }
  if (bad.length) {
    await conn.rollback();
    console.error(`\n⛔ ROLLBACK — incohérence sur : ${bad.join(', ')}. Aucune modification appliquée.`);
    process.exit(1);
  }
  await conn.commit();
  console.log('\n✅ COMMIT — corrections appliquées. (Annulation possible via le .undo.sql)');
} catch (e) {
  try { await conn.rollback(); } catch { /* ignore */ }
  console.error('Erreur — ROLLBACK :', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
