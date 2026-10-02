#!/usr/bin/env node
/**
 * Purge des commandes web antérieures à une date (démarrage réel des commandes
 * web le 03/10/2026 — décision direction du 02/10/2026).
 *
 * - Commande NON facturée  → supprimée dans Dolibarr (DELETE /orders/:id, clé
 *   admin : liens element_element nettoyés par Dolibarr) + ligne order_payments
 *   supprimée. Aucun effet stock (STOCK_CALCULATE_ON_BILL : le stock ne bouge
 *   qu'à la facture).
 * - Commande FACTURÉE      → conservée (comptabilité), simplement archivée
 *   (order_payments.archived_at) et donc masquée des écrans.
 *
 * Usage : node scripts/purge-web-orders-before.mjs [--apply] [--before=2026-10-03]
 * Sans --apply : simulation, aucune écriture.
 * Sauvegarde préalable : /home/youssoupha/harmattan/backups/web-orders-purge-2026-10-02/
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { adminApi } from '../server/dolibarr-admin-client.js';

const APPLY = process.argv.includes('--apply');
const BEFORE = (process.argv.find((a) => a.startsWith('--before=')) || '--before=2026-10-03').split('=')[1];

const db = new Database(new URL('../newsletter.sqlite', import.meta.url).pathname);
const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
});

try { db.exec('ALTER TABLE order_payments ADD COLUMN archived_at DATETIME'); } catch { /* déjà présente */ }

const rows = db.prepare('SELECT * FROM order_payments WHERE created_at < ? AND archived_at IS NULL ORDER BY id').all(BEFORE);
const summary = { deleted: [], archived: [], errors: [] };

for (const r of rows) {
  const orderId = parseInt(r.dolibarr_order_id, 10);
  const [links] = orderId
    ? await pool.query(
      `SELECT f.ref FROM llx_element_element e JOIN llx_facture f ON f.rowid = e.fk_target
        WHERE e.sourcetype = 'commande' AND e.targettype = 'facture' AND e.fk_source = ?`, [orderId])
    : [[]];
  const invoiced = links.length > 0 || !!r.invoice_ref;
  if (invoiced) {
    summary.archived.push(`${r.order_ref} → ${links[0]?.ref || r.invoice_ref}`);
    if (APPLY) db.prepare('UPDATE order_payments SET archived_at = CURRENT_TIMESTAMP WHERE id = ?').run(r.id);
    continue;
  }
  summary.deleted.push(`${r.order_ref} (${r.payment_status}, ${r.amount_expected} F, ${r.customer_name})`);
  if (!APPLY) continue;
  try {
    if (orderId) {
      const [[exists]] = await pool.query('SELECT rowid FROM llx_commande WHERE rowid = ?', [orderId]);
      if (exists) await adminApi.delete(`/orders/${orderId}`);
    }
    db.prepare('DELETE FROM order_payments WHERE id = ?').run(r.id);
  } catch (err) {
    summary.errors.push(`${r.order_ref}: ${JSON.stringify(err.response?.data || err.message)}`);
  }
}

console.log(`${APPLY ? 'APPLIQUÉ' : 'SIMULATION'} — commandes créées avant le ${BEFORE}`);
console.log(`Supprimées : ${summary.deleted.length}`); summary.deleted.forEach((l) => console.log('  - ' + l));
console.log(`Archivées (facturées) : ${summary.archived.length}`); summary.archived.forEach((l) => console.log('  - ' + l));
if (summary.errors.length) { console.log(`ERREURS : ${summary.errors.length}`); summary.errors.forEach((l) => console.log('  ! ' + l)); }
// Commandes e-commerce Dolibarr sans suivi local (signalées, jamais touchées).
const localIds = new Set(db.prepare('SELECT dolibarr_order_id FROM order_payments').all().map((x) => String(x.dolibarr_order_id)));
const [eco] = await pool.query(`SELECT rowid, ref FROM llx_commande WHERE module_source = 'ecommerce' AND date_creation < ?`, [BEFORE]);
const untracked = eco.filter((o) => !localIds.has(String(o.rowid)));
console.log(`Commandes e-commerce Dolibarr hors suivi local (non touchées) : ${untracked.length}${untracked.length ? ' — ' + untracked.map((o) => o.ref).join(', ') : ''}`);
await pool.end();
