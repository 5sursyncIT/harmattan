// Correction des factures sur-payées par le bug du paiement fractionné
// (chaque split imputait le total_ttc au lieu de sa part réelle).
//
//   node scripts/fix-split-overpay.mjs           → DRY-RUN (n'écrit rien)
//   node scripts/fix-split-overpay.mjs --apply    → applique en transaction
//
// Stratégie :
//   • ADJUST : remet le vrai montant de chaque split (fourni par le client),
//              dans llx_paiement, llx_paiement_facture et llx_bank.
//   • DELETE : supprime un paiement entièrement dupliqué (même méthode),
//              avec sa ligne bancaire et son lien (llx_bank_url).
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
  // LIBFAC20260603-021809 (DIOP, facture 40093) — total 104 500
  { p: 31260, pf: 32399, bank: 30901, from: 104500, to: 10000, label: 'Espèces', fac: 40093 },
  { p: 31261, pf: 32400, bank: 30902, from: 104500, to: 43000, label: 'Orange Money', fac: 40093 },
  { p: 31262, pf: 32401, bank: 30903, from: 104500, to: 51500, label: 'Wave', fac: 40093 },
  // LIBFAC20260602-021791 (CLIENT LIBRAIRE, facture 40065) — total 16 000
  { p: 31243, pf: 32382, bank: 30884, from: 16000, to: 13000, label: 'Espèces', fac: 40065 },
  { p: 31244, pf: 32383, bank: 30885, from: 16000, to: 3000, label: 'Wave', fac: 40065 },
];
const DELETE = [
  // LIBFAC20260327-020504 (WATT, facture 38540) — 2× LIQ 65 500 identiques : on en supprime un
  { p: 29953, pf: 30389, bank: 29812, bank_url: 59605, amount: 65500, fac: 38540 },
];
const FACTURES = [40093, 40065, 38540]; // à vérifier en fin de transaction

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

// Construit un INSERT ré-exécutable depuis une ligne (pour l'annulation des DELETE).
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
  // Colonnes multidevise présentes ?
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
  for (const d of DELETE) {
    const [[p]] = await conn.query('SELECT amount FROM llx_paiement WHERE rowid=?', [d.p]);
    const [[b]] = await conn.query('SELECT amount, rappro FROM llx_bank WHERE rowid=?', [d.bank]);
    if (!p || Number(p.amount) !== d.amount) errors.push(`DELETE p=${d.p} amount=${p?.amount} ≠ attendu ${d.amount}`);
    if (b && Number(b.rappro) !== 0) errors.push(`DELETE bank=${d.bank} RAPPROCHÉ (rappro=${b.rappro}) — abandon`);
  }
  if (errors.length) {
    console.error('⛔ Pré-contrôles échoués (données déjà modifiées ?) :');
    errors.forEach((e) => console.error('   - ' + e));
    process.exit(1);
  }

  // ---------- SAUVEGARDE + SQL D'ANNULATION ----------
  const ids = { p: [...ADJUST, ...DELETE].map((x) => x.p), pf: [...ADJUST.map((x) => x.pf), ...DELETE.map((x) => x.pf)], bank: [...ADJUST, ...DELETE].map((x) => x.bank), bu: DELETE.map((x) => x.bank_url) };
  const [bkP] = await conn.query('SELECT * FROM llx_paiement WHERE rowid IN (?)', [ids.p]);
  const [bkPf] = await conn.query('SELECT * FROM llx_paiement_facture WHERE rowid IN (?)', [ids.pf]);
  const [bkB] = await conn.query('SELECT * FROM llx_bank WHERE rowid IN (?)', [ids.bank]);
  const [bkBu] = ids.bu.length ? await conn.query('SELECT * FROM llx_bank_url WHERE rowid IN (?)', [ids.bu]) : [[]];

  const undo = [];
  // ADJUST : remettre les anciens montants.
  for (const a of ADJUST) {
    undo.push(`UPDATE llx_paiement SET amount=${a.from}, multicurrency_amount=${a.from} WHERE rowid=${a.p};`);
    undo.push(`UPDATE llx_paiement_facture SET amount=${a.from}, multicurrency_amount=${a.from} WHERE rowid=${a.pf};`);
    undo.push(`UPDATE llx_bank SET amount=${a.from}${bankHasMc ? `, multicurrency_amount=${a.from}` : ''} WHERE rowid=${a.bank};`);
  }
  // DELETE : ré-insérer les lignes supprimées.
  for (const d of DELETE) {
    bkBu.filter((r) => r.rowid === d.bank_url).forEach((r) => undo.push(buildInsert('llx_bank_url', r)));
    bkB.filter((r) => r.rowid === d.bank).forEach((r) => undo.push(buildInsert('llx_bank', r)));
    bkP.filter((r) => r.rowid === d.p).forEach((r) => undo.push(buildInsert('llx_paiement', r)));
    bkPf.filter((r) => r.rowid === d.pf).forEach((r) => undo.push(buildInsert('llx_paiement_facture', r)));
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  const jsonPath = join(bkDir, `split-overpay-${ts}.json`);
  const undoPath = join(bkDir, `split-overpay-${ts}.undo.sql`);
  writeFileSync(jsonPath, JSON.stringify({ paiement: bkP, paiement_facture: bkPf, bank: bkB, bank_url: bkBu }, null, 2));
  writeFileSync(undoPath, '-- Annulation de fix-split-overpay\n' + undo.join('\n') + '\n');
  console.log(`💾 Sauvegarde : ${jsonPath}`);
  console.log(`↩️  Annulation : ${undoPath}\n`);

  // ---------- APERÇU ----------
  console.log('AJUSTEMENTS :');
  for (const a of ADJUST) console.log(`   facture ${a.fac} · ${a.label.padEnd(13)} p=${a.p}  ${fmt(a.from)} → ${fmt(a.to)}`);
  console.log('SUPPRESSIONS :');
  for (const d of DELETE) console.log(`   facture ${d.fac} · doublon p=${d.p} (${fmt(d.amount)}) + ligne bancaire ${d.bank}`);

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
  for (const d of DELETE) {
    await conn.query('DELETE FROM llx_paiement_facture WHERE rowid=?', [d.pf]);
    await conn.query('DELETE FROM llx_bank_url WHERE rowid=?', [d.bank_url]);
    await conn.query('DELETE FROM llx_bank WHERE rowid=?', [d.bank]);
    await conn.query('DELETE FROM llx_paiement WHERE rowid=?', [d.p]);
  }

  // ---------- VÉRIFICATION FINALE (avant COMMIT) ----------
  const bad = [];
  for (const fac of FACTURES) {
    const [[f]] = await conn.query('SELECT ref, total_ttc FROM llx_facture WHERE rowid=?', [fac]);
    const [[s]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS paid FROM llx_paiement_facture WHERE fk_facture=?', [fac]);
    const ok = Math.abs(Number(f.total_ttc) - Number(s.paid)) < 1;
    console.log(`   ${ok ? '✅' : '❌'} ${f.ref} : payé ${fmt(s.paid)} / TTC ${fmt(f.total_ttc)}`);
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
