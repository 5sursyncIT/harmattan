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
import { findExistingTier } from './tier-dedup.js';

// Statuts Dolibarr d'une proposition commerciale.
const STATUS_LABELS = { 0: 'Brouillon', 1: 'Validé', 2: 'Signé', 3: 'Non signé', 4: 'Facturé' };

// Client par défaut pour une proforma de comptoir anonyme + entrepôt de vente.
const DEFAULT_QUOTE_CUSTOMER = 13; // CLIENT LIBRAIRE
const WAREHOUSE = 4;               // Rayon (idwarehouse pour la décrémentation de stock)

// Libellés d'état d'une proforma POS (SQLite pos_quotes.status).
const POS_QUOTE_STATUS_LABELS = { valid: 'Proforma POS', invoiced: 'Facturée', refused: 'Refusée' };

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

  // Colonnes de suivi conversion proforma → facture (idempotent — la table
  // pos_quotes est créée par pos-routes au démarrage).
  const ensureQuoteInvoiceCols = () => {
    if (!db) return;
    for (const col of ['dolibarr_invoice_id INTEGER', 'invoice_ref TEXT']) {
      try { db.exec(`ALTER TABLE pos_quotes ADD COLUMN ${col}`); } catch { /* déjà présente */ }
    }
  };
  try { ensureQuoteInvoiceCols(); } catch { /* table pas encore prête */ }

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
    const code = q.status && POS_QUOTE_STATUS_LABELS[q.status] ? q.status : 'valid';
    return {
      id: `pos:${q.ref}`, source: 'pos', ref: q.ref,
      customer_name: q.customer_name || 'Client comptoir',
      customer_phone: q.customer_phone || null, customer_email: q.customer_email || null,
      date: created, expiry,
      status: 'pos', status_code: code, statusLabel: POS_QUOTE_STATUS_LABELS[code],
      invoice_ref: q.invoice_ref || null, dolibarr_invoice_id: q.dolibarr_invoice_id || null,
      total_ttc: Number(q.total_ttc) || 0,
      items, validity_days: validity,
      staff: q.staff_name || null, terminal: q.terminal || null,
    };
  };

  // Résout (ou crée) le tiers Dolibarr correspondant au client d'une proforma.
  // Une proforma ne stocke qu'un nom/téléphone/email libres (pas de socid).
  const resolveQuoteClient = async (quote, bodySocid) => {
    // 1. Client explicitement choisi par l'admin.
    const explicit = parseInt(bodySocid, 10);
    if (explicit) {
      const [[s]] = await dolibarrPool.query('SELECT rowid FROM llx_societe WHERE rowid = ? AND status = 1', [explicit]);
      if (s) return explicit;
    }
    const name = String(quote.customer_name || '').trim();
    const phone = String(quote.customer_phone || '').trim();
    const email = String(quote.customer_email || '').trim();
    // 2. Comptoir anonyme → client libraire par défaut.
    if ((!name || /^client comptoir$/i.test(name)) && !phone && !email) return DEFAULT_QUOTE_CUSTOMER;
    // 3. Dédup par email / téléphone (évite les doublons de tiers).
    const existing = await findExistingTier(dolibarrPool, { email, phone });
    if (existing?.id) return existing.id;
    // 4. Sinon, correspondance exacte par nom.
    if (name) {
      const [[byName]] = await dolibarrPool.query(
        'SELECT rowid FROM llx_societe WHERE status = 1 AND nom = ? ORDER BY rowid ASC LIMIT 1', [name]
      );
      if (byName) return byName.rowid;
    }
    // 5. Création d'un nouveau tiers client.
    const created = await adminApi.post('/thirdparties', {
      name: name || 'Client comptoir', client: 1,
      phone: phone || undefined, email: email || undefined,
    });
    return created.data;
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
  // FACTURER UNE PROFORMA POS — crée une facture Dolibarr validée
  // (impayée, stock décrémenté) depuis les articles de la proforma et
  // marque la proforma « Facturée ». Body optionnel : { socid }.
  // Atomique : si la validation échoue (stock insuffisant…), le brouillon
  // est supprimé et la proforma reste intacte.
  // ═══════════════════════════════════════════════════════════
  router.post('/pos-quotes/:ref/invoice', csrf, async (req, res) => {
    try {
      if (!db) return res.status(404).json({ error: 'Indisponible' });
      ensureQuoteInvoiceCols();
      const q = db.prepare('SELECT * FROM pos_quotes WHERE ref = ?').get(req.params.ref);
      if (!q) return res.status(404).json({ error: 'Proforma introuvable' });
      if (q.status === 'invoiced') return res.status(409).json({ error: 'Cette proforma est déjà facturée' });
      if (q.status === 'refused') return res.status(409).json({ error: 'Cette proforma a été refusée — impossible de la facturer' });

      let items = [];
      try { items = JSON.parse(q.items || '[]'); } catch { items = []; }
      if (!items.length) return res.status(409).json({ error: 'Proforma sans article — facturation impossible' });

      const socid = await resolveQuoteClient(q, req.body?.socid);

      const lines = items.map((it) => {
        const qty = Number(it.qty) > 0 ? Number(it.qty) : 1;
        const line = {
          qty,
          subprice: parseInt(it.price_ttc) || 0,
          tva_tx: 0, product_type: 0,
          remise_percent: Number(it.discount) || 0,
        };
        if (!it.is_free && it.product_id) line.fk_product = parseInt(it.product_id, 10);
        if (it.label) line.desc = String(it.label).slice(0, 200);
        return line;
      });

      const today = new Date().toISOString().split('T')[0];
      const invoiceRes = await adminApi.post('/invoices', {
        socid: parseInt(socid, 10),
        date: today,
        type: 0,
        module_source: 'proforma',
        note_private: `Facture générée depuis la proforma ${q.ref} (caisse)`,
        lines,
      });
      const invoiceId = invoiceRes.data;

      // Valider → décrémente le stock (Rayon). Atomique en cas d'échec.
      try {
        await adminApi.post(`/invoices/${invoiceId}/validate`, { idwarehouse: WAREHOUSE });
      } catch (valErr) {
        try { await adminApi.delete(`/invoices/${invoiceId}`); } catch { /* ignore */ }
        const dmsg = valErr.response?.data?.error?.message || valErr.response?.data?.error || valErr.message;
        const stockIssue = /stock/i.test(String(dmsg));
        console.error('[PROPALS] pos-quote invoice validate error:', dmsg);
        return res.status(409).json({
          error: stockIssue
            ? 'Stock insuffisant pour facturer cette proforma. Réapprovisionnez les articles puis réessayez.'
            : `Impossible de valider la facture : ${dmsg}`,
        });
      }

      let invoiceRef = null;
      try {
        const [[f]] = await dolibarrPool.query('SELECT ref FROM llx_facture WHERE rowid = ?', [invoiceId]);
        invoiceRef = f?.ref || null;
      } catch { /* ignore */ }

      db.prepare("UPDATE pos_quotes SET status = 'invoiced', dolibarr_invoice_id = ?, invoice_ref = ? WHERE ref = ?")
        .run(invoiceId, invoiceRef, q.ref);

      console.log(`[PROPALS] Proforma ${q.ref} facturée → ${invoiceRef || invoiceId} (client ${socid}) par ${req.admin?.email || req.admin?.role}`);
      res.json({ success: true, invoice_id: invoiceId, invoice_ref: invoiceRef, client_id: socid });
    } catch (err) {
      const dolMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      console.error('[PROPALS] pos-quote invoice error:', dolMsg);
      res.status(500).json({ error: 'Erreur lors de la facturation de la proforma', detail: dolMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // REFUSER UNE PROFORMA POS — la classe « Refusée » (invalidée).
  // ═══════════════════════════════════════════════════════════
  router.post('/pos-quotes/:ref/refuse', csrf, (req, res) => {
    try {
      if (!db) return res.status(404).json({ error: 'Indisponible' });
      ensureQuoteInvoiceCols();
      const q = db.prepare('SELECT ref, status FROM pos_quotes WHERE ref = ?').get(req.params.ref);
      if (!q) return res.status(404).json({ error: 'Proforma introuvable' });
      if (q.status === 'invoiced') return res.status(409).json({ error: 'Cette proforma est déjà facturée — impossible de la refuser' });
      if (q.status === 'refused') return res.status(409).json({ error: 'Cette proforma est déjà refusée' });
      db.prepare("UPDATE pos_quotes SET status = 'refused' WHERE ref = ?").run(q.ref);
      console.log(`[PROPALS] Proforma ${q.ref} refusée par ${req.admin?.email || req.admin?.role}`);
      res.json({ success: true });
    } catch (err) {
      console.error('[PROPALS] pos-quote refuse error:', err.message);
      res.status(500).json({ error: 'Erreur lors du refus de la proforma' });
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
  // VALIDER ET FACTURER — transforme le devis en facture Dolibarr
  // (validée / impayée) et classe le devis « Facturé ».
  //
  // Workflow : validate (si brouillon) → création facture depuis les lignes
  // du devis → validation facture (décrémente le stock, STOCK_CALCULATE_ON_BILL)
  // → lien devis↔facture → setinvoiced. Atomique : si la validation de la
  // facture échoue (stock insuffisant…), le brouillon est supprimé et le devis
  // reste intact.
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/invoice', csrf, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Identifiant de devis invalide' });
    try {
      const [[propal]] = await dolibarrPool.query(
        'SELECT rowid AS id, ref, fk_statut, fk_soc, note_public FROM llx_propal WHERE rowid = ?', [id]
      );
      if (!propal) return res.status(404).json({ error: 'Devis introuvable' });
      if (propal.fk_statut === 4) return res.status(409).json({ error: 'Ce devis est déjà facturé' });
      if (propal.fk_statut === 3) return res.status(409).json({ error: 'Ce devis a été refusé — impossible de le facturer' });
      if (!propal.fk_soc) return res.status(409).json({ error: 'Devis sans client — facturation impossible' });

      const [lines] = await dolibarrPool.query(
        `SELECT fk_product, qty, subprice, remise_percent, tva_tx, product_type, description
         FROM llx_propaldet WHERE fk_propal = ? ORDER BY rang ASC, rowid ASC`, [id]
      );
      if (!lines.length) return res.status(409).json({ error: 'Devis sans ligne — facturation impossible' });

      // 1. Valider le devis s'il est encore en brouillon (réf PROV → définitive).
      if (propal.fk_statut === 0) {
        await adminApi.post(`/proposals/${id}/validate`);
      }

      // 2. Créer la facture depuis les lignes du devis (TVA telle quelle = 0).
      const today = new Date().toISOString().split('T')[0];
      const invoiceRes = await adminApi.post('/invoices', {
        socid: parseInt(propal.fk_soc, 10),
        date: today,
        note_public: propal.note_public || '',
        note_private: `Facture générée depuis le devis ${propal.ref}`,
        lines: lines.map((l) => ({
          fk_product: l.fk_product ? parseInt(l.fk_product, 10) : undefined,
          qty: parseFloat(l.qty),
          subprice: parseFloat(l.subprice),
          remise_percent: parseFloat(l.remise_percent) || 0,
          tva_tx: parseFloat(l.tva_tx) || 0,
          product_type: parseInt(l.product_type) || 0,
          description: l.description || undefined,
        })),
      });
      const invoiceId = invoiceRes.data;

      // 3. Valider la facture → décrémente le stock (warehouse Rayon).
      //    Atomique : en cas d'échec, on purge le brouillon et on n'altère pas le devis.
      try {
        await adminApi.post(`/invoices/${invoiceId}/validate`, { idwarehouse: 4 });
      } catch (valErr) {
        try { await adminApi.delete(`/invoices/${invoiceId}`); } catch { /* ignore */ }
        const dmsg = valErr.response?.data?.error?.message || valErr.response?.data?.error || valErr.message;
        const stockIssue = /stock/i.test(String(dmsg));
        console.error('[PROPALS] invoice validate error:', dmsg);
        return res.status(409).json({
          error: stockIssue
            ? 'Stock insuffisant pour facturer ce devis. Réapprovisionnez les articles puis réessayez.'
            : `Impossible de valider la facture : ${dmsg}`,
        });
      }

      // 4. Relier devis ↔ facture (relation Dolibarr) — best effort.
      try {
        await dolibarrPool.query(
          `INSERT INTO llx_element_element (fk_source, sourcetype, fk_target, targettype)
           VALUES (?, 'propal', ?, 'facture')`, [id, invoiceId]
        );
      } catch (e) { console.warn('[PROPALS] lien devis/facture non créé:', e.message); }

      // 5. Classer le devis « Facturé » (statut 4).
      try { await adminApi.post(`/proposals/${id}/setinvoiced`); } catch (e) { console.warn('[PROPALS] setinvoiced warning:', e.message); }

      let invoiceRef = null;
      try {
        const [[f]] = await dolibarrPool.query('SELECT ref FROM llx_facture WHERE rowid = ?', [invoiceId]);
        invoiceRef = f?.ref || null;
      } catch { /* ignore */ }

      console.log(`[PROPALS] Devis ${propal.ref} facturé → ${invoiceRef || invoiceId} par ${req.admin?.email || req.admin?.role}`);
      res.json({ success: true, invoice_id: invoiceId, invoice_ref: invoiceRef });
    } catch (err) {
      const dolMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      console.error('[PROPALS] invoice error:', dolMsg);
      res.status(500).json({ error: 'Erreur lors de la facturation du devis', detail: dolMsg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // REFUSER / INVALIDER — classe le devis « Non signé » (refusé).
  // Body optionnel : { reason }. Un brouillon est validé au préalable pour
  // conserver une réf définitive (trace propre).
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/refuse', csrf, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Identifiant de devis invalide' });
    const reason = String(req.body?.reason || '').trim().slice(0, 500);
    try {
      const [[propal]] = await dolibarrPool.query(
        'SELECT rowid AS id, ref, fk_statut FROM llx_propal WHERE rowid = ?', [id]
      );
      if (!propal) return res.status(404).json({ error: 'Devis introuvable' });
      if (propal.fk_statut === 4) return res.status(409).json({ error: 'Ce devis est déjà facturé — impossible de le refuser' });
      if (propal.fk_statut === 3) return res.status(409).json({ error: 'Ce devis est déjà refusé' });

      // Un brouillon doit d'abord être validé pour obtenir une réf définitive.
      if (propal.fk_statut === 0) {
        await adminApi.post(`/proposals/${id}/validate`);
      }

      const note = reason ? `Devis refusé : ${reason}` : 'Devis refusé';
      await adminApi.post(`/proposals/${id}/close`, { status: 3, note_private: note });

      console.log(`[PROPALS] Devis ${propal.ref} refusé par ${req.admin?.email || req.admin?.role}`);
      res.json({ success: true });
    } catch (err) {
      const dolMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      console.error('[PROPALS] refuse error:', dolMsg);
      res.status(500).json({ error: 'Erreur lors du refus du devis', detail: dolMsg });
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

      // Facture générée depuis ce devis (si facturé) — pour l'affichage.
      let linkedInvoice = null;
      if (propal.fk_statut === 4) {
        const [[li]] = await dolibarrPool.query(
          `SELECT f.rowid AS id, f.ref, f.fk_statut, f.paye
           FROM llx_element_element ee
           JOIN llx_facture f ON f.rowid = ee.fk_target
           WHERE ee.fk_source = ? AND ee.sourcetype = 'propal' AND ee.targettype = 'facture'
           ORDER BY f.rowid DESC LIMIT 1`, [id]
        );
        if (li) linkedInvoice = { id: li.id, ref: li.ref, status: li.fk_statut, paid: !!li.paye };
      }

      res.json({
        propal: {
          id: propal.id, ref: propal.ref, ref_client: propal.ref_client || null,
          status: propal.fk_statut, statusLabel: STATUS_LABELS[propal.fk_statut] || '?',
          date: propal.date, expiry: propal.expiry,
          total_ht: Number(propal.total_ht), total_tva: Number(propal.total_tva), total_ttc: Number(propal.total_ttc),
          note_public: propal.note_public, note_private: propal.note_private,
          linked_invoice: linkedInvoice,
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
