/**
 * Invoices Routes — Gestion opérationnelle et régularisation des factures.
 *
 * Permet au libraire (et admin/super_admin) de régulariser les factures
 * Dolibarr : marquer payée (encaissement manuel), créer un avoir, repasser
 * en brouillon, éditer les lignes, réassigner le client, supprimer un
 * brouillon orphelin.
 *
 * Toutes les mutations exigent un motif (reason) et tracent l'opération
 * dans la table SQLite invoice_audit_log (user, action, before/after).
 *
 * Sécurité : monté sur /api/admin/invoices, whitelist RBAC pour librarian
 * dans roles-config.js. Mutations protégées CSRF.
 */

import { Router } from 'express';
import axios from 'axios';
import { dolibarrApi } from './dolibarr-client.js';

// Client Dolibarr avec clé admin (opérations d'écriture sur factures).
const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.warn('[INVOICES] DOLIBARR_ADMIN_API_KEY non définie — les régularisations échoueront');
}
const adminApi = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { DOLAPIKEY: ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

// Endpoint PHP custom (Dolibarr internal) — utilisé en fallback quand l'API REST builddoc échoue.
const DOC_BUILDDOC_URL = 'http://localhost/dolibarr/htdocs/custom/senharmattansync/document-builddoc.php';
const DOLIBARR_WEBHOOK_SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';

// Codes paiement Dolibarr → libellés.
const PAYMENT_METHOD_LABELS = {
  LIQ: 'Espèces', CB: 'Carte bancaire', CHQ: 'Chèque',
  WAVE: 'Wave', OM: 'Orange Money', VIR: 'Virement', WEB: 'Paiement web',
};
const PAYMENT_METHODS_ALLOWED = new Set(['LIQ', 'CB', 'CHQ', 'WAVE', 'OM', 'VIR']);

const INVOICE_STATUS_LABELS = { 0: 'Brouillon', 1: 'Validée', 2: 'Payée', 3: 'Abandonnée' };

// ─── HELPERS ─────────────────────────────────────────────────

function ensureAuditTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS invoice_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fk_facture INTEGER NOT NULL,
    ref_facture TEXT,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT,
    user_role TEXT,
    before_snapshot TEXT,
    after_snapshot TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoice_audit_facture ON invoice_audit_log(fk_facture)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoice_audit_created ON invoice_audit_log(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_invoice_audit_user ON invoice_audit_log(user_id)');
}

function writeAudit(db, { admin, fk_facture, ref_facture, action, reason, before, after }) {
  try {
    db.prepare(`INSERT INTO invoice_audit_log
      (fk_facture, ref_facture, action, reason, user_id, user_name, user_role, before_snapshot, after_snapshot)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      fk_facture, ref_facture || null, action, reason,
      admin.id, admin.username, admin.role,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    );
  } catch (e) {
    console.error('[INVOICES] échec écriture audit:', e.message);
  }
}

// Charge la facture depuis SQL (snapshot avant mutation).
async function loadInvoiceRow(dolibarrPool, id) {
  const [[row]] = await dolibarrPool.query(
    `SELECT rowid, ref, datef, date_lim_reglement, fk_soc, fk_statut, paye,
            total_ht, total_tva, total_ttc, type, fk_facture_source,
            module_source, note_private
     FROM llx_facture WHERE rowid = ?`, [id]
  );
  return row || null;
}

async function sumPayments(dolibarrPool, id) {
  const [[row]] = await dolibarrPool.query(
    `SELECT COALESCE(SUM(amount), 0) AS paid, COUNT(*) AS nb
     FROM llx_paiement_facture WHERE fk_facture = ?`, [id]
  );
  return { paid: Number(row.paid), nb: Number(row.nb) };
}

function nonEmptyReason(s) {
  const trimmed = String(s || '').trim();
  return trimmed.length >= 4 && trimmed.length <= 500 ? trimmed : null;
}

// ─── ROUTER FACTORY ──────────────────────────────────────────

export function createInvoicesRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();
  ensureAuditTable(db);
  const noCsrf = csrfProtection || ((req, res, next) => next());

  // ═══════════════════════════════════════════════════════════
  // LISTE FACTURES — filtres : statut, client, ref, date, source
  // ═══════════════════════════════════════════════════════════
  router.get('/', auth, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];

      // Statut : 0=brouillon, 1=impayée (validée non payée), 2=payée, 3=abandonnée
      if (req.query.status !== undefined && req.query.status !== '') {
        const s = parseInt(req.query.status);
        if ([0, 1, 2, 3].includes(s)) { where.push('f.fk_statut = ?'); params.push(s); }
      }
      // Filtre rapide : impayées uniquement (validée + paye=0)
      if (req.query.unpaid === '1') { where.push('f.fk_statut = 1 AND f.paye = 0'); }

      if (req.query.socid) { where.push('f.fk_soc = ?'); params.push(parseInt(req.query.socid)); }
      if (req.query.search) {
        where.push('(f.ref LIKE ? OR s.nom LIKE ? OR s.code_client LIKE ? OR s.email LIKE ? OR s.town LIKE ? OR s.phone LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat, pat, pat, pat, pat);
      }
      if (req.query.date_from) { where.push('f.datef >= ?'); params.push(req.query.date_from); }
      if (req.query.date_to)   { where.push('f.datef <= ?'); params.push(req.query.date_to); }
      if (req.query.source) {
        if (req.query.source === 'direct') where.push("(f.module_source IS NULL OR f.module_source = '')");
        else { where.push('f.module_source = ?'); params.push(req.query.source); }
      }
      // Type : 0=facture standard, 2=avoir, 3=acompte, 4=remplaçante. Par défaut on
      // affiche tout (l'UI peut filtrer).
      if (req.query.type !== undefined && req.query.type !== '') {
        const t = parseInt(req.query.type);
        if ([0, 1, 2, 3, 4].includes(t)) { where.push('f.type = ?'); params.push(t); }
      }

      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const [[{ total }]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         ${whereSql}`, params
      );

      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref,
                DATE_FORMAT(f.datef, '%Y-%m-%d') AS datef,
                DATE_FORMAT(f.date_lim_reglement, '%Y-%m-%d') AS date_lim_reglement,
                f.fk_soc, s.nom AS customer_name,
                f.fk_statut, f.paye, f.type, f.module_source,
                f.total_ht, f.total_tva, f.total_ttc,
                COALESCE(pf.paid, 0) AS paid_amount
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid
                    FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         ${whereSql}
         ORDER BY f.datef DESC, f.rowid DESC
         LIMIT ? OFFSET ?`, [...params, limit, offset]
      );

      // KPIs globaux (sur l'ensemble du filtre, hors pagination)
      const [[kpis]] = await dolibarrPool.query(
        `SELECT
           SUM(CASE WHEN f.fk_statut = 0 THEN 1 ELSE 0 END) AS nb_draft,
           SUM(CASE WHEN f.fk_statut = 1 AND f.paye = 0 THEN 1 ELSE 0 END) AS nb_unpaid,
           SUM(CASE WHEN f.fk_statut = 1 AND f.paye = 0 THEN f.total_ttc - COALESCE(pf.paid, 0) ELSE 0 END) AS unpaid_amount,
           SUM(CASE WHEN f.fk_statut = 0 THEN f.total_ttc ELSE 0 END) AS draft_amount
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid
                    FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         ${whereSql}`, params
      );

      res.json({
        invoices: rows.map(r => ({
          id: r.id,
          ref: r.ref,
          date: r.datef,
          date_due: r.date_lim_reglement,
          customer_id: r.fk_soc,
          customer_name: r.customer_name || '—',
          status: r.fk_statut,
          status_label: INVOICE_STATUS_LABELS[r.fk_statut] || '?',
          paid: !!r.paye,
          type: r.type,
          source: r.module_source || 'direct',
          total_ht: Number(r.total_ht),
          total_tva: Number(r.total_tva),
          total_ttc: Number(r.total_ttc),
          paid_amount: Number(r.paid_amount),
          remaining: Number(r.total_ttc) - Number(r.paid_amount),
        })),
        total: Number(total),
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
        kpis: {
          nb_draft: Number(kpis.nb_draft || 0),
          nb_unpaid: Number(kpis.nb_unpaid || 0),
          unpaid_amount: Number(kpis.unpaid_amount || 0),
          draft_amount: Number(kpis.draft_amount || 0),
        },
      });
    } catch (err) {
      console.error('[INVOICES] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement factures' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // AUDIT LOG GLOBAL — vue transversale de toutes les régularisations
  // ═══════════════════════════════════════════════════════════
  router.get('/audit-log', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.action)  { where.push('action = ?'); params.push(req.query.action); }
      if (req.query.user_id) { where.push('user_id = ?'); params.push(parseInt(req.query.user_id)); }
      if (req.query.user_role) { where.push('user_role = ?'); params.push(req.query.user_role); }
      if (req.query.ref_facture) { where.push('ref_facture LIKE ?'); params.push(`%${req.query.ref_facture}%`); }
      if (req.query.date_from) { where.push("date(created_at) >= date(?)"); params.push(req.query.date_from); }
      if (req.query.date_to)   { where.push("date(created_at) <= date(?)"); params.push(req.query.date_to); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM invoice_audit_log ${whereSql}`).get(...params).n;
      const rows = db.prepare(`
        SELECT id, fk_facture, ref_facture, action, reason, user_id, user_name, user_role,
               before_snapshot, after_snapshot, created_at
        FROM invoice_audit_log ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);

      res.json({
        entries: rows.map(r => ({
          ...r,
          before_snapshot: r.before_snapshot ? safeParse(r.before_snapshot) : null,
          after_snapshot:  r.after_snapshot  ? safeParse(r.after_snapshot)  : null,
        })),
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (err) {
      console.error('[INVOICES] audit-log error:', err.message);
      res.status(500).json({ error: 'Erreur chargement audit log' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RAPPORT JOURNALIER / MENSUEL
  // Renvoie toutes les factures de la période + le détail des paiements
  // (par méthode) sans pagination — destiné à la génération PDF / Excel.
  // ═══════════════════════════════════════════════════════════
  router.get('/report', auth, async (req, res) => {
    try {
      const dateFrom = String(req.query.date_from || '').trim();
      const dateTo   = String(req.query.date_to || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        return res.status(400).json({ error: 'date_from / date_to requis (YYYY-MM-DD)' });
      }

      // 1. Toutes les factures de la période (pas de pagination, garde-fou 5 000 lignes).
      const [invoiceRows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref,
                DATE_FORMAT(f.datef, '%Y-%m-%d') AS datef,
                f.fk_soc, s.nom AS customer_name,
                f.fk_statut, f.paye, f.type, f.module_source,
                f.total_ht, f.total_tva, f.total_ttc,
                COALESCE(pf.paid, 0) AS paid_amount
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid
                    FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         WHERE f.datef >= ? AND f.datef <= ?
         ORDER BY f.datef ASC, f.rowid ASC
         LIMIT 5000`, [dateFrom, dateTo]
      );

      // 2. Tous les paiements imputés sur ces factures (en une seule requête).
      const ids = invoiceRows.map(r => r.id);
      let paymentRows = [];
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await dolibarrPool.query(
          `SELECT pf.fk_facture, pf.amount,
                  cp.code AS method_code, cp.libelle AS method_label,
                  p.datep
           FROM llx_paiement_facture pf
           JOIN llx_paiement p ON p.rowid = pf.fk_paiement
           LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
           WHERE pf.fk_facture IN (${placeholders})`,
          ids
        );
        paymentRows = rows;
      }

      // 3. Index paiements par facture + cumul par méthode (sur la période).
      const paymentsByInvoice = new Map();
      const totalsByMethod = new Map();
      for (const p of paymentRows) {
        const code = p.method_code || 'AUTRE';
        const label = PAYMENT_METHOD_LABELS[code] || p.method_label || code;
        const amount = Number(p.amount) || 0;
        if (!paymentsByInvoice.has(p.fk_facture)) paymentsByInvoice.set(p.fk_facture, []);
        paymentsByInvoice.get(p.fk_facture).push({ code, label, amount });
        const agg = totalsByMethod.get(code) || { code, label, total: 0, count: 0 };
        agg.total += amount;
        agg.count += 1;
        totalsByMethod.set(code, agg);
      }

      const invoices = invoiceRows.map(r => ({
        id: r.id,
        ref: r.ref,
        date: r.datef,
        customer_id: r.fk_soc,
        customer_name: r.customer_name || '—',
        status: r.fk_statut,
        status_label: INVOICE_STATUS_LABELS[r.fk_statut] || '?',
        paid: !!r.paye,
        type: r.type,
        source: r.module_source || 'direct',
        total_ht: Number(r.total_ht),
        total_tva: Number(r.total_tva),
        total_ttc: Number(r.total_ttc),
        paid_amount: Number(r.paid_amount),
        remaining: Number(r.total_ttc) - Number(r.paid_amount),
        payments: paymentsByInvoice.get(r.id) || [],
      }));

      const payments_by_method = Array.from(totalsByMethod.values())
        .sort((a, b) => b.total - a.total);

      res.json({
        date_from: dateFrom,
        date_to: dateTo,
        invoices,
        payments_by_method,
      });
    } catch (err) {
      console.error('[INVOICES] report error:', err.message);
      res.status(500).json({ error: 'Erreur génération du rapport' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RESSOURCES — comptes bancaires, recherche clients
  // (DÉCLARÉES AVANT /:id pour qu'Express ne les confonde pas avec un id)
  // ═══════════════════════════════════════════════════════════
  router.get('/banks', auth, async (req, res) => {
    try {
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, currency_code
         FROM llx_bank_account WHERE clos = 0 ORDER BY label ASC`
      );
      res.json({ accounts: rows });
    } catch (err) {
      console.error('[INVOICES] banks error:', err.message);
      res.status(500).json({ error: 'Erreur chargement comptes' });
    }
  });

  router.get('/customers/search', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ customers: [] });
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, code_client, email, town
         FROM llx_societe
         WHERE (client = 1 OR client = 3) AND status = 1
           AND (nom LIKE ? OR code_client LIKE ? OR email LIKE ?)
         ORDER BY nom ASC LIMIT 20`,
        [`%${q}%`, `%${q}%`, `%${q}%`]
      );
      res.json({ customers: rows });
    } catch (err) {
      console.error('[INVOICES] customers search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche client' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL FACTURE — header + lignes + paiements + audit local
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [[invoice]] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref,
                DATE_FORMAT(f.datef, '%Y-%m-%d') AS datef,
                DATE_FORMAT(f.date_lim_reglement, '%Y-%m-%d') AS date_lim_reglement,
                f.fk_soc, s.nom AS customer_name, s.code_client,
                f.fk_statut, f.paye, f.type, f.fk_facture_source,
                f.module_source, f.total_ht, f.total_tva, f.total_ttc,
                f.note_private, f.note_public
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.rowid = ?`, [id]
      );
      if (!invoice) return res.status(404).json({ error: 'Facture introuvable' });

      const [lines] = await dolibarrPool.query(
        `SELECT fd.rowid AS id, fd.fk_product, p.ref AS product_ref, p.label AS product_label,
                fd.description, fd.qty, fd.subprice, fd.remise_percent,
                fd.tva_tx, fd.total_ht, fd.total_tva, fd.total_ttc
         FROM llx_facturedet fd
         LEFT JOIN llx_product p ON p.rowid = fd.fk_product
         WHERE fd.fk_facture = ?
         ORDER BY fd.rang ASC, fd.rowid ASC`, [id]
      );

      const [payments] = await dolibarrPool.query(
        `SELECT pf.fk_paiement, pf.amount,
                DATE_FORMAT(p.datep, '%Y-%m-%d') AS datep,
                p.num_paiement,
                cp.code AS method_code, cp.libelle AS method_label,
                ba.label AS bank_label
         FROM llx_paiement_facture pf
         JOIN llx_paiement p ON p.rowid = pf.fk_paiement
         LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         LEFT JOIN llx_bank_url bu ON bu.url_id = p.rowid AND bu.type = 'payment'
         LEFT JOIN llx_bank b ON b.rowid = bu.fk_bank
         LEFT JOIN llx_bank_account ba ON ba.rowid = b.fk_account
         WHERE pf.fk_facture = ?
         ORDER BY p.datep DESC`, [id]
      );

      const auditRows = db.prepare(`
        SELECT id, action, reason, user_name, user_role, created_at, before_snapshot, after_snapshot
        FROM invoice_audit_log WHERE fk_facture = ? ORDER BY created_at DESC, id DESC
      `).all(id);

      res.json({
        invoice: {
          ...invoice,
          status_label: INVOICE_STATUS_LABELS[invoice.fk_statut] || '?',
          paid_amount: payments.reduce((s, p) => s + Number(p.amount), 0),
          source: invoice.module_source || 'direct',
        },
        lines: lines.map(l => ({
          ...l,
          qty: Number(l.qty), subprice: Number(l.subprice),
          remise_percent: Number(l.remise_percent),
          total_ht: Number(l.total_ht), total_ttc: Number(l.total_ttc),
        })),
        payments: payments.map(p => ({
          ...p, amount: Number(p.amount),
          method_label: PAYMENT_METHOD_LABELS[p.method_code] || p.method_label || p.method_code,
        })),
        audit: auditRows.map(r => ({
          ...r,
          before_snapshot: r.before_snapshot ? safeParse(r.before_snapshot) : null,
          after_snapshot:  r.after_snapshot  ? safeParse(r.after_snapshot)  : null,
        })),
      });
    } catch (err) {
      console.error('[INVOICES] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement facture' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PDF — génère et stream le PDF via endpoint PHP custom Dolibarr
  // (l'API REST /invoices/:id/builddoc renvoie 404 en v21)
  // ═══════════════════════════════════════════════════════════
  router.get('/:id/pdf', auth, async (req, res) => {
    const invoiceId = parseInt(req.params.id);
    if (!invoiceId) return res.status(400).json({ error: 'Id invalide' });
    if (!DOLIBARR_WEBHOOK_SECRET) {
      return res.status(500).json({ error: 'DOLIBARR_WEBHOOK_SECRET non configuré' });
    }
    try {
      const phpRes = await axios.post(
        DOC_BUILDDOC_URL,
        { type: 'invoice', id: invoiceId },
        {
          headers: { 'X-Dolibarr-Secret': DOLIBARR_WEBHOOK_SECRET, 'Content-Type': 'application/json' },
          responseType: 'arraybuffer',
          timeout: 30000,
          validateStatus: () => true,
        }
      );
      const contentType = phpRes.headers['content-type'] || '';
      if (phpRes.status >= 200 && phpRes.status < 300 && contentType.includes('application/pdf')) {
        res.set('Content-Type', 'application/pdf');
        res.set('Content-Disposition', `inline; filename="invoice-${invoiceId}.pdf"`);
        return res.send(Buffer.from(phpRes.data));
      }
      // Erreur côté PHP : décoder le JSON
      let detail = 'Erreur génération PDF';
      try {
        const json = JSON.parse(Buffer.from(phpRes.data).toString());
        detail = json.error || detail;
        console.warn('[INVOICES /pdf] php endpoint error:', json);
      } catch { void 0; }
      return res.status(phpRes.status || 500).json({ error: detail });
    } catch (err) {
      console.error('[INVOICES /pdf] exception:', err.message);
      res.status(500).json({ error: 'Erreur téléchargement PDF', detail: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PAY — encaissement manuel d'une facture impayée
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/pay', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    const amountRaw = Number(req.body?.amount);
    const method = String(req.body?.method || '').toUpperCase();
    const bankAccount = parseInt(req.body?.bank_account);
    const datepRaw = req.body?.date || new Date().toISOString().split('T')[0];
    const datepUnix = Math.floor(new Date(`${datepRaw}T12:00:00Z`).getTime() / 1000);
    const numPayment = String(req.body?.num_payment || '').slice(0, 64);

    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });
    if (!PAYMENT_METHODS_ALLOWED.has(method)) return res.status(400).json({ error: 'Méthode de paiement invalide', received: req.body?.method });
    if (!bankAccount) return res.status(400).json({ error: 'Compte bancaire requis', received: req.body?.bank_account });
    if (!(amountRaw > 0)) return res.status(400).json({ error: 'Montant invalide', received: req.body?.amount });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut < 1) return res.status(409).json({ error: 'La facture doit être validée pour être payée' });
      if (before.paye === 1) return res.status(409).json({ error: 'Facture déjà soldée' });
      if (before.type === 2)   return res.status(409).json({ error: 'Un avoir ne se paye pas (utilisez un remboursement)' });

      const { paid: alreadyPaid } = await sumPayments(dolibarrPool, id);
      const remaining = Number(before.total_ttc) - alreadyPaid;
      if (amountRaw > remaining + 0.01) {
        return res.status(400).json({ error: `Montant supérieur au reste à payer (${remaining})` });
      }

      const paymentId = await resolvePaymentId(dolibarrPool, method);
      if (!paymentId) return res.status(400).json({ error: `Code paiement inconnu dans Dolibarr`, received: method });

      // Création du paiement via API Dolibarr (gère llx_paiement + llx_paiement_facture + llx_bank)
      const payRes = await adminApi.post(`/invoices/${id}/payments`, {
        datepaye: datepUnix,
        paymentid: paymentId,
        closepaidinvoices: 'yes',
        accountid: bankAccount,
        num_payment: numPayment || undefined,
        comment: `Régularisation libraire — ${reason}`,
      });

      // Si paiement couvre tout, marquer la facture soldée (au cas où l'API
      // n'aurait pas posé paye=1 automatiquement).
      if (Math.abs(remaining - amountRaw) < 0.01) {
        try { await adminApi.post(`/invoices/${id}/settopaid`); } catch (e) { void e; }
      }

      const after = await loadInvoiceRow(dolibarrPool, id);
      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'pay', reason,
        before: { fk_statut: before.fk_statut, paye: before.paye, paid_before: alreadyPaid },
        after:  { fk_statut: after?.fk_statut, paye: after?.paye, amount: amountRaw, method, bank_account: bankAccount, payment_id: payRes.data },
      });
      res.json({ success: true, payment_id: payRes.data });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] pay error:', msg);
      res.status(500).json({ error: 'Erreur enregistrement paiement', detail: msg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CREDIT NOTE — création d'un avoir total
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/credit-note', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut < 1) return res.status(409).json({ error: 'La facture doit être validée pour créer un avoir' });
      if (before.type === 2) return res.status(409).json({ error: 'Impossible de créer un avoir d\'un avoir' });

      // Récupérer lignes d'origine via SQL pour avoir prix/remise exacts
      const [lines] = await dolibarrPool.query(
        `SELECT fk_product, qty, subprice, remise_percent, tva_tx, product_type, description
         FROM llx_facturedet WHERE fk_facture = ?`, [id]
      );
      if (!lines.length) return res.status(409).json({ error: 'Facture sans lignes — avoir impossible' });

      const today = new Date().toISOString().split('T')[0];
      const creditRes = await adminApi.post('/invoices', {
        socid: parseInt(before.fk_soc),
        date: today,
        type: 2,
        fk_facture_source: id,
        lines: lines.map(l => ({
          fk_product: l.fk_product ? parseInt(l.fk_product) : undefined,
          qty: parseFloat(l.qty),
          subprice: parseFloat(l.subprice),
          remise_percent: parseFloat(l.remise_percent) || 0,
          tva_tx: parseFloat(l.tva_tx) || 0,
          product_type: parseInt(l.product_type) || 0,
          description: l.description || undefined,
        })),
        note_private: `AVOIR régularisation libraire — facture ${before.ref} — ${reason}`,
      });
      const creditId = creditRes.data;
      await adminApi.post(`/invoices/${creditId}/validate`);

      const creditDetail = await adminApi.get(`/invoices/${creditId}`);
      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'credit_note', reason,
        before: { fk_statut: before.fk_statut, paye: before.paye, total_ttc: Number(before.total_ttc) },
        after:  { credit_invoice_id: creditId, credit_invoice_ref: creditDetail.data.ref, credit_total_ttc: Number(creditDetail.data.total_ttc) },
      });
      res.json({ success: true, credit_invoice_id: creditId, credit_invoice_ref: creditDetail.data.ref });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] credit-note error:', msg);
      res.status(500).json({ error: 'Erreur création avoir', detail: msg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SETTODRAFT — repasser une facture validée non payée en brouillon
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/settodraft', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut !== 1) return res.status(409).json({ error: 'Seule une facture validée peut repasser en brouillon' });
      if (before.paye === 1) return res.status(409).json({ error: 'Facture déjà payée — création d\'un avoir requise' });
      const { paid, nb } = await sumPayments(dolibarrPool, id);
      if (nb > 0 || paid > 0) return res.status(409).json({ error: 'Facture avec paiement(s) imputé(s) — annulation impossible' });

      await adminApi.post(`/invoices/${id}/settodraft`);
      const after = await loadInvoiceRow(dolibarrPool, id);

      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'settodraft', reason,
        before: { fk_statut: before.fk_statut },
        after:  { fk_statut: after?.fk_statut },
      });
      res.json({ success: true });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] settodraft error:', msg);
      res.status(500).json({ error: 'Erreur repasser en brouillon', detail: msg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // UPDATE LINES — éditer les lignes d'un brouillon
  // ═══════════════════════════════════════════════════════════
  router.put('/:id/lines', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });
    if (!lines || !lines.length) return res.status(400).json({ error: 'Lignes requises' });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut !== 0) return res.status(409).json({ error: 'Édition possible uniquement en brouillon' });

      // Récupération des lignes actuelles pour snapshot
      const [beforeLines] = await dolibarrPool.query(
        `SELECT rowid, fk_product, qty, subprice, remise_percent, total_ttc
         FROM llx_facturedet WHERE fk_facture = ?`, [id]
      );

      // Stratégie : on supprime puis on recrée les lignes via l'API Dolibarr.
      const existing = await adminApi.get(`/invoices/${id}`);
      for (const l of (existing.data.lines || [])) {
        await adminApi.delete(`/invoices/${id}/lines/${l.id || l.rowid}`);
      }
      const newLines = [];
      for (const l of lines) {
        const payload = {
          qty: parseFloat(l.qty),
          subprice: parseFloat(l.subprice),
          remise_percent: parseFloat(l.remise_percent) || 0,
          tva_tx: parseFloat(l.tva_tx) || 0,
          product_type: parseInt(l.product_type) || 0,
        };
        if (l.fk_product) payload.fk_product = parseInt(l.fk_product);
        if (l.description) payload.desc = l.description;
        const r = await adminApi.post(`/invoices/${id}/lines`, payload);
        newLines.push({ ...payload, line_id: r.data });
      }

      const after = await loadInvoiceRow(dolibarrPool, id);
      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'edit_lines', reason,
        before: { lines: beforeLines.map(l => ({ ...l, qty: Number(l.qty), subprice: Number(l.subprice), total_ttc: Number(l.total_ttc) })) },
        after:  { lines: newLines, total_ttc: Number(after?.total_ttc) },
      });
      res.json({ success: true });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] edit lines error:', msg);
      res.status(500).json({ error: 'Erreur édition lignes', detail: msg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CHANGE CUSTOMER — réassigner fk_soc d'un brouillon
  // ═══════════════════════════════════════════════════════════
  router.put('/:id/customer', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    const newSocId = parseInt(req.body?.socid);
    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });
    if (!newSocId) return res.status(400).json({ error: 'Nouveau client requis' });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut !== 0) return res.status(409).json({ error: 'Réassignation possible uniquement en brouillon' });

      const [[customer]] = await dolibarrPool.query(
        'SELECT rowid, nom FROM llx_societe WHERE rowid = ? AND (client = 1 OR client = 3)', [newSocId]
      );
      if (!customer) return res.status(404).json({ error: 'Client introuvable ou non actif' });

      // L'API Dolibarr PUT /invoices/{id} accepte socid
      await adminApi.put(`/invoices/${id}`, { socid: newSocId });

      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'reassign_customer', reason,
        before: { fk_soc: before.fk_soc },
        after:  { fk_soc: newSocId, customer_name: customer.nom },
      });
      res.json({ success: true });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] reassign error:', msg);
      res.status(500).json({ error: 'Erreur réassignation client', detail: msg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DELETE — suppression d'un brouillon orphelin
  // ═══════════════════════════════════════════════════════════
  router.delete('/:id', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut !== 0) return res.status(409).json({ error: 'Suppression possible uniquement sur brouillon' });
      const { paid, nb } = await sumPayments(dolibarrPool, id);
      if (nb > 0 || paid > 0) return res.status(409).json({ error: 'Brouillon avec paiement(s) — suppression refusée' });

      await adminApi.delete(`/invoices/${id}`);

      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'delete', reason,
        before: { fk_statut: before.fk_statut, total_ttc: Number(before.total_ttc), fk_soc: before.fk_soc },
        after:  null,
      });
      res.json({ success: true });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] delete error:', msg);
      res.status(500).json({ error: 'Erreur suppression facture', detail: msg });
    }
  });

  return router;
}

// ─── INTERNAL HELPERS ────────────────────────────────────────

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Dolibarr v21 exige un id entier pour paymentid ; on résout dynamiquement
// le code (LIQ/CB/CHQ/WAVE/OM/VIR) en id via llx_c_paiement, avec un cache mémoire.
const paymentIdCache = new Map();
async function resolvePaymentId(pool, code) {
  if (paymentIdCache.has(code)) return paymentIdCache.get(code);
  const [rows] = await pool.query(
    `SELECT id FROM llx_c_paiement WHERE code = ? LIMIT 1`, [code]
  );
  const id = rows[0]?.id ? Number(rows[0].id) : null;
  if (id) paymentIdCache.set(code, id);
  return id;
}
