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
import { fetchOrderDetail, ORDER_STATUS_LABELS, PAY_STATUS_LABELS } from './order-detail.js';

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

      // Filtres « hors statut » (recherche, méthode, dates) : ils s'appliquent
      // aussi bien à la liste qu'aux KPIs. Le filtre payment_status, lui, ne
      // s'applique qu'à la liste — sinon les cartes de répartition (en attente /
      // payées / rejetées), qui sont une navigation par facette, s'annuleraient
      // mutuellement (filtrer « en attente » ramènerait confirmées/rejetées à 0).
      const baseWhere = [];
      const baseParams = [];
      if (req.query.method) { baseWhere.push('payment_method = ?'); baseParams.push(req.query.method); }
      if (req.query.search) {
        baseWhere.push('(order_ref LIKE ? OR customer_name LIKE ? OR customer_email LIKE ? OR customer_phone LIKE ?)');
        const pat = `%${req.query.search}%`;
        baseParams.push(pat, pat, pat, pat);
      }
      if (req.query.date_from) { baseWhere.push("date(created_at) >= date(?)"); baseParams.push(req.query.date_from); }
      if (req.query.date_to)   { baseWhere.push("date(created_at) <= date(?)"); baseParams.push(req.query.date_to); }

      const where = [...baseWhere];
      const params = [...baseParams];
      if (req.query.payment_status && PAY_STATUS_LABELS[req.query.payment_status]) {
        where.push('payment_status = ?'); params.push(req.query.payment_status);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const baseWhereSql = baseWhere.length ? 'WHERE ' + baseWhere.join(' AND ') : '';

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
        FROM order_payments ${baseWhereSql}`).get(...baseParams);

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
      const detail = await fetchOrderDetail({ db, dolibarrPool }, id);
      if (!detail) return res.status(404).json({ error: 'Commande introuvable' });
      res.json(detail);
    } catch (err) {
      console.error('[ORDERS] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement de la commande' });
    }
  });

  return router;
}
