/**
 * Détail d'une commande web — source unique partagée.
 *
 * Utilisé par /api/admin/orders/:id (orders-routes.js) ET
 * /api/admin/payments/order/:orderId (index.js) : un seul jeu de requêtes
 * SQL et un seul format de réponse à maintenir.
 *
 * En-tête + client + lignes proviennent de Dolibarr (source de vérité métier) ;
 * le bloc paiement provient de SQLite (order_payments).
 */

export const ORDER_STATUS_LABELS = { '-1': 'Annulée', 0: 'Brouillon', 1: 'Validée', 2: 'En cours', 3: 'Livrée' };
export const PAY_STATUS_LABELS = { pending: 'En attente', confirmed: 'Confirmé', rejected: 'Rejeté' };

/**
 * @param {{ db: import('better-sqlite3').Database, dolibarrPool: any }} deps
 * @param {number} id - rowid de la commande Dolibarr
 * @returns {Promise<object|null>} { order, lines, payment } ou null si introuvable
 */
export async function fetchOrderDetail({ db, dolibarrPool }, id) {
  const [[order]] = await dolibarrPool.query(
    `SELECT c.rowid AS id, c.ref, c.fk_statut, c.facture AS billed,
            DATE_FORMAT(c.date_commande, '%Y-%m-%d') AS date_commande,
            c.total_ht, c.total_tva, c.total_ttc, c.note_public, c.note_private,
            c.fk_soc, s.nom AS customer_name, s.email AS customer_email,
            s.phone AS customer_phone, s.address, s.zip, s.town
     FROM llx_commande c
     LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
     WHERE c.rowid = ?`, [id]
  );
  if (!order) return null;

  const [lines] = await dolibarrPool.query(
    `SELECT cd.rowid AS id, cd.fk_product, p.ref AS product_ref, p.label AS product_label,
            cd.description, cd.qty, cd.subprice, cd.remise_percent, cd.total_ht, cd.total_ttc
     FROM llx_commandedet cd
     LEFT JOIN llx_product p ON p.rowid = cd.fk_product
     WHERE cd.fk_commande = ? AND cd.product_type = 0
     ORDER BY cd.rang ASC, cd.rowid ASC`, [id]
  );

  const payment = db.prepare(
    'SELECT * FROM order_payments WHERE dolibarr_order_id = ? ORDER BY id DESC LIMIT 1'
  ).get(String(id)) || null;

  return {
    order: {
      id: order.id, ref: order.ref,
      status: order.fk_statut, statusLabel: ORDER_STATUS_LABELS[String(order.fk_statut)] || '?',
      billed: !!order.billed,
      date: order.date_commande,
      total_ht: Number(order.total_ht), total_tva: Number(order.total_tva), total_ttc: Number(order.total_ttc),
      note_public: order.note_public, note_private: order.note_private,
      customer: {
        id: order.fk_soc, name: order.customer_name, email: order.customer_email,
        phone: order.customer_phone, address: order.address, zip: order.zip, town: order.town,
      },
    },
    lines: lines.map(l => ({
      id: l.id, product_id: l.fk_product, ref: l.product_ref,
      label: l.product_label || l.description, qty: Number(l.qty),
      subprice: Number(l.subprice), remise_percent: Number(l.remise_percent),
      total_ht: Number(l.total_ht), total_ttc: Number(l.total_ttc),
    })),
    payment: payment ? {
      method: payment.payment_method, status: payment.payment_status,
      statusLabel: PAY_STATUS_LABELS[payment.payment_status] || payment.payment_status,
      amount_expected: Number(payment.amount_expected), amount_received: payment.amount_received,
      transaction_ref: payment.transaction_ref, payer_phone: payment.payer_phone,
      invoice_ref: payment.invoice_ref, created_at: payment.created_at,
      confirmed_by: payment.confirmed_by, confirmed_at: payment.confirmed_at,
      rejected_by: payment.rejected_by, reject_reason: payment.reject_reason,
    } : null,
  };
}
