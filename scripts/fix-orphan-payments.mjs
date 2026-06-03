#!/usr/bin/env node
/**
 * Reconnecter les paiements ORPHELINS (aucune ligne llx_paiement_facture) à leur
 * facture, quand l'appariement est sûr.
 *
 * Deux niveaux de confiance :
 *  - 'ref'    : num_paiement nomme une facture EXISTANTE, paye=1, sans paiement,
 *               et montant = total_ttc au centime → reconnexion automatique.
 *  - 'amount' : num_paiement vide, mais il existe une UNIQUE facture paye=1 sans
 *               paiement du même montant exact (bijection) → proposé, --apply requis
 *               ET --include-amount pour l'exécuter (prudence).
 *
 * NB : ne traite que l'ère courante (datep >= --since, défaut 2026-01-01). Les
 * ~455 paiements orphelins de 2021-2022 (factures disparues d'un ancien import)
 * sont un sujet comptable distinct, hors de ce script.
 *
 * Reconnexion = INSERT llx_paiement_facture(fk_paiement, fk_facture, amount).
 * Les factures concernées sont déjà paye=1 → aucun changement de statut.
 *
 * Usage :
 *   node scripts/fix-orphan-payments.mjs                       # dry-run
 *   node scripts/fix-orphan-payments.mjs --apply               # applique les 'ref'
 *   node scripts/fix-orphan-payments.mjs --apply --include-amount
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync, mkdirSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const includeAmount = process.argv.includes('--include-amount');
const sinceArg = (process.argv.find((a) => a.startsWith('--since=')) || '').split('=')[1];
const SINCE = sinceArg || '2026-01-01';
const fmt = (n) => Number(n).toLocaleString('fr-FR');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

async function main() {
  console.log(`\n=== Reconnexion des paiements orphelins (depuis ${SINCE}) ===`);
  console.log(apply ? '*** MODE --apply ***' : '(dry-run)');
  console.log(includeAmount ? '(inclut les appariements par montant)\n' : '(appariements par montant EXCLUS — ajouter --include-amount)\n');

  const [orphans] = await pool.query(`
    SELECT p.rowid AS paie_id, p.ref AS paie_ref, p.amount, p.num_paiement, DATE(p.datep) AS datep
    FROM llx_paiement p
    LEFT JOIN llx_paiement_facture pf ON pf.fk_paiement=p.rowid
    WHERE pf.rowid IS NULL AND p.datep >= ?
    ORDER BY p.datep`, [SINCE]);

  const plan = [];
  for (const o of orphans) {
    let match = null, conf = null;
    if (o.num_paiement) {
      const [[f]] = await pool.query(
        `SELECT f.rowid, f.ref, f.total_ttc, f.paye,
                (SELECT COUNT(*) FROM llx_paiement_facture WHERE fk_facture=f.rowid) nbp
           FROM llx_facture f WHERE f.ref=?`, [o.num_paiement]);
      if (f && f.paye === 1 && f.nbp === 0 && Math.abs(f.total_ttc - o.amount) < 1) { match = f; conf = 'ref'; }
    }
    if (!match) {
      const [cands] = await pool.query(
        `SELECT f.rowid, f.ref, f.total_ttc
           FROM llx_facture f
           LEFT JOIN (SELECT fk_facture,SUM(amount) s FROM llx_paiement_facture GROUP BY fk_facture) p ON p.fk_facture=f.rowid
           WHERE f.paye=1 AND f.type IN (0,1,3,4) AND COALESCE(p.s,0)=0 AND ABS(f.total_ttc-?)<1`, [o.amount]);
      if (cands.length === 1) { match = cands[0]; conf = 'amount'; }
    }
    if (!match) { console.log(`• ${o.paie_ref} (${fmt(o.amount)}) : aucun appariement sûr → ignoré`); continue; }
    plan.push({ ...o, match, conf });
    console.log(`→ ${o.paie_ref} (${fmt(o.amount)}) ⇒ ${match.ref}  [${conf === 'ref' ? 'SÛR (réf+montant)' : 'montant (bijection)'}]`);
  }

  const toApply = plan.filter((p) => p.conf === 'ref' || includeAmount);
  if (!apply) {
    console.log(`\nDRY-RUN : ${plan.length} appariement(s) (${plan.filter(p=>p.conf==='ref').length} sûrs, ${plan.filter(p=>p.conf==='amount').length} par montant). --apply pour exécuter.\n`);
    await pool.end(); return;
  }

  mkdirSync('scripts/backups', { recursive: true });
  writeFileSync('scripts/backups/rollback-orphan.sql',
    toApply.map((p) => `DELETE FROM llx_paiement_facture WHERE fk_paiement=${p.paie_id} AND fk_facture=${p.match.rowid};`).join('\n') + '\n');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of toApply) {
      await conn.query(
        `INSERT INTO llx_paiement_facture (fk_paiement, fk_facture, amount, multicurrency_amount) VALUES (?,?,?,?)`,
        [p.paie_id, p.match.rowid, p.amount, p.amount]);
    }
    await conn.commit();
    console.log(`\n✓ ${toApply.length} lien(s) recréé(s). COMMIT. Backup: scripts/backups/rollback-orphan.sql`);
  } catch (e) {
    await conn.rollback();
    console.error('\n✗ ROLLBACK :', e.message);
    process.exitCode = 1;
  } finally { conn.release(); await pool.end(); }
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
