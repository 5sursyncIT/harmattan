/**
 * Propals Routes — Gestion des devis (propositions commerciales Dolibarr, llx_propal).
 *
 * Liste + détail des devis (créés notamment depuis le POS via /proposals, ou le web).
 * Le PDF est servi par l'endpoint existant /api/admin/propals/:id/pdf (admin-people-routes,
 * via document-builddoc type='propal').
 *
 * Sécurité : monté sur /api/admin/propals (whitelist RBAC : super_admin, admin, comptable,
 * librarian, support).
 */

import { Router } from 'express';

// Statuts Dolibarr d'une proposition commerciale.
const STATUS_LABELS = { 0: 'Brouillon', 1: 'Validé', 2: 'Signé', 3: 'Non signé', 4: 'Facturé' };

export function createPropalsRouter({ dolibarrPool }) {
  const router = Router();

  // ═══════════════════════════════════════════════════════════
  // LISTE
  // ═══════════════════════════════════════════════════════════
  router.get('/', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.status !== undefined && req.query.status !== '') {
        const s = parseInt(req.query.status, 10);
        if ([0, 1, 2, 3, 4].includes(s)) { where.push('p.fk_statut = ?'); params.push(s); }
      }
      if (req.query.search) {
        where.push('(p.ref LIKE ? OR p.ref_client LIKE ? OR s.nom LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat, pat);
      }
      if (req.query.date_from) { where.push('p.datep >= ?'); params.push(req.query.date_from); }
      if (req.query.date_to)   { where.push('p.datep <= ?'); params.push(req.query.date_to + ' 23:59:59'); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [[{ total }]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total FROM llx_propal p LEFT JOIN llx_societe s ON s.rowid = p.fk_soc ${whereSql}`, params
      );
      const [rows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.ref_client,
                DATE_FORMAT(p.datep, '%Y-%m-%d') AS date,
                DATE_FORMAT(p.fin_validite, '%Y-%m-%d') AS expiry,
                p.fk_statut, p.fk_soc, s.nom AS customer_name,
                p.total_ht, p.total_tva, p.total_ttc
         FROM llx_propal p
         LEFT JOIN llx_societe s ON s.rowid = p.fk_soc
         ${whereSql}
         ORDER BY p.datep DESC, p.rowid DESC
         LIMIT ? OFFSET ?`, [...params, limit, offset]
      );

      const [[kpis]] = await dolibarrPool.query(
        `SELECT
           SUM(CASE WHEN p.fk_statut = 0 THEN 1 ELSE 0 END) AS draft,
           SUM(CASE WHEN p.fk_statut = 1 THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN p.fk_statut = 2 THEN 1 ELSE 0 END) AS signed,
           SUM(CASE WHEN p.fk_statut = 4 THEN 1 ELSE 0 END) AS billed,
           SUM(CASE WHEN p.fk_statut = 1 THEN p.total_ttc ELSE 0 END) AS open_amount
         FROM llx_propal p LEFT JOIN llx_societe s ON s.rowid = p.fk_soc ${whereSql}`, params
      );

      res.json({
        propals: rows.map(r => ({
          id: r.id, ref: r.ref, ref_client: r.ref_client || null,
          date: r.date, expiry: r.expiry,
          status: r.fk_statut, statusLabel: STATUS_LABELS[r.fk_statut] || '?',
          customer_id: r.fk_soc, customer_name: r.customer_name || '—',
          total_ht: Number(r.total_ht), total_tva: Number(r.total_tva), total_ttc: Number(r.total_ttc),
        })),
        total: Number(total), page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: {
          draft: Number(kpis.draft || 0), open: Number(kpis.open || 0),
          signed: Number(kpis.signed || 0), billed: Number(kpis.billed || 0),
          open_amount: Number(kpis.open_amount || 0),
        },
      });
    } catch (err) {
      console.error('[PROPALS] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement devis' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Identifiant de devis invalide' });
    try {
      const [[propal]] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.ref_client,
                DATE_FORMAT(p.datep, '%Y-%m-%d') AS date,
                DATE_FORMAT(p.fin_validite, '%Y-%m-%d') AS expiry,
                p.fk_statut, p.total_ht, p.total_tva, p.total_ttc,
                p.note_public, p.note_private,
                p.fk_soc, s.nom AS customer_name, s.email AS customer_email,
                s.phone AS customer_phone, s.address, s.zip, s.town
         FROM llx_propal p
         LEFT JOIN llx_societe s ON s.rowid = p.fk_soc
         WHERE p.rowid = ?`, [id]
      );
      if (!propal) return res.status(404).json({ error: 'Devis introuvable' });

      const [lines] = await dolibarrPool.query(
        `SELECT pd.rowid AS id, pd.fk_product, prod.ref AS product_ref, prod.label AS product_label,
                pd.description, pd.qty, pd.subprice, pd.remise_percent, pd.total_ht, pd.total_ttc
         FROM llx_propaldet pd
         LEFT JOIN llx_product prod ON prod.rowid = pd.fk_product
         WHERE pd.fk_propal = ?
         ORDER BY pd.rang ASC, pd.rowid ASC`, [id]
      );

      res.json({
        propal: {
          id: propal.id, ref: propal.ref, ref_client: propal.ref_client || null,
          status: propal.fk_statut, statusLabel: STATUS_LABELS[propal.fk_statut] || '?',
          date: propal.date, expiry: propal.expiry,
          total_ht: Number(propal.total_ht), total_tva: Number(propal.total_tva), total_ttc: Number(propal.total_ttc),
          note_public: propal.note_public, note_private: propal.note_private,
          customer: {
            id: propal.fk_soc, name: propal.customer_name, email: propal.customer_email,
            phone: propal.customer_phone, address: propal.address, zip: propal.zip, town: propal.town,
          },
        },
        lines: lines.map(l => ({
          id: l.id, product_id: l.fk_product, ref: l.product_ref,
          label: l.product_label || l.description, qty: Number(l.qty),
          subprice: Number(l.subprice), remise_percent: Number(l.remise_percent),
          total_ht: Number(l.total_ht), total_ttc: Number(l.total_ttc),
        })),
      });
    } catch (err) {
      console.error('[PROPALS] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement du devis' });
    }
  });

  return router;
}
