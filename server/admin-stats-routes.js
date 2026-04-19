/**
 * Routes admin pour les statistiques et KPIs.
 * Toutes les routes sont protégées par adminAuth (librarian bloqué via middleware global).
 */

import { Router } from 'express';

const CACHE_MAIN_TTL = 60;       // 1 min
const CACHE_SERIES_TTL = 300;    // 5 min
const CACHE_CHANNELS_TTL = 300;  // 5 min
const CACHE_TOP_TTL = 300;       // 5 min

export function createAdminStatsRouter({ db, dolibarrPool, cache, auth }) {
  const router = Router();

  // ══════════════════════════════════════════════════════════
  // GET /api/admin/stats/main — KPIs agrégés
  // ══════════════════════════════════════════════════════════
  router.get('/main', auth, async (req, res) => {
    try {
      const cacheKey = 'stats:main';
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      // ── Revenue KPIs (Dolibarr) ────────────────────────────
      const [todayRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_ttc), 0) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND DATE(datef) = CURDATE()`
      );
      const [yesterdayRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_ttc), 0) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND DATE(datef) = CURDATE() - INTERVAL 1 DAY`
      );
      const [monthRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_ttc), 0) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1
           AND YEAR(datef) = YEAR(CURDATE()) AND MONTH(datef) = MONTH(CURDATE())`
      );
      const [prevMonthRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_ttc), 0) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1
           AND YEAR(datef) = YEAR(CURDATE() - INTERVAL 1 MONTH)
           AND MONTH(datef) = MONTH(CURDATE() - INTERVAL 1 MONTH)`
      );
      const [yearRow] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(total_ttc), 0) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND YEAR(datef) = YEAR(CURDATE())`
      );
      const [arRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_ttc), 0) AS amount
         FROM llx_facture WHERE fk_statut >= 1 AND paye = 0`
      );

      const today = Number(todayRow[0]?.revenue || 0);
      const yesterday = Number(yesterdayRow[0]?.revenue || 0);
      const month = Number(monthRow[0]?.revenue || 0);
      const prevMonth = Number(prevMonthRow[0]?.revenue || 0);

      const trendPct = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return ((current - previous) / previous) * 100;
      };

      // ── Operations (stock, products) ───────────────────────
      const [prodRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total FROM llx_product WHERE tosell = 1`
      );
      const [outOfStockRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt FROM llx_product WHERE tosell = 1 AND stock <= 0`
      );
      const [lowStockRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt FROM llx_product WHERE tosell = 1 AND stock > 0 AND stock < 5`
      );
      const [stockValueRow] = await dolibarrPool.query(
        `SELECT COALESCE(SUM(stock * price_ttc), 0) AS value FROM llx_product WHERE tosell = 1 AND stock > 0`
      );

      // ── Customers ─────────────────────────────────────────
      const [customersRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total FROM llx_societe WHERE client IN (1, 2, 3)`
      );
      const [active30Row] = await dolibarrPool.query(
        `SELECT COUNT(DISTINCT fk_soc) AS cnt
         FROM llx_facture
         WHERE fk_statut >= 1 AND datef >= CURDATE() - INTERVAL 30 DAY`
      );
      const [newMonthRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt FROM llx_societe
         WHERE client IN (1, 2, 3)
           AND YEAR(datec) = YEAR(CURDATE()) AND MONTH(datec) = MONTH(CURDATE())`
      );

      // ── POS Today ─────────────────────────────────────────
      const [posTodayRow] = await dolibarrPool.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(total_ttc), 0) AS revenue,
                COUNT(DISTINCT pos_source) AS terminals
         FROM llx_facture
         WHERE fk_statut >= 1 AND module_source = 'takepos'
           AND DATE(datef) = CURDATE()`
      );

      // Top cashier today (via note_private pattern "POS Terminal X | Name")
      const [topCashierRows] = await dolibarrPool.query(
        `SELECT
           SUBSTRING_INDEX(SUBSTRING_INDEX(note_private, ' | ', 2), ' | ', -1) AS cashier,
           COUNT(*) AS cnt,
           SUM(total_ttc) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND module_source = 'takepos'
           AND DATE(datef) = CURDATE()
           AND note_private LIKE 'POS Terminal%'
         GROUP BY cashier
         ORDER BY revenue DESC
         LIMIT 1`
      );

      // ── SQLite KPIs ───────────────────────────────────────
      const newsletter = db.prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(confirmed), 0) AS confirmed FROM newsletter`
      ).get();
      const contacts = db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS unread FROM contact_messages`
      ).get();

      let manuscripts = { total: 0, pending: 0 };
      try {
        const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM manuscript_submissions`).get();
        const pendingRow = db.prepare(`SELECT COUNT(*) AS c FROM manuscript_submissions WHERE status = 'reçu'`).get();
        manuscripts = { total: totalRow?.c || 0, pending: pendingRow?.c || 0 };
      } catch { /* table may not exist */ }

      let contractsActive = 0;
      let contractsExpiring = 0;
      try {
        const c1 = await dolibarrPool.query(
          `SELECT COUNT(*) AS c FROM llx_contrat WHERE statut = 1`
        );
        contractsActive = c1[0][0]?.c || 0;
        const c2 = await dolibarrPool.query(
          `SELECT COUNT(DISTINCT cd.fk_contrat) AS c
           FROM llx_contratdet cd
           INNER JOIN llx_contrat c ON c.rowid = cd.fk_contrat
           WHERE c.statut = 1 AND cd.date_fin_validite IS NOT NULL
             AND cd.date_fin_validite BETWEEN CURDATE() AND CURDATE() + INTERVAL 60 DAY`
        );
        contractsExpiring = c2[0][0]?.c || 0;
      } catch { /* tables may not exist */ }

      let preordersPending = 0;
      try {
        const row = db.prepare(`SELECT COUNT(*) AS c FROM preorders WHERE status IN ('preorder', 'pending')`).get();
        preordersPending = row?.c || 0;
      } catch { /* table may not exist */ }

      // ── Recent invoices ───────────────────────────────────
      const [recentInvoices] = await dolibarrPool.query(
        `SELECT f.ref, f.total_ttc, f.datef, s.nom AS customer
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.fk_statut >= 1
         ORDER BY f.datef DESC, f.rowid DESC
         LIMIT 8`
      );

      // ── Recent activity ───────────────────────────────────
      const recentActivity = db.prepare(
        `SELECT id, admin_username, action, details, created_at
         FROM admin_activity_log ORDER BY id DESC LIMIT 8`
      ).all();

      const payload = {
        revenue: {
          today: {
            amount: Math.round(today),
            count: Number(todayRow[0]?.cnt || 0),
            trend_pct: Math.round(trendPct(today, yesterday) * 10) / 10,
          },
          yesterday: { amount: Math.round(yesterday), count: Number(yesterdayRow[0]?.cnt || 0) },
          month: {
            amount: Math.round(month),
            count: Number(monthRow[0]?.cnt || 0),
            trend_pct: Math.round(trendPct(month, prevMonth) * 10) / 10,
          },
          previous_month: { amount: Math.round(prevMonth), count: Number(prevMonthRow[0]?.cnt || 0) },
          year: { amount: Math.round(Number(yearRow[0]?.revenue || 0)) },
          avg_ticket_today: todayRow[0]?.cnt > 0 ? Math.round(today / todayRow[0].cnt) : 0,
          avg_ticket_month: monthRow[0]?.cnt > 0 ? Math.round(month / monthRow[0].cnt) : 0,
          outstanding_ar: {
            amount: Math.round(Number(arRow[0]?.amount || 0)),
            count: Number(arRow[0]?.cnt || 0),
          },
        },
        operations: {
          products_total: Number(prodRow[0]?.total || 0),
          products_out_of_stock: Number(outOfStockRow[0]?.cnt || 0),
          low_stock_count: Number(lowStockRow[0]?.cnt || 0),
          stock_value_retail: Math.round(Number(stockValueRow[0]?.value || 0)),
        },
        customers: {
          total: Number(customersRow[0]?.total || 0),
          active_30d: Number(active30Row[0]?.cnt || 0),
          new_this_month: Number(newMonthRow[0]?.cnt || 0),
        },
        editorial: {
          manuscripts_pending: manuscripts.pending,
          manuscripts_total: manuscripts.total,
          contracts_active: contractsActive,
          contracts_expiring_soon: contractsExpiring,
          preorders_pending: preordersPending,
        },
        engagement: {
          newsletter_confirmed: Number(newsletter?.confirmed || 0),
          newsletter_total: Number(newsletter?.total || 0),
          contact_unread: Number(contacts?.unread || 0),
        },
        pos_today: {
          revenue: Math.round(Number(posTodayRow[0]?.revenue || 0)),
          count: Number(posTodayRow[0]?.cnt || 0),
          terminals_active: Number(posTodayRow[0]?.terminals || 0),
          top_cashier: topCashierRows[0]
            ? {
                name: (topCashierRows[0].cashier || '').trim(),
                revenue: Math.round(Number(topCashierRows[0].revenue || 0)),
                count: Number(topCashierRows[0].cnt || 0),
              }
            : null,
        },
        recent_invoices: recentInvoices.map((r) => ({
          ref: r.ref,
          total: Math.round(Number(r.total_ttc || 0)),
          date: r.datef,
          customer: r.customer || '—',
        })),
        recent_activity: recentActivity.map((a) => ({
          id: a.id,
          username: a.admin_username,
          action: a.action,
          details: a.details,
          created_at: a.created_at,
        })),
        generated_at: new Date().toISOString(),
      };

      cache.set(cacheKey, payload, CACHE_MAIN_TTL);
      res.json(payload);
    } catch (err) {
      console.error('[STATS] main error:', err.message);
      res.status(500).json({ error: 'Erreur chargement statistiques' });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /api/admin/stats/timeseries — Séries temporelles
  // ══════════════════════════════════════════════════════════
  router.get('/timeseries', auth, async (req, res) => {
    try {
      const cacheKey = 'stats:timeseries';
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      const [dailyRows] = await dolibarrPool.query(
        `SELECT DATE(datef) AS date, COUNT(*) AS cnt, SUM(total_ttc) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND datef >= CURDATE() - INTERVAL 30 DAY
         GROUP BY DATE(datef)
         ORDER BY date ASC`
      );

      const [monthlyRows] = await dolibarrPool.query(
        `SELECT DATE_FORMAT(datef, '%Y-%m') AS month, COUNT(*) AS cnt, SUM(total_ttc) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND datef >= CURDATE() - INTERVAL 12 MONTH
         GROUP BY month
         ORDER BY month ASC`
      );

      const payload = {
        daily_30d: dailyRows.map((r) => ({
          date: r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
          count: Number(r.cnt || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
        monthly_12m: monthlyRows.map((r) => ({
          month: r.month,
          count: Number(r.cnt || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
      };

      cache.set(cacheKey, payload, CACHE_SERIES_TTL);
      res.json(payload);
    } catch (err) {
      console.error('[STATS] timeseries error:', err.message);
      res.status(500).json({ error: 'Erreur séries temporelles' });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /api/admin/stats/channels — Canaux + paiements
  // ══════════════════════════════════════════════════════════
  router.get('/channels', auth, async (req, res) => {
    try {
      const cacheKey = 'stats:channels';
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      const [channelRows] = await dolibarrPool.query(
        `SELECT
           CASE
             WHEN module_source = 'takepos' THEN 'POS'
             WHEN module_source = 'ecommerce' THEN 'E-commerce'
             WHEN module_source IS NULL OR module_source = '' THEN 'Facturation directe'
             ELSE module_source
           END AS label,
           COUNT(*) AS cnt,
           SUM(total_ttc) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND datef >= CURDATE() - INTERVAL 30 DAY
         GROUP BY label
         ORDER BY revenue DESC`
      );

      const [paymentRows] = await dolibarrPool.query(
        `SELECT cp.code, cp.libelle AS label, COUNT(*) AS cnt, SUM(pf.amount) AS amount
         FROM llx_paiement_facture pf
         INNER JOIN llx_paiement p ON p.rowid = pf.fk_paiement
         INNER JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         INNER JOIN llx_facture f ON f.rowid = pf.fk_facture
         WHERE f.fk_statut >= 1 AND f.datef >= CURDATE() - INTERVAL 30 DAY
         GROUP BY cp.code, cp.libelle
         ORDER BY amount DESC
         LIMIT 10`
      );

      const paymentLabels = {
        LIQ: 'Espèces',
        CB: 'Carte bancaire',
        CHQ: 'Chèque',
        WAVE: 'Wave',
        OM: 'Orange Money',
        P1: 'Chèque',
        P5: 'Virement',
        P13: 'À la livraison',
        P16: 'Virement',
      };

      const payload = {
        by_channel: channelRows.map((r) => ({
          label: r.label,
          count: Number(r.cnt || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
        by_payment_method: paymentRows.map((r) => ({
          code: r.code,
          label: paymentLabels[r.code] || r.label || r.code,
          count: Number(r.cnt || 0),
          amount: Math.round(Number(r.amount || 0)),
        })),
      };

      cache.set(cacheKey, payload, CACHE_CHANNELS_TTL);
      res.json(payload);
    } catch (err) {
      console.error('[STATS] channels error:', err.message);
      res.status(500).json({ error: 'Erreur répartition canaux' });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /api/admin/stats/top — Top listes (auteurs, produits, catégories)
  // ══════════════════════════════════════════════════════════
  router.get('/top', auth, async (req, res) => {
    try {
      const cacheKey = 'stats:top';
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      // Top produits du mois
      const [topProducts] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.label, p.ref,
                SUM(fd.qty) AS units_sold, SUM(fd.total_ttc) AS revenue
         FROM llx_facturedet fd
         INNER JOIN llx_facture f ON f.rowid = fd.fk_facture
         INNER JOIN llx_product p ON p.rowid = fd.fk_product
         WHERE f.fk_statut >= 1
           AND YEAR(f.datef) = YEAR(CURDATE()) AND MONTH(f.datef) = MONTH(CURDATE())
         GROUP BY p.rowid, p.label, p.ref
         ORDER BY revenue DESC
         LIMIT 5`
      );

      // Top auteurs du mois (via extrafield)
      const [topAuthors] = await dolibarrPool.query(
        `SELECT pe.auteur AS name,
                SUM(fd.qty) AS units_sold, SUM(fd.total_ttc) AS revenue
         FROM llx_facturedet fd
         INNER JOIN llx_facture f ON f.rowid = fd.fk_facture
         INNER JOIN llx_product_extrafields pe ON pe.fk_object = fd.fk_product
         WHERE f.fk_statut >= 1
           AND YEAR(f.datef) = YEAR(CURDATE()) AND MONTH(f.datef) = MONTH(CURDATE())
           AND pe.auteur IS NOT NULL AND pe.auteur != ''
         GROUP BY pe.auteur
         ORDER BY revenue DESC
         LIMIT 5`
      );

      // Top catégories du mois (via llx_categorie_product join)
      const [topCategories] = await dolibarrPool.query(
        `SELECT c.label,
                SUM(fd.qty) AS units_sold, SUM(fd.total_ttc) AS revenue
         FROM llx_facturedet fd
         INNER JOIN llx_facture f ON f.rowid = fd.fk_facture
         INNER JOIN llx_categorie_product cp ON cp.fk_product = fd.fk_product
         INNER JOIN llx_categorie c ON c.rowid = cp.fk_categorie
         WHERE f.fk_statut >= 1
           AND YEAR(f.datef) = YEAR(CURDATE()) AND MONTH(f.datef) = MONTH(CURDATE())
           AND c.label NOT IN ('LIBRAIRIE','LIVRES','Accueil','Racine','Services','Livres du mois','http://senharmattan.com/')
         GROUP BY c.label
         ORDER BY revenue DESC
         LIMIT 5`
      );

      // Top caissiers du mois (via note_private)
      const [topCashiers] = await dolibarrPool.query(
        `SELECT
           SUBSTRING_INDEX(SUBSTRING_INDEX(note_private, ' | ', 2), ' | ', -1) AS name,
           COUNT(*) AS sales_count, SUM(total_ttc) AS revenue
         FROM llx_facture
         WHERE fk_statut >= 1 AND module_source = 'takepos'
           AND YEAR(datef) = YEAR(CURDATE()) AND MONTH(datef) = MONTH(CURDATE())
           AND note_private LIKE 'POS Terminal%'
         GROUP BY name
         ORDER BY revenue DESC
         LIMIT 5`
      );

      const payload = {
        top_products: topProducts.map((r) => ({
          id: r.id,
          label: r.label,
          ref: r.ref,
          units_sold: Number(r.units_sold || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
        top_authors: topAuthors.map((r) => ({
          name: r.name,
          units_sold: Number(r.units_sold || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
        top_categories: topCategories.map((r) => ({
          label: r.label,
          units_sold: Number(r.units_sold || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
        top_cashiers: topCashiers.map((r) => ({
          name: (r.name || '').trim(),
          sales_count: Number(r.sales_count || 0),
          revenue: Math.round(Number(r.revenue || 0)),
        })),
      };

      cache.set(cacheKey, payload, CACHE_TOP_TTL);
      res.json(payload);
    } catch (err) {
      console.error('[STATS] top error:', err.message);
      res.status(500).json({ error: 'Erreur tops' });
    }
  });

  return router;
}
