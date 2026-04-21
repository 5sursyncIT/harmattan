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
  const s = String(v ?? '');
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

export function createAccountingRouter({ db, dolibarrPool, cache, auth }) {
  const router = Router();
  const CACHE_TTL = 60; // 1 minute pour les journaux

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

      // CA mois HT
      const [[revMtd]] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(total_ht), 0) AS ca_ht, COALESCE(SUM(total_ttc), 0) AS ca_ttc, COUNT(*) AS nb
         FROM llx_facture WHERE fk_statut >= 1 AND datef BETWEEN ? AND ?`,
        [firstDay, todayStr]
      );

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

      const result = {
        generated_at: new Date().toISOString(),
        period: { from: firstDay, to: todayStr },
        revenue: { ht: Math.round(Number(revMtd.ca_ht)), ttc: Math.round(Number(revMtd.ca_ttc)), count: Number(revMtd.nb) },
        cash_in: { total: Math.round(Number(cashMtd.total)), count: Number(cashMtd.nb) },
        receivables: { outstanding: Math.round(Number(ar.outstanding)), count: Number(ar.nb) },
        treasury: { total: Math.round(Number(treasury.total)), accounts: Number(treasury.nb_accounts) },
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
             WHERE f.fk_statut >= 1 AND fd.qty > 0
               AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
               AND f.datef <= ?`,
            [isbnNorm, date_to]
          );
          cumulativeUnits = Number(cumRow.units);
        }

        // Ventes sur la période
        const [[periodRow]] = await dolibarrPool.query(
          `SELECT COALESCE(SUM(fd.qty), 0) AS units_sold,
                  COALESCE(SUM(fd.total_ht), 0) AS gross_ht,
                  COUNT(DISTINCT f.rowid) AS invoice_count
           FROM llx_facturedet fd
           JOIN llx_facture f ON f.rowid = fd.fk_facture
           JOIN llx_product p ON p.rowid = fd.fk_product
           WHERE f.fk_statut >= 1 AND fd.qty > 0
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

        // Seuil cumulatif : unités au-dessus du seuil = max(0, cumulative - threshold - freeCopies)
        // Mais on ne compte dans la période que les unités qui dépassent le seuil dans la période
        let unitsOver = 0;
        if (threshold_mode === 'cumulative') {
          const cumBefore = cumulativeUnits - unitsSold; // cumulative avant cette période
          const thresholdPlusFree = threshold + freeCopies;
          if (cumulativeUnits > thresholdPlusFree) {
            if (cumBefore >= thresholdPlusFree) {
              unitsOver = unitsSold;
            } else {
              unitsOver = cumulativeUnits - thresholdPlusFree;
            }
          }
        } else {
          unitsOver = Math.max(0, unitsSold - threshold - freeCopies);
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
         WHERE f.fk_statut >= 1 AND fd.qty > 0
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
             WHERE f.fk_statut >= 1 AND fd.qty > 0
               AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
               AND f.datef BETWEEN ? AND ?`,
            [isbnNorm, d_from, d_to]
          );
          const units = Number(sales.units);
          if (units === 0) continue;
          const gross = Number(sales.gross_ht);
          const rate = Number(c.royalty_rate_print) || 0;
          const unitsOver = Math.max(0, units - Number(c.royalty_threshold || 0) - Number(c.free_author_copies || 0));
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

  return router;
}
