// Remédiation one-off — abandon du brouillon orphelin 022045 (timeout POS 15/06).
//
// Suite à fix-phantom-payment-31491 (paiement fantôme supprimé), la facture
// LIBFAC20260615-022045 (rowid 40332) reste un BROUILLON impayé. Dolibarr refuse
// de la SUPPRIMER (is_erasable → « not last » : elle a déjà un n° définitif et
// 022046/022047 sont passées derrière → un delete créerait un trou dans la
// numérotation légale). Décision : l'ABANDONNER (garde le n°, séquence sans trou,
// traçable), comme le doublon POS du 04/06.
//
// Action : llx_facture 40332 → fk_statut=3 (Abandonnée), close_code='replaced',
// close_note + date/clôture/auteur. AUCUN impact stock (mouvements déjà nets à 0 :
// 022045 a fait -1 puis +1 au rollback ; le -1 réel est porté par 022046).
// + journal d'audit applicatif (invoice_audit_log, action='abandon').
//
//   node scripts/abandon-invoice-40332.mjs           → DRY-RUN
//   node scripts/abandon-invoice-40332.mjs --apply    → applique en transaction
//
// Garde-fous : statut courant=0, paye=0, 0 paiement imputé. Idempotent (si déjà 3,
// s'arrête). Backup + undo.sql avant écriture.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dir = dirname(fileURLToPath(import.meta.url));

const FACTURE = 40332;
const REF = 'LIBFAC20260615-022045';
const REPLACED_BY = 'LIBFAC20260615-022046';
const ADMIN_UID = 1; // login=admin
const CLOSE_NOTE = `Doublon timeout POS 15/06 — remplacée par ${REPLACED_BY} (régularisation: Doublons)`;
const AUDIT_REASON = `Doublon (timeout POS 15/06) — remplacée par ${REPLACED_BY}`;

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

const conn = await pool.getConnection();
try {
  const [[f]] = await conn.query(
    'SELECT rowid, ref, fk_statut, paye, total_ttc, fk_soc, close_code, close_note, date_closing, fk_user_closing FROM llx_facture WHERE rowid=?',
    [FACTURE]
  );
  if (!f) { console.error(`⛔ Facture ${FACTURE} introuvable`); process.exit(1); }
  if (f.ref !== REF) { console.error(`⛔ ref inattendue (${f.ref} ≠ ${REF})`); process.exit(1); }
  if (Number(f.fk_statut) === 3) { console.log(`Facture ${REF} déjà Abandonnée — rien à faire.`); process.exit(0); }
  if (Number(f.fk_statut) !== 0) { console.error(`⛔ statut=${f.fk_statut} ≠ 0 (brouillon) — abandon`); process.exit(1); }
  const [[pf]] = await conn.query('SELECT COUNT(*) AS nb, COALESCE(SUM(amount),0) AS regle FROM llx_paiement_facture WHERE fk_facture=?', [FACTURE]);
  if (Number(pf.nb) > 0 || Number(pf.regle) > 0) { console.error(`⛔ ${pf.nb} paiement(s) encore imputé(s) (${pf.regle}) — abandon`); process.exit(1); }

  // ---------- SAUVEGARDE + UNDO ----------
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  writeFileSync(join(bkDir, `abandon-40332-${ts}.json`), JSON.stringify(f, null, 2));
  const undo = `-- Annulation abandon-invoice-40332 (remet le brouillon)\n`
    + `UPDATE llx_facture SET fk_statut=${f.fk_statut}, close_code=${f.close_code ? `'${f.close_code}'` : 'NULL'}, `
    + `close_note=${f.close_note ? `'${String(f.close_note).replace(/'/g, "''")}'` : 'NULL'}, `
    + `date_closing=${f.date_closing ? `'${f.date_closing}'` : 'NULL'}, `
    + `fk_user_closing=${f.fk_user_closing ?? 'NULL'} WHERE rowid=${FACTURE};\n`;
  writeFileSync(join(bkDir, `abandon-40332-${ts}.undo.sql`), undo);
  console.log(`💾 Sauvegarde + undo : scripts/backups/abandon-40332-${ts}.*\n`);

  console.log('ABANDON :');
  console.log(`   ${REF} (rowid ${FACTURE}, ${Number(f.total_ttc)} F) → Abandonnée / replaced`);
  console.log(`   close_note: "${CLOSE_NOTE}"`);
  console.log(`   stock: aucun impact (mouvements déjà nets à 0)\n`);

  if (!APPLY) { console.log('🔍 DRY-RUN — aucune écriture. Relancez avec --apply.'); process.exit(0); }

  // ---------- APPLICATION ----------
  await conn.beginTransaction();
  const [r] = await conn.query(
    `UPDATE llx_facture
       SET fk_statut=3, paye=0, close_code='replaced', close_note=?,
           date_closing=NOW(), fk_user_closing=?, fk_user_modif=?, tms=NOW()
     WHERE rowid=? AND fk_statut=0`,
    [CLOSE_NOTE, ADMIN_UID, ADMIN_UID, FACTURE]
  );
  if (r.affectedRows !== 1) { await conn.rollback(); console.error(`⛔ UPDATE a touché ${r.affectedRows} ligne(s) — ROLLBACK`); process.exit(1); }
  const [[chk]] = await conn.query('SELECT fk_statut, close_code FROM llx_facture WHERE rowid=?', [FACTURE]);
  if (Number(chk.fk_statut) !== 3) { await conn.rollback(); console.error('⛔ vérif post-update KO — ROLLBACK'); process.exit(1); }
  await conn.commit();
  console.log(`✅ Dolibarr : ${REF} passée en Abandonnée (replaced).`);

  // ---------- JOURNAL D'AUDIT APPLICATIF ----------
  const sdb = new Database(join(__dir, '..', 'newsletter.sqlite'));
  sdb.prepare(
    `INSERT INTO invoice_audit_log (fk_facture, ref_facture, action, reason, user_id, user_name, user_role, before_snapshot, after_snapshot)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    FACTURE, REF, 'abandon', AUDIT_REASON, ADMIN_UID, 'admin (régularisation console)', 'super_admin',
    JSON.stringify({ fk_statut: 0, paye: 0, regle: 0 }),
    JSON.stringify({ fk_statut: 3, close_code: 'replaced', replaced_by: REPLACED_BY })
  );
  sdb.close();
  console.log('✅ Journal d’audit : entrée « abandon » ajoutée.');
  console.log('\n✅ Terminé. Le brouillon disparaît de la liste, le n° 022045 reste tracé (Abandonnée).');
} catch (e) {
  try { await conn.rollback(); } catch { /* ignore */ }
  console.error('Erreur — ROLLBACK :', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
