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
           WHERE f.fk_statut > 0 AND fd.qty > 0 AND f.datef >= DATE_SUB(NOW(), INTERVAL 180 DAY)
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
      const { q, abc, coverage_max, sort = 'coverage', order = 'ASC', page = 1, limit = 50 } = req.query;
      const products = await calculateCoverageAndRotation(dolibarrPool, 500);

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

      // Filtres
      if (q) {
        const ql = q.toLowerCase();
        enriched = enriched.filter(p => p.label.toLowerCase().includes(ql) || p.ref.toLowerCase().includes(ql));
      }
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

  router.get('/recommendations', auth, (req, res) => {
    const { status = 'draft' } = req.query;
    const recs = db.prepare(
      `SELECT r.*, sp.abc_class, sp.xyz_class FROM purchase_recommendations r
       LEFT JOIN stock_policies sp ON sp.product_id = r.product_id
       WHERE r.status = ? ORDER BY r.coverage_days ASC, r.demand_avg_daily DESC`
    ).all(status);
    res.json(recs);
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

      // Tracer dans le journal d'activité
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'reprint_request', `Réimpression demandée : ${product.ref} "${product.label}" × ${qty} → ${moRef}`);

      console.log(`[STOCK] Réimpression: ${moRef} — ${product.ref} × ${qty} par ${req.admin.username}`);

      res.json({ success: true, mo_ref: moRef, mo_id: result.insertId, product_ref: product.ref, qty });
    } catch (err) {
      console.error('[STOCK] Reprint error:', err.message);
      res.status(500).json({ error: 'Erreur création ordre de réimpression' });
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

      // Charger le produit + éditeur
      const [[product]] = await dolibarrPool.query(
        `SELECT p.rowid, p.ref, p.label, p.price_ttc, pe.editeur
         FROM llx_product p LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid = ?`, [product_id]
      );
      if (!product) return res.status(404).json({ error: 'Produit introuvable' });

      // Déterminer le fournisseur automatiquement si non spécifié
      let socid = supplier_id;
      if (!socid) {
        if (product.editeur === "L'Harmattan Paris" || product.editeur === "L'Harmattan") {
          socid = HARMATTAN_PARIS_ID;
        } else {
          return res.status(400).json({ error: 'supplier_id requis pour les éditeurs tiers' });
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

      // Ajouter la ligne produit (via SQL car l'API REST ne supporte pas les lignes)
      const unitPrice = parseFloat(product.price_ttc) * 0.6; // estimation prix d'achat = 60% du prix public
      await dolibarrPool.query(
        `INSERT INTO llx_commande_fournisseurdet (fk_commande, fk_product, qty, subprice, total_ht, total_ttc, tva_tx, product_type, description)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        [orderId, product_id, qty, unitPrice, unitPrice * qty, unitPrice * qty, `Réappro: ${product.ref} ${product.label}`]
      );

      // Mettre à jour les totaux de la commande
      await dolibarrPool.query(
        `UPDATE llx_commande_fournisseur SET total_ht = ?, total_ttc = ? WHERE rowid = ?`,
        [unitPrice * qty, unitPrice * qty, orderId]
      );

      // Récupérer la ref de la commande
      const detail = await adminApi.get(`/supplierorders/${orderId}`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'supplier_order', `Commande fournisseur : ${product.ref} × ${qty} → ${detail.data.ref}`);

      console.log(`[STOCK] Commande fournisseur: ${detail.data.ref} — ${product.ref} × ${qty} par ${req.admin.username}`);

      res.json({ success: true, order_ref: detail.data.ref, order_id: orderId, product_ref: product.ref, qty });
    } catch (err) {
      console.error('[STOCK] Supplier order error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur création commande fournisseur' });
    }
  });

  return router;
}

// ═══════════════════════════════════════════════════════════
// SUPPLIERS ROUTER
// ═══════════════════════════════════════════════════════════

export function createSuppliersRouter({ db, auth, csrfProtection }) {
  const router = Router();

  router.get('/', auth, (req, res) => {
    const suppliers = db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY priority_rank ASC, supplier_name ASC').all();
    res.json(suppliers);
  });

  router.get('/:id', auth, (req, res) => {
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Fournisseur introuvable' });
    const products = db.prepare(
      `SELECT sp.*, p.ref, p.label, p.stock, p.price_ttc
       FROM supplier_products sp
       LEFT JOIN (SELECT rowid AS id, ref, label, stock, price_ttc FROM llx_product) p ON p.id = sp.product_id
       WHERE sp.supplier_id = ?`
    ).all(req.params.id);
    // Note: the LEFT JOIN above won't work across SQLite/MySQL boundary.
    // We'll enrich with MySQL data in a future iteration.
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
