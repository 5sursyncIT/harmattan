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
import axios from 'axios';

// Statuts Dolibarr d'une proposition commerciale.
const STATUS_LABELS = { 0: 'Brouillon', 1: 'Validé', 2: 'Signé', 3: 'Non signé', 4: 'Facturé' };

// Client REST Dolibarr (création de devis via /proposals — même patron que le POS).
const adminApi = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

export function createPropalsRouter({ dolibarrPool, csrfProtection, db }) {
  const router = Router();
  // No-op si la protection CSRF n'est pas fournie (montage hérité).
  const csrf = csrfProtection || ((req, res, next) => next());

  // Met en forme une ligne pos_quotes (SQLite) pour l'affichage admin / l'impression.
  const shapePosQuote = (q) => {
    let items = [];
    try { items = JSON.parse(q.items || '[]'); } catch { items = []; }
    const validity = q.validity_days || 30;
    const created = q.created_at ? String(q.created_at).replace(' ', 'T') + 'Z' : null;
    let expiry = null;
    if (q.created_at) {
      const d = new Date(String(q.created_at).replace(' ', 'T') + 'Z');
      d.setDate(d.getDate() + validity);
      expiry = d.toISOString();
    }
    return {
      id: `pos:${q.ref}`, source: 'pos', ref: q.ref,
      customer_name: q.customer_name || 'Client comptoir',
      customer_phone: q.customer_phone || null, customer_email: q.customer_email || null,
      date: created, expiry,
      status: 'pos', statusLabel: 'Proforma POS',
      total_ttc: Number(q.total_ttc) || 0,
      items, validity_days: validity,
      staff: q.staff_name || null, terminal: q.terminal || null,
    };
  };

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
  // PROFORMAS POS (devis de caisse, stockés en SQLite pos_quotes)
  // Les proformas POS sont des devis commerciaux distincts des fiches
  // de fabrication (llx_propal repurposé pour l'éditorial). On les expose
  // ici pour qu'ils soient visibles dans /admin/devis.
  // ═══════════════════════════════════════════════════════════
  router.get('/pos-quotes', (req, res) => {
    try {
      if (!db) return res.json({ quotes: [] });
      const where = [];
      const params = [];
      if (req.query.search) {
        where.push('(ref LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat, pat);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT * FROM pos_quotes ${whereSql} ORDER BY id DESC LIMIT 500`
      ).all(...params);
      const quotes = rows.map(shapePosQuote);
      res.json({
        quotes,
        total: quotes.length,
        total_amount: quotes.reduce((s, q) => s + q.total_ttc, 0),
      });
    } catch (err) {
      console.error('[PROPALS] pos-quotes list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement proformas POS' });
    }
  });

  router.get('/pos-quotes/:ref', (req, res) => {
    try {
      if (!db) return res.status(404).json({ error: 'Indisponible' });
      const q = db.prepare('SELECT * FROM pos_quotes WHERE ref = ?').get(req.params.ref);
      if (!q) return res.status(404).json({ error: 'Proforma introuvable' });
      res.json({ quote: shapePosQuote(q) });
    } catch (err) {
      console.error('[PROPALS] pos-quote detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement proforma' });
    }
  });

  // Suppression d'une proforma POS — réservée aux administrateurs.
  router.delete('/pos-quotes/:ref', csrf, (req, res) => {
    try {
      if (!db) return res.status(404).json({ error: 'Indisponible' });
      const role = req.admin?.role;
      if (role !== 'super_admin' && role !== 'admin') {
        return res.status(403).json({ error: 'Suppression réservée aux administrateurs' });
      }
      const q = db.prepare('SELECT ref FROM pos_quotes WHERE ref = ?').get(req.params.ref);
      if (!q) return res.status(404).json({ error: 'Proforma introuvable' });
      db.prepare('DELETE FROM pos_quotes WHERE ref = ?').run(req.params.ref);
      console.log(`[PROPALS] Proforma POS ${req.params.ref} supprimée par ${req.admin?.email || role}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('[PROPALS] pos-quote delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression proforma' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RECHERCHE CLIENT (pour le formulaire de création)
  // ═══════════════════════════════════════════════════════════
  router.get('/clients/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ clients: [] });
      const pat = `%${q}%`;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, code_client, email, address, zip, town, phone
         FROM llx_societe
         WHERE status = 1 AND (nom LIKE ? OR code_client LIKE ? OR email LIKE ?)
         ORDER BY nom ASC LIMIT 20`,
        [pat, pat, pat]
      );
      res.json({ clients: rows.map(r => ({
        id: r.id, name: r.nom, code: r.code_client, email: r.email,
        address: r.address, zip: r.zip, town: r.town, phone: r.phone,
      })) });
    } catch (err) {
      console.error('[PROPALS] clients search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche client' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RECHERCHE PRODUIT (réf, titre, ISBN) — avec prix pour le devis
  // ═══════════════════════════════════════════════════════════
  router.get('/products/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ products: [] });
      const pat = `%${q}%`;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, barcode, price_ttc
         FROM llx_product
         WHERE tosell = 1 AND (ref LIKE ? OR label LIKE ? OR barcode LIKE ?)
         ORDER BY label ASC LIMIT 20`,
        [pat, pat, pat]
      );
      res.json({ products: rows.map(r => ({
        id: r.id, ref: r.ref, label: r.label, isbn: r.barcode, price_ttc: Number(r.price_ttc) || 0,
      })) });
    } catch (err) {
      console.error('[PROPALS] products search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche produit' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CRÉATION (brouillon Dolibarr — non validé)
  // ═══════════════════════════════════════════════════════════
  router.post('/', csrf, async (req, res) => {
    try {
      const { socid, lines, note_public, duree_validite } = req.body || {};
      const sid = parseInt(socid, 10);
      if (!sid) return res.status(400).json({ error: 'Client requis' });
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: 'Au moins une ligne est requise' });
      }

      const propalLines = lines.map((l) => {
        const qty = Number(l.qty) > 0 ? Number(l.qty) : 1;
        const subprice = Number(l.subprice) || 0;
        const line = { qty, subprice, tva_tx: 0, product_type: 0 };
        if (l.product_id) line.fk_product = parseInt(l.product_id, 10);
        if (l.label) line.desc = String(l.label).slice(0, 255);
        return line;
      });

      const today = new Date().toISOString().split('T')[0];
      const validity = Math.min(365, Math.max(1, parseInt(duree_validite, 10) || 30));

      // Création via API REST Dolibarr → reste en brouillon (pas d'appel /validate).
      const createRes = await adminApi.post('/proposals', {
        socid: sid,
        date: today,
        duree_validite: validity,
        lines: propalLines,
        note_public: note_public ? String(note_public).slice(0, 2000) : '',
      });
      const newId = createRes.data;

      // Récupère la réf provisoire (PROVxx) pour l'affichage immédiat — non bloquant.
      let ref = null;
      try {
        const detail = await adminApi.get(`/proposals/${newId}`);
        ref = detail.data?.ref || null;
      } catch { /* ignore */ }

      res.json({ id: newId, ref, status: 0 });
    } catch (err) {
      const dolMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      console.error('[PROPALS] create error:', dolMsg);
      res.status(500).json({ error: 'Erreur lors de la création du devis' });
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
