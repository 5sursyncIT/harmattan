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
import { recordInvoicePayment } from './dolibarr-payments.js';
import { logManuscriptEvent } from './manuscript-workflow.js';

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
  // RAPPORT JOURNALIER / MENSUEL — double vue
  //   • « Factures émises »   → filtrées par DATE DE FACTURE (f.datef)
  //   • « Encaissements »     → filtrés par DATE DE PAIEMENT (p.datep)
  // Les deux sont indépendants : un impayé émis hier mais réglé aujourd'hui
  // apparaît dans les encaissements d'aujourd'hui (et non dans ceux d'hier).
  // Le cumul par mode de paiement = encaisse réelle de la période (datep).
  // Sans pagination — destiné à la génération PDF / Excel.
  // ═══════════════════════════════════════════════════════════
  router.get('/report', auth, async (req, res) => {
    try {
      const dateFrom = String(req.query.date_from || '').trim();
      const dateTo   = String(req.query.date_to || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        return res.status(400).json({ error: 'date_from / date_to requis (YYYY-MM-DD)' });
      }

      // 1. Factures ÉMISES sur la période (date de facture). Garde-fou 5 000 lignes.
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

      // 2. Paiements imputés sur ces factures émises — colonne « modes » de la
      //    liste (contexte all-time de la facture, pas un total de période).
      const ids = invoiceRows.map(r => r.id);
      const paymentsByInvoice = new Map();
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await dolibarrPool.query(
          `SELECT pf.fk_facture, pf.amount,
                  cp.code AS method_code, cp.libelle AS method_label
           FROM llx_paiement_facture pf
           JOIN llx_paiement p ON p.rowid = pf.fk_paiement
           LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
           WHERE pf.fk_facture IN (${placeholders})`,
          ids
        );
        for (const p of rows) {
          const code = p.method_code || 'AUTRE';
          const label = PAYMENT_METHOD_LABELS[code] || p.method_label || code;
          if (!paymentsByInvoice.has(p.fk_facture)) paymentsByInvoice.set(p.fk_facture, []);
          paymentsByInvoice.get(p.fk_facture).push({ code, label, amount: Number(p.amount) || 0 });
        }
      }

      // 3. ENCAISSEMENTS reçus sur la période (date de PAIEMENT, p.datep).
      //    Indépendant de la date d'émission : capte les impayés réglés plus tard.
      //    DATE(p.datep) car datep est un datetime ; bornes incluses.
      const [paymentRows] = await dolibarrPool.query(
        `SELECT pf.fk_facture AS invoice_id, pf.amount,
                DATE_FORMAT(p.datep, '%Y-%m-%d') AS datep,
                f.ref AS invoice_ref,
                DATE_FORMAT(f.datef, '%Y-%m-%d') AS invoice_date,
                f.type AS invoice_type,
                f.fk_soc, s.nom AS customer_name,
                cp.code AS method_code, cp.libelle AS method_label
         FROM llx_paiement p
         JOIN llx_paiement_facture pf ON pf.fk_paiement = p.rowid
         JOIN llx_facture f ON f.rowid = pf.fk_facture
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         WHERE DATE(p.datep) >= ? AND DATE(p.datep) <= ?
         ORDER BY p.datep ASC, p.rowid ASC
         LIMIT 5000`, [dateFrom, dateTo]
      );

      // Cumul par méthode sur la base des encaissements (datep).
      const totalsByMethod = new Map();
      const encaissements = paymentRows.map(p => {
        const code = p.method_code || 'AUTRE';
        const label = PAYMENT_METHOD_LABELS[code] || p.method_label || code;
        const amount = Number(p.amount) || 0;
        const agg = totalsByMethod.get(code) || { code, label, total: 0, count: 0 };
        agg.total += amount;
        agg.count += 1;
        totalsByMethod.set(code, agg);
        return {
          invoice_id: p.invoice_id,
          invoice_ref: p.invoice_ref,
          invoice_date: p.invoice_date,
          invoice_type: p.invoice_type,
          customer_id: p.fk_soc,
          customer_name: p.customer_name || '—',
          method_code: code,
          method_label: label,
          amount,
          date: p.datep,
        };
      });

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
      const total_encaisse = payments_by_method.reduce((s, m) => s + m.total, 0);

      res.json({
        date_from: dateFrom,
        date_to: dateTo,
        invoices,            // factures émises (datef)
        encaissements,       // règlements reçus (datep)
        payments_by_method,  // cumul par mode, base encaissements (datep)
        total_encaisse,
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

      // Acomptes / avoirs imputés SUR cette facture (réduisent le reste à payer,
      // comme dans getListOfPayments() de Dolibarr). Source type : 3=acompte, 2=avoir.
      const [creditsApplied] = await dolibarrPool.query(
        `SELECT re.rowid, re.amount_ttc, re.description,
                DATE_FORMAT(re.datec, '%Y-%m-%d') AS datec,
                fs.ref AS source_ref, fs.type AS source_type
         FROM llx_societe_remise_except re
         LEFT JOIN llx_facture fs ON fs.rowid = re.fk_facture_source
         WHERE re.fk_facture = ?
         ORDER BY re.datec ASC, re.rowid ASC`, [id]
      );

      const auditRows = db.prepare(`
        SELECT id, action, reason, user_name, user_role, created_at, before_snapshot, after_snapshot
        FROM invoice_audit_log WHERE fk_facture = ? ORDER BY created_at DESC, id DESC
      `).all(id);

      // Normalisation des montants.
      const paymentsOut = payments.map(p => ({
        ...p, amount: Number(p.amount),
        method_label: PAYMENT_METHOD_LABELS[p.method_code] || p.method_label || p.method_code,
      }));
      const creditsOut = creditsApplied.map(c => ({
        id: c.rowid,
        amount: Number(c.amount_ttc),
        date: c.datec,
        kind: c.source_type === 3 ? 'deposit' : 'credit_note',
        label: c.source_type === 3 ? 'Acompte imputé' : 'Avoir imputé',
        source_ref: c.source_ref || null,
        description: c.description || null,
      }));

      const totalTtc = Number(invoice.total_ttc);
      const paidPayments = paymentsOut.reduce((s, p) => s + p.amount, 0);
      const paidCredits = creditsOut.reduce((s, c) => s + c.amount, 0);
      const paidAmount = paidPayments + paidCredits;

      // Timeline fusionnée (chronologique) avec reste à payer après chaque opération.
      const events = [
        ...paymentsOut.map(p => ({
          kind: 'payment', date: p.datep, amount: p.amount,
          label: p.method_label, method_code: p.method_code,
          bank_label: p.bank_label || null, num: p.num_paiement || null,
        })),
        ...creditsOut.map(c => ({
          kind: c.kind, date: c.date, amount: c.amount,
          label: c.label, source_ref: c.source_ref, num: null,
        })),
      ].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
      let running = totalTtc;
      const timeline = events.map(e => {
        running = Math.round((running - e.amount) * 100) / 100;
        return { ...e, running_remaining: running };
      });

      res.json({
        invoice: {
          ...invoice,
          status_label: INVOICE_STATUS_LABELS[invoice.fk_statut] || '?',
          paid_amount: paidAmount,
          paid_payments: paidPayments,
          paid_credits: paidCredits,
          remaining: Math.round((totalTtc - paidAmount) * 100) / 100,
          source: invoice.module_source || 'direct',
        },
        lines: lines.map(l => ({
          ...l,
          qty: Number(l.qty), subprice: Number(l.subprice),
          remise_percent: Number(l.remise_percent),
          total_ht: Number(l.total_ht), total_ttc: Number(l.total_ttc),
        })),
        payments: paymentsOut,
        credits_applied: creditsOut,
        timeline,
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
  // PAY — encaissement manuel (mono ou multi-méthode / fractionné)
  // Payload : { reason, bank_account, date, splits:[{method, amount, num_payment?}] }
  // Rétro-compat : { reason, method, amount, bank_account, num_payment } accepté.
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/pay', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    const bankAccount = parseInt(req.body?.bank_account);
    const datepRaw = req.body?.date || new Date().toISOString().split('T')[0];
    const datepUnix = Math.floor(new Date(`${datepRaw}T12:00:00Z`).getTime() / 1000);

    // Normalisation : splits[] sinon repli sur le format mono-méthode historique.
    const splits = normalizeSplits(req.body);

    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });
    if (!bankAccount) return res.status(400).json({ error: 'Compte bancaire requis', received: req.body?.bank_account });
    if (!splits.length) return res.status(400).json({ error: 'Au moins une ligne de paiement requise' });
    for (const s of splits) {
      if (!PAYMENT_METHODS_ALLOWED.has(s.method)) return res.status(400).json({ error: 'Méthode de paiement invalide', received: s.method });
      if (!(s.amount > 0)) return res.status(400).json({ error: 'Montant invalide', received: s.amount });
    }
    const totalSplit = splits.reduce((sum, s) => sum + s.amount, 0);

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut < 1) return res.status(409).json({ error: 'La facture doit être validée pour être payée' });
      if (before.paye === 1) return res.status(409).json({ error: 'Facture déjà soldée' });
      if (before.type === 2)   return res.status(409).json({ error: 'Un avoir ne se paye pas (utilisez un remboursement)' });

      const { paid: alreadyPaid } = await sumPayments(dolibarrPool, id);
      const remaining = Number(before.total_ttc) - alreadyPaid;
      if (totalSplit > remaining + 0.01) {
        return res.status(400).json({ error: `Montant total (${totalSplit}) supérieur au reste à payer (${remaining})` });
      }

      const paymentIds = await recordSplitPayments(dolibarrPool, id, splits, bankAccount, datepUnix, `Régularisation libraire — ${reason}`);

      // Si l'encaissement solde la facture, forcer paye=1 (l'API ne le fait pas toujours).
      if (Math.abs(remaining - totalSplit) < 0.01) {
        try { await adminApi.post(`/invoices/${id}/settopaid`); } catch (e) { void e; }
      }

      const after = await loadInvoiceRow(dolibarrPool, id);
      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'pay', reason,
        before: { fk_statut: before.fk_statut, paye: before.paye, paid_before: alreadyPaid },
        after:  { fk_statut: after?.fk_statut, paye: after?.paye, total_amount: totalSplit, bank_account: bankAccount,
                  splits: splits.map(s => ({ method: s.method, amount: s.amount })), payment_ids: paymentIds },
      });

      // Si cette facture est issue d'un devis de contribution (FICHEFAB) rattaché
      // à un manuscrit, tracer l'encaissement sur la frise — quel que soit le point
      // d'entrée (cette route générale comme la route dédiée /quotes/:id/pay).
      try {
        const q = db.prepare('SELECT contract_id, ref FROM contract_quotes WHERE dolibarr_invoice_id = ?').get(id);
        if (q?.contract_id) {
          const ms = db.prepare('SELECT id FROM manuscripts WHERE contract_id = ?').get(q.contract_id);
          if (ms) {
            const solded = after?.paye === 1 || Math.abs(remaining - totalSplit) < 0.01;
            logManuscriptEvent(db, ms.id, 'quote_paid',
              { role: req.admin?.role || 'admin', id: req.admin?.id, label: req.admin?.username },
              `Devis ${q.ref} — encaissé ${totalSplit.toLocaleString('fr-FR')} FCFA (${solded ? 'soldé' : 'acompte'})`);
          }
        }
      } catch (e) { console.warn('Manuscript event (quote_paid via invoice) warning:', e.message); }

      res.json({ success: true, payment_ids: paymentIds, total: totalSplit });
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
      // idwarehouse:4 (Rayon) → avec STOCK_CALCULATE_ON_BILL=1, valider un avoir
      // (type 2) RÉ-INCRÉMENTE le stock. Sans idwarehouse, Dolibarr ne bouge pas le
      // stock et la vente initiale (qui l'avait décrémenté) n'était jamais restituée.
      await adminApi.post(`/invoices/${creditId}/validate`, { idwarehouse: 4 });

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

  // ═══════════════════════════════════════════════════════════
  // CREDITS DISPONIBLES — acomptes/avoirs non encore imputés d'un client
  // (3 segments → aucune collision avec /:id ni /customers/search)
  // ═══════════════════════════════════════════════════════════
  router.get('/customers/:socid/credits', auth, async (req, res) => {
    try {
      const socid = parseInt(req.params.socid);
      if (!socid) return res.status(400).json({ error: 'Client invalide' });
      const [rows] = await dolibarrPool.query(
        `SELECT re.rowid AS id, re.amount_ttc, re.amount_ht, re.tva_tx, re.description,
                DATE_FORMAT(re.datec, '%Y-%m-%d') AS datec,
                fs.ref AS source_ref, fs.type AS source_type
         FROM llx_societe_remise_except re
         LEFT JOIN llx_facture fs ON fs.rowid = re.fk_facture_source
         WHERE re.fk_soc = ? AND re.discount_type = 0
           AND re.fk_facture IS NULL AND re.fk_invoice_supplier IS NULL
         ORDER BY re.datec DESC, re.rowid DESC`, [socid]
      );
      res.json({
        credits: rows.map(r => ({
          id: r.id,
          amount: Number(r.amount_ttc),
          amount_ht: Number(r.amount_ht),
          tva_tx: Number(r.tva_tx),
          kind: r.source_type === 3 ? 'deposit' : (r.source_type === 2 ? 'credit_note' : 'discount'),
          label: r.source_type === 3 ? 'Acompte' : (r.source_type === 2 ? 'Avoir' : 'Remise'),
          source_ref: r.source_ref || null,
          description: r.description || null,
          date: r.datec,
        })),
      });
    } catch (err) {
      console.error('[INVOICES] credits error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des crédits disponibles' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DEPOSIT — créer une facture d'acompte (type=3), l'encaisser et la
  // convertir en avoir disponible (DEPOSIT), prêt à imputer sur la finale.
  // Body : { socid, amount, tva_tx?, date?, reason, pay?:{ splits, bank_account } }
  // ═══════════════════════════════════════════════════════════
  router.post('/deposit', auth, noCsrf, async (req, res) => {
    const reason = nonEmptyReason(req.body?.reason);
    const socid = parseInt(req.body?.socid);
    const amount = Number(req.body?.amount);
    const tvaTx = Number(req.body?.tva_tx) || 0;
    const dateRaw = req.body?.date || new Date().toISOString().split('T')[0];

    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });
    if (!socid) return res.status(400).json({ error: 'Client requis' });
    if (!(amount > 0)) return res.status(400).json({ error: 'Montant de l\'acompte invalide' });

    try {
      const [[customer]] = await dolibarrPool.query(
        'SELECT rowid, nom FROM llx_societe WHERE rowid = ? AND (client = 1 OR client = 3)', [socid]
      );
      if (!customer) return res.status(404).json({ error: 'Client introuvable ou non actif' });

      // Le montant saisi est le TTC encaissé → subprice HT déduit de la TVA.
      const subpriceHt = Math.round((amount / (1 + tvaTx / 100)) * 100) / 100;

      // 1. Création de la facture d'acompte (type 3).
      const createRes = await adminApi.post('/invoices', {
        socid,
        date: dateRaw,
        type: 3,
        lines: [{
          desc: `Acompte — ${reason}`,
          subprice: subpriceHt,
          qty: 1,
          tva_tx: tvaTx,
          product_type: 0,
        }],
        note_private: `Acompte saisi par ${req.admin.username} — ${reason}`,
      });
      const depositId = createRes.data;

      // 2. Validation.
      await adminApi.post(`/invoices/${depositId}/validate`);

      // 3. Encaissement optionnel (multi-méthode).
      let paymentIds = [];
      const pay = req.body?.pay;
      if (pay && Array.isArray(pay.splits) && pay.splits.length) {
        const bankAccount = parseInt(pay.bank_account);
        if (!bankAccount) return res.status(400).json({ error: 'Compte bancaire requis pour l\'encaissement' });
        const splits = normalizeSplits({ splits: pay.splits });
        for (const s of splits) {
          if (!PAYMENT_METHODS_ALLOWED.has(s.method)) return res.status(400).json({ error: 'Méthode de paiement invalide', received: s.method });
        }
        const datepUnix = Math.floor(new Date(`${dateRaw}T12:00:00Z`).getTime() / 1000);
        paymentIds = await recordSplitPayments(dolibarrPool, depositId, splits, bankAccount, datepUnix, `Encaissement acompte — ${reason}`);
      }

      // 4. Conversion en avoir disponible (DEPOSIT) — idempotent côté Dolibarr.
      await adminApi.post(`/invoices/${depositId}/markAsCreditAvailable`);

      // 5. Récupération de l'id du crédit créé (pour imputation immédiate éventuelle).
      let discountId = null;
      try {
        const disc = await adminApi.get(`/invoices/${depositId}/discount`);
        discountId = disc.data?.id || null;
      } catch (e) { void e; }

      const depositRow = await loadInvoiceRow(dolibarrPool, depositId);
      writeAudit(db, {
        admin: req.admin, fk_facture: depositId, ref_facture: depositRow?.ref,
        action: 'deposit_create', reason,
        before: null,
        after: { socid, customer: customer.nom, amount, tva_tx: tvaTx, payment_ids: paymentIds, discount_id: discountId },
      });

      res.json({ success: true, deposit_id: depositId, deposit_ref: depositRow?.ref, discount_id: discountId, payment_ids: paymentIds });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] deposit error:', msg);
      res.status(err.statusCode || 500).json({ error: 'Erreur création acompte', detail: msg });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // APPLY-CREDIT — imputer un acompte/avoir disponible sur une facture
  // finale (réduit le reste à payer via une ligne de remise négative).
  // Body : { discountid, reason }
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/apply-credit', auth, noCsrf, async (req, res) => {
    const id = parseInt(req.params.id);
    const reason = nonEmptyReason(req.body?.reason);
    const discountId = parseInt(req.body?.discountid);
    if (!reason) return res.status(400).json({ error: 'Motif obligatoire (4-500 caractères)' });
    if (!discountId) return res.status(400).json({ error: 'Crédit à imputer requis' });

    try {
      const before = await loadInvoiceRow(dolibarrPool, id);
      if (!before) return res.status(404).json({ error: 'Facture introuvable' });
      if (before.fk_statut < 1) return res.status(409).json({ error: 'La facture doit être validée pour imputer un crédit' });
      if (before.paye === 1) return res.status(409).json({ error: 'Facture déjà soldée' });
      if (before.type === 2) return res.status(409).json({ error: 'Impossible d\'imputer un crédit sur un avoir' });

      // Le crédit doit appartenir au même client et être disponible (non imputé).
      const [[credit]] = await dolibarrPool.query(
        `SELECT re.rowid, re.fk_soc, re.amount_ttc, re.fk_facture, re.description,
                fs.type AS source_type
         FROM llx_societe_remise_except re
         LEFT JOIN llx_facture fs ON fs.rowid = re.fk_facture_source
         WHERE re.rowid = ?`, [discountId]
      );
      if (!credit) return res.status(404).json({ error: 'Crédit introuvable' });
      if (credit.fk_facture) return res.status(409).json({ error: 'Ce crédit a déjà été imputé' });
      if (Number(credit.fk_soc) !== Number(before.fk_soc)) {
        return res.status(409).json({ error: 'Le crédit appartient à un autre client' });
      }

      // Acompte (DEPOSIT) → ligne de remise (usediscount). Avoir (CREDIT_NOTE) →
      // imputé comme paiement (usecreditnote). On se base sur le type de la source.
      const isCreditNote = credit.source_type === 2 || /CREDIT_NOTE/i.test(credit.description || '');
      const endpoint = isCreditNote
        ? `/invoices/${id}/usecreditnote/${discountId}`
        : `/invoices/${id}/usediscount/${discountId}`;
      await adminApi.post(endpoint);
      const after = await loadInvoiceRow(dolibarrPool, id);

      writeAudit(db, {
        admin: req.admin, fk_facture: id, ref_facture: before.ref,
        action: 'apply_credit', reason,
        before: { fk_statut: before.fk_statut, total_ttc: Number(before.total_ttc) },
        after: { discount_id: discountId, amount: Number(credit.amount_ttc), total_ttc: Number(after?.total_ttc) },
      });
      res.json({ success: true, amount: Number(credit.amount_ttc) });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('[INVOICES] apply-credit error:', msg);
      res.status(500).json({ error: 'Erreur imputation du crédit', detail: msg });
    }
  });

  return router;
}

// ─── INTERNAL HELPERS ────────────────────────────────────────

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// Normalise un corps de requête de paiement vers un tableau de splits
// [{ method, amount, num_payment }]. Accepte le format multi-méthode (splits[])
// comme l'ancien format mono-méthode ({ method, amount, num_payment }).
function normalizeSplits(body) {
  const raw = Array.isArray(body?.splits) && body.splits.length
    ? body.splits
    : [{ method: body?.method, amount: body?.amount, num_payment: body?.num_payment }];
  return raw
    .map(s => ({
      method: String(s?.method || '').toUpperCase(),
      amount: Number(s?.amount),
      num_payment: String(s?.num_payment || '').slice(0, 64),
    }))
    .filter(s => s.method && s.amount > 0);
}

// Enregistre N paiements (un par split / méthode) sur une facture, du montant
// EXACT de chaque split. Passe par recordInvoicePayment (endpoint
// /invoices/paymentsdistributed) : voir dolibarr-payments.js — l'endpoint
// /invoices/{id}/payments IGNORE le montant et impute le reste-à-payer complet,
// d'où le bug de sur-paiement fractionné. On ne solde la facture
// (closepaidinvoices) que sur le dernier split.
async function recordSplitPayments(pool, invoiceId, splits, bankAccount, datepUnix, comment) {
  const ids = [];
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    const paymentId = await resolvePaymentId(pool, s.method);
    if (!paymentId) {
      const err = new Error(`Code paiement inconnu dans Dolibarr : ${s.method}`);
      err.statusCode = 400;
      throw err;
    }
    const id = await recordInvoicePayment(adminApi, {
      invoiceId,
      amount: s.amount,
      paymentId,
      accountId: bankAccount,
      datepaye: datepUnix,
      isLast: i === splits.length - 1,
      numPayment: s.num_payment,
      comment,
    });
    ids.push(id);
  }
  return ids;
}

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
