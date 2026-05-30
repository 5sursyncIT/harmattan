/**
 * Stock Engine — Moteur de calcul pour le pilotage stock et réapprovisionnement.
 *
 * Responsabilités :
 * - Calcul de la demande moyenne (30j / 90j)
 * - Calcul du stock de sécurité, point de commande, couverture
 * - Classification ABC/XYZ
 * - Génération d'alertes automatiques
 * - KPIs de santé stock
 */

import { excludedCategorySqlList } from '../src/utils/excludedCategories.js';

// ─── DEMAND CALCULATION ────────────────────────────────────

/**
 * Calcule la demande moyenne journalière sur une période donnée.
 * Source : lignes de factures validées (llx_facturedet + llx_facture).
 */
export async function calculateDemandAvg(dolibarrPool, productId, days = 30) {
  const [rows] = await dolibarrPool.query(
    `SELECT COALESCE(SUM(fd.qty), 0) AS total_sold
     FROM llx_facturedet fd
     JOIN llx_facture f ON f.rowid = fd.fk_facture
     WHERE fd.fk_product = ? AND f.fk_statut IN (1, 2) AND f.type = 0 AND fd.qty > 0
       AND f.datef >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [productId, days]
  );
  return (rows[0]?.total_sold || 0) / days;
}

/**
 * Calcule la demande moyenne pour tous les produits actifs (batch).
 */
export async function calculateDemandBatch(dolibarrPool, days = 30) {
  const [rows] = await dolibarrPool.query(
    `SELECT fd.fk_product AS product_id, SUM(fd.qty) AS total_sold
     FROM llx_facturedet fd
     JOIN llx_facture f ON f.rowid = fd.fk_facture
     WHERE f.fk_statut IN (1, 2) AND f.type = 0 AND fd.qty > 0 AND fd.fk_product IS NOT NULL
       AND f.datef >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY fd.fk_product`,
    [days]
  );
  const map = new Map();
  for (const r of rows) map.set(r.product_id, r.total_sold / days);
  return map;
}

/**
 * Calcule l'écart-type de la demande journalière (pour stock de sécurité avancé).
 */
export async function calculateDemandStdDev(dolibarrPool, productId, days = 90) {
  const [rows] = await dolibarrPool.query(
    `SELECT DATE(f.datef) AS sale_date, SUM(fd.qty) AS daily_qty
     FROM llx_facturedet fd
     JOIN llx_facture f ON f.rowid = fd.fk_facture
     WHERE fd.fk_product = ? AND f.fk_statut IN (1, 2) AND f.type = 0 AND fd.qty > 0
       AND f.datef >= DATE_SUB(NOW(), INTERVAL ? DAY)
     GROUP BY DATE(f.datef)`,
    [productId, days]
  );
  if (rows.length < 2) return 0;
  const values = rows.map(r => r.daily_qty);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

// ─── LEAD TIME BY PUBLISHER TYPE ────────────────────────────

/**
 * Délai d'approvisionnement par défaut selon le type d'éditeur.
 * - Édité en interne : réimpression locale (14j)
 * - L'Harmattan Paris : expédition maritime/aérien (45j)
 * - Autre éditeur : variable, plus long (60j)
 */
const LEAD_TIME_BY_PUBLISHER = {
  "L'Harmattan Sénégal": 14,  // Réimpression interne
  "L'Harmattan Paris": 45,    // Commande groupe + expédition
  "L'Harmattan": 45,          // Idem Paris
  'Autre': 60,                // Fournisseur tiers
};

const SAFETY_DAYS_BY_PUBLISHER = {
  "L'Harmattan Sénégal": 7,
  "L'Harmattan Paris": 21,
  "L'Harmattan": 21,
  'Autre': 30,
};

/**
 * Détermine le type de réapprovisionnement selon l'éditeur.
 * - 'reimpression' = titre édité en interne → ordre de fabrication
 * - 'commande' = titre acheté → commande fournisseur
 */
export function getSupplyType(editeur) {
  if (editeur === "L'Harmattan Sénégal") return 'reimpression';
  return 'commande';
}

export function getDefaultLeadTime(editeur) {
  return LEAD_TIME_BY_PUBLISHER[editeur] || 60;
}

export function getDefaultSafetyDays(editeur) {
  return SAFETY_DAYS_BY_PUBLISHER[editeur] || 30;
}

// ─── STOCK CALCULATIONS ────────────────────────────────────

/**
 * Stock de sécurité — version simple.
 * SS = demande_moy_jour × marge_securite_jours
 */
export function safetyStockSimple(demandAvgDaily, safetyDays = 7) {
  return Math.ceil(demandAvgDaily * safetyDays);
}

/**
 * Stock de sécurité — version statistique.
 * SS = z × σ(demande) × √(lead_time)
 * z = 1.65 pour 95% de service, 2.33 pour 99%
 */
export function safetyStockStatistical(demandStdDev, leadTimeDays, serviceLevel = 0.95) {
  const zTable = { 0.9: 1.28, 0.95: 1.65, 0.97: 1.88, 0.99: 2.33 };
  const z = zTable[serviceLevel] || 1.65;
  return Math.ceil(z * demandStdDev * Math.sqrt(leadTimeDays));
}

/**
 * Point de commande (Reorder Point).
 * ROP = (demande_moy × lead_time) + stock_securite
 */
export function reorderPoint(demandAvgDaily, leadTimeDays, safetyStock) {
  return Math.ceil(demandAvgDaily * leadTimeDays + safetyStock);
}

/**
 * Couverture de stock en jours.
 * Coverage = stock_dispo / demande_moy_jour
 */
export function coverageDays(stockOnHand, demandAvgDaily) {
  if (demandAvgDaily <= 0) return stockOnHand > 0 ? 999 : 0;
  return Math.round(stockOnHand / demandAvgDaily);
}

/**
 * Quantité économique de commande (EOQ).
 * EOQ = √((2 × D × S) / H)
 */
export function eoq(annualDemand, orderCost = 5000, holdingCostPerUnit = 500) {
  if (annualDemand <= 0 || holdingCostPerUnit <= 0) return 1;
  return Math.ceil(Math.sqrt((2 * annualDemand * orderCost) / holdingCostPerUnit));
}

/**
 * Quantité de réappro recommandée.
 * Arrondi au multiple de commande si spécifié.
 */
export function recommendedQty(reorderPoint, stockOnHand, maxStockTarget, minOrderQty = 1, orderMultiple = 1) {
  let qty = Math.max(0, reorderPoint - stockOnHand);
  if (maxStockTarget > 0) qty = Math.min(qty, maxStockTarget - stockOnHand);
  qty = Math.max(qty, minOrderQty);
  if (orderMultiple > 1) qty = Math.ceil(qty / orderMultiple) * orderMultiple;
  return Math.max(0, qty);
}

// ─── ABC/XYZ CLASSIFICATION ────────────────────────────────

/**
 * Classification ABC par contribution au chiffre d'affaires.
 * A = top 80% du CA, B = 80-95%, C = 95-100%
 */
export function classifyABC(products) {
  const sorted = [...products].sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = sorted.reduce((s, p) => s + p.revenue, 0);
  if (totalRevenue === 0) return sorted.map(p => ({ ...p, abc_class: 'C' }));

  let cumulative = 0;
  return sorted.map(p => {
    cumulative += p.revenue;
    const pct = cumulative / totalRevenue;
    return { ...p, abc_class: pct <= 0.8 ? 'A' : pct <= 0.95 ? 'B' : 'C' };
  });
}

/**
 * Classification XYZ par variabilité de la demande.
 * X = CV < 0.5 (régulier), Y = 0.5-1.0 (variable), Z = > 1.0 (erratique)
 */
export function classifyXYZ(products) {
  return products.map(p => {
    const cv = p.demandAvg > 0 ? p.demandStdDev / p.demandAvg : 999;
    return { ...p, xyz_class: cv < 0.5 ? 'X' : cv < 1.0 ? 'Y' : 'Z' };
  });
}

// ─── ALERT GENERATION ──────────────────────────────────────

/**
 * Génère les alertes stock pour un ensemble de produits.
 * Retourne un tableau d'alertes à insérer.
 */
export function generateAlerts(products) {
  const alerts = [];
  const now = new Date().toISOString();

  for (const p of products) {
    const {
      product_id, warehouse_id, stock, demandAvgDaily, safetyStock: ss, reorderPt, coverage,
      maxStockTarget, minOrderQty = 1, orderMultiple = 1,
    } = p;
    const base = { product_id, warehouse_id: warehouse_id || null, created_at: now };
    const hasDemand = demandAvgDaily > 0;
    // Quantité de réappro bornée (≥ 0) + conditionnement/min/max éventuels.
    const qty = recommendedQty(reorderPt, stock, maxStockTarget, minOrderQty, orderMultiple);

    // UNE SEULE alerte par produit, par priorité décroissante (évite le bruit :
    // un produit sous le seuil était auparavant signalé 2-3 fois simultanément).
    let alert = null;
    if (stock <= 0 && hasDemand) {
      alert = { alert_type: 'rupture', severity: 'critique', coverage_days: 0, recommended_qty: Math.max(qty, minOrderQty, 1) };
    } else if (hasDemand && coverage > 0 && coverage <= 7) {
      alert = { alert_type: 'couverture_critique', severity: coverage <= 3 ? 'critique' : 'haute', coverage_days: coverage, recommended_qty: Math.max(qty, 1) };
    } else if (hasDemand && stock <= ss) {
      alert = { alert_type: 'stock_bas', severity: 'haute', coverage_days: coverage, recommended_qty: Math.max(qty, 1) };
    } else if (hasDemand && stock <= reorderPt) {
      alert = { alert_type: 'sous_point_de_commande', severity: 'moyenne', coverage_days: coverage, recommended_qty: Math.max(qty, 1) };
    } else if ((maxStockTarget > 0 && stock > maxStockTarget * 2) || (hasDemand && coverage > 365)) {
      alert = { alert_type: 'surstock', severity: 'moyenne', coverage_days: coverage, recommended_qty: 0 };
    } else if (stock > 0 && !hasDemand) {
      alert = { alert_type: 'stock_dormant', severity: 'information', coverage_days: 999, recommended_qty: 0 };
    }

    if (alert) {
      alerts.push({
        ...base,
        ...alert,
        current_stock: stock,
        reorder_point_snapshot: alert.alert_type === 'stock_dormant' ? 0 : reorderPt,
      });
    }
  }

  return alerts;
}

// ─── BATCH KPI CALCULATIONS ────────────────────────────────

/**
 * Calcule les KPIs exécutifs de santé stock.
 */
export async function calculateStockKPIs(dolibarrPool) {
  // Stock total par dépôt
  const [stockByWarehouse] = await dolibarrPool.query(
    `SELECT e.ref AS warehouse, e.rowid AS warehouse_id,
            COUNT(DISTINCT ps.fk_product) AS products,
            COALESCE(SUM(ps.reel), 0) AS total_units
     FROM llx_product_stock ps
     JOIN llx_entrepot e ON e.rowid = ps.fk_entrepot
     WHERE e.statut = 1
     GROUP BY e.rowid`
  );

  // Valeur stock au prix public — basé sur p.stock global (source de vérité unique).
  // Évite les doublons que produisait l'agrégat depuis llx_product_stock (un produit
  // présent dans N dépôts y apparaît N fois), et garde les KPIs cohérents avec les
  // requêtes ruptures/stock_bas plus bas qui interrogent aussi p.stock.
  const [[stockValue]] = await dolibarrPool.query(
    `SELECT COALESCE(SUM(p.stock * p.price_ttc), 0) AS value_public,
            COUNT(*) AS total_products,
            COALESCE(SUM(p.stock), 0) AS total_units
     FROM llx_product p
     WHERE p.tosell = 1 AND p.stock > 0`
  );

  // Produits en rupture
  const [[ruptures]] = await dolibarrPool.query(
    `SELECT COUNT(*) AS count FROM llx_product p
     WHERE p.tosell = 1 AND p.stock <= 0`
  );

  // Produits en stock bas (< 5 unités mais > 0)
  const [[stockBas]] = await dolibarrPool.query(
    `SELECT COUNT(*) AS count FROM llx_product p
     WHERE p.tosell = 1 AND p.stock > 0 AND p.stock < 5`
  );

  // Total actifs
  const [[totalActifs]] = await dolibarrPool.query(
    `SELECT COUNT(*) AS count FROM llx_product WHERE tosell = 1`
  );

  // Taux de rupture
  const tauxRupture = totalActifs.count > 0
    ? Math.round((ruptures.count / totalActifs.count) * 1000) / 10
    : 0;

  return {
    total_products: totalActifs.count,
    total_units: stockValue.total_units,
    value_public: Math.round(stockValue.value_public),
    products_in_stock: stockValue.total_products,
    ruptures: ruptures.count,
    stock_bas: stockBas.count,
    taux_rupture: tauxRupture,
    by_warehouse: stockByWarehouse.map(w => ({
      id: w.warehouse_id,
      name: w.warehouse,
      products: w.products,
      units: w.total_units,
    })),
  };
}

/**
 * Calcule la couverture et rotation pour les top produits vendus.
 */
export async function calculateCoverageAndRotation(dolibarrPool, limit = 100, opts = {}) {
  // Si `search` est fourni, on cherche dans TOUT le catalogue (ref/titre/ISBN) et on
  // trie par pertinence (titre) plutôt que par ventes — sinon un titre hors top-ventes
  // était introuvable. Sans search : top produits par ventes 30j (comportement initial).
  const search = String(opts.search || '').trim();
  const params = [];
  let whereExtra = '';
  let orderBy = 'COALESCE(sales.total_30, 0) DESC';
  if (search) {
    const pat = `%${search.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    whereExtra = ' AND (p.ref LIKE ? OR p.label LIKE ? OR p.barcode LIKE ?)';
    params.push(pat, pat, pat);
    orderBy = 'p.label ASC';
  }
  params.push(limit);

  const [rows] = await dolibarrPool.query(
    `SELECT p.rowid AS product_id, p.ref, p.label, p.price_ttc, p.stock AS stock_reel,
            COALESCE(sales.total_30, 0) AS sold_30d,
            COALESCE(sales.total_90, 0) AS sold_90d,
            pe.editeur,
            (SELECT c.label FROM llx_categorie c
             INNER JOIN llx_categorie_product cp ON cp.fk_categorie = c.rowid
             WHERE cp.fk_product = p.rowid
             AND c.label NOT IN (${excludedCategorySqlList()})
             LIMIT 1) AS category
     FROM llx_product p
     LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
     LEFT JOIN (
       SELECT fd.fk_product,
              SUM(CASE WHEN f.datef >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN fd.qty ELSE 0 END) AS total_30,
              SUM(fd.qty) AS total_90
       FROM llx_facturedet fd
       JOIN llx_facture f ON f.rowid = fd.fk_facture
       WHERE f.fk_statut IN (1, 2) AND f.type = 0 AND fd.qty > 0
         AND f.datef >= DATE_SUB(NOW(), INTERVAL 90 DAY)
       GROUP BY fd.fk_product
     ) sales ON sales.fk_product = p.rowid
     WHERE p.tosell = 1${whereExtra}
     ORDER BY ${orderBy}
     LIMIT ?`,
    params
  );

  return rows.map(r => {
    const demandAvg30 = r.sold_30d / 30;
    const demandAvg90 = r.sold_90d / 90;
    const demandAvg = demandAvg30 > 0 ? demandAvg30 : demandAvg90;
    const coverage = coverageDays(r.stock_reel, demandAvg);
    const rotation = r.stock_reel > 0 ? Math.round((r.sold_90d * 4 / r.stock_reel) * 10) / 10 : 0;

    return {
      product_id: r.product_id,
      ref: r.ref,
      label: r.label,
      category: r.category,
      editeur: r.editeur || 'Autre',
      supply_type: getSupplyType(r.editeur),
      price_ttc: r.price_ttc,
      stock: r.stock_reel,
      sold_30d: r.sold_30d,
      sold_90d: r.sold_90d,
      demand_avg_daily: Math.round(demandAvg * 100) / 100,
      coverage_days: coverage,
      rotation_annual: rotation,
    };
  });
}

/**
 * Recalcul batch complet — appelé par le cron quotidien.
 * Retourne les produits enrichis avec métriques + alertes générées.
 */
export async function runDailyBatch(dolibarrPool, db) {
  const demand30 = await calculateDemandBatch(dolibarrPool, 30);
  const demand90 = await calculateDemandBatch(dolibarrPool, 90);

  // Charger les politiques stock existantes
  let policies;
  try {
    policies = db.prepare('SELECT * FROM stock_policies').all();
  } catch {
    policies = [];
  }
  const policyMap = new Map(policies.map(p => [p.product_id, p]));

  // Charger le stock actuel + éditeur depuis Dolibarr
  const [stockRows] = await dolibarrPool.query(
    `SELECT p.rowid AS product_id, p.ref, p.label, p.stock AS total_stock,
            p.price_ttc, p.tosell, pe.editeur
     FROM llx_product p
     LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
     WHERE p.tosell = 1`
  );

  const enriched = [];
  for (const p of stockRows) {
    const d30 = demand30.get(p.product_id) || 0;
    const d90 = demand90.get(p.product_id) || 0;
    const demandAvg = d30 > 0 ? d30 : d90;
    const policy = policyMap.get(p.product_id);
    const editeur = p.editeur || 'Autre';

    // Lead time et sécurité différenciés selon l'éditeur
    const leadTime = policy?.lead_time_days || getDefaultLeadTime(editeur);
    const safetyDays = getDefaultSafetyDays(editeur);
    const ss = policy?.safety_stock ?? safetyStockSimple(demandAvg, safetyDays);
    const rop = policy?.reorder_point ?? reorderPoint(demandAvg, leadTime, ss);
    const cov = coverageDays(p.total_stock, demandAvg);
    const maxStock = policy?.max_stock_target || 0;

    enriched.push({
      product_id: p.product_id,
      ref: p.ref,
      label: p.label,
      stock: p.total_stock,
      price_ttc: p.price_ttc,
      editeur,
      supply_type: getSupplyType(editeur),
      demandAvgDaily: demandAvg,
      leadTimeDays: leadTime,
      safetyStock: ss,
      reorderPt: rop,
      coverage: cov,
      maxStockTarget: maxStock,
      minOrderQty: policy?.min_order_qty || 1,
      orderMultiple: policy?.order_multiple || 1,
      abc_class: policy?.abc_class || null,
      warehouse_id: null,
    });
  }

  // Générer les alertes (une par produit)
  const alerts = generateAlerts(enriched);

  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  // Quantités déjà commandées et non encore reçues (anti double-commande) :
  // on additionne stock physique + stock en commande avant de décider d'un réappro.
  let onOrderMap = new Map();
  try {
    const rows = db.prepare(
      `SELECT l.product_id AS pid, SUM(l.ordered_qty - l.received_qty) AS qty
       FROM purchase_order_lines l
       JOIN purchase_orders_local po ON po.id = l.purchase_order_id
       WHERE po.status IN ('ordered','partial')
       GROUP BY l.product_id`
    ).all();
    onOrderMap = new Map(rows.map(r => [r.pid, Math.max(0, r.qty || 0)]));
  } catch { /* tables d'appro pas encore créées */ }

  // Recommandations d'achat : produits dont (stock + en commande) est sous le point de
  // commande, avec une demande réelle et une quantité de réappro > 0. status='draft'.
  const recommendations = enriched
    .map(p => {
      const onOrder = onOrderMap.get(p.product_id) || 0;
      const effective = p.stock + onOrder; // déjà couvert par le stock + les commandes en cours
      if (!(p.demandAvgDaily > 0) || effective > p.reorderPt) return null;
      const qty = recommendedQty(p.reorderPt, effective, p.maxStockTarget, p.minOrderQty, p.orderMultiple);
      if (qty <= 0) return null;
      const expected = new Date(Date.now() + (p.leadTimeDays || 14) * 86400000).toISOString().slice(0, 10);
      return {
        product_id: p.product_id,
        recommended_qty: qty,
        recommended_order_date: today,
        expected_receipt_date: expected,
        reason_code: p.stock <= 0 ? 'rupture' : (p.stock <= p.safetyStock ? 'stock_bas' : 'sous_point_de_commande'),
        demand_avg_daily: p.demandAvgDaily,
        coverage_days: p.coverage,
        stock_on_hand: p.stock,
        stock_on_order: onOrder,
      };
    })
    .filter(Boolean);

  // Statements
  const insertAlert = db.prepare(
    `INSERT INTO stock_alerts (product_id, warehouse_id, alert_type, severity, current_stock, coverage_days, reorder_point_snapshot, recommended_qty, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  );
  // Ne pas recréer un doublon si une alerte 'open' OU 'acknowledged' existe déjà
  // pour ce produit (sinon une alerte acquittée par l'utilisateur réapparaissait).
  const checkExisting = db.prepare(
    `SELECT id FROM stock_alerts WHERE product_id = ? AND alert_type = ? AND status IN ('open','acknowledged') LIMIT 1`
  );
  const resolveStmt = db.prepare(`UPDATE stock_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?`);
  const insertReco = db.prepare(
    `INSERT INTO purchase_recommendations (product_id, recommended_qty, recommended_order_date, expected_receipt_date, reason_code, demand_avg_daily, coverage_days, stock_on_hand, stock_on_order, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`
  );

  const activeAlertKeys = new Set(alerts.map(a => `${a.product_id}:${a.alert_type}`));
  const openAlerts = db.prepare(`SELECT id, product_id, alert_type FROM stock_alerts WHERE status = 'open'`).all();

  let newAlertCount = 0, resolvedCount = 0;
  // Tout en une transaction (atomicité + performance).
  const persist = db.transaction(() => {
    for (const a of alerts) {
      if (!checkExisting.get(a.product_id, a.alert_type)) {
        insertAlert.run(a.product_id, a.warehouse_id, a.alert_type, a.severity, a.current_stock, a.coverage_days, a.reorder_point_snapshot, a.recommended_qty, a.created_at);
        newAlertCount++;
      }
    }
    // Auto-résoudre les alertes 'open' dont la condition n'est plus active.
    // (On ne touche pas aux 'acknowledged'/'ignored' : gérées par l'utilisateur.)
    for (const oa of openAlerts) {
      if (!activeAlertKeys.has(`${oa.product_id}:${oa.alert_type}`)) {
        resolveStmt.run(nowIso, oa.id);
        resolvedCount++;
      }
    }
    // Recommandations : on régénère les brouillons à chaque batch (les approuvées/
    // annulées sont conservées telles quelles).
    db.prepare(`DELETE FROM purchase_recommendations WHERE status = 'draft'`).run();
    for (const r of recommendations) {
      insertReco.run(r.product_id, r.recommended_qty, r.recommended_order_date, r.expected_receipt_date, r.reason_code, r.demand_avg_daily, r.coverage_days, r.stock_on_hand, r.stock_on_order, nowIso);
    }
  });
  persist();

  console.log(`[STOCK] Batch: ${enriched.length} produits, ${newAlertCount} nouvelles alertes, ${resolvedCount} résolues, ${recommendations.length} recommandations`);
  return { products: enriched.length, newAlerts: newAlertCount, resolved: resolvedCount, recommendations: recommendations.length };
}

/**
 * Classification ABC/XYZ batch — appelé par le cron hebdomadaire.
 */
export async function runClassificationBatch(dolibarrPool, db) {
  // Revenus 90j par produit
  const [revenueRows] = await dolibarrPool.query(
    `SELECT fd.fk_product AS product_id, SUM(fd.total_ttc) AS revenue, SUM(fd.qty) AS qty
     FROM llx_facturedet fd
     JOIN llx_facture f ON f.rowid = fd.fk_facture
     WHERE f.fk_statut IN (1, 2) AND f.type = 0 AND fd.qty > 0 AND fd.fk_product IS NOT NULL
       AND f.datef >= DATE_SUB(NOW(), INTERVAL 90 DAY)
     GROUP BY fd.fk_product`
  );

  // ABC
  const withRevenue = revenueRows.map(r => ({ product_id: r.product_id, revenue: r.revenue, qty: r.qty }));
  const abcClassified = classifyABC(withRevenue);

  // XYZ — calculer la variabilité journalière sur 90j
  const [dailySales] = await dolibarrPool.query(
    `SELECT fd.fk_product AS product_id, DATE(f.datef) AS d, SUM(fd.qty) AS daily_qty
     FROM llx_facturedet fd
     JOIN llx_facture f ON f.rowid = fd.fk_facture
     WHERE f.fk_statut IN (1, 2) AND f.type = 0 AND fd.qty > 0 AND fd.fk_product IS NOT NULL
       AND f.datef >= DATE_SUB(NOW(), INTERVAL 90 DAY)
     GROUP BY fd.fk_product, DATE(f.datef)`
  );

  const dailyMap = new Map();
  for (const r of dailySales) {
    if (!dailyMap.has(r.product_id)) dailyMap.set(r.product_id, []);
    dailyMap.get(r.product_id).push(r.daily_qty);
  }

  // CV calculé sur la fenêtre COMPLÈTE de 90 jours (les jours sans vente comptent
  // comme 0). Sans ça, ne considérer que les jours de vente sous-estime fortement la
  // variabilité et classe à tort des titres erratiques en « X » (régulier).
  const WINDOW_DAYS = 90;
  const xyzData = abcClassified.map(p => {
    const values = dailyMap.get(p.product_id) || []; // quantités des jours AVEC vente
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / WINDOW_DAYS;
    // Somme des carrés des écarts sur les 90 jours : jours de vente + jours à 0.
    const ssqSaleDays = values.reduce((s, v) => s + (v - mean) ** 2, 0);
    const zeroDays = Math.max(0, WINDOW_DAYS - values.length);
    const ssq = ssqSaleDays + zeroDays * (mean ** 2);
    const variance = WINDOW_DAYS > 1 ? ssq / (WINDOW_DAYS - 1) : 0;
    return { ...p, demandAvg: mean, demandStdDev: Math.sqrt(variance) };
  });
  const fullClassified = classifyXYZ(xyzData);

  // Persister dans stock_policies (upsert)
  const upsert = db.prepare(
    `INSERT INTO stock_policies (product_id, abc_class, xyz_class, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_id) DO UPDATE SET abc_class = excluded.abc_class, xyz_class = excluded.xyz_class, updated_at = excluded.updated_at`
  );

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const p of fullClassified) {
      upsert.run(p.product_id, p.abc_class, p.xyz_class, now);
    }
  });
  tx();

  console.log(`[STOCK] Classification: ${fullClassified.length} produits classifiés ABC/XYZ`);
  return { classified: fullClassified.length };
}
