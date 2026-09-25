// Remédiation one-off — réouverture de LIBFAC20241123-007361 (rowid 21994).
//
// La facture (BINETOU, 779 500 F du 23/11/2024) a été fermée en « Abandonnée »
// par le lot de nettoyage de migration (close_note « Migration cleanup - facture
// ancienne irrécouvrable », 636 factures 2022-2024). Or elle N'ÉTAIT PAS
// irrécouvrable : deux règlements espèces y sont imputés (350 000 le 16/12/2024
// + 200 000 le 06/11/2025 = 550 000), et le client vient de solder les 229 500 F
// restants en espèces à la librairie.
//
// Le lot a fermé les factures en SQL direct (fk_user_closing NULL, libellé anglais) :
// il n'est donc pas passé par la route applicative /abandon, qui refuse justement
// toute facture portant des paiements. Aucune écriture comptable n'existe pour
// cette facture (llx_accounting_bookkeeping vide) et le stock n'a jamais été
// restitué (66 sorties du 23/11/2024, -91 ex., aucun retour) : la réouverture est
// donc neutre pour le stock ET pour la compta — elle remet simplement la créance
// là où elle n'aurait jamais dû cesser d'être.
//
// Action : llx_facture 21994 → fk_statut=1 (Validée/impayée), close_code/close_note/
//          date_closing/fk_user_closing remis à NULL. La librairie peut alors
//          encaisser les 229 500 F par l'écran « Encaisser un impayé » ; Dolibarr
//          passera la facture à « Payée » de lui-même une fois soldée.
//
//   node scripts/reopen-invoice-21994.mjs           → DRY-RUN
//   node scripts/reopen-invoice-21994.mjs --apply   → applique
//
// Garde-fous : ref attendue, statut=3, paye=0, close_code='abandon', au moins un
// paiement imputé, reste dû > 0, zéro écriture comptable, stock non restitué.
// Idempotent (si déjà rouverte, s'arrête). Backup + undo avant écriture.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dir = dirname(fileURLToPath(import.meta.url));

const FACTURE = 21994;
const REF = 'LIBFAC20241123-007361';
const ADMIN_UID = 1; // login=admin
const AUDIT_REASON = 'Abandon à tort par le lot « Migration cleanup » : facture partiellement réglée '
  + '(550 000 F) et solde de 229 500 F encaissé en espèces par la librairie. Réouverture pour encaissement.';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

const fmt = n => Number(n).toLocaleString('fr-FR');
const conn = await pool.getConnection();
try {
  // ---------- GARDE-FOUS ----------
  const [[f]] = await conn.query(
    `SELECT rowid, ref, datef, fk_statut, paye, total_ttc, fk_soc,
            close_code, close_note, date_closing, fk_user_closing
       FROM llx_facture WHERE rowid=?`, [FACTURE]
  );
  if (!f) { console.error(`⛔ Facture ${FACTURE} introuvable`); process.exit(1); }
  if (f.ref !== REF) { console.error(`⛔ ref inattendue (${f.ref} ≠ ${REF})`); process.exit(1); }
  if (Number(f.fk_statut) === 1) { console.log(`Facture ${REF} déjà rouverte (statut 1) — rien à faire.`); process.exit(0); }
  if (Number(f.fk_statut) !== 3) { console.error(`⛔ statut=${f.fk_statut} ≠ 3 (Abandonnée) — abandon`); process.exit(1); }
  if (Number(f.paye) !== 0) { console.error(`⛔ paye=${f.paye} ≠ 0 — abandon`); process.exit(1); }
  if (f.close_code !== 'abandon') { console.error(`⛔ close_code='${f.close_code}' ≠ 'abandon' — abandon`); process.exit(1); }

  const [[pf]] = await conn.query(
    'SELECT COUNT(*) AS nb, COALESCE(SUM(amount),0) AS regle FROM llx_paiement_facture WHERE fk_facture=?', [FACTURE]
  );
  if (Number(pf.nb) === 0) {
    console.error('⛔ aucun paiement imputé — ce n\'est pas le cas traité ici (abandon peut-être légitime)');
    process.exit(1);
  }
  const reste = Number(f.total_ttc) - Number(pf.regle);
  if (reste <= 0) { console.error(`⛔ reste dû = ${fmt(reste)} F (≤ 0) — la facture est soldée, abandon`); process.exit(1); }

  const [[bk]] = await conn.query(
    'SELECT COUNT(*) AS n FROM llx_accounting_bookkeeping WHERE doc_ref=?', [REF]
  );
  if (Number(bk.n) > 0) {
    console.error(`⛔ ${bk.n} écriture(s) comptable(s) sur ${REF} — réouverture à traiter avec le comptable, abandon`);
    process.exit(1);
  }

  // Le stock doit être TOUJOURS sorti : si l'abandon l'avait restitué, rouvrir la
  // facture recréerait une créance sur des exemplaires revenus en rayon.
  const [[st]] = await conn.query(
    `SELECT COALESCE(SUM(value),0) AS net, COUNT(*) AS n
       FROM llx_stock_mouvement WHERE origintype='facture' AND fk_origin=?`, [FACTURE]
  );
  if (Number(st.n) > 0 && Number(st.net) >= 0) {
    console.error(`⛔ stock déjà restitué (solde net ${st.net}) — il faudrait le ressortir, abandon`);
    process.exit(1);
  }

  const [[soc]] = await conn.query('SELECT nom FROM llx_societe WHERE rowid=?', [f.fk_soc]);
  const [pays] = await conn.query(
    `SELECT p.datep, pf2.amount, c.code
       FROM llx_paiement_facture pf2 JOIN llx_paiement p ON p.rowid=pf2.fk_paiement
       LEFT JOIN llx_c_paiement c ON c.id=p.fk_paiement
      WHERE pf2.fk_facture=? ORDER BY p.datep`, [FACTURE]
  );

  console.log(`RÉOUVERTURE : ${REF} (rowid ${FACTURE}) — ${soc?.nom} — ${f.datef}`);
  console.log(`   Abandonnée (${f.close_code}) : "${f.close_note}"`);
  console.log(`   Total ${fmt(f.total_ttc)} F — déjà réglé ${fmt(pf.regle)} F (${pf.nb} paiement(s)) — reste ${fmt(reste)} F`);
  for (const p of pays) console.log(`     • ${String(p.datep).slice(0, 10)}  ${fmt(p.amount)} F  (${p.code})`);
  console.log(`   Stock : ${st.n} mouvement(s), solde net ${st.net} — non restitué, rien à faire.`);
  console.log(`   Compta : 0 écriture — rien à reprendre.`);
  console.log(`   → fk_statut ${f.fk_statut} → 1 (Validée / impayée), close_* remis à NULL\n`);

  if (!APPLY) { console.log('🔍 DRY-RUN — aucune écriture. Relancez avec --apply.'); process.exit(0); }

  // ---------- SAUVEGARDE + UNDO ----------
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  writeFileSync(join(bkDir, `reopen-21994-${ts}.json`), JSON.stringify({ facture: f, paiements: pays }, null, 2));
  const q = v => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  writeFileSync(join(bkDir, `reopen-21994-${ts}.undo.sql`),
    `-- Annulation reopen-invoice-21994 (remet la facture en Abandonnée)\n`
    + `UPDATE llx_facture SET fk_statut=${f.fk_statut}, paye=${f.paye}, close_code=${q(f.close_code)}, `
    + `close_note=${q(f.close_note)}, date_closing=${q(f.date_closing)}, `
    + `fk_user_closing=${f.fk_user_closing ?? 'NULL'} WHERE rowid=${FACTURE};\n`);
  console.log(`💾 Sauvegarde + undo : scripts/backups/reopen-21994-${ts}.*\n`);

  // ---------- RÉOUVERTURE ----------
  await conn.beginTransaction();
  const [r] = await conn.query(
    `UPDATE llx_facture
        SET fk_statut=1, paye=0, close_code=NULL, close_note=NULL,
            date_closing=NULL, fk_user_closing=NULL, fk_user_modif=?, tms=NOW()
      WHERE rowid=? AND fk_statut=3`,
    [ADMIN_UID, FACTURE]
  );
  if (r.affectedRows !== 1) { await conn.rollback(); console.error(`⛔ UPDATE a touché ${r.affectedRows} ligne(s) — ROLLBACK`); process.exit(1); }
  const [[chk]] = await conn.query('SELECT fk_statut, paye, close_code FROM llx_facture WHERE rowid=?', [FACTURE]);
  if (Number(chk.fk_statut) !== 1 || chk.close_code !== null) {
    await conn.rollback(); console.error('⛔ vérif post-update KO — ROLLBACK'); process.exit(1);
  }
  await conn.commit();
  console.log(`✅ Dolibarr : ${REF} rouverte — Validée / impayée, reste ${fmt(reste)} F à encaisser.`);

  // ---------- JOURNAL D'AUDIT APPLICATIF ----------
  const sdb = new Database(join(__dir, '..', 'newsletter.sqlite'));
  sdb.prepare(
    `INSERT INTO invoice_audit_log (fk_facture, ref_facture, action, reason, user_id, user_name, user_role, before_snapshot, after_snapshot)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    FACTURE, REF, 'reopen', AUDIT_REASON, ADMIN_UID, 'admin (régularisation console)', 'super_admin',
    JSON.stringify({ fk_statut: Number(f.fk_statut), paye: Number(f.paye), close_code: f.close_code, close_note: f.close_note, total_ttc: Number(f.total_ttc), deja_regle: Number(pf.regle) }),
    JSON.stringify({ fk_statut: 1, paye: 0, close_code: null, reste_a_encaisser: reste }),
  );
  sdb.close();
  console.log('✅ Audit applicatif écrit (invoice_audit_log, action=reopen).');
} finally {
  conn.release();
  await pool.end();
}
