/**
 * Accounting Routes — Interface comptable simplifiée.
 *
 * Lecture seule sur les données Dolibarr (llx_facture, llx_paiement, llx_bank, llx_contrat).
 * Aucune écriture. Exports CSV en UTF-8 BOM compatible Excel/LibreOffice.
 *
 * Sécurité : monté sur /api/admin/accounting, non whitelist pour editor/support/librarian
 * dans admin-routes.js ROLE_ALLOWED_PATHS → automatiquement bloqué.
 */

import { Router } from 'express';
import { runTransfer, getTransferSummary } from './accounting-engine.js';

// ─── LABELS FRANÇAIS ─────────────────────────────────────────
const PAYMENT_METHOD_LABELS = {
  LIQ: 'Espèces', CB: 'Carte bancaire', CHQ: 'Chèque',
  WAVE: 'Wave', OM: 'Orange Money',
  P1: 'Chèque', P5: 'Virement', P13: 'À la livraison', P16: 'Virement',
  VIR: 'Virement', WEB: 'Paiement web',
};

const INVOICE_STATUS_LABELS = {
  0: 'Brouillon',
  1: 'Validée',
  2: 'Payée',
  3: 'Abandonnée',
};

const CHANNEL_LABELS = {
  takepos: 'POS',
  web: 'E-commerce',
  '': 'Direct',
};

// ─── HELPERS ─────────────────────────────────────────────────

function normalizeIsbn(isbn) {
  return String(isbn || '').replace(/[-\s]/g, '');
}

function escCsv(v) {
  let s = String(v ?? '');
  // Neutralisation de l'injection de formules CSV : une cellule commençant par
  // =, +, -, @, tabulation ou retour chariot peut être interprétée comme une
  // formule par Excel/LibreOffice. On la préfixe d'une apostrophe.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const headerLine = headers.map(h => escCsv(h.label)).join(',');
  const dataLines = rows.map(r => headers.map(h => escCsv(typeof h.get === 'function' ? h.get(r) : r[h.key])).join(','));
  return '\uFEFF' + headerLine + '\n' + dataLines.join('\n');
}

function firstDayOfMonth(date = new Date()) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

function today(date = new Date()) {
  return new Date(date).toISOString().split('T')[0];
}

function parseDateRange(req) {
  const date_from = req.query.date_from || firstDayOfMonth();
  const date_to = req.query.date_to || today();
  return { date_from, date_to };
}

// ─── ROUTER FACTORY ──────────────────────────────────────────

export function createAccountingRouter({ db, dolibarrPool, cache, auth, csrfProtection }) {
  const router = Router();
  const CACHE_TTL = 60; // 1 minute pour les journaux
  const noCsrf = csrfProtection || ((req, res, next) => next());

  // Invalide les caches dépendant des écritures
  function invalidateAccountingCache() {
    cache.set('accounting:dashboard', null, 1);
    cache.set('accounting:treasury', null, 1);
  }

  // Année comptable courante par défaut
  function currentYearRange() {
    const y = new Date().getFullYear();
    return { date_from: `${y}-01-01`, date_to: `${y}-12-31` };
  }

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD COMPTABLE
  // ═══════════════════════════════════════════════════════════

  router.get('/dashboard', auth, async (req, res) => {
    try {
      const cacheKey = 'accounting:dashboard';
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      const firstDay = firstDayOfMonth();
      const todayStr = today();

      // CA mois HT + TVA collectée
      const [[revMtd]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(total_ht), 0) AS ca_ht, COALESCE(SUM(total_ttc), 0) AS ca_ttc,
                COALESCE(SUM(total_tva), 0) AS tva_collected, COUNT(*) AS nb
         FROM llx_facture WHERE fk_statut >= 1 AND datef BETWEEN ? AND ?`,
        [firstDay, todayStr]
      );

      // TVA cumulée année en cours
      const yearStart = `${new Date().getFullYear()}-01-01`;
      const [[vatYtd]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(total_tva), 0) AS collected
         FROM llx_facture WHERE fk_statut >= 1 AND datef BETWEEN ? AND ?`,
        [yearStart, todayStr]
      );

      // Achats fournisseurs du mois (charges) — pour estimer le résultat
      let purchasesMtd = { ht: 0, ttc: 0, tva: 0, nb: 0 };
      try {
        const [[p]] = await dolibarrPool.query(
          `SELECT COALESCE(SUM(total_ht), 0) AS ht, COALESCE(SUM(total_ttc), 0) AS ttc,
                  COALESCE(SUM(total_tva), 0) AS tva, COUNT(*) AS nb
           FROM llx_facture_fourn WHERE fk_statut >= 1 AND datef BETWEEN ? AND ?`,
          [firstDay, todayStr]
        );
        purchasesMtd = { ht: Number(p.ht), ttc: Number(p.ttc), tva: Number(p.tva), nb: Number(p.nb) };
      } catch (e) { /* table peut ne pas exister si module pas activé */ void e; }

      // Encaissements mois
      const [[cashMtd]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS nb
         FROM llx_paiement WHERE datep BETWEEN ? AND ?`,
        [firstDay, todayStr]
      );

      // Créances totales (impayées)
      const [[ar]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(f.total_ttc - COALESCE(pf.paid, 0)), 0) AS outstanding, COUNT(*) AS nb
         FROM llx_facture f
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         WHERE f.fk_statut >= 1 AND f.paye = 0`
      );

      // Trésorerie totale (tous comptes actifs)
      const [[treasury]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(b.amount), 0) AS total, COUNT(DISTINCT ba.rowid) AS nb_accounts
         FROM llx_bank b
         INNER JOIN llx_bank_account ba ON ba.rowid = b.fk_account AND ba.clos = 0`
      );

      // CA 12 mois (pour graphique)
      const [monthly] = await dolibarrPool.query(
        `SELECT DATE_FORMAT(datef, '%Y-%m') AS month, SUM(total_ttc) AS ca
         FROM llx_facture WHERE fk_statut >= 1 AND datef >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         GROUP BY month ORDER BY month ASC`
      );
      const [monthlyPayments] = await dolibarrPool.query(
        `SELECT DATE_FORMAT(datep, '%Y-%m') AS month, SUM(amount) AS total
         FROM llx_paiement WHERE datep >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         GROUP BY month ORDER BY month ASC`
      );
      const paymentsByMonth = new Map(monthlyPayments.map(p => [p.month, Number(p.total)]));
      const monthlySeries = monthly.map(m => ({
        month: m.month,
        ca: Math.round(Number(m.ca)),
        encaissements: Math.round(paymentsByMonth.get(m.month) || 0),
      }));

      // Dernières factures
      const [recentInvoices] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.datef, f.total_ttc, f.paye, s.nom AS customer
         FROM llx_facture f LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.fk_statut >= 1 ORDER BY f.rowid DESC LIMIT 10`
      );

      // Derniers paiements
      const [recentPayments] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.datep, p.amount, cp.code AS method_code
         FROM llx_paiement p LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         ORDER BY p.rowid DESC LIMIT 10`
      );

      const caHt = Math.round(Number(revMtd.ca_ht));
      const purchHt = Math.round(purchasesMtd.ht);
      const result = {
        generated_at: new Date().toISOString(),
        period: { from: firstDay, to: todayStr },
        revenue: { ht: caHt, ttc: Math.round(Number(revMtd.ca_ttc)), count: Number(revMtd.nb) },
        cash_in: { total: Math.round(Number(cashMtd.total)), count: Number(cashMtd.nb) },
        receivables: { outstanding: Math.round(Number(ar.outstanding)), count: Number(ar.nb) },
        treasury: { total: Math.round(Number(treasury.total)), accounts: Number(treasury.nb_accounts) },
        // KPIs enrichis (niveau 1)
        vat: {
          collected_mtd: Math.round(Number(revMtd.tva_collected)),
          deductible_mtd: Math.round(purchasesMtd.tva),
          to_pay_mtd: Math.round(Number(revMtd.tva_collected) - purchasesMtd.tva),
          collected_ytd: Math.round(Number(vatYtd.collected)),
        },
        purchases: { ht: purchHt, ttc: Math.round(purchasesMtd.ttc), count: purchasesMtd.nb },
        result_mtd: { value: caHt - purchHt, label: caHt - purchHt >= 0 ? 'Bénéfice' : 'Perte' },
        monthly_series: monthlySeries,
        recent_invoices: recentInvoices.map(i => ({
          ...i, total_ttc: Number(i.total_ttc), paye: Number(i.paye),
        })),
        recent_payments: recentPayments.map(p => ({
          ...p, amount: Number(p.amount),
          method_label: PAYMENT_METHOD_LABELS[p.method_code] || p.method_code || '—',
        })),
      };

      cache.set(cacheKey, result, CACHE_TTL);
      res.json(result);
    } catch (err) {
      console.error('[ACCOUNTING] Dashboard error:', err.message);
      res.status(500).json({ error: 'Erreur chargement dashboard comptable' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // JOURNAL DES VENTES
  // ═══════════════════════════════════════════════════════════

  router.get('/sales-journal', auth, async (req, res) => {
    try {
      const { date_from, date_to } = parseDateRange(req);
      const { status, channel, customer, page = 1, limit = 50 } = req.query;
      const pageInt = Math.max(1, parseInt(page));
      const limitInt = Math.min(parseInt(limit) || 50, 200);
      const offset = (pageInt - 1) * limitInt;

      let where = 'WHERE f.datef BETWEEN ? AND ?';
      const params = [date_from, date_to];

      if (status !== undefined && status !== '') {
        if (status === 'paye') { where += ' AND f.paye = 1'; }
        else if (status === 'impaye') { where += ' AND f.paye = 0 AND f.fk_statut >= 1'; }
        else { where += ' AND f.fk_statut = ?'; params.push(parseInt(status)); }
      }
      if (channel) { where += ' AND f.module_source = ?'; params.push(channel); }
      if (customer) { where += ' AND s.nom LIKE ?'; params.push(`%${String(customer).replace(/[%_]/g, '')}%`); }

      // Total + totaux globaux
      const [[totals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total_rows,
                COALESCE(SUM(f.total_ht), 0) AS sum_ht,
                COALESCE(SUM(f.total_ttc), 0) AS sum_ttc,
                COALESCE(SUM(COALESCE(pf.paid, 0)), 0) AS sum_paid
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         ${where}`,
        params
      );

      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.datef, f.date_lim_reglement,
                f.total_ht, f.total_tva, f.total_ttc,
                f.fk_statut, f.paye, f.module_source,
                s.rowid AS customer_id, s.nom AS customer_name,
                COALESCE(pf.paid, 0) AS paid_amount
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         ${where}
         ORDER BY f.datef DESC, f.rowid DESC LIMIT ? OFFSET ?`,
        [...params, limitInt, offset]
      );

      res.json({
        invoices: rows.map(r => ({
          id: r.id,
          ref: r.ref,
          date: r.datef,
          date_due: r.date_lim_reglement,
          total_ht: Math.round(Number(r.total_ht)),
          total_tva: Math.round(Number(r.total_tva)),
          total_ttc: Math.round(Number(r.total_ttc)),
          paid: Math.round(Number(r.paid_amount)),
          remaining: Math.round(Number(r.total_ttc) - Number(r.paid_amount)),
          status: Number(r.fk_statut),
          status_label: Number(r.paye) === 1 ? 'Payée' : INVOICE_STATUS_LABELS[r.fk_statut] || '—',
          is_paid: Number(r.paye) === 1,
          customer: r.customer_name,
          customer_id: r.customer_id,
          channel: r.module_source || 'direct',
          channel_label: CHANNEL_LABELS[r.module_source] || 'Direct',
        })),
        totals: {
          sum_ht: Math.round(Number(totals.sum_ht)),
          sum_ttc: Math.round(Number(totals.sum_ttc)),
          sum_paid: Math.round(Number(totals.sum_paid)),
          sum_remaining: Math.round(Number(totals.sum_ttc) - Number(totals.sum_paid)),
        },
        total: Number(totals.total_rows),
        page: pageInt,
        pages: Math.ceil(Number(totals.total_rows) / limitInt),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Sales journal error:', err.message);
      res.status(500).json({ error: 'Erreur journal des ventes' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // JOURNAL DES ENCAISSEMENTS
  // ═══════════════════════════════════════════════════════════

  router.get('/payments-journal', auth, async (req, res) => {
    try {
      const { date_from, date_to } = parseDateRange(req);
      const { method, bank_account, page = 1, limit = 50 } = req.query;
      const pageInt = Math.max(1, parseInt(page));
      const limitInt = Math.min(parseInt(limit) || 50, 200);
      const offset = (pageInt - 1) * limitInt;

      let where = 'WHERE p.datep BETWEEN ? AND ?';
      const params = [date_from, date_to];

      if (method) { where += ' AND cp.code = ?'; params.push(method); }
      if (bank_account) { where += ' AND ba.rowid = ?'; params.push(parseInt(bank_account)); }

      // Total + répartition par méthode
      const [[totalsRow]] = await dolibarrPool.query(
        `SELECT COUNT(DISTINCT p.rowid) AS total_rows, COALESCE(SUM(p.amount), 0) AS sum_total
         FROM llx_paiement p
         LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         LEFT JOIN llx_bank bk ON bk.rowid = p.fk_bank
         LEFT JOIN llx_bank_account ba ON ba.rowid = bk.fk_account
         ${where}`,
        params
      );

      const [byMethod] = await dolibarrPool.query(
        `SELECT cp.code AS method, COUNT(DISTINCT p.rowid) AS nb, SUM(p.amount) AS total
         FROM llx_paiement p
         LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         LEFT JOIN llx_bank bk ON bk.rowid = p.fk_bank
         LEFT JOIN llx_bank_account ba ON ba.rowid = bk.fk_account
         ${where}
         GROUP BY cp.code ORDER BY total DESC`,
        params
      );

      const [rows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.datep, p.amount, p.num_paiement,
                cp.code AS method_code,
                ba.rowid AS bank_id, ba.ref AS bank_ref, ba.label AS bank_label,
                GROUP_CONCAT(DISTINCT CONCAT(f.ref, '|', pf.amount) SEPARATOR ',') AS allocations,
                GROUP_CONCAT(DISTINCT s.nom SEPARATOR ', ') AS customers
         FROM llx_paiement p
         LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         LEFT JOIN llx_bank bk ON bk.rowid = p.fk_bank
         LEFT JOIN llx_bank_account ba ON ba.rowid = bk.fk_account
         LEFT JOIN llx_paiement_facture pf ON pf.fk_paiement = p.rowid
         LEFT JOIN llx_facture f ON f.rowid = pf.fk_facture
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         ${where}
         GROUP BY p.rowid ORDER BY p.datep DESC, p.rowid DESC LIMIT ? OFFSET ?`,
        [...params, limitInt, offset]
      );

      res.json({
        payments: rows.map(r => ({
          id: r.id,
          ref: r.ref,
          date: r.datep,
          amount: Math.round(Number(r.amount)),
          num_payment: r.num_paiement,
          method_code: r.method_code,
          method_label: PAYMENT_METHOD_LABELS[r.method_code] || r.method_code || '—',
          bank_id: r.bank_id,
          bank_label: r.bank_label || r.bank_ref || '—',
          allocations: r.allocations || '',
          customers: r.customers || '',
        })),
        totals: {
          sum_total: Math.round(Number(totalsRow.sum_total)),
          by_method: byMethod.map(m => ({
            method: m.method,
            label: PAYMENT_METHOD_LABELS[m.method] || m.method || '—',
            nb: Number(m.nb),
            total: Math.round(Number(m.total)),
          })),
        },
        total: Number(totalsRow.total_rows),
        page: pageInt,
        pages: Math.ceil(Number(totalsRow.total_rows) / limitInt),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Payments journal error:', err.message);
      res.status(500).json({ error: 'Erreur journal des encaissements' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // BALANCE ÂGÉE (CRÉANCES CLIENTS)
  // ═══════════════════════════════════════════════════════════

  router.get('/receivables', auth, async (req, res) => {
    try {
      const { bucket, customer, group_by = 'invoice', page = 1, limit = 100 } = req.query;
      const pageInt = Math.max(1, parseInt(page));
      const limitInt = Math.min(parseInt(limit) || 100, 500);
      const offset = (pageInt - 1) * limitInt;

      // Buckets agrégés
      const [[buckets]] = await dolibarrPool.query(
        `SELECT
           SUM(CASE WHEN days_overdue <= 0 THEN remaining ELSE 0 END) AS b_current,
           SUM(CASE WHEN days_overdue BETWEEN 1 AND 30 THEN remaining ELSE 0 END) AS b_0_30,
           SUM(CASE WHEN days_overdue BETWEEN 31 AND 60 THEN remaining ELSE 0 END) AS b_30_60,
           SUM(CASE WHEN days_overdue BETWEEN 61 AND 90 THEN remaining ELSE 0 END) AS b_60_90,
           SUM(CASE WHEN days_overdue > 90 THEN remaining ELSE 0 END) AS b_90_plus,
           SUM(remaining) AS total, COUNT(*) AS nb
         FROM (
           SELECT f.rowid, (f.total_ttc - COALESCE(pf.paid, 0)) AS remaining,
                  DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) AS days_overdue
           FROM llx_facture f
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf
             ON pf.fk_facture = f.rowid
           WHERE f.fk_statut >= 1 AND f.paye = 0 AND (f.total_ttc - COALESCE(pf.paid, 0)) > 0
         ) t`
      );

      // Détail
      let where = 'WHERE f.fk_statut >= 1 AND f.paye = 0 AND (f.total_ttc - COALESCE(pf.paid, 0)) > 0';
      const params = [];

      if (bucket) {
        const ranges = {
          current: 'AND DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) <= 0',
          '0_30': 'AND DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) BETWEEN 1 AND 30',
          '30_60': 'AND DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) BETWEEN 31 AND 60',
          '60_90': 'AND DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) BETWEEN 61 AND 90',
          '90_plus': 'AND DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) > 90',
        };
        if (ranges[bucket]) where += ' ' + ranges[bucket];
      }
      if (customer) { where += ' AND s.nom LIKE ?'; params.push(`%${String(customer).replace(/[%_]/g, '')}%`); }

      let rows;
      let totalCount;

      if (group_by === 'customer') {
        const [[countRow]] = await dolibarrPool.query(
          `SELECT COUNT(DISTINCT f.fk_soc) AS total FROM llx_facture f
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf ON pf.fk_facture = f.rowid
           ${where}`, params
        );
        totalCount = Number(countRow.total);

        const [customerRows] = await dolibarrPool.query(
          `SELECT s.rowid AS id, s.nom AS name, s.email, COUNT(f.rowid) AS nb_invoices,
                  SUM(f.total_ttc - COALESCE(pf.paid, 0)) AS total_due,
                  MAX(DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef))) AS max_days_overdue
           FROM llx_facture f
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf ON pf.fk_facture = f.rowid
           ${where}
           GROUP BY s.rowid ORDER BY total_due DESC LIMIT ? OFFSET ?`,
          [...params, limitInt, offset]
        );
        rows = customerRows.map(r => ({
          customer_id: r.id,
          customer: r.name,
          email: r.email,
          nb_invoices: Number(r.nb_invoices),
          total_due: Math.round(Number(r.total_due)),
          max_days_overdue: Number(r.max_days_overdue),
        }));
      } else {
        const [[countRow]] = await dolibarrPool.query(
          `SELECT COUNT(*) AS total FROM llx_facture f
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf ON pf.fk_facture = f.rowid
           ${where}`, params
        );
        totalCount = Number(countRow.total);

        const [invoiceRows] = await dolibarrPool.query(
          `SELECT f.rowid AS id, f.ref, f.datef, f.date_lim_reglement, f.total_ttc,
                  COALESCE(pf.paid, 0) AS paid,
                  (f.total_ttc - COALESCE(pf.paid, 0)) AS remaining,
                  DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) AS days_overdue,
                  s.rowid AS customer_id, s.nom AS customer, s.email
           FROM llx_facture f
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf ON pf.fk_facture = f.rowid
           ${where}
           ORDER BY days_overdue DESC, remaining DESC LIMIT ? OFFSET ?`,
          [...params, limitInt, offset]
        );
        rows = invoiceRows.map(r => ({
          id: r.id,
          ref: r.ref,
          date: r.datef,
          date_due: r.date_lim_reglement,
          total_ttc: Math.round(Number(r.total_ttc)),
          paid: Math.round(Number(r.paid)),
          remaining: Math.round(Number(r.remaining)),
          days_overdue: Number(r.days_overdue),
          customer_id: r.customer_id,
          customer: r.customer,
          email: r.email,
        }));
      }

      res.json({
        buckets: {
          current: Math.round(Number(buckets.b_current || 0)),
          '0_30': Math.round(Number(buckets.b_0_30 || 0)),
          '30_60': Math.round(Number(buckets.b_30_60 || 0)),
          '60_90': Math.round(Number(buckets.b_60_90 || 0)),
          '90_plus': Math.round(Number(buckets.b_90_plus || 0)),
          total: Math.round(Number(buckets.total || 0)),
          nb: Number(buckets.nb || 0),
        },
        rows,
        group_by,
        total: totalCount,
        page: pageInt,
        pages: Math.ceil(totalCount / limitInt),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Receivables error:', err.message);
      res.status(500).json({ error: 'Erreur balance âgée' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TRÉSORERIE MULTI-BANQUE
  // ═══════════════════════════════════════════════════════════

  router.get('/treasury', auth, async (req, res) => {
    try {
      const cacheKey = 'accounting:treasury';
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      // Solde par compte
      const [accounts] = await dolibarrPool.query(
        `SELECT ba.rowid AS id, ba.ref, ba.label, ba.bank, ba.currency_code,
                COALESCE(SUM(b.amount), 0) AS balance,
                MAX(b.datev) AS last_movement, COUNT(b.rowid) AS nb_movements
         FROM llx_bank_account ba
         LEFT JOIN llx_bank b ON b.fk_account = ba.rowid
         WHERE ba.clos = 0
         GROUP BY ba.rowid ORDER BY balance DESC`
      );

      // Flux 30j par compte
      const [flows] = await dolibarrPool.query(
        `SELECT fk_account, DATE(datev) AS d,
                SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS inflow,
                SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS outflow
         FROM llx_bank
         WHERE datev >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
         GROUP BY fk_account, DATE(datev) ORDER BY d ASC`
      );

      // Derniers mouvements (50 par défaut)
      const { account_id } = req.query;
      const whereBank = account_id ? 'WHERE b.fk_account = ?' : '';
      const paramsBank = account_id ? [parseInt(account_id)] : [];
      const [movements] = await dolibarrPool.query(
        `SELECT b.rowid AS id, b.datev, b.amount, b.label, b.num_chq, b.num_releve,
                ba.ref AS bank_ref, ba.label AS bank_label, ba.rowid AS bank_id
         FROM llx_bank b
         JOIN llx_bank_account ba ON ba.rowid = b.fk_account AND ba.clos = 0
         ${whereBank}
         ORDER BY b.datev DESC, b.rowid DESC LIMIT 50`,
        paramsBank
      );

      const totalBalance = accounts.reduce((s, a) => s + Number(a.balance), 0);

      const result = {
        accounts: accounts.map(a => ({
          id: a.id,
          ref: a.ref,
          label: a.label,
          bank: a.bank,
          currency: a.currency_code || 'XOF',
          balance: Math.round(Number(a.balance)),
          last_movement: a.last_movement,
          nb_movements: Number(a.nb_movements),
        })),
        total_balance: Math.round(totalBalance),
        flows_30d: flows.map(f => ({
          account_id: f.fk_account,
          date: f.d,
          inflow: Math.round(Number(f.inflow)),
          outflow: Math.round(Number(f.outflow)),
        })),
        movements: movements.map(m => ({
          id: m.id,
          date: m.datev,
          amount: Math.round(Number(m.amount)),
          label: m.label,
          num_payment: m.num_chq,
          num_statement: m.num_releve,
          bank_id: m.bank_id,
          bank_label: m.bank_label || m.bank_ref || '—',
        })),
      };

      cache.set(cacheKey, result, 120);
      res.json(result);
    } catch (err) {
      console.error('[ACCOUNTING] Treasury error:', err.message);
      res.status(500).json({ error: 'Erreur trésorerie' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ROYALTIES (calcul par contrat actif)
  // ═══════════════════════════════════════════════════════════

  router.get('/royalties', auth, async (req, res) => {
    try {
      const { year = new Date().getFullYear(), month, threshold_mode = 'cumulative', contract_type, author } = req.query;

      // Période
      let date_from, date_to;
      if (month) {
        const m = parseInt(month);
        date_from = `${year}-${String(m).padStart(2, '0')}-01`;
        const endDate = new Date(year, m, 0);
        date_to = endDate.toISOString().split('T')[0];
      } else {
        date_from = `${year}-01-01`;
        date_to = `${year}-12-31`;
      }

      // Liste des contrats actifs avec ISBN
      let whereContract = `WHERE c.statut >= 1 AND ce.book_isbn IS NOT NULL AND ce.book_isbn <> ''`;
      const paramsContract = [];
      if (contract_type) { whereContract += ' AND ce.contract_type = ?'; paramsContract.push(contract_type); }
      if (author) { whereContract += ' AND s.nom LIKE ?'; paramsContract.push(`%${String(author).replace(/[%_]/g, '')}%`); }

      const [contracts] = await dolibarrPool.query(
        `SELECT c.rowid AS contract_id, c.ref, c.statut, c.date_contrat,
                s.rowid AS author_id, s.nom AS author_name, s.email AS author_email,
                ce.book_title, ce.book_isbn, ce.contract_type,
                ce.royalty_rate_print, ce.royalty_rate_digital,
                ce.royalty_threshold, ce.free_author_copies
         FROM llx_contrat c
         JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         JOIN llx_societe s ON s.rowid = c.fk_soc
         ${whereContract}
         ORDER BY s.nom ASC, ce.book_title ASC`,
        paramsContract
      );

      // Calcul pour chaque contrat
      const results = [];
      let contractsWithoutSales = 0;

      for (const c of contracts) {
        const isbnNorm = normalizeIsbn(c.book_isbn);
        if (!isbnNorm) continue;

        // Période de ventes
        let periodClause = 'f.datef BETWEEN ? AND ?';
        let periodParams = [date_from, date_to];

        // Ventes cumulées depuis publication (pour seuil cumulatif)
        let cumulativeUnits = 0;
        if (threshold_mode === 'cumulative') {
          const [[cumRow]] = await dolibarrPool.query(
            `SELECT COALESCE(SUM(fd.qty), 0) AS units
             FROM llx_facturedet fd
             JOIN llx_facture f ON f.rowid = fd.fk_facture
             JOIN llx_product p ON p.rowid = fd.fk_product
             WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
               AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
               AND f.datef <= ?`,
            [isbnNorm, date_to]
          );
          cumulativeUnits = Number(cumRow.units);
        }

        // Ventes sur la période.
        // fd.total_ht > 0 : exclut les exemplaires facturés à 0 F (service de
        // presse, dons) — ils décrémentent le stock mais ne sont pas des ventes,
        // donc ni comptés en unités ni dans l'assiette des royalties.
        const [[periodRow]] = await dolibarrPool.query(
          `SELECT COALESCE(SUM(fd.qty), 0) AS units_sold,
                  COALESCE(SUM(fd.total_ht), 0) AS gross_ht,
                  COUNT(DISTINCT f.rowid) AS invoice_count
           FROM llx_facturedet fd
           JOIN llx_facture f ON f.rowid = fd.fk_facture
           JOIN llx_product p ON p.rowid = fd.fk_product
           WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
             AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
             AND ${periodClause}`,
          [isbnNorm, ...periodParams]
        );

        const unitsSold = Number(periodRow.units_sold);
        const grossHt = Number(periodRow.gross_ht);

        if (unitsSold === 0) { contractsWithoutSales += 1; continue; }

        const threshold = Number(c.royalty_threshold) || 0;
        const freeCopies = Number(c.free_author_copies) || 0;
        const rate = Number(c.royalty_rate_print) || 0;

        // Assiette des royalties = unités VENDUES au-dessus du seuil de versement.
        // IMPORTANT : on NE retranche PAS les exemplaires gratuits (free_author_copies).
        // Ces exemplaires sont remis gratuitement à l'auteur et ne sont jamais facturés
        // (absents de llx_facturedet), donc déjà exclus de `unitsSold`. Les soustraire
        // une seconde fois sous-estimait les droits dus (cf. contrat Art. 4 : « les droits
        // ne portent pas sur les exemplaires remis gratuitement » — exclusion, pas seuil).
        let unitsOver = 0;
        if (threshold_mode === 'cumulative') {
          const cumBefore = cumulativeUnits - unitsSold; // cumulative avant cette période
          if (cumulativeUnits > threshold) {
            if (cumBefore >= threshold) {
              unitsOver = unitsSold;
            } else {
              unitsOver = cumulativeUnits - threshold;
            }
          }
        } else {
          unitsOver = Math.max(0, unitsSold - threshold);
        }

        const avgHtPerUnit = unitsSold > 0 ? grossHt / unitsSold : 0;
        const royaltyBase = unitsOver * avgHtPerUnit;
        const royaltyDue = royaltyBase * (rate / 100);

        results.push({
          contract_id: c.contract_id,
          contract_ref: c.ref,
          author_id: c.author_id,
          author_name: c.author_name,
          author_email: c.author_email,
          book_title: c.book_title,
          book_isbn: c.book_isbn,
          contract_type: c.contract_type,
          royalty_rate: rate,
          threshold,
          free_copies: freeCopies,
          units_sold: unitsSold,
          units_cumulative: cumulativeUnits,
          units_over_threshold: Math.round(unitsOver * 100) / 100,
          gross_ht: Math.round(grossHt),
          avg_ht_per_unit: Math.round(avgHtPerUnit),
          royalty_base: Math.round(royaltyBase),
          royalty_due: Math.round(royaltyDue),
          invoice_count: Number(periodRow.invoice_count),
        });
      }

      // Contrats sans ISBN (avertissement)
      const [[noIsbn]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS nb FROM llx_contrat c
         JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         WHERE c.statut >= 1 AND (ce.book_isbn IS NULL OR ce.book_isbn = '')`
      );

      const totalRoyalties = results.reduce((s, r) => s + r.royalty_due, 0);
      const totalUnits = results.reduce((s, r) => s + r.units_sold, 0);
      const uniqueAuthors = new Set(results.map(r => r.author_id)).size;

      res.json({
        period: { from: date_from, to: date_to, year: parseInt(year), month: month ? parseInt(month) : null },
        threshold_mode,
        summary: {
          nb_contracts: results.length,
          nb_authors: uniqueAuthors,
          nb_contracts_without_sales: contractsWithoutSales,
          nb_contracts_without_isbn: Number(noIsbn.nb),
          total_units_sold: totalUnits,
          total_royalties_due: Math.round(totalRoyalties),
        },
        royalties: results.sort((a, b) => b.royalty_due - a.royalty_due),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Royalties error:', err.message);
      res.status(500).json({ error: 'Erreur calcul royalties' });
    }
  });

  // Détail des ventes pour un contrat (drill-down)
  router.get('/royalties/:contract_id/details', auth, async (req, res) => {
    try {
      const { year = new Date().getFullYear(), month } = req.query;
      let date_from, date_to;
      if (month) {
        const m = parseInt(month);
        date_from = `${year}-${String(m).padStart(2, '0')}-01`;
        date_to = new Date(year, m, 0).toISOString().split('T')[0];
      } else {
        date_from = `${year}-01-01`;
        date_to = `${year}-12-31`;
      }

      const [[contract]] = await dolibarrPool.query(
        `SELECT c.ref, ce.book_title, ce.book_isbn, s.nom AS author
         FROM llx_contrat c
         JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         JOIN llx_societe s ON s.rowid = c.fk_soc
         WHERE c.rowid = ?`, [req.params.contract_id]
      );
      if (!contract) return res.status(404).json({ error: 'Contrat introuvable' });

      const isbnNorm = normalizeIsbn(contract.book_isbn);
      const [invoices] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.datef, s.nom AS customer,
                fd.qty, fd.subprice, fd.total_ht
         FROM llx_facturedet fd
         JOIN llx_facture f ON f.rowid = fd.fk_facture
         JOIN llx_product p ON p.rowid = fd.fk_product
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
           AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
           AND f.datef BETWEEN ? AND ?
         ORDER BY f.datef DESC`,
        [isbnNorm, date_from, date_to]
      );

      res.json({
        contract: { ref: contract.ref, book_title: contract.book_title, author: contract.author },
        period: { from: date_from, to: date_to },
        invoices: invoices.map(i => ({
          id: i.id, ref: i.ref, date: i.datef, customer: i.customer,
          qty: Number(i.qty), subprice: Math.round(Number(i.subprice)),
          total_ht: Math.round(Number(i.total_ht)),
        })),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Royalty details error:', err.message);
      res.status(500).json({ error: 'Erreur détails royalties' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // EXPORTS CSV
  // ═══════════════════════════════════════════════════════════

  router.get('/export/:journal', auth, async (req, res) => {
    try {
      const { journal } = req.params;
      const { date_from = firstDayOfMonth(), date_to = today() } = req.query;

      let csv = '';
      let filename = '';

      if (journal === 'sales') {
        const [rows] = await dolibarrPool.query(
          `SELECT f.ref, f.datef, f.date_lim_reglement, f.total_ht, f.total_tva, f.total_ttc,
                  f.fk_statut, f.paye, f.module_source, s.nom AS customer,
                  COALESCE(pf.paid, 0) AS paid
           FROM llx_facture f
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf ON pf.fk_facture = f.rowid
           WHERE f.datef BETWEEN ? AND ? AND f.fk_statut >= 1
           ORDER BY f.datef DESC, f.rowid DESC`,
          [date_from, date_to]
        );
        csv = toCsv([
          { label: 'Date', get: r => r.datef?.toISOString?.().split('T')[0] || r.datef },
          { label: 'Référence', key: 'ref' },
          { label: 'Client', key: 'customer' },
          { label: 'Canal', get: r => CHANNEL_LABELS[r.module_source] || 'Direct' },
          { label: 'Total HT', get: r => Math.round(Number(r.total_ht)) },
          { label: 'TVA', get: r => Math.round(Number(r.total_tva)) },
          { label: 'Total TTC', get: r => Math.round(Number(r.total_ttc)) },
          { label: 'Encaissé', get: r => Math.round(Number(r.paid)) },
          { label: 'Reste', get: r => Math.round(Number(r.total_ttc) - Number(r.paid)) },
          { label: 'Statut', get: r => Number(r.paye) === 1 ? 'Payée' : INVOICE_STATUS_LABELS[r.fk_statut] || '—' },
          { label: 'Échéance', get: r => r.date_lim_reglement?.toISOString?.().split('T')[0] || r.date_lim_reglement || '' },
        ], rows);
        filename = `ventes-${date_from}-${date_to}.csv`;
      }
      else if (journal === 'payments') {
        const [rows] = await dolibarrPool.query(
          `SELECT p.ref, p.datep, p.amount, p.num_paiement, cp.code AS method,
                  ba.label AS bank_label, ba.ref AS bank_ref,
                  GROUP_CONCAT(DISTINCT f.ref SEPARATOR ';') AS invoices,
                  GROUP_CONCAT(DISTINCT s.nom SEPARATOR ', ') AS customers
           FROM llx_paiement p
           LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
           LEFT JOIN llx_bank bk ON bk.rowid = p.fk_bank
           LEFT JOIN llx_bank_account ba ON ba.rowid = bk.fk_account
           LEFT JOIN llx_paiement_facture pf ON pf.fk_paiement = p.rowid
           LEFT JOIN llx_facture f ON f.rowid = pf.fk_facture
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           WHERE p.datep BETWEEN ? AND ?
           GROUP BY p.rowid ORDER BY p.datep DESC, p.rowid DESC`,
          [date_from, date_to]
        );
        csv = toCsv([
          { label: 'Date', get: r => r.datep?.toISOString?.().split('T')[0] || r.datep },
          { label: 'Référence', key: 'ref' },
          { label: 'N° transaction', get: r => r.num_paiement || '' },
          { label: 'Montant', get: r => Math.round(Number(r.amount)) },
          { label: 'Méthode', get: r => PAYMENT_METHOD_LABELS[r.method] || r.method || '—' },
          { label: 'Banque', get: r => r.bank_label || r.bank_ref || '—' },
          { label: 'Factures imputées', get: r => r.invoices || '' },
          { label: 'Clients', get: r => r.customers || '' },
        ], rows);
        filename = `encaissements-${date_from}-${date_to}.csv`;
      }
      else if (journal === 'receivables') {
        const [rows] = await dolibarrPool.query(
          `SELECT f.ref, f.datef, f.date_lim_reglement, f.total_ttc,
                  COALESCE(pf.paid, 0) AS paid,
                  (f.total_ttc - COALESCE(pf.paid, 0)) AS remaining,
                  DATEDIFF(CURDATE(), COALESCE(f.date_lim_reglement, f.datef)) AS days_overdue,
                  s.nom AS customer, s.email
           FROM llx_facture f
           LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
           LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf ON pf.fk_facture = f.rowid
           WHERE f.fk_statut >= 1 AND f.paye = 0 AND (f.total_ttc - COALESCE(pf.paid, 0)) > 0
           ORDER BY days_overdue DESC, remaining DESC`
        );
        csv = toCsv([
          { label: 'Client', key: 'customer' },
          { label: 'Email', get: r => r.email || '' },
          { label: 'Facture', key: 'ref' },
          { label: 'Date émission', get: r => r.datef?.toISOString?.().split('T')[0] || r.datef },
          { label: 'Date échéance', get: r => r.date_lim_reglement?.toISOString?.().split('T')[0] || r.date_lim_reglement || '' },
          { label: 'Jours retard', get: r => Number(r.days_overdue) },
          { label: 'Total TTC', get: r => Math.round(Number(r.total_ttc)) },
          { label: 'Encaissé', get: r => Math.round(Number(r.paid)) },
          { label: 'Montant dû', get: r => Math.round(Number(r.remaining)) },
        ], rows);
        filename = `balance-agee-${today()}.csv`;
      }
      else if (journal === 'royalties') {
        // Re-calcul via la même logique que /royalties
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = req.query.month ? parseInt(req.query.month) : null;
        const d_from = month ? `${year}-${String(month).padStart(2, '0')}-01` : `${year}-01-01`;
        const d_to = month ? new Date(year, month, 0).toISOString().split('T')[0] : `${year}-12-31`;

        const [contracts] = await dolibarrPool.query(
          `SELECT c.rowid AS contract_id, c.ref, s.nom AS author, s.email,
                  ce.book_title, ce.book_isbn,
                  ce.royalty_rate_print, ce.royalty_threshold, ce.free_author_copies
           FROM llx_contrat c
           JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
           JOIN llx_societe s ON s.rowid = c.fk_soc
           WHERE c.statut >= 1 AND ce.book_isbn IS NOT NULL AND ce.book_isbn <> ''
           ORDER BY s.nom ASC`
        );

        const rows = [];
        for (const c of contracts) {
          const isbnNorm = normalizeIsbn(c.book_isbn);
          const [[sales]] = await dolibarrPool.query(
            `SELECT COALESCE(SUM(fd.qty), 0) AS units, COALESCE(SUM(fd.total_ht), 0) AS gross_ht
             FROM llx_facturedet fd
             JOIN llx_facture f ON f.rowid = fd.fk_facture
             JOIN llx_product p ON p.rowid = fd.fk_product
             WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
               AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
               AND f.datef BETWEEN ? AND ?`,
            [isbnNorm, d_from, d_to]
          );
          const units = Number(sales.units);
          if (units === 0) continue;
          const gross = Number(sales.gross_ht);
          const rate = Number(c.royalty_rate_print) || 0;
          // Pas de soustraction des ex. gratuits : non facturés, déjà hors `units`.
          const unitsOver = Math.max(0, units - Number(c.royalty_threshold || 0));
          const royalty = (gross / units) * unitsOver * (rate / 100);
          rows.push({
            ref: c.ref, author: c.author, email: c.email, book: c.book_title, isbn: c.book_isbn,
            rate, threshold: c.royalty_threshold, free: c.free_author_copies,
            units, unitsOver: Math.round(unitsOver * 100) / 100, gross: Math.round(gross),
            royalty: Math.round(royalty),
          });
        }

        csv = toCsv([
          { label: 'Référence contrat', key: 'ref' },
          { label: 'Auteur', key: 'author' },
          { label: 'Email', key: 'email' },
          { label: 'Ouvrage', key: 'book' },
          { label: 'ISBN', key: 'isbn' },
          { label: 'Taux %', key: 'rate' },
          { label: 'Seuil', key: 'threshold' },
          { label: 'Ex. gratuits', key: 'free' },
          { label: 'Unités vendues', key: 'units' },
          { label: 'Unités > seuil', key: 'unitsOver' },
          { label: 'CA HT', key: 'gross' },
          { label: 'Royalty due', key: 'royalty' },
        ], rows);
        filename = `royalties-${d_from}-${d_to}.csv`;
      }
      else if (journal === 'royalties_od') {
        // Génère un fichier d'écritures de journal OD prêt à importer dans Dolibarr
        // Modèle SYSCOHADA :
        //   DEBIT  6512 (Redevances pour brevets, licences, marques) — charge royalties
        //   CREDIT 401  (Fournisseurs)                              — dette envers l'auteur
        // Une écriture (2 lignes) par contrat avec royalty > 0 sur la période.
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = req.query.month ? parseInt(req.query.month) : null;
        const d_from = month ? `${year}-${String(month).padStart(2, '0')}-01` : `${year}-01-01`;
        const d_to = month ? new Date(year, month, 0).toISOString().split('T')[0] : `${year}-12-31`;
        const docDate = d_to;

        const [contracts] = await dolibarrPool.query(
          `SELECT c.rowid AS contract_id, c.ref, s.rowid AS soc_id, s.nom AS author,
                  s.code_fournisseur, ce.book_title, ce.book_isbn,
                  ce.royalty_rate_print, ce.royalty_threshold, ce.free_author_copies
           FROM llx_contrat c
           JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
           JOIN llx_societe s ON s.rowid = c.fk_soc
           WHERE c.statut >= 1 AND ce.book_isbn IS NOT NULL AND ce.book_isbn <> ''
           ORDER BY s.nom ASC`
        );

        const odRows = [];
        for (const c of contracts) {
          const isbnNorm = normalizeIsbn(c.book_isbn);
          const [[sales]] = await dolibarrPool.query(
            `SELECT COALESCE(SUM(fd.qty), 0) AS units, COALESCE(SUM(fd.total_ht), 0) AS gross_ht
             FROM llx_facturedet fd
             JOIN llx_facture f ON f.rowid = fd.fk_facture
             JOIN llx_product p ON p.rowid = fd.fk_product
             WHERE f.fk_statut >= 1 AND fd.qty > 0 AND fd.total_ht > 0
               AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
               AND f.datef BETWEEN ? AND ?`,
            [isbnNorm, d_from, d_to]
          );
          const units = Number(sales.units);
          if (units === 0) continue;
          const gross = Number(sales.gross_ht);
          const rate = Number(c.royalty_rate_print) || 0;
          // Pas de soustraction des ex. gratuits : non facturés, déjà hors `units`.
          const unitsOver = Math.max(0, units - Number(c.royalty_threshold || 0));
          const royalty = Math.round((gross / units) * unitsOver * (rate / 100));
          if (royalty <= 0) continue;

          const piece = `ROY-${c.ref}-${month ? String(month).padStart(2, '0') : 'AN'}-${year}`;
          const authorSubledger = c.code_fournisseur || `AUT${c.soc_id}`;
          const label = `Royalties ${c.book_title || c.ref} — ${c.author} (${month ? `${String(month).padStart(2, '0')}/` : ''}${year})`;

          // DEBIT charge
          odRows.push({
            doc_date: docDate, code_journal: 'OD', piece_num: piece,
            account_num: '6512', subledger: '', label,
            debit: royalty, credit: 0,
          });
          // CREDIT dette fournisseur (auteur)
          odRows.push({
            doc_date: docDate, code_journal: 'OD', piece_num: piece,
            account_num: '401', subledger: authorSubledger, label,
            debit: 0, credit: royalty,
          });
        }

        csv = toCsv([
          { label: 'Date', key: 'doc_date' },
          { label: 'Code journal', key: 'code_journal' },
          { label: 'Pièce', key: 'piece_num' },
          { label: 'Compte', key: 'account_num' },
          { label: 'Tiers', key: 'subledger' },
          { label: 'Libellé', key: 'label' },
          { label: 'Débit', key: 'debit' },
          { label: 'Crédit', key: 'credit' },
        ], odRows);
        filename = `royalties-OD-${d_from}-${d_to}.csv`;
      }
      else if (journal === 'fec') {
        // Fichier des Écritures Comptables — format normalisé expert-comptable
        const [rows] = await dolibarrPool.query(
          `SELECT piece_num, doc_date, doc_ref, code_journal, journal_label,
                  numero_compte, label_compte, subledger_account, subledger_label,
                  label_operation, debit, credit, lettering_code, date_lettering,
                  date_validated
           FROM llx_accounting_bookkeeping
           WHERE entity = 1 AND doc_date BETWEEN ? AND ?
           ORDER BY piece_num, rowid`,
          [date_from, date_to]
        );
        const fecDate = (d) => d ? (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0].replace(/-/g, '') : '';
        const fecAmt = (v) => String(Math.round(Number(v || 0) * 100) / 100).replace('.', ',');
        const header = ['JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum',
          'CompteLib', 'CompAuxNum', 'CompAuxLib', 'PieceRef', 'PieceDate', 'EcritureLib',
          'Debit', 'Credit', 'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise'];
        const lines = rows.map(r => [
          r.code_journal || 'OD', r.journal_label || '', r.piece_num, fecDate(r.doc_date),
          r.numero_compte, r.label_compte || '', r.subledger_account || '', r.subledger_label || '',
          r.doc_ref || '', fecDate(r.doc_date), (r.label_operation || '').replace(/[\t\n\r]/g, ' '),
          fecAmt(r.debit), fecAmt(r.credit), r.lettering_code || '', fecDate(r.date_lettering),
          fecDate(r.date_validated), '', '',
        ].join('\t'));
        csv = '﻿' + header.join('\t') + '\n' + lines.join('\n');
        filename = `FEC-${date_from}-${date_to}.txt`;
      }
      else if (journal === 'ledger') {
        const [rows] = await dolibarrPool.query(
          `SELECT doc_date, piece_num, code_journal, numero_compte, label_compte,
                  subledger_label, doc_ref, label_operation, debit, credit
           FROM llx_accounting_bookkeeping
           WHERE entity = 1 AND doc_date BETWEEN ? AND ?
           ORDER BY numero_compte, doc_date, piece_num`,
          [date_from, date_to]
        );
        csv = toCsv([
          { label: 'Compte', key: 'numero_compte' },
          { label: 'Libellé compte', key: 'label_compte' },
          { label: 'Date', get: r => r.doc_date?.toISOString?.().split('T')[0] || r.doc_date },
          { label: 'Pièce', key: 'piece_num' },
          { label: 'Journal', key: 'code_journal' },
          { label: 'Référence', key: 'doc_ref' },
          { label: 'Libellé', key: 'label_operation' },
          { label: 'Tiers', key: 'subledger_label' },
          { label: 'Débit', get: r => Math.round(Number(r.debit)) },
          { label: 'Crédit', get: r => Math.round(Number(r.credit)) },
        ], rows);
        filename = `grand-livre-${date_from}-${date_to}.csv`;
      }
      else if (journal === 'balance') {
        const [rows] = await dolibarrPool.query(
          `SELECT numero_compte, label_compte,
                  COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
           FROM llx_accounting_bookkeeping
           WHERE entity = 1 AND doc_date BETWEEN ? AND ?
           GROUP BY numero_compte ORDER BY numero_compte`,
          [date_from, date_to]
        );
        csv = toCsv([
          { label: 'Compte', key: 'numero_compte' },
          { label: 'Libellé', key: 'label_compte' },
          { label: 'Total débit', get: r => Math.round(Number(r.debit)) },
          { label: 'Total crédit', get: r => Math.round(Number(r.credit)) },
          { label: 'Solde débiteur', get: r => Math.max(0, Math.round(Number(r.debit) - Number(r.credit))) },
          { label: 'Solde créditeur', get: r => Math.max(0, Math.round(Number(r.credit) - Number(r.debit))) },
        ], rows);
        filename = `balance-${date_from}-${date_to}.csv`;
      }
      else {
        return res.status(400).json({ error: 'Journal inconnu' });
      }

      // Log activité
      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin.username, `export_accounting_${journal}`, `Export ${journal} ${date_from} → ${date_to}`);
      } catch { /* ignore */ }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      console.error('[ACCOUNTING] Export error:', err.message);
      res.status(500).json({ error: 'Erreur export' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PLAN COMPTABLE (SYSCOHADA)
  // ═══════════════════════════════════════════════════════════

  router.get('/chart-of-accounts', auth, async (req, res) => {
    try {
      const { search, account_class } = req.query;
      let where = 'WHERE entity = 1 AND active = 1';
      const params = [];
      if (account_class) { where += ' AND LEFT(account_number, 1) = ?'; params.push(String(account_class)); }
      if (search) {
        where += ' AND (account_number LIKE ? OR label LIKE ?)';
        const s = `%${String(search).replace(/[%_]/g, '')}%`;
        params.push(s, s);
      }
      const [rows] = await dolibarrPool.query(
        `SELECT account_number, label, LEFT(account_number, 1) AS account_class
         FROM llx_accounting_account ${where}
         ORDER BY account_number LIMIT 2000`,
        params
      );
      const [classes] = await dolibarrPool.query(
        `SELECT LEFT(account_number, 1) AS c, COUNT(*) AS nb
         FROM llx_accounting_account WHERE entity = 1 AND active = 1
         GROUP BY c ORDER BY c`
      );
      const CLASS_NAMES = {
        1: 'Comptes de ressources durables', 2: 'Comptes d\'actif immobilisé',
        3: 'Comptes de stocks', 4: 'Comptes de tiers', 5: 'Comptes de trésorerie',
        6: 'Comptes de charges', 7: 'Comptes de produits', 8: 'Comptes de résultats',
      };
      res.json({
        accounts: rows.map(r => ({ number: r.account_number, label: r.label, class: r.account_class })),
        classes: classes.map(c => ({ id: c.c, name: CLASS_NAMES[c.c] || `Classe ${c.c}`, count: Number(c.nb) })),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Chart of accounts error:', err.message);
      res.status(500).json({ error: 'Erreur plan comptable' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TRANSFERT EN COMPTABILITÉ
  // ═══════════════════════════════════════════════════════════

  router.get('/transfer/status', auth, async (req, res) => {
    try {
      res.json(await getTransferSummary(dolibarrPool));
    } catch (err) {
      console.error('[ACCOUNTING] Transfer status error:', err.message);
      res.status(500).json({ error: 'Erreur état du grand livre' });
    }
  });

  router.post('/transfer', auth, noCsrf, async (req, res) => {
    try {
      const def = currentYearRange();
      const date_from = req.body?.date_from || def.date_from;
      const date_to = req.body?.date_to || def.date_to;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from) || !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
        return res.status(400).json({ error: 'Dates invalides' });
      }
      const result = await runTransfer(dolibarrPool, { date_from, date_to, userId: req.admin?.dolibarr_user_id || 0 });
      invalidateAccountingCache();
      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin.username, 'accounting_transfer', `Transfert ${date_from} → ${date_to} : ${result.inserted} lignes`);
      } catch { /* ignore */ }
      res.json(result);
    } catch (err) {
      console.error('[ACCOUNTING] Transfer error:', err.message);
      res.status(500).json({ error: 'Erreur transfert en comptabilité : ' + err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // GRAND LIVRE
  // ═══════════════════════════════════════════════════════════

  router.get('/ledger', auth, async (req, res) => {
    try {
      const { date_from = firstDayOfMonth(), date_to = today(), account, journal, page = 1, limit = 100 } = req.query;
      const pageInt = Math.max(1, parseInt(page));
      const limitInt = Math.min(parseInt(limit) || 100, 500);
      const offset = (pageInt - 1) * limitInt;

      let where = 'WHERE entity = 1 AND doc_date BETWEEN ? AND ?';
      const params = [date_from, date_to];
      if (account) { where += ' AND numero_compte LIKE ?'; params.push(`${String(account).replace(/[%_]/g, '')}%`); }
      if (journal) { where += ' AND code_journal = ?'; params.push(journal); }

      const [[totals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS nb, COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
         FROM llx_accounting_bookkeeping ${where}`, params
      );

      // Report à nouveau (solde avant la période) si un compte est filtré
      let opening = 0;
      if (account) {
        const [[op]] = await dolibarrPool.query(
          `SELECT COALESCE(SUM(debit - credit), 0) AS solde
           FROM llx_accounting_bookkeeping
           WHERE entity = 1 AND doc_date < ? AND numero_compte LIKE ?`,
          [date_from, `${String(account).replace(/[%_]/g, '')}%`]
        );
        opening = Math.round(Number(op.solde));
      }

      const [rows] = await dolibarrPool.query(
        `SELECT rowid, piece_num, doc_date, doc_ref, doc_type, code_journal, journal_label,
                numero_compte, label_compte, subledger_account, subledger_label,
                label_operation, debit, credit, sens, import_key
         FROM llx_accounting_bookkeeping ${where}
         ORDER BY numero_compte, doc_date, piece_num, rowid
         LIMIT ? OFFSET ?`,
        [...params, limitInt, offset]
      );

      res.json({
        opening,
        entries: rows.map(r => ({
          id: r.rowid, piece: r.piece_num, date: r.doc_date, ref: r.doc_ref,
          journal: r.code_journal, account: r.numero_compte, account_label: r.label_compte,
          subledger: r.subledger_label || r.subledger_account || '',
          label: r.label_operation,
          debit: Math.round(Number(r.debit)), credit: Math.round(Number(r.credit)),
          is_manual: !r.import_key,
        })),
        totals: {
          nb: Number(totals.nb),
          debit: Math.round(Number(totals.debit)),
          credit: Math.round(Number(totals.credit)),
        },
        page: pageInt,
        pages: Math.ceil(Number(totals.nb) / limitInt),
      });
    } catch (err) {
      console.error('[ACCOUNTING] Ledger error:', err.message);
      res.status(500).json({ error: 'Erreur grand livre' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // BALANCE GÉNÉRALE
  // ═══════════════════════════════════════════════════════════

  router.get('/balance', auth, async (req, res) => {
    try {
      const { date_from = firstDayOfMonth(), date_to = today(), account_class } = req.query;
      let classClause = '';
      const params = [date_from, date_from, date_to, date_from, date_to, date_to];
      if (account_class) { classClause = ' AND LEFT(numero_compte, 1) = ?'; params.push(String(account_class)); }

      const [rows] = await dolibarrPool.query(
        `SELECT numero_compte, MAX(label_compte) AS label,
                COALESCE(SUM(CASE WHEN doc_date < ? THEN debit - credit ELSE 0 END), 0) AS opening,
                COALESCE(SUM(CASE WHEN doc_date BETWEEN ? AND ? THEN debit ELSE 0 END), 0) AS p_debit,
                COALESCE(SUM(CASE WHEN doc_date BETWEEN ? AND ? THEN credit ELSE 0 END), 0) AS p_credit
         FROM llx_accounting_bookkeeping
         WHERE entity = 1 AND doc_date <= ?${classClause}
         GROUP BY numero_compte
         HAVING opening <> 0 OR p_debit <> 0 OR p_credit <> 0
         ORDER BY numero_compte`,
        params
      );

      const accounts = rows.map(r => {
        const opening = Math.round(Number(r.opening));
        const pDebit = Math.round(Number(r.p_debit));
        const pCredit = Math.round(Number(r.p_credit));
        const solde = opening + pDebit - pCredit;
        return {
          number: r.numero_compte, label: r.label,
          class: r.numero_compte.charAt(0),
          opening, period_debit: pDebit, period_credit: pCredit,
          solde_debit: solde > 0 ? solde : 0,
          solde_credit: solde < 0 ? -solde : 0,
        };
      });
      const totals = accounts.reduce((t, a) => ({
        period_debit: t.period_debit + a.period_debit,
        period_credit: t.period_credit + a.period_credit,
        solde_debit: t.solde_debit + a.solde_debit,
        solde_credit: t.solde_credit + a.solde_credit,
      }), { period_debit: 0, period_credit: 0, solde_debit: 0, solde_credit: 0 });

      res.json({ period: { from: date_from, to: date_to }, accounts, totals });
    } catch (err) {
      console.error('[ACCOUNTING] Balance error:', err.message);
      res.status(500).json({ error: 'Erreur balance générale' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // COMPTE DE RÉSULTAT (classes 6 & 7)
  // ═══════════════════════════════════════════════════════════

  router.get('/income-statement', auth, async (req, res) => {
    try {
      const def = currentYearRange();
      const date_from = req.query.date_from || def.date_from;
      const date_to = req.query.date_to || def.date_to;

      const [rows] = await dolibarrPool.query(
        `SELECT numero_compte, MAX(label_compte) AS label,
                COALESCE(SUM(debit), 0) AS debit, COALESCE(SUM(credit), 0) AS credit
         FROM llx_accounting_bookkeeping
         WHERE entity = 1 AND doc_date BETWEEN ? AND ? AND LEFT(numero_compte, 1) IN ('6', '7')
         GROUP BY numero_compte ORDER BY numero_compte`,
        [date_from, date_to]
      );

      const charges = [];
      const produits = [];
      let totalCharges = 0;
      let totalProduits = 0;
      for (const r of rows) {
        const debit = Math.round(Number(r.debit));
        const credit = Math.round(Number(r.credit));
        if (r.numero_compte.charAt(0) === '6') {
          const amount = debit - credit;
          charges.push({ number: r.numero_compte, label: r.label, amount });
          totalCharges += amount;
        } else {
          const amount = credit - debit;
          produits.push({ number: r.numero_compte, label: r.label, amount });
          totalProduits += amount;
        }
      }
      res.json({
        period: { from: date_from, to: date_to },
        charges, produits,
        total_charges: totalCharges,
        total_produits: totalProduits,
        result: totalProduits - totalCharges,
      });
    } catch (err) {
      console.error('[ACCOUNTING] Income statement error:', err.message);
      res.status(500).json({ error: 'Erreur compte de résultat' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // BILAN (classes 1 à 5)
  // ═══════════════════════════════════════════════════════════

  router.get('/balance-sheet', auth, async (req, res) => {
    try {
      const date_to = req.query.date_to || today();

      const [rows] = await dolibarrPool.query(
        `SELECT numero_compte, MAX(label_compte) AS label,
                COALESCE(SUM(debit - credit), 0) AS solde
         FROM llx_accounting_bookkeeping
         WHERE entity = 1 AND doc_date <= ? AND LEFT(numero_compte, 1) IN ('1','2','3','4','5')
         GROUP BY numero_compte ORDER BY numero_compte`,
        [date_to]
      );
      // Résultat de l'exercice (classes 6/7) jusqu'à la date
      const [[rstat]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(CASE WHEN LEFT(numero_compte,1)='7' THEN credit - debit
                                  ELSE -(debit - credit) END), 0) AS result
         FROM llx_accounting_bookkeeping
         WHERE entity = 1 AND doc_date <= ? AND LEFT(numero_compte, 1) IN ('6', '7')`,
        [date_to]
      );
      const result = Math.round(Number(rstat.result));

      const actif = [];
      const passif = [];
      let totalActif = 0;
      let totalPassif = 0;
      for (const r of rows) {
        const solde = Math.round(Number(r.solde));
        if (solde === 0) continue;
        const cls = r.numero_compte.charAt(0);
        // Classes 2/3 : actif. Classes 4/5 : selon le sens. Classe 1 : passif.
        if (cls === '2' || cls === '3' || ((cls === '4' || cls === '5') && solde > 0)) {
          actif.push({ number: r.numero_compte, label: r.label, amount: solde });
          totalActif += solde;
        } else {
          const amount = -solde;
          passif.push({ number: r.numero_compte, label: r.label, amount });
          totalPassif += amount;
        }
      }
      passif.push({ number: '—', label: 'Résultat de l\'exercice', amount: result, is_result: true });
      totalPassif += result;

      res.json({
        date: date_to,
        actif, passif,
        total_actif: totalActif,
        total_passif: totalPassif,
        result,
        ecart: totalActif - totalPassif,
      });
    } catch (err) {
      console.error('[ACCOUNTING] Balance sheet error:', err.message);
      res.status(500).json({ error: 'Erreur bilan' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ÉCRITURES MANUELLES (journal OD)
  // ═══════════════════════════════════════════════════════════

  router.get('/entries', auth, async (req, res) => {
    try {
      const { date_from = `${new Date().getFullYear()}-01-01`, date_to = today() } = req.query;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid, piece_num, doc_date, doc_ref, code_journal,
                numero_compte, label_compte, subledger_account, subledger_label,
                label_operation, debit, credit, date_validated
         FROM llx_accounting_bookkeeping
         WHERE entity = 1 AND code_journal = 'OD' AND (import_key IS NULL OR import_key = '')
           AND doc_date BETWEEN ? AND ?
         ORDER BY doc_date DESC, piece_num DESC, rowid`,
        [date_from, date_to]
      );
      const byPiece = new Map();
      for (const r of rows) {
        if (!byPiece.has(r.piece_num)) {
          byPiece.set(r.piece_num, {
            piece: r.piece_num, date: r.doc_date, ref: r.doc_ref,
            label: r.label_operation, validated: !!r.date_validated, lines: [],
          });
        }
        byPiece.get(r.piece_num).lines.push({
          account: r.numero_compte, account_label: r.label_compte,
          subledger: r.subledger_label || r.subledger_account || '',
          label: r.label_operation,
          debit: Math.round(Number(r.debit)), credit: Math.round(Number(r.credit)),
        });
      }
      res.json({ entries: [...byPiece.values()] });
    } catch (err) {
      console.error('[ACCOUNTING] Entries error:', err.message);
      res.status(500).json({ error: 'Erreur écritures' });
    }
  });

  router.post('/entries', auth, noCsrf, async (req, res) => {
    try {
      const { date, ref, label, lines } = req.body || {};
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide' });
      if (!Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'Au moins 2 lignes requises' });

      let totalDebit = 0;
      let totalCredit = 0;
      const clean = [];
      for (const l of lines) {
        const account = String(l.account || '').trim();
        const debit = Math.max(0, Math.round(Number(l.debit) || 0));
        const credit = Math.max(0, Math.round(Number(l.credit) || 0));
        if (!account) return res.status(400).json({ error: 'Compte manquant sur une ligne' });
        if (debit > 0 && credit > 0) return res.status(400).json({ error: 'Une ligne ne peut être à la fois au débit et au crédit' });
        if (debit === 0 && credit === 0) return res.status(400).json({ error: 'Montant manquant sur une ligne' });
        totalDebit += debit;
        totalCredit += credit;
        clean.push({ account, debit, credit, subledger: String(l.subledger || '').trim(), label: String(l.label || label || '').trim() });
      }
      if (totalDebit !== totalCredit) {
        return res.status(400).json({ error: `Écriture déséquilibrée : débit ${totalDebit} ≠ crédit ${totalCredit}` });
      }

      // Vérifie l'existence des comptes
      const accountNums = [...new Set(clean.map(l => l.account))];
      const [accRows] = await dolibarrPool.query(
        `SELECT account_number, label FROM llx_accounting_account
         WHERE entity = 1 AND account_number IN (${accountNums.map(() => '?').join(',')})`,
        accountNums
      );
      const accMap = new Map(accRows.map(a => [String(a.account_number), a.label]));
      for (const num of accountNums) {
        if (!accMap.has(num)) return res.status(400).json({ error: `Compte inconnu : ${num}` });
      }

      const [[mx]] = await dolibarrPool.query(
        `SELECT COALESCE(MAX(piece_num), 0) + 1 AS p FROM llx_accounting_bookkeeping WHERE entity = 1`
      );
      const piece = Number(mx.p);
      const userId = req.admin?.dolibarr_user_id || 0;
      const opLabel = (label || ref || 'Écriture OD').slice(0, 250);

      const values = clean.map(l => [
        1, piece, date, 'mvt', ref || '', 0, 0,
        l.subledger || '', l.subledger || '', '',
        l.account, accMap.get(l.account) || l.account,
        l.label || opLabel, l.debit, l.credit, l.debit || l.credit,
        l.debit > 0 ? 'D' : 'C', userId, new Date(), 'OD', 'Opérations diverses', null,
      ]);
      await dolibarrPool.query(
        `INSERT INTO llx_accounting_bookkeeping
         (entity, piece_num, doc_date, doc_type, doc_ref, fk_doc, fk_docdet,
          thirdparty_code, subledger_account, subledger_label, numero_compte, label_compte,
          label_operation, debit, credit, montant, sens, fk_user_author, date_creation,
          code_journal, journal_label, import_key) VALUES ?`,
        [values]
      );
      invalidateAccountingCache();
      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin.username, 'accounting_entry_create', `Écriture OD #${piece} : ${opLabel}`);
      } catch { /* ignore */ }
      res.json({ ok: true, piece });
    } catch (err) {
      console.error('[ACCOUNTING] Entry create error:', err.message);
      res.status(500).json({ error: 'Erreur création écriture' });
    }
  });

  router.delete('/entries/:piece', auth, noCsrf, async (req, res) => {
    try {
      const piece = parseInt(req.params.piece);
      if (!piece) return res.status(400).json({ error: 'Pièce invalide' });
      const [r] = await dolibarrPool.query(
        `DELETE FROM llx_accounting_bookkeeping
         WHERE entity = 1 AND piece_num = ? AND code_journal = 'OD'
           AND (import_key IS NULL OR import_key = '') AND date_validated IS NULL`,
        [piece]
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Écriture introuvable ou non supprimable' });
      invalidateAccountingCache();
      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin.username, 'accounting_entry_delete', `Suppression écriture OD #${piece}`);
      } catch { /* ignore */ }
      res.json({ ok: true, deleted: r.affectedRows });
    } catch (err) {
      console.error('[ACCOUNTING] Entry delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression écriture' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // FACTURES FOURNISSEURS & CHARGES
  // ═══════════════════════════════════════════════════════════

  router.get('/suppliers', auth, async (req, res) => {
    try {
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom AS name, code_fournisseur AS code
         FROM llx_societe WHERE entity = 1 AND fournisseur >= 1 AND status = 1
         ORDER BY nom LIMIT 500`
      );
      res.json({ suppliers: rows });
    } catch (err) {
      console.error('[ACCOUNTING] Suppliers error:', err.message);
      res.status(500).json({ error: 'Erreur fournisseurs' });
    }
  });

  router.get('/supplier-invoices', auth, async (req, res) => {
    try {
      const { date_from = `${new Date().getFullYear()}-01-01`, date_to = today() } = req.query;
      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.ref_supplier, f.datef, f.date_lim_reglement,
                f.total_ht, f.total_tva, f.total_ttc, f.fk_statut, f.paye, f.libelle,
                s.nom AS supplier,
                COALESCE(pf.paid, 0) AS paid
         FROM llx_facture_fourn f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facturefourn, SUM(amount) AS paid
                    FROM llx_paiementfourn_facturefourn GROUP BY fk_facturefourn) pf
           ON pf.fk_facturefourn = f.rowid
         WHERE f.entity = 1 AND f.datef BETWEEN ? AND ?
         ORDER BY f.datef DESC, f.rowid DESC`,
        [date_from, date_to]
      );
      const [[totals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS nb, COALESCE(SUM(total_ht), 0) AS ht,
                COALESCE(SUM(total_tva), 0) AS tva, COALESCE(SUM(total_ttc), 0) AS ttc
         FROM llx_facture_fourn WHERE entity = 1 AND datef BETWEEN ? AND ?`,
        [date_from, date_to]
      );
      res.json({
        invoices: rows.map(r => ({
          id: r.id, ref: r.ref, ref_supplier: r.ref_supplier, label: r.libelle,
          date: r.datef, date_due: r.date_lim_reglement, supplier: r.supplier,
          total_ht: Math.round(Number(r.total_ht)),
          total_tva: Math.round(Number(r.total_tva)),
          total_ttc: Math.round(Number(r.total_ttc)),
          paid: Math.round(Number(r.paid)),
          remaining: Math.round(Number(r.total_ttc) - Number(r.paid)),
          status: Number(r.fk_statut), is_paid: Number(r.paye) === 1,
        })),
        totals: {
          nb: Number(totals.nb), ht: Math.round(Number(totals.ht)),
          tva: Math.round(Number(totals.tva)), ttc: Math.round(Number(totals.ttc)),
        },
      });
    } catch (err) {
      console.error('[ACCOUNTING] Supplier invoices error:', err.message);
      res.status(500).json({ error: 'Erreur factures fournisseurs' });
    }
  });

  router.post('/supplier-invoices', auth, noCsrf, async (req, res) => {
    try {
      const { supplier_id, date, ref_supplier, label, total_ht, vat_rate = 0, date_due } = req.body || {};
      if (!supplier_id) return res.status(400).json({ error: 'Fournisseur requis' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide' });
      const ht = Math.round(Number(total_ht) || 0);
      if (ht <= 0) return res.status(400).json({ error: 'Montant HT invalide' });
      const rate = Number(vat_rate) || 0;
      const tva = Math.round(ht * rate / 100);
      const ttc = ht + tva;

      const [[soc]] = await dolibarrPool.query(
        `SELECT rowid, nom FROM llx_societe WHERE rowid = ? AND entity = 1`, [supplier_id]
      );
      if (!soc) return res.status(400).json({ error: 'Fournisseur introuvable' });

      // Référence interne : FA + année + séquence
      const year = date.slice(0, 4);
      const [[seq]] = await dolibarrPool.query(
        `SELECT COUNT(*) + 1 AS n FROM llx_facture_fourn WHERE entity = 1 AND YEAR(datec) = ?`, [year]
      );
      const ref = `FA${year}-${String(seq.n).padStart(5, '0')}`;
      const userId = req.admin?.dolibarr_user_id || 0;
      const dueDate = date_due && /^\d{4}-\d{2}-\d{2}$/.test(date_due) ? date_due : date;

      const [ins] = await dolibarrPool.query(
        `INSERT INTO llx_facture_fourn
         (ref, entity, ref_supplier, type, fk_soc, datec, datef, date_lim_reglement,
          libelle, total_ht, total_tva, total_ttc, fk_statut, paye, fk_user_author)
         VALUES (?, 1, ?, 0, ?, NOW(), ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
        [ref, ref_supplier || '', supplier_id, date, dueDate,
         (label || '').slice(0, 250), ht, tva, ttc, userId]
      );
      const invoiceId = ins.insertId;

      // Ligne de détail
      try {
        await dolibarrPool.query(
          `INSERT INTO llx_facture_fourn_det
           (fk_facture_fourn, description, qty, tva_tx, total_ht, tva, total_ttc, rang)
           VALUES (?, ?, 1, ?, ?, ?, ?, 1)`,
          [invoiceId, (label || 'Charge').slice(0, 250), rate, ht, tva, ttc]
        );
      } catch (e) { console.warn('[ACCOUNTING] facture_fourn_det:', e.message); }

      invalidateAccountingCache();
      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.admin.username, 'supplier_invoice_create', `Facture fournisseur ${ref} — ${soc.nom} : ${ttc}`);
      } catch { /* ignore */ }
      res.json({ ok: true, id: invoiceId, ref });
    } catch (err) {
      console.error('[ACCOUNTING] Supplier invoice create error:', err.message);
      res.status(500).json({ error: 'Erreur création facture fournisseur' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉCLARATION TVA
  // ═══════════════════════════════════════════════════════════

  router.get('/vat-report', auth, async (req, res) => {
    try {
      const def = currentYearRange();
      const date_from = req.query.date_from || firstDayOfMonth();
      const date_to = req.query.date_to || today();
      void def;

      // TVA collectée (ventes) par taux
      const [collected] = await dolibarrPool.query(
        `SELECT fd.tva_tx AS rate, COALESCE(SUM(fd.total_ht), 0) AS base,
                COALESCE(SUM(fd.total_tva), 0) AS tva
         FROM llx_facturedet fd
         JOIN llx_facture f ON f.rowid = fd.fk_facture
         WHERE f.entity = 1 AND f.fk_statut IN (1, 2) AND f.datef BETWEEN ? AND ?
         GROUP BY fd.tva_tx ORDER BY fd.tva_tx`,
        [date_from, date_to]
      );
      // TVA déductible (achats) par taux
      let deductible = [];
      try {
        const [d] = await dolibarrPool.query(
          `SELECT fd.tva_tx AS rate, COALESCE(SUM(fd.total_ht), 0) AS base,
                  COALESCE(SUM(fd.tva), 0) AS tva
           FROM llx_facture_fourn_det fd
           JOIN llx_facture_fourn f ON f.rowid = fd.fk_facture_fourn
           WHERE f.entity = 1 AND f.fk_statut IN (1, 2) AND f.datef BETWEEN ? AND ?
           GROUP BY fd.tva_tx ORDER BY fd.tva_tx`,
          [date_from, date_to]
        );
        deductible = d;
      } catch (e) { void e; }

      const mapRows = (rows) => rows.map(r => ({
        rate: Number(r.rate), base: Math.round(Number(r.base)), tva: Math.round(Number(r.tva)),
      }));
      const collectedRows = mapRows(collected);
      const deductibleRows = mapRows(deductible);
      const totalCollected = collectedRows.reduce((s, r) => s + r.tva, 0);
      const totalDeductible = deductibleRows.reduce((s, r) => s + r.tva, 0);

      res.json({
        period: { from: date_from, to: date_to },
        collected: collectedRows,
        deductible: deductibleRows,
        total_collected: totalCollected,
        total_deductible: totalDeductible,
        net: totalCollected - totalDeductible,
      });
    } catch (err) {
      console.error('[ACCOUNTING] VAT report error:', err.message);
      res.status(500).json({ error: 'Erreur déclaration TVA' });
    }
  });

  return router;
}
