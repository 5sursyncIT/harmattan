/**
 * Migration : ajout des colonnes liées à un agrégateur de paiement (PayTech)
 * sur la table order_payments. Idempotent — peut être appelée à chaque boot.
 *
 * Pattern : ALTER TABLE en try/catch (SQLite ne supporte pas IF NOT EXISTS sur ADD COLUMN).
 */
export function migrateAddPaytechColumns(db) {
  const additions = [
    { name: 'external_transaction_id', def: 'TEXT' },     // token PayTech
    { name: 'external_payment_id',     def: 'TEXT' },     // payment_id retourné par IPN
    { name: 'external_status',         def: 'TEXT' },     // 'pending'|'success'|'failed'|'cancelled'
    { name: 'external_provider',       def: "TEXT DEFAULT 'paytech'" },
    { name: 'external_payload',        def: 'TEXT' },     // dump JSON du dernier IPN reçu (debug)
  ];

  for (const col of additions) {
    try {
      db.exec(`ALTER TABLE order_payments ADD COLUMN ${col.name} ${col.def}`);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) {
        console.error(`[MIGRATION] add ${col.name} failed:`, err.message);
      }
    }
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_op_external_txn ON order_payments(external_transaction_id)');
  } catch (err) {
    console.error('[MIGRATION] index creation failed:', err.message);
  }
}
