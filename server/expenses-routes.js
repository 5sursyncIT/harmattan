/**
 * Expenses Routes — Sorties d'argent / Dépenses (module NATIF).
 *
 * Enregistre toute sortie d'argent de l'entreprise (loyer, salaires, fournitures,
 * transport, services, taxes…) avec :
 *   - justification obligatoire (motif + catégorie + bénéficiaire + méthode + source) ;
 *   - traçabilité complète (qui/quand/combien/pourquoi) via expense_audit_log immuable ;
 *   - notification automatique des admins dès qu'un retrait est enregistré (email + badge) ;
 *   - suivi du solde par source de fonds (caisse, banque, Wave, OM…).
 *
 * Workflow « a posteriori » : la dépense est enregistrée immédiatement (pas de blocage),
 * les admins sont notifiés juste après. L'annulation (réservée admin) reste tracée.
 *
 * 100 % natif SQLite — aucune écriture dans Dolibarr. La lecture des recettes encaissées
 * (pour le rapport de caisse net) interroge llx_paiement en lecture seule.
 *
 * Sécurité : monté sur /api/admin/expenses, whitelist RBAC (super_admin, admin, comptable)
 * dans roles-config.js. Mutations protégées CSRF. Actions sensibles (annulation, sources,
 * approvisionnements) réservées aux admins par garde-fou applicatif.
 */

import { Router } from 'express';

// ─── CONSTANTES MÉTIER ───────────────────────────────────────
const CATEGORY_LABELS = {
  loyer: 'Loyer',
  salaire: 'Salaire / Personnel',
  fournitures: 'Fournitures',
  transport: 'Transport / Livraison',
  services: 'Services / Prestations',
  taxes: 'Taxes / Impôts',
  maintenance: 'Maintenance / Réparations',
  communication: 'Communication / Marketing',
  achat: 'Achat marchandises',
  autre: 'Autre',
};

const METHOD_LABELS = {
  especes: 'Espèces',
  wave: 'Wave',
  om: 'Orange Money',
  virement: 'Virement',
  cheque: 'Chèque',
};

const SOURCE_TYPE_LABELS = { caisse: 'Caisse', banque: 'Banque', mobile: 'Mobile money' };

const STATUS_LABELS = { recorded: 'Enregistrée', cancelled: 'Annulée' };

const ADMIN_ROLES = ['super_admin', 'admin'];
const CREATOR_ROLES = ['super_admin', 'admin', 'comptable'];

// ─── HELPERS ─────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cash_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'caisse',
    opening_balance REAL NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS cash_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    label TEXT,
    created_by TEXT,
    created_by_role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    beneficiary TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_method TEXT NOT NULL,
    source_id INTEGER,
    reason TEXT NOT NULL,
    note TEXT,
    expense_date DATE,
    status TEXT NOT NULL DEFAULT 'recorded',
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_by_role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cancelled_by TEXT,
    cancelled_at DATETIME,
    cancel_reason TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_source ON expenses(source_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at)');

  db.exec(`CREATE TABLE IF NOT EXISTS expense_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fk_expense INTEGER NOT NULL,
    ref_expense TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    user_id INTEGER,
    user_name TEXT,
    user_role TEXT,
    snapshot TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_audit_expense ON expense_audit_log(fk_expense)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expense_audit_created ON expense_audit_log(created_at)');

  // Seed des sources de fonds par défaut (idempotent).
  const seed = db.prepare('INSERT OR IGNORE INTO cash_sources (key, label, type) VALUES (?,?,?)');
  seed.run('caisse', 'Caisse espèces', 'caisse');
  seed.run('banque', 'Compte bancaire', 'banque');
  seed.run('wave', 'Wave', 'mobile');
  seed.run('om', 'Orange Money', 'mobile');
}

// Montant entier FCFA positif borné (FCFA n'a pas de centimes).
function cleanAmount(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 1_000_000_000);
}

function nonEmpty(s, { min = 2, max = 500 } = {}) {
  const t = String(s ?? '').trim();
  return t.length >= min && t.length <= max ? t : null;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

function writeAudit(db, { expense_id, ref, action, reason, admin, snapshot }) {
  try {
    db.prepare(`INSERT INTO expense_audit_log
      (fk_expense, ref_expense, action, reason, user_id, user_name, user_role, snapshot)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      expense_id, ref || null, action, reason || null,
      admin?.id || null, admin?.username || null, admin?.role || null,
      snapshot ? JSON.stringify(snapshot) : null,
    );
  } catch (e) {
    console.error('[EXPENSES] échec écriture audit:', e.message);
  }
}

function rowToDto(r, sourceMap) {
  const src = r.source_id ? sourceMap?.get(r.source_id) : null;
  return {
    id: r.id,
    ref: r.ref,
    category: r.category,
    category_label: CATEGORY_LABELS[r.category] || r.category,
    beneficiary: r.beneficiary,
    amount: Number(r.amount),
    method: r.payment_method,
    method_label: METHOD_LABELS[r.payment_method] || r.payment_method,
    source_id: r.source_id,
    source_label: src ? src.label : (r.source_id ? `#${r.source_id}` : '—'),
    reason: r.reason,
    note: r.note,
    expense_date: r.expense_date,
    status: r.status,
    status_label: STATUS_LABELS[r.status] || r.status,
    acknowledged: !!r.acknowledged,
    created_by: r.created_by,
    created_by_role: r.created_by_role,
    created_at: r.created_at,
    cancelled_by: r.cancelled_by,
    cancelled_at: r.cancelled_at,
    cancel_reason: r.cancel_reason,
  };
}

// Solde par source = ouverture + Σ approvisionnements − Σ dépenses actives.
function computeSourceBalances(db) {
  const sources = db.prepare('SELECT * FROM cash_sources ORDER BY is_active DESC, label ASC').all();
  const topups = db.prepare('SELECT source_id, COALESCE(SUM(amount),0) AS t FROM cash_topups GROUP BY source_id').all();
  const spent = db.prepare("SELECT source_id, COALESCE(SUM(amount),0) AS t FROM expenses WHERE status='recorded' AND source_id IS NOT NULL GROUP BY source_id").all();
  const topupMap = new Map(topups.map(r => [r.source_id, Number(r.t)]));
  const spentMap = new Map(spent.map(r => [r.source_id, Number(r.t)]));
  return sources.map(s => {
    const inflow = Number(s.opening_balance) + (topupMap.get(s.id) || 0);
    const outflow = spentMap.get(s.id) || 0;
    return {
      id: s.id,
      key: s.key,
      label: s.label,
      type: s.type,
      type_label: SOURCE_TYPE_LABELS[s.type] || s.type,
      opening_balance: Number(s.opening_balance),
      topups_total: topupMap.get(s.id) || 0,
      spent_total: outflow,
      balance: inflow - outflow,
      is_active: !!s.is_active,
    };
  });
}

// Notification admins (best-effort, ne bloque jamais la création).
async function notifyAdmins(transporter, db, dto, siteUrl) {
  try {
    if (!transporter) return;
    const admins = db.prepare(
      "SELECT email FROM admin_users WHERE is_active=1 AND role IN ('super_admin','admin') AND email IS NOT NULL AND email != ''"
    ).all();
    const to = admins.map(a => a.email).filter(Boolean);
    if (to.length === 0) return;

    const fmt = (n) => (Number(n) || 0).toLocaleString('fr-FR') + ' FCFA';
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const link = `${siteUrl || ''}/admin/expenses`;
    const html = `<!DOCTYPE html><html lang="fr"><body style="font-family:Arial,sans-serif;color:#374151;background:#fafafa;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.05)">
        <div style="background:#9a3412;padding:16px 24px"><h1 style="margin:0;color:#fff;font-size:17px">⚠️ Sortie d'argent enregistrée</h1></div>
        <div style="padding:24px">
          <p style="font-size:22px;font-weight:800;color:#9a3412;margin:0 0 12px">${esc(fmt(dto.amount))}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:6px 0;color:#6b7280">Référence</td><td style="padding:6px 0;text-align:right;font-weight:600">${esc(dto.ref)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Catégorie</td><td style="padding:6px 0;text-align:right">${esc(dto.category_label)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Bénéficiaire</td><td style="padding:6px 0;text-align:right">${esc(dto.beneficiary)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Méthode</td><td style="padding:6px 0;text-align:right">${esc(dto.method_label)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Source</td><td style="padding:6px 0;text-align:right">${esc(dto.source_label)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Saisi par</td><td style="padding:6px 0;text-align:right">${esc(dto.created_by)} (${esc(dto.created_by_role)})</td></tr>
          </table>
          <p style="margin:16px 0 4px;color:#6b7280;font-size:13px">Motif :</p>
          <p style="margin:0;padding:10px 12px;background:#fff7ed;border-left:3px solid #9a3412;border-radius:6px">${esc(dto.reason)}</p>
          <div style="text-align:center;margin:20px 0 4px">
            <a href="${esc(link)}" style="display:inline-block;padding:11px 22px;background:#10531a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Voir les sorties d'argent</a>
          </div>
        </div>
      </div></body></html>`;

    await transporter.sendMail({
      from: `"L'Harmattan Sénégal" <${process.env.SMTP_USER}>`,
      to: to.join(','),
      subject: `Sortie d'argent : ${fmt(dto.amount)} — ${dto.beneficiary}`,
      html,
    });
  } catch (e) {
    console.error('[EXPENSES] échec notification admins:', e.message);
  }
}

// ─── ROUTER FACTORY ──────────────────────────────────────────
export function createExpensesRouter({ db, dolibarrPool, auth, csrfProtection, getTransporter }) {
  const router = Router();
  ensureTables(db);
  const noCsrf = csrfProtection || ((req, res, next) => next());
  const siteUrl = process.env.SITE_URL || process.env.PUBLIC_URL || '';

  // Génère une réf DEP{aamm}-{0001}.
  function generateRef() {
    const now = new Date();
    const yymm = String(now.getFullYear() % 100).padStart(2, '0') + String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `DEP${yymm}-`;
    const max = db.prepare('SELECT MAX(ref) AS max FROM expenses WHERE ref LIKE ?').get(`${prefix}%`);
    let next = 1;
    if (max?.max) next = (parseInt(String(max.max).split('-')[1], 10) || 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  const requireAdmin = (req, res) => {
    if (!ADMIN_ROLES.includes(req.admin?.role)) {
      res.status(403).json({ error: 'Action réservée aux administrateurs' });
      return false;
    }
    return true;
  };

  // ═══════════════════════════════════════════════════════════
  // CONSTANTES UI (catégories / méthodes) — pour les <select>
  // ═══════════════════════════════════════════════════════════
  router.get('/meta', auth, (req, res) => {
    res.json({
      categories: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
      methods: Object.entries(METHOD_LABELS).map(([value, label]) => ({ value, label })),
    });
  });

  // ═══════════════════════════════════════════════════════════
  // SOURCES DE FONDS (+ soldes)
  // ═══════════════════════════════════════════════════════════
  router.get('/sources', auth, (req, res) => {
    try {
      res.json({ sources: computeSourceBalances(db) });
    } catch (err) {
      console.error('[EXPENSES] sources error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des sources' });
    }
  });

  router.post('/sources', auth, noCsrf, (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const b = req.body || {};
      const label = nonEmpty(b.label, { min: 2, max: 120 });
      if (!label) return res.status(400).json({ error: 'Libellé requis' });
      const type = ['caisse', 'banque', 'mobile'].includes(b.type) ? b.type : 'caisse';
      const opening = Math.max(0, Math.round(Number(b.opening_balance) || 0));
      // Clé unique dérivée du libellé.
      let key = String(b.key || label).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `src_${Date.now()}`;
      const exists = db.prepare('SELECT 1 FROM cash_sources WHERE key = ?').get(key);
      if (exists) key = `${key}_${Date.now().toString(36)}`;
      const r = db.prepare('INSERT INTO cash_sources (key, label, type, opening_balance) VALUES (?,?,?,?)')
        .run(key, label, type, opening);
      res.status(201).json({ id: r.lastInsertRowid, key });
    } catch (err) {
      console.error('[EXPENSES] create source error:', err.message);
      res.status(500).json({ error: 'Erreur création de la source' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // APPROVISIONNEMENT D'UNE SOURCE (top-up) — admin uniquement
  // ═══════════════════════════════════════════════════════════
  router.post('/topups', auth, noCsrf, (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const b = req.body || {};
      const sourceId = parseInt(b.source_id, 10);
      const source = sourceId ? db.prepare('SELECT * FROM cash_sources WHERE id = ?').get(sourceId) : null;
      if (!source) return res.status(400).json({ error: 'Source invalide' });
      const amount = cleanAmount(b.amount);
      if (!amount) return res.status(400).json({ error: 'Montant invalide' });
      const label = String(b.label || '').trim().slice(0, 200) || null;
      db.prepare('INSERT INTO cash_topups (source_id, amount, label, created_by, created_by_role) VALUES (?,?,?,?,?)')
        .run(sourceId, amount, label, req.admin?.username || 'admin', req.admin?.role || null);
      res.status(201).json({ success: true });
    } catch (err) {
      console.error('[EXPENSES] topup error:', err.message);
      res.status(500).json({ error: 'Erreur approvisionnement' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RAPPORT DE CAISSE — recettes encaissées − dépenses = solde net
  // ═══════════════════════════════════════════════════════════
  router.get('/report', auth, async (req, res) => {
    try {
      const dateFrom = String(req.query.date_from || '').trim();
      const dateTo = String(req.query.date_to || '').trim();
      if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
        return res.status(400).json({ error: 'date_from / date_to requis (YYYY-MM-DD)' });
      }

      // 1. Recettes : encaissements Dolibarr sur la période (par méthode).
      let receiptsByMethod = [];
      try {
        const [rows] = await dolibarrPool.query(
          `SELECT cp.code AS method_code, cp.libelle AS method_label,
                  COALESCE(SUM(p.amount),0) AS total, COUNT(*) AS count
           FROM llx_paiement p
           LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
           WHERE DATE(p.datep) >= ? AND DATE(p.datep) <= ?
           GROUP BY cp.code, cp.libelle
           ORDER BY total DESC`, [dateFrom, dateTo]
        );
        receiptsByMethod = rows.map(r => ({
          code: r.method_code || 'AUTRE',
          label: r.method_label || r.method_code || 'Autre',
          total: Number(r.total) || 0,
          count: Number(r.count) || 0,
        }));
      } catch (e) {
        console.error('[EXPENSES] report receipts error:', e.message);
      }
      const receiptsTotal = receiptsByMethod.reduce((s, m) => s + m.total, 0);

      // 2. Dépenses natives de la période (status='recorded').
      const sourceMap = new Map(db.prepare('SELECT id, label FROM cash_sources').all().map(s => [s.id, { label: s.label }]));
      const expenseRows = db.prepare(
        `SELECT * FROM expenses
         WHERE status='recorded' AND date(COALESCE(expense_date, created_at)) >= date(?)
           AND date(COALESCE(expense_date, created_at)) <= date(?)
         ORDER BY COALESCE(expense_date, created_at) ASC, id ASC`
      ).all(dateFrom, dateTo);
      const expenses = expenseRows.map(r => rowToDto(r, sourceMap));
      const expensesTotal = expenses.reduce((s, e) => s + e.amount, 0);

      // 3. Cumul par catégorie.
      const byCat = new Map();
      for (const e of expenses) {
        const agg = byCat.get(e.category) || { category: e.category, label: e.category_label, total: 0, count: 0 };
        agg.total += e.amount;
        agg.count += 1;
        byCat.set(e.category, agg);
      }
      const expensesByCategory = Array.from(byCat.values()).sort((a, b) => b.total - a.total);

      // 4. Approvisionnements de la période (entrées de fonds hors ventes).
      const [[topupAgg]] = [[db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS t FROM cash_topups WHERE date(created_at) >= date(?) AND date(created_at) <= date(?)`
      ).get(dateFrom, dateTo)]];
      const topupsTotal = Number(topupAgg.t) || 0;

      res.json({
        date_from: dateFrom,
        date_to: dateTo,
        receipts_by_method: receiptsByMethod,
        receipts_total: receiptsTotal,
        expenses,
        expenses_by_category: expensesByCategory,
        expenses_total: expensesTotal,
        topups_total: topupsTotal,
        net: receiptsTotal - expensesTotal,
      });
    } catch (err) {
      console.error('[EXPENSES] report error:', err.message);
      res.status(500).json({ error: 'Erreur génération du rapport' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // JOURNAL D'AUDIT GLOBAL
  // ═══════════════════════════════════════════════════════════
  router.get('/audit-log', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;
      const total = db.prepare('SELECT COUNT(*) AS n FROM expense_audit_log').get().n;
      const rows = db.prepare('SELECT * FROM expense_audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
      res.json({ entries: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
    } catch (err) {
      console.error('[EXPENSES] audit-log error:', err.message);
      res.status(500).json({ error: 'Erreur chargement du journal' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LISTE + FILTRES + KPIs
  // ═══════════════════════════════════════════════════════════
  router.get('/', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.category && CATEGORY_LABELS[req.query.category]) { where.push('category = ?'); params.push(req.query.category); }
      if (req.query.method && METHOD_LABELS[req.query.method]) { where.push('payment_method = ?'); params.push(req.query.method); }
      if (req.query.source_id) { where.push('source_id = ?'); params.push(parseInt(req.query.source_id, 10)); }
      if (req.query.status && STATUS_LABELS[req.query.status]) { where.push('status = ?'); params.push(req.query.status); }
      if (req.query.search) {
        where.push('(ref LIKE ? OR beneficiary LIKE ? OR reason LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat, pat);
      }
      if (req.query.date_from) { where.push('date(COALESCE(expense_date, created_at)) >= date(?)'); params.push(req.query.date_from); }
      if (req.query.date_to) { where.push('date(COALESCE(expense_date, created_at)) <= date(?)'); params.push(req.query.date_to); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM expenses ${whereSql}`).get(...params).n;
      const rows = db.prepare(
        `SELECT * FROM expenses ${whereSql} ORDER BY COALESCE(expense_date, created_at) DESC, id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      const sourceMap = new Map(db.prepare('SELECT id, label FROM cash_sources').all().map(s => [s.id, { label: s.label }]));

      // KPIs sur le filtre courant (hors pagination), dépenses actives uniquement.
      const kpiWhere = where.length ? whereSql + " AND status='recorded'" : "WHERE status='recorded'";
      const kpi = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS nb FROM expenses ${kpiWhere}`
      ).get(...params);
      const byCatRows = db.prepare(
        `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS nb FROM expenses ${kpiWhere} GROUP BY category ORDER BY total DESC`
      ).all(...params);

      res.json({
        expenses: rows.map(r => rowToDto(r, sourceMap)),
        total, page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: {
          total: Number(kpi.total) || 0,
          nb: Number(kpi.nb) || 0,
          by_category: byCatRows.map(r => ({
            category: r.category, label: CATEGORY_LABELS[r.category] || r.category,
            total: Number(r.total) || 0, nb: Number(r.nb) || 0,
          })),
        },
      });
    } catch (err) {
      console.error('[EXPENSES] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des dépenses' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL (+ audit de la dépense)
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', auth, (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Dépense introuvable' });
      const sourceMap = new Map(db.prepare('SELECT id, label FROM cash_sources').all().map(s => [s.id, { label: s.label }]));
      const audit = db.prepare('SELECT * FROM expense_audit_log WHERE fk_expense = ? ORDER BY id DESC').all(row.id);
      res.json({ expense: rowToDto(row, sourceMap), audit });
    } catch (err) {
      console.error('[EXPENSES] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement de la dépense' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CRÉATION D'UNE SORTIE D'ARGENT (+ notification admins)
  // ═══════════════════════════════════════════════════════════
  router.post('/', auth, noCsrf, async (req, res) => {
    try {
      if (!CREATOR_ROLES.includes(req.admin?.role)) {
        return res.status(403).json({ error: 'Accès refusé' });
      }
      const b = req.body || {};
      const amount = cleanAmount(b.amount);
      if (!amount) return res.status(400).json({ error: 'Montant invalide (entier positif requis)' });
      const category = CATEGORY_LABELS[b.category] ? b.category : null;
      if (!category) return res.status(400).json({ error: 'Catégorie invalide' });
      const method = METHOD_LABELS[b.payment_method] ? b.payment_method : null;
      if (!method) return res.status(400).json({ error: 'Méthode de paiement invalide' });
      const beneficiary = nonEmpty(b.beneficiary, { min: 2, max: 200 });
      if (!beneficiary) return res.status(400).json({ error: 'Bénéficiaire requis' });
      const reason = nonEmpty(b.reason, { min: 4, max: 1000 });
      if (!reason) return res.status(400).json({ error: 'Motif/justification requis (4 caractères min.)' });

      const sourceId = b.source_id ? parseInt(b.source_id, 10) : null;
      if (sourceId) {
        const src = db.prepare('SELECT id FROM cash_sources WHERE id = ? AND is_active = 1').get(sourceId);
        if (!src) return res.status(400).json({ error: 'Source de fonds invalide' });
      } else {
        return res.status(400).json({ error: 'Source de fonds requise' });
      }
      const note = String(b.note || '').trim().slice(0, 1000) || null;
      const expenseDate = isIsoDate(b.expense_date) ? b.expense_date : null;

      const create = db.transaction(() => {
        const ref = generateRef();
        const r = db.prepare(`INSERT INTO expenses
          (ref, category, beneficiary, amount, payment_method, source_id, reason, note, expense_date, status, created_by, created_by_role)
          VALUES (?,?,?,?,?,?,?,?,?, 'recorded', ?, ?)`).run(
          ref, category, beneficiary, amount, method, sourceId, reason, note, expenseDate,
          req.admin?.username || 'admin', req.admin?.role || null,
        );
        const id = r.lastInsertRowid;
        writeAudit(db, {
          expense_id: id, ref, action: 'create', reason, admin: req.admin,
          snapshot: { amount, category, beneficiary, method, source_id: sourceId },
        });
        return { id, ref };
      });
      const { id, ref } = create();

      // Notification admins (best-effort, après commit).
      const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
      const sourceMap = new Map(db.prepare('SELECT id, label FROM cash_sources').all().map(s => [s.id, { label: s.label }]));
      notifyAdmins(typeof getTransporter === 'function' ? getTransporter() : null, db, rowToDto(row, sourceMap), siteUrl);

      res.status(201).json({ id, ref });
    } catch (err) {
      console.error('[EXPENSES] create error:', err.message);
      res.status(500).json({ error: 'Erreur enregistrement de la sortie' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ACQUITTEMENT (admin marque le retrait comme vu → badge à zéro)
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/acknowledge', auth, noCsrf, (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT id FROM expenses WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Dépense introuvable' });
      db.prepare('UPDATE expenses SET acknowledged = 1 WHERE id = ?').run(id);
      res.json({ success: true });
    } catch (err) {
      console.error('[EXPENSES] acknowledge error:', err.message);
      res.status(500).json({ error: 'Erreur acquittement' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ANNULATION (tracée) — admin uniquement, motif requis
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/cancel', auth, noCsrf, (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Dépense introuvable' });
      if (row.status === 'cancelled') return res.status(409).json({ error: 'Dépense déjà annulée' });
      const reason = nonEmpty(req.body?.reason, { min: 4, max: 500 });
      if (!reason) return res.status(400).json({ error: 'Motif d\'annulation requis (4 caractères min.)' });

      db.prepare(`UPDATE expenses SET status='cancelled', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, cancel_reason=? WHERE id=?`)
        .run(req.admin?.username || 'admin', reason, id);
      writeAudit(db, {
        expense_id: id, ref: row.ref, action: 'cancel', reason, admin: req.admin,
        snapshot: { amount: row.amount, category: row.category, beneficiary: row.beneficiary },
      });
      res.json({ success: true });
    } catch (err) {
      console.error('[EXPENSES] cancel error:', err.message);
      res.status(500).json({ error: 'Erreur annulation' });
    }
  });

  return router;
}
