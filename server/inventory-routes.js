/**
 * Inventaire physique (comptage de stock) — API routes natives.
 * Monté sur /api/admin/inventory.
 *
 * Réimplémentation native du module Inventory de Dolibarr (le module Dolibarr
 * n'a PAS d'API REST et on ne touche jamais l'UI Dolibarr — backend only).
 *
 * Mécanique reproduite à l'identique :
 *  1. Création d'une session avec un PÉRIMÈTRE (entrepôt complet / catégorie /
 *     éditeur / sélection manuelle).
 *  2. Démarrage (`/start`) = SNAPSHOT : on fige le stock théorique courant
 *     (llx_product_stock.reel) dans qty_snapshot, ligne par ligne.
 *  3. Comptage : on remplit qty_counted (scan ISBN / saisie manuelle / import CSV).
 *  4. Clôture (`/close`) = pour chaque ligne comptée, écart = compté − stock
 *     COURANT à la clôture (PAS le snapshot : compense les ventes POS survenues
 *     pendant le comptage), puis mouvement de stock signé via l'API Dolibarr.
 *     Une ligne NON comptée est ignorée (jamais mise à 0), sauf option explicite.
 */

import { Router } from 'express';
import axios from 'axios';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { runDailyBatch } from './stock-engine.js';

const DEFAULT_WAREHOUSE = 4; // « Rayon » (cf. llx_entrepot) — défaut du reste de l'app
const SCOPES = new Set(['warehouse', 'category', 'publisher', 'manual']);
const MAX_SNAPSHOT = 50000; // garde-fou anti-emballement sur un inventaire complet

// ─── Rapport (CSV / PDF) ──────────────────────────────────────
const EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || "L'Harmattan Sénégal";
const FOOTER_LEGAL = "L'HARMATTAN SENEGAL SARL – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";
const INV_PRIMARY = '#1e40af';
const INV_MUTED = '#6b7280';
const MAX_PDF_ROWS = 1200; // au-delà, le PDF tronque (le CSV reste exhaustif)

const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const fmtF = (n) => `${Math.round(n || 0).toLocaleString('fr-FR')} F`;
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

// Neutralisation de l'injection de formules + échappement CSV.
// On EXCLUT les nombres purs de la garde (sinon un écart « -2 » deviendrait le
// texte « '-2 » et Excel ne le compterait pas comme nombre).
function escCsv(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_BOM = String.fromCharCode(0xFEFF); // BOM UTF-8 pour Excel/LibreOffice
function toCsv(headers, rows) {
  const headerLine = headers.map(h => escCsv(h.label)).join(',');
  const dataLines = rows.map(r => headers.map(h => escCsv(typeof h.get === 'function' ? h.get(r) : r[h.key])).join(','));
  return CSV_BOM + headerLine + '\n' + dataLines.join('\n');
}

export function createInventoryRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();

  // Libraire : peut consulter et COMPTER, mais pas créer / démarrer / clôturer.
  function blockLibrarianWrite(req, res, next) {
    if (req.admin?.role === 'librarian') return res.status(403).json({ error: 'Accès en lecture seule pour votre profil' });
    next();
  }

  function makeAdminApi() {
    return axios.create({
      baseURL: process.env.DOLIBARR_URL,
      headers: { DOLAPIKEY: process.env.DOLIBARR_ADMIN_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
  }

  // ─── Tables SQLite ────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS inventory_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    title TEXT,
    warehouse_id INTEGER NOT NULL,
    scope_type TEXT NOT NULL DEFAULT 'manual',   -- warehouse|category|publisher|manual
    scope_value TEXT,                             -- id catégorie / nom éditeur / NULL
    scope_label TEXT,                             -- libellé lisible (affichage)
    status TEXT NOT NULL DEFAULT 'draft',         -- draft|counting|closed|canceled
    treat_uncounted_as_zero INTEGER DEFAULT 0,    -- non-comptés présumés à 0 (DANGER, off par défaut)
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_by TEXT,
    started_at DATETIME,
    closed_by TEXT,
    closed_at DATETIME
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS inventory_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_ref TEXT,
    product_label TEXT,
    qty_snapshot REAL DEFAULT 0,    -- reel figé au démarrage
    qty_counted REAL,               -- NULL tant que non compté
    variance REAL,                  -- compté − reel courant, calculé à la clôture
    variance_reason TEXT,
    movement_id INTEGER,            -- id du mouvement de stock Dolibarr créé
    applied INTEGER DEFAULT 0,      -- 1 une fois l'ajustement appliqué
    counted_by TEXT,
    counted_at DATETIME,
    applied_at DATETIME,
    UNIQUE(session_id, product_id)
  )`);

  db.exec('CREATE INDEX IF NOT EXISTS idx_inv_lines_session ON inventory_lines(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_inv_lines_product ON inventory_lines(product_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_inv_sessions_status ON inventory_sessions(status)');

  // ─── Helpers ──────────────────────────────────────────────

  // Réf séquentielle par jour : INV-YYYYMMDD-NNN
  function genRef() {
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `INV-${ymd}-`;
    const last = db.prepare("SELECT ref FROM inventory_sessions WHERE ref LIKE ? ORDER BY ref DESC LIMIT 1").get(prefix + '%');
    let seq = 1;
    if (last) { const m = last.ref.match(/-(\d+)$/); if (m) seq = parseInt(m[1], 10) + 1; }
    return prefix + String(seq).padStart(3, '0');
  }

  function lineStats(sessionId) {
    return db.prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN qty_counted IS NOT NULL THEN 1 ELSE 0 END), 0) AS counted,
         COALESCE(SUM(CASE WHEN qty_counted IS NULL THEN 1 ELSE 0 END), 0) AS uncounted,
         COALESCE(SUM(CASE WHEN qty_counted IS NOT NULL AND qty_counted <> qty_snapshot THEN 1 ELSE 0 END), 0) AS with_variance
       FROM inventory_lines WHERE session_id = ?`
    ).get(sessionId) || { total: 0, counted: 0, uncounted: 0, with_variance: 0 };
  }

  function sessionDto(s) {
    return { ...s, stats: lineStats(s.id) };
  }

  // Lecture du stock courant d'un produit dans l'entrepôt de la session.
  async function currentReel(productId, warehouseId) {
    const [[row]] = await dolibarrPool.query(
      'SELECT reel FROM llx_product_stock WHERE fk_product = ? AND fk_entrepot = ?',
      [productId, warehouseId]
    );
    return Number(row?.reel || 0);
  }

  // Crée une ligne à la volée (produit scanné/saisi absent du snapshot) en figeant
  // son stock courant comme théorique — exactement comme Dolibarr lors d'un ajout
  // de ligne pendant l'inventaire.
  async function ensureLine(session, product) {
    let line = db.prepare('SELECT * FROM inventory_lines WHERE session_id = ? AND product_id = ?').get(session.id, product.id);
    if (line) return line;
    const reel = await currentReel(product.id, session.warehouse_id);
    db.prepare(
      `INSERT INTO inventory_lines (session_id, product_id, product_ref, product_label, qty_snapshot)
       VALUES (?, ?, ?, ?, ?)`
    ).run(session.id, product.id, product.ref || null, product.label || null, reel);
    return db.prepare('SELECT * FROM inventory_lines WHERE session_id = ? AND product_id = ?').get(session.id, product.id);
  }

  function logActivity(req, action, details) {
    try {
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'system', action, details);
    } catch { /* table absente : ignorer */ }
  }

  // ═══════════════════════════════════════════════════════════
  // OPTIONS DE PÉRIMÈTRE (entrepôts actifs, catégories, éditeurs)
  // ═══════════════════════════════════════════════════════════

  router.get('/scope-options', auth, async (req, res) => {
    try {
      const [warehouses] = await dolibarrPool.query(
        'SELECT rowid AS id, ref AS label FROM llx_entrepot WHERE statut = 1 ORDER BY ref'
      );
      const [categories] = await dolibarrPool.query(
        'SELECT rowid AS id, label FROM llx_categorie WHERE type = 0 ORDER BY label'
      );
      const [publishers] = await dolibarrPool.query(
        `SELECT editeur AS label, COUNT(*) AS products
         FROM llx_product_extrafields
         WHERE editeur IS NOT NULL AND editeur <> ''
         GROUP BY editeur ORDER BY editeur`
      );
      res.json({
        warehouses,
        default_warehouse: DEFAULT_WAREHOUSE,
        categories,
        publishers: publishers.map(p => ({ label: p.label, products: p.products })),
      });
    } catch (err) {
      console.error('[INVENTORY] scope-options error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des périmètres' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SESSIONS — liste / détail / création
  // ═══════════════════════════════════════════════════════════

  router.get('/sessions', auth, (req, res) => {
    try {
      const { status } = req.query;
      let where = '';
      const params = [];
      if (status && ['draft', 'counting', 'closed', 'canceled'].includes(status)) {
        where = 'WHERE status = ?'; params.push(status);
      }
      const sessions = db.prepare(
        `SELECT * FROM inventory_sessions ${where} ORDER BY created_at DESC LIMIT 300`
      ).all(...params);
      const counts = db.prepare('SELECT status, COUNT(*) n FROM inventory_sessions GROUP BY status')
        .all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
      res.json({ sessions: sessions.map(sessionDto), counts });
    } catch (err) {
      console.error('[INVENTORY] sessions list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des sessions' });
    }
  });

  router.get('/sessions/:id', auth, (req, res) => {
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session introuvable' });
    res.json(sessionDto(s));
  });

  // Lignes d'une session (filtre : all|counted|uncounted|variance, recherche, pagination).
  router.get('/sessions/:id/lines', auth, (req, res) => {
    const s = db.prepare('SELECT id FROM inventory_sessions WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session introuvable' });

    const { filter = 'all', q, page = 1, limit = 100 } = req.query;
    const limitInt = Math.min(parseInt(limit) || 100, 500);
    const offset = (Math.max(1, parseInt(page)) - 1) * limitInt;

    let where = 'WHERE session_id = ?';
    const params = [req.params.id];
    if (filter === 'counted') where += ' AND qty_counted IS NOT NULL';
    else if (filter === 'uncounted') where += ' AND qty_counted IS NULL';
    else if (filter === 'variance') where += ' AND qty_counted IS NOT NULL AND qty_counted <> qty_snapshot';
    if (q && String(q).trim()) {
      where += ' AND (product_ref LIKE ? OR product_label LIKE ?)';
      const pat = `%${String(q).trim()}%`;
      params.push(pat, pat);
    }

    const total = db.prepare(`SELECT COUNT(*) c FROM inventory_lines ${where}`).get(...params)?.c || 0;
    const lines = db.prepare(
      `SELECT * FROM inventory_lines ${where}
       ORDER BY (qty_counted IS NULL) ASC, product_label ASC LIMIT ? OFFSET ?`
    ).all(...params, limitInt, offset);

    res.json({ lines, total, page: Math.max(1, parseInt(page)), pages: Math.ceil(total / limitInt) });
  });

  router.post('/sessions', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const { title, warehouse_id = DEFAULT_WAREHOUSE, scope_type = 'manual', scope_value, treat_uncounted_as_zero, notes } = req.body || {};
      const wh = parseInt(warehouse_id, 10) || DEFAULT_WAREHOUSE;
      if (!SCOPES.has(scope_type)) return res.status(400).json({ error: 'Périmètre invalide' });

      // Entrepôt actif obligatoire
      const [[whRow]] = await dolibarrPool.query('SELECT rowid, ref FROM llx_entrepot WHERE rowid = ? AND statut = 1', [wh]);
      if (!whRow) return res.status(400).json({ error: 'Entrepôt invalide ou inactif' });

      // Résolution du libellé de périmètre (affichage)
      let scopeLabel = 'Sélection manuelle';
      let scopeVal = null;
      if (scope_type === 'warehouse') {
        scopeLabel = `Entrepôt complet — ${whRow.ref}`;
      } else if (scope_type === 'category') {
        const cid = parseInt(scope_value, 10);
        const [[cat]] = await dolibarrPool.query('SELECT rowid, label FROM llx_categorie WHERE rowid = ? AND type = 0', [cid]);
        if (!cat) return res.status(400).json({ error: 'Catégorie invalide' });
        scopeVal = String(cid); scopeLabel = `Catégorie — ${cat.label}`;
      } else if (scope_type === 'publisher') {
        const ed = String(scope_value || '').trim();
        if (!ed) return res.status(400).json({ error: 'Éditeur requis' });
        scopeVal = ed; scopeLabel = `Éditeur — ${ed}`;
      }

      const ref = genRef();
      const result = db.prepare(
        `INSERT INTO inventory_sessions (ref, title, warehouse_id, scope_type, scope_value, scope_label, status, treat_uncounted_as_zero, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
      ).run(ref, String(title || '').slice(0, 200) || null, wh, scope_type, scopeVal, scopeLabel,
        treat_uncounted_as_zero ? 1 : 0, String(notes || '').slice(0, 500) || null, req.admin.username);

      logActivity(req, 'inventory_create', `Inventaire créé : ${ref} (${scopeLabel}, dépôt ${wh})`);
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(result.lastInsertRowid);
      res.json(sessionDto(s));
    } catch (err) {
      console.error('[INVENTORY] create error:', err.message);
      res.status(500).json({ error: 'Erreur création de la session' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉMARRAGE = SNAPSHOT du stock théorique (draft → counting)
  // ═══════════════════════════════════════════════════════════

  router.post('/sessions/:id/start', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });
      if (s.status !== 'draft') return res.status(409).json({ error: 'Session déjà démarrée ou clôturée' });

      let rows = [];
      if (s.scope_type === 'manual') {
        // Pré-remplissage optionnel par liste d'IDs ; sinon démarrage à vide
        // (les lignes seront créées au fil du scan/saisie).
        const ids = Array.isArray(req.body?.product_ids) ? req.body.product_ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
        if (ids.length) {
          const placeholders = ids.map(() => '?').join(',');
          const [r] = await dolibarrPool.query(
            `SELECT p.rowid AS product_id, p.ref, p.label, COALESCE(ps.reel, 0) AS reel
             FROM llx_product p
             LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = ?
             WHERE p.rowid IN (${placeholders}) AND p.fk_product_type = 0`,
            [s.warehouse_id, ...ids]
          );
          rows = r;
        }
      } else if (s.scope_type === 'warehouse') {
        // Entrepôt complet : tous les produits TRACÉS dans cet entrepôt (ils ont
        // une ligne llx_product_stock), reel possiblement à 0 — calque exact du
        // validate() de Dolibarr qui lit llx_product_stock.
        const [r] = await dolibarrPool.query(
          `SELECT p.rowid AS product_id, p.ref, p.label, ps.reel
           FROM llx_product_stock ps
           JOIN llx_product p ON p.rowid = ps.fk_product
           WHERE ps.fk_entrepot = ? AND p.fk_product_type = 0
           LIMIT ${MAX_SNAPSHOT}`,
          [s.warehouse_id]
        );
        rows = r;
      } else if (s.scope_type === 'category') {
        const [r] = await dolibarrPool.query(
          `SELECT p.rowid AS product_id, p.ref, p.label, COALESCE(ps.reel, 0) AS reel
           FROM llx_categorie_product cp
           JOIN llx_product p ON p.rowid = cp.fk_product
           LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = ?
           WHERE cp.fk_categorie = ? AND p.fk_product_type = 0
           LIMIT ${MAX_SNAPSHOT}`,
          [s.warehouse_id, parseInt(s.scope_value, 10)]
        );
        rows = r;
      } else if (s.scope_type === 'publisher') {
        const [r] = await dolibarrPool.query(
          `SELECT p.rowid AS product_id, p.ref, p.label, COALESCE(ps.reel, 0) AS reel
           FROM llx_product_extrafields pe
           JOIN llx_product p ON p.rowid = pe.fk_object
           LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = ?
           WHERE pe.editeur = ? AND p.fk_product_type = 0
           LIMIT ${MAX_SNAPSHOT}`,
          [s.warehouse_id, s.scope_value]
        );
        rows = r;
      }

      // Insertion du snapshot en transaction (lecture async déjà faite).
      const insert = db.prepare(
        `INSERT OR IGNORE INTO inventory_lines (session_id, product_id, product_ref, product_label, qty_snapshot)
         VALUES (?, ?, ?, ?, ?)`
      );
      const tx = db.transaction((items) => {
        for (const it of items) {
          insert.run(s.id, it.product_id, it.ref || null, it.label || null, Number(it.reel || 0));
        }
        db.prepare("UPDATE inventory_sessions SET status = 'counting', started_by = ?, started_at = ? WHERE id = ?")
          .run(req.admin.username, new Date().toISOString(), s.id);
      });
      tx(rows);

      logActivity(req, 'inventory_start', `Inventaire démarré : ${s.ref} — ${rows.length} ligne(s) figée(s)`);
      console.log(`[INVENTORY] Démarré ${s.ref} : ${rows.length} lignes (snapshot) par ${req.admin.username}`);

      const fresh = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(s.id);
      res.json({ ...sessionDto(fresh), snapshot_lines: rows.length });
    } catch (err) {
      console.error('[INVENTORY] start error:', err.message);
      res.status(500).json({ error: 'Erreur démarrage de la session' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // COMPTAGE — scan ISBN (+1) / saisie manuelle (qté absolue) / bulk CSV
  // ═══════════════════════════════════════════════════════════

  // Résout un produit par code (ISBN en ref OU barcode).
  async function resolveByBarcode(code) {
    const c = String(code).trim();
    const [[p]] = await dolibarrPool.query(
      'SELECT p.rowid AS id, p.ref, p.label FROM llx_product p WHERE (p.ref = ? OR p.barcode = ?) AND p.fk_product_type = 0 LIMIT 1',
      [c, c]
    );
    return p || null;
  }

  router.post('/sessions/:id/count', auth, csrfProtection, async (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });
      if (s.status !== 'counting') return res.status(409).json({ error: 'La session doit être démarrée (en comptage)' });

      const { barcode, product_id, qty } = req.body || {};
      let product = null;

      if (barcode) {
        product = await resolveByBarcode(barcode);
        if (!product) return res.status(404).json({ error: `Aucun produit pour le code « ${String(barcode).trim()} »` });
      } else if (product_id) {
        const [[p]] = await dolibarrPool.query(
          'SELECT rowid AS id, ref, label FROM llx_product WHERE rowid = ? AND fk_product_type = 0', [parseInt(product_id, 10)]
        );
        if (!p) return res.status(404).json({ error: 'Produit introuvable' });
        product = p;
      } else {
        return res.status(400).json({ error: 'barcode ou product_id requis' });
      }

      const line = await ensureLine(s, product);

      // Sans qty (scan OU ajout par recherche-titre) : incrément +1.
      // Avec qty : quantité absolue (saisie manuelle / stepper).
      let newCount;
      if (qty === undefined || qty === null || qty === '') {
        newCount = Number(line.qty_counted || 0) + 1;
      } else {
        const q = Number(qty);
        if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: 'qty doit être un nombre ≥ 0' });
        newCount = q;
      }
      if (newCount > 1000000) return res.status(400).json({ error: 'Quantité trop élevée' });

      db.prepare('UPDATE inventory_lines SET qty_counted = ?, counted_by = ?, counted_at = ? WHERE id = ?')
        .run(newCount, req.admin.username, new Date().toISOString(), line.id);

      const updated = db.prepare('SELECT * FROM inventory_lines WHERE id = ?').get(line.id);
      res.json({ success: true, line: updated, stats: lineStats(s.id) });
    } catch (err) {
      console.error('[INVENTORY] count error:', err.message);
      res.status(500).json({ error: 'Erreur de saisie' });
    }
  });

  // Import en masse (CSV pré-parsé côté client → tableau de lignes).
  // Chaque entrée : { barcode | product_id, qty }. qty = quantité ABSOLUE comptée.
  router.post('/sessions/:id/count/bulk', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });
      if (s.status !== 'counting') return res.status(409).json({ error: 'La session doit être démarrée (en comptage)' });

      const items = Array.isArray(req.body?.lines) ? req.body.lines : null;
      if (!items || !items.length) return res.status(400).json({ error: 'lines[] requis' });
      if (items.length > 10000) return res.status(400).json({ error: 'Import trop volumineux (max 10000 lignes)' });

      const now = new Date().toISOString();
      const ok = [], errors = [];
      for (const [i, it] of items.entries()) {
        try {
          const q = Number(it.qty);
          if (!Number.isFinite(q) || q < 0) { errors.push({ row: i + 1, error: 'qty invalide', input: it }); continue; }
          let product = null;
          if (it.barcode) product = await resolveByBarcode(it.barcode);
          else if (it.product_id) {
            const [[p]] = await dolibarrPool.query('SELECT rowid AS id, ref, label FROM llx_product WHERE rowid = ? AND fk_product_type = 0', [parseInt(it.product_id, 10)]);
            product = p || null;
          }
          if (!product) { errors.push({ row: i + 1, error: 'produit introuvable', input: it }); continue; }
          const line = await ensureLine(s, product);
          db.prepare('UPDATE inventory_lines SET qty_counted = ?, counted_by = ?, counted_at = ? WHERE id = ?')
            .run(q, req.admin.username, now, line.id);
          ok.push({ row: i + 1, product_id: product.id, ref: product.ref, qty: q });
        } catch (e) {
          errors.push({ row: i + 1, error: e.message, input: it });
        }
      }

      logActivity(req, 'inventory_bulk_count', `Import comptage ${s.ref} : ${ok.length} ok, ${errors.length} erreur(s)`);
      res.json({ success: true, applied: ok.length, errors, stats: lineStats(s.id) });
    } catch (err) {
      console.error('[INVENTORY] bulk count error:', err.message);
      res.status(500).json({ error: 'Erreur import' });
    }
  });

  // Réinitialise une ligne (annule la saisie : qty_counted → NULL).
  router.post('/sessions/:id/lines/:lineId/reset', auth, csrfProtection, (req, res) => {
    const s = db.prepare('SELECT status FROM inventory_sessions WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session introuvable' });
    if (s.status !== 'counting') return res.status(409).json({ error: 'Session non modifiable' });
    const r = db.prepare("UPDATE inventory_lines SET qty_counted = NULL, counted_by = NULL, counted_at = NULL WHERE id = ? AND session_id = ?")
      .run(req.params.lineId, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Ligne introuvable' });
    res.json({ success: true, stats: lineStats(req.params.id) });
  });

  // ═══════════════════════════════════════════════════════════
  // PRÉ-CLÔTURE — aperçu valorisé des écarts (théorique → compté)
  // ═══════════════════════════════════════════════════════════

  router.get('/sessions/:id/preview', auth, async (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });

      const counted = db.prepare(
        'SELECT * FROM inventory_lines WHERE session_id = ? AND qty_counted IS NOT NULL'
      ).all(s.id);

      // PMP des produits concernés (pour valoriser l'écart)
      let pmpMap = new Map();
      if (counted.length) {
        const ids = [...new Set(counted.map(l => l.product_id))];
        const placeholders = ids.map(() => '?').join(',');
        const [rows] = await dolibarrPool.query(
          `SELECT rowid AS id, pmp, price_ttc FROM llx_product WHERE rowid IN (${placeholders})`, ids
        );
        pmpMap = new Map(rows.map(r => [r.id, Number(r.pmp) > 0 ? Number(r.pmp) : Number(r.price_ttc || 0)]));
      }

      let posQty = 0, negQty = 0, valueDelta = 0;
      const lines = counted.map(l => {
        const delta = Number(l.qty_counted) - Number(l.qty_snapshot);
        if (delta > 0) posQty += delta; else if (delta < 0) negQty += delta;
        const unit = pmpMap.get(l.product_id) || 0;
        valueDelta += delta * unit;
        return { ...l, delta, unit_value: unit, line_value_delta: Math.round(delta * unit) };
      }).filter(l => l.delta !== 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      res.json({
        session: sessionDto(s),
        // Aperçu basé sur le snapshot ; la clôture recalculera contre le stock courant.
        variance_lines: lines,
        summary: {
          counted_lines: counted.length,
          variance_lines: lines.length,
          qty_positive: posQty,
          qty_negative: negQty,
          qty_net: posQty + negQty,
          value_delta: Math.round(valueDelta),
        },
      });
    } catch (err) {
      console.error('[INVENTORY] preview error:', err.message);
      res.status(500).json({ error: 'Erreur aperçu' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CLÔTURE — applique les écarts (counting → closed)
  // Pour chaque ligne comptée : écart = compté − stock COURANT (pas le snapshot),
  // puis mouvement de stock signé via l'API Dolibarr. Idempotent : une ligne déjà
  // appliquée est sautée (réessai possible si une partie a échoué).
  // ═══════════════════════════════════════════════════════════

  router.post('/sessions/:id/close', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });
      if (s.status === 'closed') return res.status(409).json({ error: 'Session déjà clôturée' });
      if (s.status === 'canceled') return res.status(409).json({ error: 'Session annulée' });
      if (s.status !== 'counting') return res.status(409).json({ error: 'Session non démarrée' });

      const lines = db.prepare('SELECT * FROM inventory_lines WHERE session_id = ?').all(s.id);
      const adminApi = makeAdminApi();
      const now = new Date().toISOString();

      const applied = [], failed = [];
      let skipped = 0, netDelta = 0;

      for (const l of lines) {
        if (l.applied) continue; // déjà appliquée (clôture partielle précédente)

        let counted = l.qty_counted;
        if (counted === null || counted === undefined) {
          if (s.treat_uncounted_as_zero) counted = 0;
          else { skipped++; continue; }
        }
        counted = Number(counted);

        // Écart contre le stock COURANT (compense les ventes pendant le comptage).
        const reelNow = await currentReel(l.product_id, s.warehouse_id);
        const delta = counted - reelNow;

        if (delta === 0) {
          db.prepare('UPDATE inventory_lines SET variance = 0, applied = 1, applied_at = ? WHERE id = ?').run(now, l.id);
          applied.push({ product_id: l.product_id, delta: 0 });
          continue;
        }

        try {
          // Mouvement signé : delta > 0 = entrée, delta < 0 = sortie.
          const movement = await adminApi.post('/stockmovements', {
            product_id: l.product_id,
            warehouse_id: s.warehouse_id,
            qty: delta,
            movementcode: `INV-${s.ref}`,
            movementlabel: `Inventaire ${s.ref} (${reelNow}→${counted})`,
          });
          const movementId = typeof movement.data === 'number' ? movement.data : (movement.data?.id || null);
          db.prepare('UPDATE inventory_lines SET variance = ?, movement_id = ?, applied = 1, applied_at = ? WHERE id = ?')
            .run(delta, movementId, now, l.id);
          applied.push({ product_id: l.product_id, ref: l.product_ref, delta });
          netDelta += delta;
        } catch (e) {
          failed.push({ product_id: l.product_id, label: l.product_label, error: e.response?.data?.error?.message || e.message });
        }
      }

      // On ne clôture définitivement que si TOUT est passé. En cas d'échec partiel,
      // la session reste en comptage : les lignes appliquées (applied=1) ne seront
      // pas rejouées, on peut relancer la clôture pour finir.
      let finalStatus = s.status;
      if (failed.length === 0) {
        db.prepare("UPDATE inventory_sessions SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?")
          .run(req.admin.username, now, s.id);
        finalStatus = 'closed';
      }

      logActivity(req, 'inventory_close',
        `Clôture ${s.ref} : ${applied.length} ligne(s) appliquée(s), ${failed.length} échec(s), ${skipped} ignorée(s) — net ${netDelta > 0 ? '+' : ''}${netDelta}`);
      console.log(`[INVENTORY] Clôture ${s.ref} : ${applied.length} appliquées, ${failed.length} échecs, net ${netDelta} par ${req.admin.username}`);

      // Recalcul réappro/alertes en arrière-plan (non bloquant) si le stock a bougé.
      if (applied.some(a => a.delta !== 0)) {
        Promise.resolve().then(() => runDailyBatch(dolibarrPool, db))
          .catch(e => console.warn('[INVENTORY] recalc post-clôture échoué:', e.message));
      }

      res.json({
        success: failed.length === 0,
        status: finalStatus,
        applied: applied.length,
        failed,
        skipped,
        net_delta: netDelta,
      });
    } catch (err) {
      console.error('[INVENTORY] close error:', err.message);
      res.status(500).json({ error: 'Erreur clôture' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ANNULATION / SUPPRESSION
  // ═══════════════════════════════════════════════════════════

  router.post('/sessions/:id/cancel', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session introuvable' });
    if (s.status === 'closed') return res.status(409).json({ error: 'Session déjà clôturée (mouvements appliqués)' });
    db.prepare("UPDATE inventory_sessions SET status = 'canceled' WHERE id = ?").run(s.id);
    logActivity(req, 'inventory_cancel', `Inventaire annulé : ${s.ref}`);
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════════
  // RAPPORT — données valorisées partagées (CSV exhaustif / PDF écarts)
  // ═══════════════════════════════════════════════════════════

  async function buildReportData(session) {
    const lines = db.prepare('SELECT * FROM inventory_lines WHERE session_id = ? ORDER BY product_label').all(session.id);
    // PMP des produits (par lots de 1000 pour ne pas exploser le IN(...)).
    const pmpMap = new Map();
    const ids = [...new Set(lines.map(l => l.product_id))];
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const ph = chunk.map(() => '?').join(',');
      const [rows] = await dolibarrPool.query(`SELECT rowid AS id, pmp, price_ttc FROM llx_product WHERE rowid IN (${ph})`, chunk);
      for (const r of rows) pmpMap.set(r.id, Number(r.pmp) > 0 ? Number(r.pmp) : Number(r.price_ttc || 0));
    }

    const enriched = lines.map(l => {
      const counted = l.qty_counted;
      const delta = counted == null ? null : counted - l.qty_snapshot;
      const unit = pmpMap.get(l.product_id) || 0;
      const valueDelta = delta == null ? 0 : Math.round(delta * unit);
      return { ...l, counted, delta, unit, valueDelta };
    });

    const sum = { total: enriched.length, counted: 0, uncounted: 0, variance: 0, qtyPos: 0, qtyNeg: 0, valPos: 0, valNeg: 0 };
    for (const l of enriched) {
      if (l.counted == null) { sum.uncounted++; continue; }
      sum.counted++;
      if (l.delta !== 0) sum.variance++;
      if (l.delta > 0) { sum.qtyPos += l.delta; sum.valPos += l.valueDelta; }
      else if (l.delta < 0) { sum.qtyNeg += l.delta; sum.valNeg += l.valueDelta; }
    }
    sum.qtyNet = sum.qtyPos + sum.qtyNeg;
    sum.valNet = sum.valPos + sum.valNeg;
    return { lines: enriched, summary: sum };
  }

  // CSV exhaustif (toutes les lignes, comptées ou non) — archivage / Excel.
  router.get('/sessions/:id/report.csv', auth, async (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });
      const { lines } = await buildReportData(s);
      const csv = toCsv([
        { label: 'Référence', get: l => l.product_ref },
        { label: 'Titre', get: l => l.product_label },
        { label: 'Stock théorique', get: l => l.qty_snapshot },
        { label: 'Compté', get: l => l.counted == null ? '' : l.counted },
        { label: 'Écart', get: l => l.delta == null ? '' : l.delta },
        { label: 'Valeur écart (FCFA)', get: l => l.delta == null ? '' : l.valueDelta },
        { label: 'Statut', get: l => l.counted == null ? 'Non compté' : (l.delta === 0 ? 'Conforme' : 'Écart') },
        { label: 'Appliqué', get: l => l.applied ? 'Oui' : 'Non' },
        { label: 'Mouvement', get: l => l.movement_id || '' },
        { label: 'Compté par', get: l => l.counted_by || '' },
      ], lines);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="inventaire-${s.ref}.csv"`);
      res.send(csv);
    } catch (err) {
      console.error('[INVENTORY] report.csv error:', err.message);
      res.status(500).json({ error: 'Erreur export CSV' });
    }
  });

  // PDF — rapport d'écarts valorisé (ODT → LibreOffice), archivable.
  router.get('/sessions/:id/report.pdf', auth, async (req, res) => {
    let tmpDir;
    try {
      const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ error: 'Session introuvable' });
      const report = await buildReportData(s);
      const [[wh]] = await dolibarrPool.query('SELECT ref FROM llx_entrepot WHERE rowid = ?', [s.warehouse_id]);

      tmpDir = join('/tmp', `inv-${s.id}-${Date.now()}`);
      mkdirSync(join(tmpDir, 'META-INF'), { recursive: true });
      writeFileSync(join(tmpDir, 'mimetype'), 'application/vnd.oasis.opendocument.text');
      writeFileSync(join(tmpDir, 'META-INF/manifest.xml'), INV_MANIFEST);
      writeFileSync(join(tmpDir, 'styles.xml'), buildInvStyles());
      writeFileSync(join(tmpDir, 'content.xml'), buildInvContent(s, report, wh?.ref || `#${s.warehouse_id}`));

      const odt = join(tmpDir, 'inv.odt');
      execFileSync('zip', ['-q', '-X', '-0', odt, 'mimetype'], { cwd: tmpDir });
      execFileSync('zip', ['-q', '-r', '-X', odt, 'META-INF', 'content.xml', 'styles.xml'], { cwd: tmpDir });

      const profile = join(tmpDir, 'profile');
      mkdirSync(profile, { recursive: true });
      execFileSync('soffice', [
        '--headless', '--norestore', '--nologo', '--nofirststartwizard',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to', 'pdf', '--outdir', tmpDir, odt,
      ], { stdio: 'pipe', timeout: 60000 });

      const pdfPath = join(tmpDir, 'inv.pdf');
      if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée');
      const buf = readFileSync(pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="inventaire-${s.ref}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[INVENTORY] report.pdf error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Suppression d'un brouillon/annulé (purge — jamais une session clôturée).
  router.delete('/sessions/:id', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    const s = db.prepare('SELECT * FROM inventory_sessions WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session introuvable' });
    if (s.status === 'closed') return res.status(409).json({ error: 'Impossible de supprimer une session clôturée' });
    db.transaction(() => {
      db.prepare('DELETE FROM inventory_lines WHERE session_id = ?').run(s.id);
      db.prepare('DELETE FROM inventory_sessions WHERE id = ?').run(s.id);
    })();
    logActivity(req, 'inventory_delete', `Inventaire supprimé : ${s.ref} (${s.status})`);
    res.json({ success: true });
  });

  return router;
}

// ═══════════════════════════════════════════════════════════════
// CONSTRUCTION DU RAPPORT PDF (ODT → LibreOffice)
// ═══════════════════════════════════════════════════════════════

const STATUS_FR = { draft: 'Brouillon', counting: 'En comptage', closed: 'Clôturé', canceled: 'Annulé' };

const INV_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

function buildInvStyles() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties fo:margin-bottom="0.12cm" fo:line-height="125%"/>
   <style:text-properties style:font-name="Liberation Sans" fo:font-size="10pt" fo:color="#1a1a1a" fo:language="fr" fo:country="FR"/>
  </style:default-style>
  <style:style style:name="Editor" style:family="paragraph"><style:text-properties fo:font-size="15pt" fo:font-weight="bold" fo:color="${INV_PRIMARY}"/></style:style>
  <style:style style:name="Tag" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.4cm" fo:border-bottom="1pt solid ${INV_PRIMARY}" fo:padding-bottom="0.2cm"/><style:text-properties fo:font-size="8.5pt" fo:color="${INV_MUTED}" fo:letter-spacing="0.05cm"/></style:style>
  <style:style style:name="DocTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.2cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="19pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${INV_PRIMARY}"/></style:style>
  <style:style style:name="DocRef" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.4cm"/><style:text-properties fo:font-size="11pt" fo:color="${INV_MUTED}"/></style:style>
  <style:style style:name="BlockTitle" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.35cm" fo:margin-bottom="0.12cm"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${INV_MUTED}"/></style:style>
  <style:style style:name="Box" style:family="paragraph"><style:paragraph-properties fo:background-color="#eff6ff" fo:border-left="3pt solid ${INV_PRIMARY}" fo:padding="0.3cm 0.4cm" fo:margin-bottom="0.35cm"/><style:text-properties fo:font-size="9.5pt"/></style:style>
  <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Pos" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#15803d"/></style:style>
  <style:style style:name="Neg" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#b91c1c"/></style:style>
  <style:style style:name="Muted" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.2cm"/><style:text-properties fo:font-size="8.5pt" fo:color="${INV_MUTED}"/></style:style>
  <style:style style:name="FooterLegal" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="7.5pt" fo:color="${INV_MUTED}"/></style:style>
  <style:style style:name="THead" style:family="table-cell"><style:table-cell-properties fo:background-color="${INV_PRIMARY}" fo:padding="0.14cm 0.22cm"/></style:style>
  <style:style style:name="TCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm 0.22cm" fo:border-bottom="0.3pt solid #d1d5db"/></style:style>
  <style:style style:name="THeadP" style:family="paragraph"><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPR" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="TCellC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9.5pt"/></style:style>
  <style:style style:name="TCellRt" style:family="paragraph"><style:paragraph-properties fo:text-align="end"/><style:text-properties fo:font-size="9.5pt"/></style:style>
  <style:style style:name="ITable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.3cm" fo:margin-bottom="0.2cm"/></style:style>
  <style:style style:name="ColRef" style:family="table-column"><style:table-column-properties style:column-width="2.6cm"/></style:style>
  <style:style style:name="ColLabel" style:family="table-column"><style:table-column-properties style:column-width="7.4cm"/></style:style>
  <style:style style:name="ColNum" style:family="table-column"><style:table-column-properties style:column-width="1.6cm"/></style:style>
  <style:style style:name="ColDelta" style:family="table-column"><style:table-column-properties style:column-width="1.4cm"/></style:style>
  <style:style style:name="ColVal" style:family="table-column"><style:table-column-properties style:column-width="2cm"/></style:style>
 </office:styles>
 <office:automatic-styles>
  <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="1.8cm" fo:margin-bottom="1.8cm" fo:margin-left="2.2cm" fo:margin-right="2.2cm"/>
   <style:footer-style><style:header-footer-properties fo:min-height="1cm" fo:margin-top="0.4cm"/></style:footer-style>
  </style:page-layout>
 </office:automatic-styles>
 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pm1">
   <style:footer><text:p text:style-name="FooterLegal">${escXml(FOOTER_LEGAL)}</text:p></style:footer>
  </style:master-page>
 </office:master-styles>
</office:document-styles>`;
}

function buildInvContent(s, report, whRef) {
  const { lines, summary } = report;
  const variance = lines.filter(l => l.delta != null && l.delta !== 0);
  const shown = variance.slice(0, MAX_PDF_ROWS);
  const truncated = variance.length - shown.length;

  const metaBox = `<text:p text:style-name="Box">`
    + `<text:span text:style-name="Bold">Périmètre :</text:span> ${escXml(s.scope_label)}<text:line-break/>`
    + `<text:span text:style-name="Bold">Entrepôt :</text:span> ${escXml(whRef)}`
    + `   ·   <text:span text:style-name="Bold">Statut :</text:span> ${escXml(STATUS_FR[s.status] || s.status)}<text:line-break/>`
    + `<text:span text:style-name="Bold">Créé :</text:span> ${escXml(s.created_by || '—')} le ${escXml(fmtDate(s.created_at))}`
    + (s.status === 'closed' ? `   ·   <text:span text:style-name="Bold">Clôturé :</text:span> ${escXml(s.closed_by || '—')} le ${escXml(fmtDate(s.closed_at))}` : '')
    + `</text:p>`;

  const span = (v, pos = '', neg = '') => {
    const cls = v > 0 ? pos : v < 0 ? neg : '';
    const txt = (v > 0 ? '+' : '') + (typeof v === 'string' ? v : v.toLocaleString('fr-FR'));
    return cls ? `<text:span text:style-name="${cls}">${escXml(txt)}</text:span>` : escXml(txt);
  };

  const summaryBox = `<text:p text:style-name="Box">`
    + `<text:span text:style-name="Bold">Lignes :</text:span> ${summary.total}`
    + `   ·   <text:span text:style-name="Bold">Comptées :</text:span> ${summary.counted}`
    + `   ·   <text:span text:style-name="Bold">Non comptées :</text:span> ${summary.uncounted}`
    + `   ·   <text:span text:style-name="Bold">Écarts :</text:span> ${summary.variance}<text:line-break/>`
    + `<text:span text:style-name="Bold">Net :</text:span> ${span(summary.qtyNet, 'Pos', 'Neg')} exemplaire(s)`
    + `   ·   <text:span text:style-name="Bold">Manquants :</text:span> <text:span text:style-name="Neg">${escXml(fmtF(summary.valNeg))}</text:span>`
    + `   ·   <text:span text:style-name="Bold">Excédents :</text:span> <text:span text:style-name="Pos">+${escXml(fmtF(summary.valPos))}</text:span>`
    + `   ·   <text:span text:style-name="Bold">Valeur nette :</text:span> ${summary.valNet < 0 ? `<text:span text:style-name="Neg">${escXml(fmtF(summary.valNet))}</text:span>` : `<text:span text:style-name="Pos">+${escXml(fmtF(summary.valNet))}</text:span>`}`
    + `</text:p>`;

  let varianceBlock;
  if (shown.length === 0) {
    varianceBlock = `<text:p text:style-name="Muted">Aucun écart constaté : le stock compté correspond au stock théorique.</text:p>`;
  } else {
    const rows = shown.map(l => `
   <table:table-row>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(l.product_ref || '—')}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(l.product_label)}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellC">${escXml(String(l.qty_snapshot))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellC">${escXml(String(l.counted))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellC">${l.delta > 0 ? '<text:span text:style-name="Pos">+' + l.delta + '</text:span>' : '<text:span text:style-name="Neg">' + l.delta + '</text:span>'}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellRt">${escXml((l.valueDelta > 0 ? '+' : '') + fmtF(l.valueDelta))}</text:p></table:table-cell>
   </table:table-row>`).join('');
    varianceBlock = `
  <table:table table:name="Variance" table:style-name="ITable">
   <table:table-column table:style-name="ColRef"/>
   <table:table-column table:style-name="ColLabel"/>
   <table:table-column table:style-name="ColNum"/>
   <table:table-column table:style-name="ColNum"/>
   <table:table-column table:style-name="ColDelta"/>
   <table:table-column table:style-name="ColVal"/>
   <table:table-row>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Référence</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Désignation</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPC">Théo.</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPC">Compté</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPC">Écart</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Valeur</text:p></table:table-cell>
   </table:table-row>${rows}
  </table:table>`
      + (truncated > 0 ? `<text:p text:style-name="Muted">… et ${truncated} autre(s) écart(s) — voir l'export CSV pour le détail complet.</text:p>` : '');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:automatic-styles/>
 <office:body><office:text>
  <text:p text:style-name="Editor">${escXml(EDITOR_NAME)}</text:p>
  <text:p text:style-name="Tag">INVENTAIRE PHYSIQUE — État des écarts de stock</text:p>

  <text:p text:style-name="DocTitle">RAPPORT D'INVENTAIRE</text:p>
  <text:p text:style-name="DocRef">N° <text:span text:style-name="Bold">${escXml(s.ref)}</text:span>${s.title ? ' · ' + escXml(s.title) : ''}</text:p>

  ${metaBox}

  <text:p text:style-name="BlockTitle">SYNTHÈSE</text:p>
  ${summaryBox}

  <text:p text:style-name="BlockTitle">DÉTAIL DES ÉCARTS</text:p>
  ${varianceBlock}

  <text:p text:style-name="Muted">Valeurs estimées au prix moyen pondéré (PMP). Document généré le ${escXml(fmtDate(new Date().toISOString()))}.</text:p>
 </office:text></office:body>
</office:document-content>`;
}
