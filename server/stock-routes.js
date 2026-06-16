/**
 * Stock & Réapprovisionnement — API routes.
 * Monté sur /api/admin/stock et /api/admin/suppliers.
 */

import { Router } from 'express';
import {
  calculateStockKPIs,
  calculateCoverageAndRotation,
  runDailyBatch,
  runClassificationBatch,
  safetyStockSimple,
  reorderPoint,
  getDefaultLeadTime,
  getDefaultSafetyDays,
  getSupplyType,
} from './stock-engine.js';

export function createStockRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();

  // Libraire = lecture seule sur le module stock
  function blockLibrarianWrite(req, res, next) {
    if (req.admin?.role === 'librarian') return res.status(403).json({ error: 'Accès en lecture seule pour votre profil' });
    next();
  }

  // ─── SQLite tables ────────────────────────────────────────

  db.exec(`CREATE TABLE IF NOT EXISTS stock_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER UNIQUE NOT NULL,
    warehouse_id INTEGER,
    abc_class TEXT,
    xyz_class TEXT,
    service_level_target REAL DEFAULT 0.95,
    lead_time_days INTEGER DEFAULT 14,
    review_period_days INTEGER DEFAULT 7,
    safety_stock INTEGER,
    reorder_point INTEGER,
    reorder_qty_default INTEGER,
    min_order_qty INTEGER DEFAULT 1,
    order_multiple INTEGER DEFAULT 1,
    max_stock_target INTEGER DEFAULT 0,
    is_manual_override INTEGER DEFAULT 0,
    notes TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_name TEXT NOT NULL,
    dolibarr_supplier_id TEXT,
    priority_rank INTEGER DEFAULT 1,
    lead_time_avg_days INTEGER DEFAULT 14,
    lead_time_max_days INTEGER DEFAULT 30,
    minimum_order_amount REAL DEFAULT 0,
    minimum_order_qty INTEGER DEFAULT 0,
    order_multiple INTEGER DEFAULT 1,
    freight_free_threshold REAL DEFAULT 0,
    reliability_score REAL DEFAULT 0,
    quality_score REAL DEFAULT 0,
    cost_score REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS supplier_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    supplier_id INTEGER NOT NULL,
    supplier_sku TEXT,
    purchase_price REAL DEFAULT 0,
    currency TEXT DEFAULT 'XOF',
    lead_time_days_override INTEGER,
    is_primary INTEGER DEFAULT 0,
    is_preferred_backup INTEGER DEFAULT 0,
    last_purchase_date TEXT,
    last_purchase_price REAL,
    UNIQUE(product_id, supplier_id)
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS stock_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    warehouse_id INTEGER,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    current_stock REAL DEFAULT 0,
    coverage_days INTEGER DEFAULT 0,
    reorder_point_snapshot INTEGER DEFAULT 0,
    recommended_qty INTEGER DEFAULT 0,
    supplier_id INTEGER,
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    resolved_by TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS purchase_recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    warehouse_id INTEGER,
    supplier_id INTEGER,
    recommended_qty INTEGER NOT NULL,
    recommended_order_date TEXT,
    expected_receipt_date TEXT,
    reason_code TEXT,
    demand_avg_daily REAL DEFAULT 0,
    coverage_days INTEGER DEFAULT 0,
    stock_on_hand REAL DEFAULT 0,
    stock_on_order REAL DEFAULT 0,
    status TEXT DEFAULT 'draft',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS purchase_orders_local (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    reference TEXT UNIQUE,
    status TEXT DEFAULT 'draft',
    ordered_at DATETIME,
    expected_at DATETIME,
    received_at DATETIME,
    amount_estimated REAL DEFAULT 0,
    amount_final REAL DEFAULT 0,
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    ordered_qty INTEGER NOT NULL,
    received_qty INTEGER DEFAULT 0,
    unit_cost REAL DEFAULT 0,
    line_total REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders_local(id)
  )`);

  // Migration : traçabilité (id/ref Dolibarr, type commande/réimpression, libellé produit).
  for (const c of ['dolibarr_order_id TEXT', "order_type TEXT DEFAULT 'supplier'", 'warehouse_id INTEGER DEFAULT 4']) {
    try { db.exec(`ALTER TABLE purchase_orders_local ADD COLUMN ${c}`); } catch { /* déjà présent */ }
  }
  try { db.exec(`ALTER TABLE purchase_order_lines ADD COLUMN product_label TEXT`); } catch { /* déjà présent */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_po_lines_product ON purchase_order_lines(product_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders_local(status)');

  // Enregistre une commande d'appro locale (fournisseur OU réimpression) + ses lignes.
  function recordPurchaseOrder({ supplier_id, dolibarr_order_id, order_type, reference, expected_at, amount, warehouse_id, created_by, lines }) {
    const tx = db.transaction(() => {
      const po = db.prepare(
        `INSERT INTO purchase_orders_local (supplier_id, reference, status, ordered_at, expected_at, amount_estimated, dolibarr_order_id, order_type, warehouse_id, created_by)
         VALUES (?, ?, 'ordered', ?, ?, ?, ?, ?, ?, ?)`
      ).run(supplier_id || 0, reference, new Date().toISOString(), expected_at || null, amount || 0,
        dolibarr_order_id != null ? String(dolibarr_order_id) : null, order_type, warehouse_id || 4, created_by);
      for (const l of lines) {
        db.prepare(
          `INSERT INTO purchase_order_lines (purchase_order_id, product_id, ordered_qty, received_qty, unit_cost, line_total, product_label, status)
           VALUES (?, ?, ?, 0, ?, ?, ?, 'pending')`
        ).run(po.lastInsertRowid, l.product_id, l.ordered_qty, l.unit_cost || 0, l.line_total || 0, l.product_label || null);
      }
      return po.lastInsertRowid;
    });
    return tx();
  }

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD KPIs
  // ═══════════════════════════════════════════════════════════

  router.get('/dashboard', auth, async (req, res) => {
    try {
      const kpis = await calculateStockKPIs(dolibarrPool);

      // Alertes ouvertes par type
      const alertCounts = db.prepare(
        `SELECT alert_type, severity, COUNT(*) AS count
         FROM stock_alerts WHERE status = 'open'
         GROUP BY alert_type, severity
         ORDER BY CASE severity WHEN 'critique' THEN 1 WHEN 'haute' THEN 2 WHEN 'moyenne' THEN 3 ELSE 4 END`
      ).all();

      // Couverture moyenne sur top références
      const topProducts = await calculateCoverageAndRotation(dolibarrPool, 50);
      const avgCoverage = topProducts.length > 0
        ? Math.round(topProducts.reduce((s, p) => s + Math.min(p.coverage_days, 365), 0) / topProducts.length)
        : 0;

      // Stock par éditeur
      const [byPublisher] = await dolibarrPool.query(
        `SELECT COALESCE(pe.editeur, 'Non qualifié') AS editeur,
                COUNT(*) AS products,
                COALESCE(SUM(CASE WHEN p.stock <= 0 THEN 1 ELSE 0 END), 0) AS ruptures,
                COALESCE(SUM(p.stock), 0) AS units
         FROM llx_product p
         LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.tosell = 1
         GROUP BY pe.editeur
         ORDER BY products DESC`
      );

      // Stock dormant (produits avec stock > 0 et 0 ventes 180j)
      const [[dormant]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS count FROM llx_product p
         WHERE p.tosell = 1 AND p.stock > 0
         AND p.rowid NOT IN (
           SELECT DISTINCT fd.fk_product FROM llx_facturedet fd
           JOIN llx_facture f ON f.rowid = fd.fk_facture
           WHERE f.fk_statut > 0 AND fd.qty > 0 AND f.datef >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 180 DAY)
         )`
      );

      // Sous point de commande
      const sousRop = db.prepare(`SELECT COUNT(*) AS count FROM stock_alerts WHERE alert_type = 'sous_point_de_commande' AND status = 'open'`).get();

      res.json({
        ...kpis,
        avg_coverage_days: avgCoverage,
        dormant_count: dormant.count,
        sous_rop_count: sousRop?.count || 0,
        alert_summary: alertCounts,
        by_publisher: byPublisher.map(p => ({
          editeur: p.editeur,
          products: p.products,
          ruptures: p.ruptures,
          units: p.units,
        })),
        top_products: topProducts.slice(0, 20),
      });
    } catch (err) {
      console.error('[STOCK] Dashboard error:', err.message);
      res.status(500).json({ error: 'Erreur chargement dashboard stock' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ALERTS
  // ═══════════════════════════════════════════════════════════

  router.get('/alerts', auth, async (req, res) => {
    try {
      const { type, severity, status = 'open', page = 1, limit = 50 } = req.query;
      const limitInt = Math.min(parseInt(limit) || 50, 200);
      const offset = (Math.max(1, parseInt(page)) - 1) * limitInt;

      let where = 'WHERE 1=1';
      const params = [];
      if (type) { where += ' AND a.alert_type = ?'; params.push(type); }
      if (severity) { where += ' AND a.severity = ?'; params.push(severity); }
      if (status) { where += ' AND a.status = ?'; params.push(status); }

      const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_alerts a ${where}`).get(...params)?.c || 0;

      const alerts = db.prepare(
        `SELECT a.* FROM stock_alerts a ${where} ORDER BY
         CASE a.severity WHEN 'critique' THEN 1 WHEN 'haute' THEN 2 WHEN 'moyenne' THEN 3 ELSE 4 END,
         a.created_at DESC LIMIT ? OFFSET ?`
      ).all(...params, limitInt, offset);

      // Enrichir avec les infos produit depuis Dolibarr
      if (alerts.length > 0) {
        const productIds = [...new Set(alerts.map(a => a.product_id))];
        const placeholders = productIds.map(() => '?').join(',');
        const [products] = await dolibarrPool.query(
          `SELECT rowid AS id, ref, label, stock FROM llx_product WHERE rowid IN (${placeholders})`,
          productIds
        );
        const productMap = new Map(products.map(p => [p.id, p]));
        for (const a of alerts) {
          const p = productMap.get(a.product_id);
          if (p) { a.product_ref = p.ref; a.product_label = p.label; a.current_stock_live = p.stock; }
        }
      }

      res.json({ alerts, total, page: Math.max(1, parseInt(page)), pages: Math.ceil(total / limitInt) });
    } catch (err) {
      console.error('[STOCK] Alerts error:', err.message);
      res.status(500).json({ error: 'Erreur chargement alertes' });
    }
  });

  router.post('/alerts/:id/acknowledge', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    const alert = db.prepare('SELECT * FROM stock_alerts WHERE id = ?').get(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alerte introuvable' });
    db.prepare('UPDATE stock_alerts SET status = ? WHERE id = ?').run('acknowledged', req.params.id);
    res.json({ success: true });
  });

  router.post('/alerts/:id/resolve', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    const alert = db.prepare('SELECT * FROM stock_alerts WHERE id = ?').get(req.params.id);
    if (!alert) return res.status(404).json({ error: 'Alerte introuvable' });
    db.prepare('UPDATE stock_alerts SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?')
      .run('resolved', new Date().toISOString(), req.admin?.username || 'system', req.params.id);
    res.json({ success: true });
  });

  router.post('/alerts/:id/ignore', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    db.prepare('UPDATE stock_alerts SET status = ? WHERE id = ?').run('ignored', req.params.id);
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // STOCK PRODUCTS LIST (with metrics)
  // ═══════════════════════════════════════════════════════════

  router.get('/products', auth, async (req, res) => {
    try {
      const { q, abc, coverage_max, sort = 'coverage', order = 'ASC', page = 1, limit = 50, scan_limit } = req.query;
      const search = String(q || '').trim();
      // Avec recherche : on interroge TOUT le catalogue (ref/titre/ISBN), borné à 500
      // résultats. Sans recherche : top-N par ventes 30j (scan_limit, défaut 2000).
      const scanN = search
        ? 500
        : Math.min(10000, Math.max(100, parseInt(scan_limit) || 2000));
      const products = await calculateCoverageAndRotation(dolibarrPool, scanN, search ? { search } : {});

      // Enrichir avec politiques locales
      const policies = db.prepare('SELECT * FROM stock_policies').all();
      const policyMap = new Map(policies.map(p => [p.product_id, p]));

      let enriched = products.map(p => {
        const pol = policyMap.get(p.product_id);
        const editeur = p.editeur || 'Autre';
        const leadTime = pol?.lead_time_days || getDefaultLeadTime(editeur);
        const safetyDays = getDefaultSafetyDays(editeur);
        return {
          ...p,
          abc_class: pol?.abc_class || null,
          xyz_class: pol?.xyz_class || null,
          safety_stock: pol?.safety_stock ?? safetyStockSimple(p.demand_avg_daily, safetyDays),
          reorder_point: pol?.reorder_point ?? reorderPoint(p.demand_avg_daily, leadTime, pol?.safety_stock ?? safetyStockSimple(p.demand_avg_daily, safetyDays)),
          lead_time_days: leadTime,
        };
      });

      // Filtres (la recherche q est déjà appliquée en SQL plein catalogue ci-dessus)
      if (abc) enriched = enriched.filter(p => p.abc_class === abc);
      if (coverage_max) enriched = enriched.filter(p => p.coverage_days <= parseInt(coverage_max));

      // Tri
      const sortMap = { coverage: 'coverage_days', stock: 'stock', sold: 'sold_30d', rotation: 'rotation_annual', label: 'label' };
      const sortKey = sortMap[sort] || 'coverage_days';
      const dir = order === 'DESC' ? -1 : 1;
      enriched.sort((a, b) => {
        const va = a[sortKey] ?? 0, vb = b[sortKey] ?? 0;
        return typeof va === 'string' ? dir * va.localeCompare(vb) : dir * (va - vb);
      });

      // Pagination
      const total = enriched.length;
      const limitInt = Math.min(parseInt(limit) || 50, 200);
      const pageInt = Math.max(1, parseInt(page));
      const paginated = enriched.slice((pageInt - 1) * limitInt, pageInt * limitInt);

      res.json({ products: paginated, total, page: pageInt, pages: Math.ceil(total / limitInt) });
    } catch (err) {
      console.error('[STOCK] Products error:', err.message);
      res.status(500).json({ error: 'Erreur chargement produits stock' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // STOCK POLICIES
  // ═══════════════════════════════════════════════════════════

  router.get('/policies/:productId', auth, (req, res) => {
    const policy = db.prepare('SELECT * FROM stock_policies WHERE product_id = ?').get(req.params.productId);
    res.json(policy || { product_id: parseInt(req.params.productId), lead_time_days: 14, safety_stock: null, reorder_point: null });
  });

  router.put('/policies/:productId', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    const pid = parseInt(req.params.productId);
    const d = req.body;
    db.prepare(
      `INSERT INTO stock_policies (product_id, lead_time_days, safety_stock, reorder_point, reorder_qty_default, min_order_qty, order_multiple, max_stock_target, service_level_target, is_manual_override, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(product_id) DO UPDATE SET
         lead_time_days = excluded.lead_time_days, safety_stock = excluded.safety_stock, reorder_point = excluded.reorder_point,
         reorder_qty_default = excluded.reorder_qty_default, min_order_qty = excluded.min_order_qty, order_multiple = excluded.order_multiple,
         max_stock_target = excluded.max_stock_target, service_level_target = excluded.service_level_target,
         is_manual_override = 1, notes = excluded.notes, updated_at = excluded.updated_at`
    ).run(pid, d.lead_time_days || 14, d.safety_stock, d.reorder_point, d.reorder_qty_default, d.min_order_qty || 1, d.order_multiple || 1, d.max_stock_target || 0, d.service_level_target || 0.95, d.notes || '', new Date().toISOString());
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // RECOMMENDATIONS
  // ═══════════════════════════════════════════════════════════

  router.get('/recommendations', auth, async (req, res) => {
    try {
      const { status = 'draft' } = req.query;
      const recs = db.prepare(
        `SELECT r.*, sp.abc_class, sp.xyz_class FROM purchase_recommendations r
         LEFT JOIN stock_policies sp ON sp.product_id = r.product_id
         WHERE r.status = ? ORDER BY r.coverage_days ASC, r.demand_avg_daily DESC`
      ).all(status);

      // Enrichir avec les infos produit + éditeur (titre, stock live, type de réappro)
      // — sinon l'écran n'afficherait qu'un product_id.
      if (recs.length > 0) {
        const ids = [...new Set(recs.map(r => r.product_id))];
        const placeholders = ids.map(() => '?').join(',');
        const [products] = await dolibarrPool.query(
          `SELECT p.rowid AS id, p.ref, p.label, p.stock, pe.editeur
           FROM llx_product p LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
           WHERE p.rowid IN (${placeholders})`, ids
        );
        const pMap = new Map(products.map(p => [p.id, p]));
        for (const r of recs) {
          const p = pMap.get(r.product_id);
          r.product_ref = p?.ref || null;
          r.product_label = p?.label || `Produit #${r.product_id}`;
          r.current_stock_live = p?.stock ?? r.stock_on_hand;
          r.editeur = p?.editeur || 'Autre';
          r.supply_type = getSupplyType(p?.editeur);
        }
      }

      // Compteurs par statut (pour les onglets/badges)
      const counts = db.prepare(
        `SELECT status, COUNT(*) AS n FROM purchase_recommendations GROUP BY status`
      ).all().reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {});

      res.json({ recommendations: recs, counts });
    } catch (err) {
      console.error('[STOCK] recommendations error:', err.message);
      res.status(500).json({ error: 'Erreur chargement recommandations' });
    }
  });

  router.post('/recommendations/:id/approve', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    db.prepare('UPDATE purchase_recommendations SET status = ? WHERE id = ?').run('approved', req.params.id);
    res.json({ success: true });
  });

  router.post('/recommendations/:id/cancel', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    db.prepare('UPDATE purchase_recommendations SET status = ? WHERE id = ?').run('cancelled', req.params.id);
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // BATCH TRIGGERS (manual)
  // ═══════════════════════════════════════════════════════════

  router.post('/batch/daily', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const result = await runDailyBatch(dolibarrPool, db);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[STOCK] Manual daily batch error:', err.message);
      res.status(500).json({ error: 'Erreur recalcul' });
    }
  });

  router.post('/batch/classify', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const result = await runClassificationBatch(dolibarrPool, db);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[STOCK] Classification batch error:', err.message);
      res.status(500).json({ error: 'Erreur classification' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // REPRINT REQUEST (titre interne → MRP manufacturing order)
  // ═══════════════════════════════════════════════════════════

  router.post('/reprint', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const { product_id, qty, warehouse_id = 4 } = req.body;
      if (!product_id || !qty || qty < 1) return res.status(400).json({ error: 'product_id et qty requis' });

      // Vérifier que le produit existe et est bien un titre interne
      const [[product]] = await dolibarrPool.query(
        `SELECT p.rowid, p.ref, p.label, pe.editeur
         FROM llx_product p LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid = ?`, [product_id]
      );
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });

      // Générer la référence MO
      const [[maxRef]] = await dolibarrPool.query(
        `SELECT MAX(CAST(SUBSTRING(ref, 8) AS UNSIGNED)) AS max_seq FROM llx_mrp_mo WHERE ref LIKE 'MO${new Date().toISOString().slice(2, 4)}%'`
      );
      const yymm = new Date().toISOString().slice(2, 4) + String(new Date().getMonth() + 1).padStart(2, '0');
      const seq = String((maxRef?.max_seq || 0) + 1).padStart(4, '0');
      const moRef = `MO${yymm}-${seq}`;

      // Créer l'ordre de fabrication dans Dolibarr
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const endDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
      const [result] = await dolibarrPool.query(
        `INSERT INTO llx_mrp_mo (ref, entity, label, qty, fk_warehouse, fk_product, status, date_start_planned, date_end_planned, date_creation, fk_user_creat, mrptype)
         VALUES (?, 1, ?, ?, ?, ?, 0, ?, ?, ?, 1, 0)`,
        [moRef, `Réimpression ${product.label}`, qty, warehouse_id, product_id, now, endDate, now]
      );

      // Suivi local (apparaît dans « Commandes d'appro », réceptionnable, compté en on-order)
      const poId = recordPurchaseOrder({
        supplier_id: 0, // interne (réimpression)
        dolibarr_order_id: result.insertId,
        order_type: 'reprint',
        reference: moRef,
        expected_at: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
        amount: 0,
        warehouse_id: parseInt(warehouse_id, 10) || 4,
        created_by: req.admin.username,
        lines: [{ product_id, ordered_qty: qty, unit_cost: 0, line_total: 0, product_label: product.label }],
      });

      // Tracer dans le journal d'activité
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'reprint_request', `Réimpression demandée : ${product.ref} "${product.label}" × ${qty} → ${moRef}`);

      console.log(`[STOCK] Réimpression: ${moRef} — ${product.ref} × ${qty} par ${req.admin.username}`);

      res.json({ success: true, mo_ref: moRef, mo_id: result.insertId, po_id: poId, product_ref: product.ref, qty });
    } catch (err) {
      console.error('[STOCK] Reprint error:', err.message);
      res.status(500).json({ error: 'Erreur création ordre de réimpression' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ENTRÉE DE STOCK (réception fournisseur, fin de réimpression, correction +)
  // C'est le SEUL point d'INCRÉMENT de stock natif de l'app. Sans lui, le stock ne
  // pouvait que décroître (ventes/BL) — les réceptions devaient être saisies dans Dolibarr.
  // ═══════════════════════════════════════════════════════════

  router.post('/entry', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const { product_id, qty, warehouse_id = 4, reason } = req.body;
      const q = parseInt(qty, 10);
      const wh = parseInt(warehouse_id, 10) || 4;
      if (!product_id || !q || q < 1) return res.status(400).json({ error: 'product_id et qty (> 0) requis' });
      if (q > 100000) return res.status(400).json({ error: 'Quantité trop élevée' });

      // Produit + entrepôt valides
      const [[product]] = await dolibarrPool.query(
        `SELECT rowid, ref, label FROM llx_product WHERE rowid = ?`, [product_id]
      );
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });
      const [[whRow]] = await dolibarrPool.query(
        `SELECT rowid FROM llx_entrepot WHERE rowid = ? AND statut = 1`, [wh]
      );
      if (!whRow) return res.status(400).json({ error: 'Entrepôt invalide ou inactif' });

      const adminApi = (await import('axios')).default.create({
        baseURL: process.env.DOLIBARR_URL,
        headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      // qty POSITIVE = entrée de stock (Dolibarr remappe le type interne).
      await adminApi.post('/stockmovements', {
        product_id: parseInt(product_id, 10),
        warehouse_id: wh,
        qty: Math.abs(q),
        movementcode: 'ENTREE',
        movementlabel: `Entrée stock — ${String(reason || '').slice(0, 80) || req.admin.username}`,
      });

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'stock_entry', `Entrée stock : ${product.ref} +${q} (dépôt ${wh})${reason ? ' — ' + reason : ''}`);
      console.log(`[STOCK] Entrée: ${product.ref} +${q} (dépôt ${wh}) par ${req.admin.username}`);

      res.json({ success: true, product_ref: product.ref, qty: q, warehouse_id: wh });
    } catch (err) {
      console.error('[STOCK] entry error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur entrée de stock' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // AJUSTEMENT D'INVENTAIRE (déphasage stock physique ↔ système)
  // L'utilisateur saisit la quantité PHYSIQUE réelle ; le système calcule
  // l'écart vs le stock du dépôt et applique un mouvement +/- (auto-correcteur,
  // aucun calcul mental). Accessible à TOUS les profils admin (libraire/vendeur
  // inclus) : la personne au rayon doit pouvoir corriger un écart immédiatement.
  // Tracé intégralement dans admin_activity_log.
  // ═══════════════════════════════════════════════════════════

  router.post('/adjust', auth, csrfProtection, async (req, res) => {
    try {
      const { product_id, warehouse_id = 4, counted_qty, reason } = req.body;
      const counted = parseInt(counted_qty, 10);
      const wh = parseInt(warehouse_id, 10) || 4;
      if (!product_id || !Number.isInteger(counted) || counted < 0) {
        return res.status(400).json({ error: 'product_id et counted_qty (entier ≥ 0) requis' });
      }
      if (counted > 100000) return res.status(400).json({ error: 'Quantité trop élevée' });

      const [[product]] = await dolibarrPool.query(
        `SELECT rowid, ref, label FROM llx_product WHERE rowid = ?`, [product_id]
      );
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });
      const [[whRow]] = await dolibarrPool.query(
        `SELECT rowid FROM llx_entrepot WHERE rowid = ? AND statut = 1`, [wh]
      );
      if (!whRow) return res.status(400).json({ error: 'Entrepôt invalide ou inactif' });

      // Stock système actuel POUR CE DÉPÔT (pas le global) : c'est ce qu'on corrige.
      const [[stockRow]] = await dolibarrPool.query(
        `SELECT reel FROM llx_product_stock WHERE fk_product = ? AND fk_entrepot = ?`, [product_id, wh]
      );
      const current = Number(stockRow?.reel || 0);
      const delta = counted - current;

      if (delta === 0) {
        return res.json({ success: true, product_ref: product.ref, current, counted, delta: 0, message: 'Stock déjà à jour' });
      }

      const adminApi = (await import('axios')).default.create({
        baseURL: process.env.DOLIBARR_URL,
        headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
      // Mouvement signé : delta > 0 = entrée (ENTREE), delta < 0 = sortie (SORTIE).
      await adminApi.post('/stockmovements', {
        product_id: parseInt(product_id, 10),
        warehouse_id: wh,
        qty: delta,
        movementcode: delta > 0 ? 'ENTREE' : 'SORTIE',
        movementlabel: `Ajustement inventaire (${current}→${counted}) — ${String(reason || '').slice(0, 60) || req.admin.username}`,
      });

      // Feedback immédiat : si le produit n'est plus en rupture, on solde les
      // alertes 'rupture'/'couverture_critique' ouvertes (le batch quotidien
      // recalculera le reste — stock_bas/point de commande selon les seuils).
      let resolvedAlerts = 0;
      if (counted > 0) {
        try {
          const r = db.prepare(
            `UPDATE stock_alerts SET status = 'resolved', resolved_at = ?
             WHERE product_id = ? AND status = 'open'
               AND alert_type IN ('rupture', 'couverture_critique')`
          ).run(new Date().toISOString(), product_id);
          resolvedAlerts = r.changes || 0;
        } catch { /* table absente : ignorer */ }
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'stock_adjust',
          `Ajustement : ${product.ref} ${current}→${counted} (${delta > 0 ? '+' : ''}${delta}, dépôt ${wh})${reason ? ' — ' + reason : ''}`);
      console.log(`[STOCK] Ajustement: ${product.ref} ${current}→${counted} (${delta > 0 ? '+' : ''}${delta}, dépôt ${wh}) par ${req.admin.username}`);

      res.json({ success: true, product_ref: product.ref, current, counted, delta, resolvedAlerts });
    } catch (err) {
      console.error('[STOCK] adjust error:', err.response?.data || err.message);
      res.status(500).json({ error: "Erreur d'ajustement de stock" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ENTREPÔTS — liste des dépôts actifs (+ stock du produit par dépôt)
  // Sert l'écran de transfert : voir où se trouve le stock avant de déplacer.
  // ═══════════════════════════════════════════════════════════

  router.get('/warehouses', auth, async (req, res) => {
    try {
      const pid = parseInt(req.query.product_id, 10);
      if (pid) {
        // Tous les entrepôts actifs + stock courant du produit dans chacun
        // (LEFT JOIN : un dépôt sans ligne de stock pour ce produit → reel 0).
        const [rows] = await dolibarrPool.query(
          `SELECT e.rowid AS id, e.ref, e.label, e.lieu, COALESCE(ps.reel, 0) AS reel
           FROM llx_entrepot e
           LEFT JOIN llx_product_stock ps ON ps.fk_entrepot = e.rowid AND ps.fk_product = ?
           WHERE e.statut = 1 ORDER BY e.ref`, [pid]
        );
        return res.json({ warehouses: rows, default_warehouse: 4 });
      }
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, lieu FROM llx_entrepot WHERE statut = 1 ORDER BY ref`
      );
      res.json({ warehouses: rows, default_warehouse: 4 });
    } catch (err) {
      console.error('[STOCK] warehouses error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des entrepôts' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TRANSFERT ENTRE ENTREPÔTS (circulation de livres dépôt → dépôt)
  // Réplique le « transfert de stock » natif Dolibarr : DEUX mouvements
  // appariés — une SORTIE de la source et une ENTRÉE en destination — reliés
  // par un code commun (équivalent de l'inventorycode d'un transfert Dolibarr).
  // Le stock global du produit est inchangé, seule sa répartition par dépôt bouge.
  // ═══════════════════════════════════════════════════════════

  router.post('/transfer', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const { product_id, qty, warehouse_source_id, warehouse_dest_id, reason } = req.body;
      const q = parseInt(qty, 10);
      const src = parseInt(warehouse_source_id, 10);
      const dst = parseInt(warehouse_dest_id, 10);
      if (!product_id || !q || q < 1) return res.status(400).json({ error: 'product_id et qty (> 0) requis' });
      if (q > 100000) return res.status(400).json({ error: 'Quantité trop élevée' });
      if (!src || !dst) return res.status(400).json({ error: 'Entrepôt source et destination requis' });
      if (src === dst) return res.status(400).json({ error: 'Les entrepôts source et destination doivent être différents' });

      // Produit + les deux entrepôts valides et actifs
      const [[product]] = await dolibarrPool.query(
        `SELECT rowid, ref, label FROM llx_product WHERE rowid = ?`, [product_id]
      );
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });
      const [whRows] = await dolibarrPool.query(
        `SELECT rowid, ref FROM llx_entrepot WHERE rowid IN (?, ?) AND statut = 1`, [src, dst]
      );
      const whMap = new Map(whRows.map(w => [w.rowid, w]));
      if (!whMap.has(src)) return res.status(400).json({ error: 'Entrepôt source invalide ou inactif' });
      if (!whMap.has(dst)) return res.status(400).json({ error: 'Entrepôt destination invalide ou inactif' });

      // Anti stock négatif : on ne déplace pas plus que ce qui est réellement en
      // source (comportement Dolibarr par défaut, hors STOCK_ALLOW_NEGATIVE).
      const [[srcStock]] = await dolibarrPool.query(
        `SELECT reel FROM llx_product_stock WHERE fk_product = ? AND fk_entrepot = ?`, [product_id, src]
      );
      const available = Number(srcStock?.reel || 0);
      if (available < q) {
        return res.status(400).json({ error: `Stock insuffisant dans « ${whMap.get(src).ref} » : ${available} disponible(s) pour ${q} demandé(s).` });
      }

      const adminApi = (await import('axios')).default.create({
        baseURL: process.env.DOLIBARR_URL,
        headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      // Code commun reliant les deux mouvements (TRF-AAMMJJ-XXXX) + libellé partagé.
      const stamp = new Date().toISOString().slice(2, 10).replace(/-/g, '');
      const trfCode = `TRF-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const lbl = `Transfert ${whMap.get(src).ref}→${whMap.get(dst).ref}${reason ? ' — ' + String(reason).slice(0, 60) : ''}`;
      const pidInt = parseInt(product_id, 10);

      // 1) SORTIE de la source (qty NÉGATIVE = décrément, cf. /adjust).
      let outId;
      try {
        const r = await adminApi.post('/stockmovements', {
          product_id: pidInt, warehouse_id: src, qty: -Math.abs(q),
          movementcode: trfCode, movementlabel: lbl,
        });
        outId = r.data;
      } catch (e) {
        console.error('[STOCK] transfer SORTIE error:', e.response?.data || e.message);
        return res.status(500).json({ error: 'Erreur lors de la sortie du stock source (rien déplacé)' });
      }

      // 2) ENTRÉE en destination (qty POSITIVE). Si elle échoue, on annule la
      //    sortie par un mouvement compensatoire pour ne pas perdre de stock.
      let inId;
      try {
        const r = await adminApi.post('/stockmovements', {
          product_id: pidInt, warehouse_id: dst, qty: Math.abs(q),
          movementcode: trfCode, movementlabel: lbl,
        });
        inId = r.data;
      } catch (e) {
        console.error('[STOCK] transfer ENTREE error → rollback SORTIE:', e.response?.data || e.message);
        try {
          await adminApi.post('/stockmovements', {
            product_id: pidInt, warehouse_id: src, qty: Math.abs(q),
            movementcode: trfCode + '-RB',
            movementlabel: `Annulation transfert (échec destination) — ${product.ref}`,
          });
        } catch (rbErr) {
          console.error('[STOCK] CRITIQUE: rollback transfert échoué (source décrémentée sans crédit destination):', rbErr.response?.data || rbErr.message);
          return res.status(500).json({ error: "Échec du transfert ET de son annulation. Un retrait a eu lieu en source — vérifiez le stock manuellement." });
        }
        return res.status(500).json({ error: "Erreur d'entrée en destination — transfert annulé, aucun stock déplacé." });
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'stock_transfer',
          `Transfert : ${product.ref} × ${q} ${whMap.get(src).ref}→${whMap.get(dst).ref}${reason ? ' — ' + reason : ''} [${trfCode}]`);
      console.log(`[STOCK] Transfert: ${product.ref} ×${q} ${whMap.get(src).ref}→${whMap.get(dst).ref} par ${req.admin.username} (${trfCode})`);

      res.json({
        success: true, product_ref: product.ref, qty: q, code: trfCode,
        source: whMap.get(src).ref, dest: whMap.get(dst).ref,
        movement_out: outId, movement_in: inId,
      });
    } catch (err) {
      console.error('[STOCK] transfer error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur lors du transfert de stock' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SUPPLIER ORDER (titre externe → commande fournisseur Dolibarr)
  // ═══════════════════════════════════════════════════════════

  const HARMATTAN_PARIS_ID = 959; // Les Éditions L'Harmattan (Paris)

  router.post('/order-supplier', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const { product_id, qty, supplier_id } = req.body;
      if (!product_id || !qty || qty < 1) return res.status(400).json({ error: 'product_id et qty requis' });

      // Charger le produit + éditeur + coûts Dolibarr (cost_price, pmp)
      const [[product]] = await dolibarrPool.query(
        `SELECT p.rowid, p.ref, p.label, p.price_ttc, p.cost_price, p.pmp, pe.editeur
         FROM llx_product p LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid = ?`, [product_id]
      );
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });

      // Déterminer le fournisseur automatiquement si non spécifié :
      //   1) éditeur L'Harmattan Paris → socid connu
      //   2) sinon, fournisseur principal du titre (supplier_products → suppliers)
      //   3) sinon erreur explicite (à renseigner dans l'écran Fournisseurs)
      let socid = supplier_id ? parseInt(supplier_id, 10) : null;
      if (!socid) {
        if (product.editeur === "L'Harmattan Paris" || product.editeur === "L'Harmattan") {
          socid = HARMATTAN_PARIS_ID;
        } else {
          const primary = db.prepare(
            `SELECT s.dolibarr_supplier_id FROM supplier_products sp
             JOIN suppliers s ON s.id = sp.supplier_id
             WHERE sp.product_id = ? AND s.active = 1
               AND s.dolibarr_supplier_id IS NOT NULL AND s.dolibarr_supplier_id != ''
             ORDER BY sp.is_primary DESC, s.priority_rank ASC LIMIT 1`
          ).get(product_id);
          if (primary?.dolibarr_supplier_id) socid = parseInt(primary.dolibarr_supplier_id, 10);
          else return res.status(400).json({ error: 'Aucun fournisseur défini pour ce titre. Renseignez un fournisseur principal (écran Fournisseurs) puis réessayez.' });
        }
      }

      // Créer la commande fournisseur via l'API Dolibarr
      const adminApi = (await import('axios')).default.create({
        baseURL: process.env.DOLIBARR_URL,
        headers: { 'DOLAPIKEY': process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      const orderRes = await adminApi.post('/supplierorders', {
        socid: parseInt(socid),
        date_commande: new Date().toISOString().split('T')[0],
        note_private: `Réappro auto depuis backoffice — ${req.admin.username}`,
      });
      const orderId = orderRes.data;

      // Prix d'achat réel, par ordre de préférence :
      //   1) tarif fournisseur négocié (supplier_products.purchase_price)
      //   2) coût Dolibarr (cost_price) puis PMP (prix moyen pondéré)
      //   3) à défaut seulement, estimation à 60% du prix public (signalée)
      const spRow = db.prepare(
        `SELECT sp.purchase_price FROM supplier_products sp
         JOIN suppliers s ON s.id = sp.supplier_id
         WHERE sp.product_id = ? AND s.dolibarr_supplier_id = ? AND sp.purchase_price > 0
         ORDER BY sp.is_primary DESC LIMIT 1`
      ).get(product_id, String(socid));
      let unitPrice, priceSource;
      if (spRow?.purchase_price > 0) { unitPrice = parseFloat(spRow.purchase_price); priceSource = 'tarif fournisseur'; }
      else if (parseFloat(product.cost_price) > 0) { unitPrice = parseFloat(product.cost_price); priceSource = 'coût Dolibarr'; }
      else if (parseFloat(product.pmp) > 0) { unitPrice = parseFloat(product.pmp); priceSource = 'PMP'; }
      else { unitPrice = Math.round(parseFloat(product.price_ttc) * 0.6); priceSource = 'estimation 60% PP'; }
      unitPrice = Math.max(0, unitPrice);
      const lineTotal = Math.round(unitPrice * qty);

      // Ajouter la ligne produit (via SQL car l'API REST ne supporte pas les lignes).
      // TVA 0 : les livres sont exonérés au Sénégal et les imports L'Harmattan Paris
      // sont en autoliquidation → total_ttc = total_ht.
      await dolibarrPool.query(
        `INSERT INTO llx_commande_fournisseurdet (fk_commande, fk_product, label, qty, subprice, total_ht, total_ttc, tva_tx, product_type, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        [orderId, product_id, String(product.label || '').slice(0, 255), qty, unitPrice, lineTotal, lineTotal, `Réappro: ${product.ref} ${product.label} (prix: ${priceSource})`]
      );

      // Mettre à jour les totaux de la commande
      await dolibarrPool.query(
        `UPDATE llx_commande_fournisseur SET total_ht = ?, total_ttc = ? WHERE rowid = ?`,
        [lineTotal, lineTotal, orderId]
      );

      // Valider la commande → réf définitive (pas de mouvement stock :
      // STOCK_CALCULATE_ON_SUPPLIER_VALIDATE_ORDER off). Si échec, on garde le brouillon.
      let finalRef = null;
      try {
        await adminApi.post(`/supplierorders/${orderId}/validate`);
      } catch (vErr) {
        console.warn('[STOCK] Validation commande fournisseur échouée (reste brouillon):', vErr.response?.data?.error?.message || vErr.message);
      }
      try {
        const detail = await adminApi.get(`/supplierorders/${orderId}`);
        finalRef = detail.data.ref;
      } catch { /* ref indisponible */ }
      finalRef = finalRef || `CF-${orderId}`;

      // Suivi local de la commande d'appro (liste « commandes en cours » + réception + stock_on_order)
      const localSupplier = db.prepare("SELECT id FROM suppliers WHERE dolibarr_supplier_id = ? AND active = 1").get(String(socid));
      const poId = recordPurchaseOrder({
        supplier_id: localSupplier?.id || 0,
        dolibarr_order_id: orderId,
        order_type: 'supplier',
        reference: finalRef,
        expected_at: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        amount: lineTotal,
        warehouse_id: 4,
        created_by: req.admin.username,
        lines: [{ product_id, ordered_qty: qty, unit_cost: unitPrice, line_total: lineTotal, product_label: product.label }],
      });

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'supplier_order', `Commande fournisseur : ${product.ref} × ${qty} → ${finalRef}`);

      console.log(`[STOCK] Commande fournisseur: ${finalRef} — ${product.ref} × ${qty} par ${req.admin.username}`);

      res.json({ success: true, order_ref: finalRef, order_id: orderId, po_id: poId, product_ref: product.ref, qty });
    } catch (err) {
      console.error('[STOCK] Supplier order error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur création commande fournisseur' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // COMMANDES D'APPRO — suivi local (liste, détail, réception)
  // ═══════════════════════════════════════════════════════════

  const PO_STATUS_LABELS = { ordered: 'En cours', partial: 'Reçue partiellement', received: 'Reçue', cancelled: 'Annulée' };

  function poLinesOf(poId) { return db.prepare('SELECT * FROM purchase_order_lines WHERE purchase_order_id = ?').all(poId); }
  function poToDto(o) {
    const lines = poLinesOf(o.id);
    const ordered = lines.reduce((s, l) => s + l.ordered_qty, 0);
    const received = lines.reduce((s, l) => s + l.received_qty, 0);
    return {
      ...o,
      status_label: PO_STATUS_LABELS[o.status] || o.status,
      supplier_label: o.order_type === 'reprint' ? 'Réimpression interne' : (o.supplier_name || 'Fournisseur'),
      lines, total_ordered: ordered, total_received: received,
      progress: ordered > 0 ? Math.round((received / ordered) * 100) : 0,
    };
  }

  router.get('/purchase-orders', auth, (req, res) => {
    try {
      const { status } = req.query;
      let where = '';
      const params = [];
      if (status === 'open') where = "WHERE po.status IN ('ordered','partial')";
      else if (status && PO_STATUS_LABELS[status]) { where = 'WHERE po.status = ?'; params.push(status); }
      const orders = db.prepare(
        `SELECT po.*, s.supplier_name FROM purchase_orders_local po
         LEFT JOIN suppliers s ON s.id = po.supplier_id
         ${where} ORDER BY po.created_at DESC LIMIT 300`
      ).all(...params);
      const counts = db.prepare('SELECT status, COUNT(*) n FROM purchase_orders_local GROUP BY status')
        .all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
      res.json({ orders: orders.map(poToDto), counts });
    } catch (err) {
      console.error('[STOCK] purchase-orders list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement commandes d\'appro' });
    }
  });

  router.get('/purchase-orders/:id', auth, (req, res) => {
    const o = db.prepare(
      `SELECT po.*, s.supplier_name FROM purchase_orders_local po
       LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`
    ).get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Commande introuvable' });
    res.json(poToDto(o));
  });

  // Réception : crédite le stock Dolibarr (entrée) et met à jour received_qty + statut.
  router.post('/purchase-orders/:id/receive', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const po = db.prepare('SELECT * FROM purchase_orders_local WHERE id = ?').get(req.params.id);
      if (!po) return res.status(404).json({ error: 'Commande introuvable' });
      if (po.status === 'received') return res.status(409).json({ error: 'Commande déjà entièrement reçue' });
      if (po.status === 'cancelled') return res.status(409).json({ error: 'Commande annulée' });

      const lines = poLinesOf(po.id);
      const body = req.body || {};
      // Map ligne→qty à recevoir : soit "full", soit lines[] explicite.
      const recvById = {};
      if (body.full) { for (const l of lines) recvById[l.id] = Math.max(0, l.ordered_qty - l.received_qty); }
      else { for (const r of (body.lines || [])) recvById[parseInt(r.line_id, 10)] = Math.max(0, parseInt(r.qty, 10) || 0); }

      const wh = po.warehouse_id || 4;
      const adminApi = (await import('axios')).default.create({
        baseURL: process.env.DOLIBARR_URL,
        headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      const moved = [], failed = [];
      for (const l of lines) {
        const recv = Math.min(recvById[l.id] || 0, l.ordered_qty - l.received_qty);
        if (recv <= 0) continue;
        try {
          await adminApi.post('/stockmovements', {
            product_id: l.product_id, warehouse_id: wh, qty: Math.abs(recv),
            movementcode: po.reference, movementlabel: `Réception ${po.reference}`,
          });
          const newRecv = l.received_qty + recv;
          db.prepare('UPDATE purchase_order_lines SET received_qty = ?, status = ? WHERE id = ?')
            .run(newRecv, newRecv >= l.ordered_qty ? 'received' : 'partial', l.id);
          moved.push({ product_id: l.product_id, qty: recv });
        } catch (e) {
          failed.push({ product_id: l.product_id, label: l.product_label, error: e.response?.data?.error?.message || e.message });
        }
      }

      if (moved.length === 0 && failed.length === 0) {
        return res.status(400).json({ error: 'Aucune quantité à réceptionner' });
      }

      const fresh = poLinesOf(po.id);
      const allRecv = fresh.every(l => l.received_qty >= l.ordered_qty);
      const someRecv = fresh.some(l => l.received_qty > 0);
      const newStatus = allRecv ? 'received' : someRecv ? 'partial' : 'ordered';
      db.prepare('UPDATE purchase_orders_local SET status = ?, received_at = ? WHERE id = ?')
        .run(newStatus, allRecv ? new Date().toISOString() : po.received_at, po.id);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'po_receive', `Réception ${po.reference} : ${moved.reduce((s, m) => s + m.qty, 0)} ex. (dépôt ${wh})`);

      res.json({ success: true, status: newStatus, moved: moved.length, failed });
    } catch (err) {
      console.error('[STOCK] receive error:', err.message);
      res.status(500).json({ error: 'Erreur réception' });
    }
  });

  // Annuler une commande d'appro (non encore reçue) — suivi local uniquement.
  router.post('/purchase-orders/:id/cancel', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    const po = db.prepare('SELECT * FROM purchase_orders_local WHERE id = ?').get(req.params.id);
    if (!po) return res.status(404).json({ error: 'Commande introuvable' });
    if (po.status === 'received') return res.status(409).json({ error: 'Commande déjà reçue' });
    db.prepare("UPDATE purchase_orders_local SET status = 'cancelled' WHERE id = ?").run(po.id);
    db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
      .run(req.admin.username, 'po_cancel', `Commande d'appro annulée : ${po.reference}`);
    res.json({ success: true });
  });

  return router;
}

// ═══════════════════════════════════════════════════════════
// SUPPLIERS ROUTER
// ═══════════════════════════════════════════════════════════

export function createSuppliersRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();

  // Migration ponctuelle : la version précédente synchronisait automatiquement
  // tous les tiers ayant fournisseur=1, ce qui a créé ~1500 faux fournisseurs
  // (le flag est pollué chez Sen Harmattan). On désactive ces lignes auto-créées
  // pour repartir d'une liste curée — l'utilisateur ré-ajoute via la recherche.
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (key TEXT PRIMARY KEY, run_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const cleanupKey = '2026-05-27_suppliers_curated';
  if (!db.prepare('SELECT 1 FROM _migrations WHERE key = ?').get(cleanupKey)) {
    db.prepare(
      "UPDATE suppliers SET active = 0 WHERE dolibarr_supplier_id IS NOT NULL AND dolibarr_supplier_id != ''",
    ).run();
    db.prepare('INSERT INTO _migrations (key) VALUES (?)').run(cleanupKey);
  }

  router.get('/', auth, async (req, res) => {
    // Liste curée : seuls les fournisseurs explicitement ajoutés (locaux) sont
    // retournés. Le flag Dolibarr fournisseur=1 n'est PAS utilisé comme source
    // (trop pollué). L'utilisateur ajoute via la recherche tiers + bouton.
    const suppliers = db.prepare(
      'SELECT * FROM suppliers WHERE active = 1 ORDER BY priority_rank ASC, supplier_name ASC',
    ).all();

    const linkedIds = suppliers
      .map((s) => parseInt(s.dolibarr_supplier_id))
      .filter((n) => !isNaN(n));
    let dolMap = new Map();
    if (linkedIds.length && dolibarrPool) {
      try {
        const placeholders = linkedIds.map(() => '?').join(',');
        const [rows] = await dolibarrPool.query(
          `SELECT rowid AS id, code_fournisseur, email, phone, town, zip
             FROM llx_societe WHERE rowid IN (${placeholders})`,
          linkedIds,
        );
        dolMap = new Map(rows.map((r) => [String(r.id), r]));
      } catch (err) {
        console.warn('[SUPPLIERS] Enrichissement Dolibarr échoué:', err.message);
      }
    }

    const enriched = suppliers.map((s) => {
      const d = s.dolibarr_supplier_id ? dolMap.get(String(s.dolibarr_supplier_id)) : null;
      return {
        ...s,
        dolibarr_code: d?.code_fournisseur || null,
        dolibarr_email: d?.email || null,
        dolibarr_phone: d?.phone || null,
        dolibarr_town: d?.town || null,
        dolibarr_zip: d?.zip || null,
      };
    });
    res.json(enriched);
  });

  // Recherche globale tiers Dolibarr (toutes catégories) pour promotion en
  // fournisseur. On indique already_supplier=true si déjà rattaché localement.
  router.get('/search-tiers', auth, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    try {
      const pat = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, name_alias, code_client, code_fournisseur,
                client, fournisseur, email, phone, town, zip
           FROM llx_societe
          WHERE status = 1
            AND (nom LIKE ? OR name_alias LIKE ? OR code_fournisseur LIKE ?
                 OR code_client LIKE ? OR email LIKE ? OR phone LIKE ?)
          ORDER BY nom ASC
          LIMIT 30`,
        [pat, pat, pat, pat, pat, pat],
      );
      const linked = new Set(
        db.prepare(
          "SELECT dolibarr_supplier_id FROM suppliers WHERE active = 1 AND dolibarr_supplier_id IS NOT NULL AND dolibarr_supplier_id != ''",
        ).all().map((r) => String(r.dolibarr_supplier_id)),
      );
      res.json({
        results: rows.map((r) => ({ ...r, already_supplier: linked.has(String(r.id)) })),
      });
    } catch (err) {
      console.error('[SUPPLIERS] search-tiers error:', err.message);
      res.status(500).json({ error: 'Erreur recherche' });
    }
  });

  // Promotion d'un tiers Dolibarr en fournisseur (crée la ligne locale + pose
  // le flag fournisseur=1 dans Dolibarr si absent).
  router.post('/from-tier/:dolibarrId', auth, csrfProtection, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    const dolId = parseInt(req.params.dolibarrId);
    if (!dolId) return res.status(400).json({ error: 'ID tiers invalide' });
    try {
      const [[tier]] = await dolibarrPool.query(
        'SELECT rowid AS id, nom, fournisseur FROM llx_societe WHERE rowid = ? AND status = 1',
        [dolId],
      );
      if (!tier) return res.status(404).json({ error: 'Tiers introuvable' });

      const dolIdStr = String(dolId);
      const existing = db.prepare('SELECT id, active FROM suppliers WHERE dolibarr_supplier_id = ?').get(dolIdStr);
      let localId;
      if (existing) {
        db.prepare('UPDATE suppliers SET active = 1, supplier_name = ? WHERE id = ?')
          .run(tier.nom || `Tier #${dolId}`, existing.id);
        localId = existing.id;
      } else {
        const result = db.prepare(
          `INSERT INTO suppliers (supplier_name, dolibarr_supplier_id, priority_rank, lead_time_avg_days, lead_time_max_days)
           VALUES (?, ?, 1, 14, 30)`,
        ).run(tier.nom || `Tier #${dolId}`, dolIdStr);
        localId = result.lastInsertRowid;
      }

      if (!tier.fournisseur) {
        try {
          await dolibarrPool.query('UPDATE llx_societe SET fournisseur = 1 WHERE rowid = ?', [dolId]);
        } catch (err) {
          console.warn('[SUPPLIERS] Flag Dolibarr non posé:', err.message);
        }
      }
      res.json({ success: true, id: localId });
    } catch (err) {
      console.error('[SUPPLIERS] from-tier error:', err.message);
      res.status(500).json({ error: 'Erreur ajout fournisseur' });
    }
  });

  router.get('/:id', auth, async (req, res) => {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Fournisseur introuvable' });
    // Liens fournisseur ↔ produit en local (SQLite).
    const links = db.prepare(
      `SELECT * FROM supplier_products WHERE supplier_id = ?`
    ).all(req.params.id);

    // Enrichissement depuis Dolibarr (MySQL) — requête séparée car
    // better-sqlite3 ne peut pas joindre une table externe.
    let products = links;
    if (links.length > 0) {
      try {
        const ids = links.map((l) => l.product_id);
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await dolibarrPool.query(
          `SELECT rowid AS id, ref, label, stock, price_ttc FROM llx_product WHERE rowid IN (${placeholders})`,
          ids,
        );
        const prodMap = new Map(rows.map((r) => [r.id, r]));
        products = links.map((l) => {
          const p = prodMap.get(l.product_id) || {};
          return { ...l, ref: p.ref || null, label: p.label || null, stock: p.stock ?? null, price_ttc: p.price_ttc ?? null };
        });
      } catch (err) {
        console.warn('[SUPPLIERS] Enrichissement Dolibarr échoué:', err.message);
      }
    }
    res.json({ ...supplier, products });
  });

  router.post('/', auth, csrfProtection, (req, res) => {
    const d = req.body;
    if (!d.supplier_name?.trim()) return res.status(400).json({ error: 'Nom du fournisseur requis' });
    const result = db.prepare(
      `INSERT INTO suppliers (supplier_name, dolibarr_supplier_id, priority_rank, lead_time_avg_days, lead_time_max_days, minimum_order_amount, minimum_order_qty, order_multiple, freight_free_threshold, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(d.supplier_name.trim(), d.dolibarr_supplier_id || null, d.priority_rank || 1, d.lead_time_avg_days || 14, d.lead_time_max_days || 30, d.minimum_order_amount || 0, d.minimum_order_qty || 0, d.order_multiple || 1, d.freight_free_threshold || 0, d.notes || '');
    res.json({ id: result.lastInsertRowid, success: true });
  });

  router.put('/:id', auth, csrfProtection, (req, res) => {
    const d = req.body;
    const existing = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Fournisseur introuvable' });
    db.prepare(
      `UPDATE suppliers SET supplier_name = ?, dolibarr_supplier_id = ?, priority_rank = ?,
       lead_time_avg_days = ?, lead_time_max_days = ?, minimum_order_amount = ?,
       minimum_order_qty = ?, order_multiple = ?, freight_free_threshold = ?,
       reliability_score = ?, quality_score = ?, cost_score = ?, notes = ?
       WHERE id = ?`
    ).run(d.supplier_name, d.dolibarr_supplier_id, d.priority_rank || 1, d.lead_time_avg_days || 14, d.lead_time_max_days || 30, d.minimum_order_amount || 0, d.minimum_order_qty || 0, d.order_multiple || 1, d.freight_free_threshold || 0, d.reliability_score || 0, d.quality_score || 0, d.cost_score || 0, d.notes || '', req.params.id);
    res.json({ success: true });
  });

  router.delete('/:id', auth, csrfProtection, (req, res) => {
    db.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Supplier-product links
  router.post('/:id/products', auth, csrfProtection, (req, res) => {
    const { product_id, purchase_price, supplier_sku, is_primary, lead_time_days_override } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id requis' });
    db.prepare(
      `INSERT OR REPLACE INTO supplier_products (product_id, supplier_id, purchase_price, supplier_sku, is_primary, lead_time_days_override)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(product_id, req.params.id, purchase_price || 0, supplier_sku || '', is_primary ? 1 : 0, lead_time_days_override || null);
    res.json({ success: true });
  });

  router.delete('/:id/products/:productId', auth, csrfProtection, (req, res) => {
    db.prepare('DELETE FROM supplier_products WHERE supplier_id = ? AND product_id = ?').run(req.params.id, req.params.productId);
    res.json({ success: true });
  });

  return router;
}
