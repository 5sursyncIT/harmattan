// Remédiation one-off — abandon du brouillon numéroté 022626 + restitution du stock.
//
// La facture LIBFAC20260713-022626 (rowid 40918, 30 ex. « Droit civil SÉNÉGALAIS »,
// 252 000 F) a été validée (stock -30), puis repassée en brouillon (motif « Erreur
// remise »). Dolibarr refuse de la SUPPRIMER (is_erasable → -2 : n° définitif et
// 17 factures validées derrière → un delete trouerait la numérotation légale) :
// l'API renvoie 403 « Invoice not erasable », que la route DELETE de la boutique
// masquait en 500. Décision (validée) : l'ABANDONNER et refaire une facture propre.
//
// ⚠ Le retour en brouillon N'A PAS restitué le stock : la route settodraft appelait
// l'API sans idwarehouse, et sans entrepôt Dolibarr échoue le mouvement de retour
// EN SILENCE. Les 30 exemplaires sont donc toujours sortis à tort. Il faut les
// rendre AVANT toute nouvelle facture, sinon la prochaine validation décrémente une
// 2ᵉ fois — exactement ce qui est arrivé le 30/05 (021700 vs 021703, -79 en double).
// La cause racine est corrigée dans server/invoices-routes.js (settodraft + route
// /abandon) ; ce script ne traite que le passif de 40918.
//
// Actions : 1) mouvement d'entrée +30 (produit 4179, entrepôt 4) via l'API Dolibarr,
//              pour que llx_product_stock et llx_stock_mouvement restent cohérents ;
//           2) llx_facture 40918 → fk_statut=3 (Abandonnée), close_code='abandon' ;
//           3) journal d'audit applicatif (invoice_audit_log, action='abandon').
//
//   node scripts/abandon-invoice-40918.mjs           → DRY-RUN
//   node scripts/abandon-invoice-40918.mjs --apply   → applique
//
// Garde-fous : statut=0, paye=0, 0 paiement imputé, ref attendue. Idempotent (si déjà
// abandonnée, s'arrête ; le stock est calculé sur le solde net des mouvements, donc
// un 2ᵉ passage ne recrédite rien). Backup + undo avant écriture.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import axios from 'axios';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dir = dirname(fileURLToPath(import.meta.url));

const FACTURE = 40918;
const REF = 'LIBFAC20260713-022626';
const ADMIN_UID = 1; // login=admin
const CLOSE_NOTE = 'Erreur remise — facture refaite. Abandon (n° définitif : suppression impossible).';
const AUDIT_REASON = 'Erreur remise — abandon du brouillon numéroté, stock restitué, facture à refaire';

const api = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

const conn = await pool.getConnection();
try {
  // ---------- GARDE-FOUS ----------
  const [[f]] = await conn.query(
    'SELECT rowid, ref, fk_statut, paye, total_ttc, fk_soc, close_code, close_note, date_closing, fk_user_closing FROM llx_facture WHERE rowid=?',
    [FACTURE]
  );
  if (!f) { console.error(`⛔ Facture ${FACTURE} introuvable`); process.exit(1); }
  if (f.ref !== REF) { console.error(`⛔ ref inattendue (${f.ref} ≠ ${REF})`); process.exit(1); }
  if (Number(f.fk_statut) === 3) { console.log(`Facture ${REF} déjà Abandonnée — rien à faire.`); process.exit(0); }
  if (Number(f.fk_statut) !== 0) { console.error(`⛔ statut=${f.fk_statut} ≠ 0 (brouillon) — abandon`); process.exit(1); }
  const [[pf]] = await conn.query(
    'SELECT COUNT(*) AS nb, COALESCE(SUM(amount),0) AS regle FROM llx_paiement_facture WHERE fk_facture=?', [FACTURE]
  );
  if (Number(pf.nb) > 0 || Number(pf.regle) > 0) { console.error(`⛔ ${pf.nb} paiement(s) imputé(s) (${pf.regle} F) — abandon`); process.exit(1); }

  // ---------- STOCK ENCORE DÛ (solde net des mouvements de la facture) ----------
  const [moves] = await conn.query(
    `SELECT fk_product, fk_entrepot, SUM(value) AS net
       FROM llx_stock_mouvement
      WHERE origintype='facture' AND fk_origin=?
      GROUP BY fk_product, fk_entrepot
     HAVING net < 0`, [FACTURE]
  );
  const toRestore = moves.map(m => ({
    product: Number(m.fk_product), warehouse: Number(m.fk_entrepot), qty: Math.abs(Number(m.net)),
  }));

  console.log(`ABANDON : ${REF} (rowid ${FACTURE}, ${Number(f.total_ttc).toLocaleString('fr-FR')} F) → Abandonnée / abandon`);
  console.log(`   close_note: "${CLOSE_NOTE}"`);
  if (!toRestore.length) {
    console.log('   stock: aucun mouvement à restituer (solde net déjà à 0)\n');
  } else {
    for (const m of toRestore) {
      const [[p]] = await conn.query('SELECT ref, label, stock FROM llx_product WHERE rowid=?', [m.product]);
      console.log(`   stock: produit ${m.product} (${p?.ref} — ${p?.label}) → +${m.qty} en entrepôt ${m.warehouse} `
        + `[stock actuel ${Number(p?.stock)} → ${Number(p?.stock) + m.qty}]`);
    }
    console.log('');
  }

  if (!APPLY) { console.log('🔍 DRY-RUN — aucune écriture. Relancez avec --apply.'); process.exit(0); }

  // ---------- SAUVEGARDE + UNDO ----------
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  writeFileSync(join(bkDir, `abandon-40918-${ts}.json`), JSON.stringify({ facture: f, stock_to_restore: toRestore }, null, 2));
  const undo = `-- Annulation abandon-invoice-40918 (remet le brouillon)\n`
    + `UPDATE llx_facture SET fk_statut=${f.fk_statut}, close_code=${f.close_code ? `'${f.close_code}'` : 'NULL'}, `
    + `close_note=${f.close_note ? `'${String(f.close_note).replace(/'/g, "''")}'` : 'NULL'}, `
    + `date_closing=${f.date_closing ? `'${f.date_closing}'` : 'NULL'}, `
    + `fk_user_closing=${f.fk_user_closing ?? 'NULL'} WHERE rowid=${FACTURE};\n`
    + `-- Le stock restitué doit être repris par un mouvement de SORTIE inverse (ne pas\n`
    + `-- éditer llx_stock_mouvement à la main : llx_product_stock/llx_product.stock\n`
    + `-- resteraient désynchronisés). Sorties à repasser :\n`
    + toRestore.map(m => `--   produit ${m.product}, entrepôt ${m.warehouse}, -${m.qty}\n`).join('');
  writeFileSync(join(bkDir, `abandon-40918-${ts}.undo.sql`), undo);
  console.log(`💾 Sauvegarde + undo : scripts/backups/abandon-40918-${ts}.*\n`);

  // ---------- 1. RESTITUTION DU STOCK (via l'API : garde llx_product_stock cohérent) ----------
  for (const m of toRestore) {
    await api.post('/stockmovements', {
      product_id: m.product,
      warehouse_id: m.warehouse,
      qty: m.qty,
      type: 3,   // entrée
      price: 0,  // prix nul → le PMP n'est pas altéré (comme le fait setDraft)
      movementlabel: `Facture ${REF} abandonnée — restitution stock`,
      origin_type: 'facture',
      origin_id: FACTURE,
    });
    console.log(`✅ Stock : produit ${m.product} +${m.qty} (entrepôt ${m.warehouse}) restitué.`);
  }

  // ---------- 2. ABANDON DE LA FACTURE ----------
  await conn.beginTransaction();
  const [r] = await conn.query(
    `UPDATE llx_facture
       SET fk_statut=3, paye=0, close_code='abandon', close_note=?,
           date_closing=NOW(), fk_user_closing=?, fk_user_modif=?, tms=NOW()
     WHERE rowid=? AND fk_statut=0`,
    [CLOSE_NOTE, ADMIN_UID, ADMIN_UID, FACTURE]
  );
  if (r.affectedRows !== 1) { await conn.rollback(); console.error(`⛔ UPDATE a touché ${r.affectedRows} ligne(s) — ROLLBACK`); process.exit(1); }
  const [[chk]] = await conn.query('SELECT fk_statut, close_code FROM llx_facture WHERE rowid=?', [FACTURE]);
  if (Number(chk.fk_statut) !== 3) { await conn.rollback(); console.error('⛔ vérif post-update KO — ROLLBACK'); process.exit(1); }
  // Les remises/avoirs que la facture retenait sont libérés (cf. Facture::setCanceled).
  await conn.query('UPDATE llx_societe_remise_except SET fk_facture=NULL WHERE fk_facture=?', [FACTURE]);
  await conn.commit();
  console.log(`✅ Dolibarr : ${REF} passée en Abandonnée (abandon).`);

  // ---------- 3. JOURNAL D'AUDIT APPLICATIF ----------
  const sdb = new Database(join(__dir, '..', 'newsletter.sqlite'));
  sdb.prepare(
    `INSERT INTO invoice_audit_log (fk_facture, ref_facture, action, reason, user_id, user_name, user_role, before_snapshot, after_snapshot)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    FACTURE, REF, 'abandon', AUDIT_REASON, ADMIN_UID, 'admin (régularisation console)', 'super_admin',
    JSON.stringify({ fk_statut: Number(f.fk_statut), paye: Number(f.paye), total_ttc: Number(f.total_ttc) }),
    JSON.stringify({ fk_statut: 3, close_code: 'abandon', stock_restored: toRestore }),
  );
  sdb.close();
  console.log('✅ Audit applicatif écrit (invoice_audit_log, action=abandon).');
} finally {
  conn.release();
  await pool.end();
}
