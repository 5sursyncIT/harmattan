#!/usr/bin/env node
/**
 * Rattrapage : enregistre dans Dolibarr les règlements MANQUANTS des commandes
 * web marquées « confirmées » (SQLite order_payments) dont la facture est restée
 * paye=0 (« Impayée ») faute d'avoir appelé recordInvoicePayment lors de la
 * confirmation. Voir paytech-routes.js / index.js (confirm-payment) pour le
 * correctif côté code qui empêche la récidive.
 *
 * Impute chaque règlement sur le compte de trésorerie du moyen déclaré
 * (paytech → CPTEPAYTECH, wave → COMPTE WAVE, …) à la date de confirmation,
 * et solde la facture (closepaidinvoices). Idempotent : ignore toute facture
 * qui a déjà au moins un paiement.
 *
 * Usage :
 *   node scripts/backfill-ecommerce-payments.mjs            # dry-run (n'écrit rien)
 *   node scripts/backfill-ecommerce-payments.mjs --apply    # exécute
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { recordEcommerceInvoicePayment, resolveEcommercePayment } from '../server/dolibarr-payments.js';
import { adminApi } from '../server/dolibarr-admin-client.js';

const APPLY = process.argv.includes('--apply');

const db = new Database('newsletter.sqlite', { readonly: true });
const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

function toEpoch(sqliteDatetime) {
  // order_payments.confirmed_at est en UTC (CURRENT_TIMESTAMP / new Date().toISOString()).
  const d = sqliteDatetime ? new Date(sqliteDatetime.replace(' ', 'T') + 'Z') : new Date();
  const s = Math.floor(d.getTime() / 1000);
  return Number.isFinite(s) && s > 0 ? s : Math.floor(Date.now() / 1000);
}

const rows = db.prepare(
  `SELECT id, dolibarr_order_id, order_ref, invoice_ref, payment_method, amount_received, amount_expected, confirmed_at
   FROM order_payments
   WHERE payment_status = 'confirmed' AND invoice_ref IS NOT NULL AND invoice_ref <> ''`
).all();

console.log(`Mode : ${APPLY ? 'APPLY (écriture)' : 'DRY-RUN (lecture seule)'}`);
console.log(`Commandes confirmées avec facture : ${rows.length}\n`);

let done = 0, skipped = 0, failed = 0;

for (const r of rows) {
  const [inv] = await pool.query(
    'SELECT rowid, ref, total_ttc, paye, fk_statut FROM llx_facture WHERE ref = ? LIMIT 1',
    [r.invoice_ref]
  );
  if (!inv.length) {
    console.log(`⚠  ${r.invoice_ref} : facture introuvable dans Dolibarr — ignorée`);
    skipped++; continue;
  }
  const f = inv[0];
  const [paidRows] = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS paid FROM llx_paiement_facture WHERE fk_facture = ?',
    [f.rowid]
  );
  const paid = Number(paidRows[0]?.paid) || 0;
  if (paid > 0) {
    console.log(`✔  ${r.invoice_ref} : déjà un paiement (${paid}) — ignorée`);
    skipped++; continue;
  }
  if (Number(f.fk_statut) === 0) {
    console.log(`⚠  ${r.invoice_ref} : facture en brouillon (non validée) — ignorée`);
    skipped++; continue;
  }

  const amount = Number(r.amount_received) > 0 ? Number(r.amount_received) : Number(f.total_ttc);
  const { code, accountId } = resolveEcommercePayment(r.payment_method);
  const datepaye = toEpoch(r.confirmed_at);

  console.log(
    `${APPLY ? '→' : '·'}  ${r.invoice_ref} : ${amount} FCFA via ${r.payment_method} ` +
    `(mode ${code}, compte ${accountId}, date ${new Date(datepaye * 1000).toISOString().slice(0, 10)})`
  );

  if (!APPLY) { done++; continue; }

  try {
    const payId = await recordEcommerceInvoicePayment(adminApi, pool, {
      invoiceId: f.rowid,
      amount,
      method: r.payment_method,
      datepaye,
      comment: `Rattrapage encaissement web — commande ${r.order_ref}`,
    });
    console.log(`   ✓ paiement Dolibarr créé : rowid=${payId}`);
    done++;
  } catch (e) {
    console.error(`   ✗ échec : ${e.response?.data?.error?.message || e.response?.data || e.message}`);
    failed++;
  }
}

console.log(`\nRésumé : ${done} traitée(s), ${skipped} ignorée(s), ${failed} échec(s)`);
if (!APPLY) console.log('Relancer avec --apply pour écrire les paiements.');

await pool.end();
db.close();
