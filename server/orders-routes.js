/**
 * Orders Routes — Gestion des commandes passées via le site internet.
 *
 * Vue consolidée des commandes web : chaque commande web est tracée localement
 * dans `order_payments` (SQLite) ; on l'enrichit du statut LIVE de la commande
 * Dolibarr (llx_commande, via dolibarrPool) — les deux bases étant distinctes,
 * la jointure est applicative (pas de JOIN SQL cross-base).
 *
 * Lecture seule (liste + détail). Les actions de paiement restent sur l'écran
 * Paiements ; la création de BL reste sur l'écran Bons de livraison.
 *
 * Sécurité : monté sur /api/admin/orders, whitelist RBAC (super_admin, admin,
 * comptable, librarian).
 */

import { Router } from 'express';

const ORDER_STATUS_LABELS = { '-1': 'Annulée', 0: 'Brouillon', 1: 'Validée', 2: 'En cours', 3: 'Livrée' };
const PAY_STATUS_LABELS = { pending: 'En attente', confirmed: 'Confirmé', rejected: 'Rejeté' };

export function createOrdersRouter({ db, dolibarrPool }) {
  const router = Router();

  // ═══════════════════════════════════════════════════════════
  // LISTE — commandes web (order_payments) + statut Dolibarr live
  // ═══════════════════════════════════════════════════════════
  router.get('/', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.payment_status && PAY_STATUS_LABELS[req.query.payment_status]) {
        where.push('payment_status = ?'); params.push(req.query.payment_status);
      }
      if (req.query.method) { where.push('payment_method = ?'); params.push(req.query.method); }
      if (req.query.search) {
        where.push('(order_ref LIKE ? OR customer_name LIKE ? OR customer_email LIKE ? OR customer_phone LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat, pat, pat);
      }
      if (req.query.date_from) { where.push("date(created_at) >= date(?)"); params.push(req.query.date_from); }
      if (req.query.date_to)   { where.push("date(created_at) <= date(?)"); params.push(req.query.date_to); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM order_payments ${whereSql}`).get(...params).n;
      const rows = db.prepare(
        `SELECT id, dolibarr_order_id, order_ref, customer_name, customer_email, customer_phone,
                payment_method, payment_status, amount_expected, invoice_ref, created_at
         FROM order_payments ${whereSql}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      // Statut Dolibarr live (une seule requête pour la page).
      const orderIds = [...new Set(rows.map(r => parseInt(r.dolibarr_order_id, 10)).filter(Boolean))];
      const statusById = new Map();
      if (orderIds.length > 0) {
        const placeholders = orderIds.map(() => '?').join(',');
        const [crows] = await dolibarrPool.query(
          `SELECT rowid AS id, fk_statut, facture AS billed, total_ttc FROM llx_commande WHERE rowid IN (${placeholders})`,
          orderIds
        );
        for (const c of crows) statusById.set(Number(c.id), c);
      }

      const kpis = db.prepare(`SELECT
        SUM(CASE WHEN payment_status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN payment_status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN payment_status='rejected' THEN 1 ELSE 0 END) AS rejected
        FROM order_payments`).get();

      res.json({
        orders: rows.map(r => {
          const c = statusById.get(parseInt(r.dolibarr_order_id, 10));
          return {
            id: r.dolibarr_order_id,
            payment_id: r.id,
            ref: r.order_ref,
            customer: { name: r.customer_name, email: r.customer_email, phone: r.customer_phone },
            amount: Number(r.amount_expected),
            method: r.payment_method,
            paymentStatus: r.payment_status,
            paymentStatusLabel: PAY_STATUS_LABELS[r.payment_status] || r.payment_status,
            invoiceRef: r.invoice_ref || null,
            orderStatus: c ? c.fk_statut : null,
            orderStatusLabel: c ? (ORDER_STATUS_LABELS[String(c.fk_statut)] || '?') : 'Introuvable',
            billed: c ? !!c.billed : false,
            createdAt: r.created_at,
          };
        }),
        total, page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: {
          pending: Number(kpis.pending || 0),
          confirmed: Number(kpis.confirmed || 0),
          rejected: Number(kpis.rejected || 0),
        },
      });
    } catch (err) {
      console.error('[ORDERS] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement commandes' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL — en-tête + client + lignes + paiement local
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Identifiant de commande invalide' });
    try {
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
      if (!order) return res.status(404).json({ error: 'Commande introuvable' });

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

      res.json({
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
      });
    } catch (err) {
      console.error('[ORDERS] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement de la commande' });
    }
  });

  return router;
}
