/**
 * Expenses Routes — Sorties d'argent / Dépenses (module NATIF).
 *
 * Enregistre toute sortie d'argent prise DANS LA CAISSE POS (loyer, salaires,
 * fournitures, transport, services, taxes…) avec :
 *   - justification obligatoire (motif + catégorie + bénéficiaire) ;
 *   - traçabilité complète (qui/quand/combien/pourquoi) via expense_audit_log immuable ;
 *   - notification automatique des admins dès qu'un retrait est enregistré (email + badge).
 *
 * SAISIE : uniquement au POS (par le caissier/manager). La dépense est posée comme
 * un mouvement de caisse `out` (pos_cash_movements) rattaché à la session POS ouverte,
 * donc DÉDUITE automatiquement par le rapport de caisse et la clôture. Si aucune session
 * n'est ouverte, la dépense est tout de même enregistrée (hors-caisse) pour la traçabilité.
 *
 * Cet écran admin est en CONSULTATION : liste, détail, journal d'audit, rapport de caisse
 * (recettes encaissées − dépenses = solde net) et ANNULATION (admins). La création se fait
 * au POS via [server/pos-routes.js] qui réutilise les helpers exportés ci-dessous.
 *
 * 100 % natif SQLite — aucune écriture comptable Dolibarr (la ligne de banque caisse est
 * créée côté POS comme pour tout mouvement de caisse).
 *
 * Sécurité : monté sur /api/admin/expenses, whitelist RBAC (super_admin, admin, comptable).
 * Annulation réservée aux admins (garde-fou applicatif).
 */

import { Router } from 'express';

// ─── CONSTANTES MÉTIER (partagées avec le POS) ───────────────
export const CATEGORY_LABELS = {
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

export const EXPENSE_STATUS_LABELS = { recorded: 'Enregistrée', cancelled: 'Annulée' };

const ADMIN_ROLES = ['super_admin', 'admin'];

// ─── SCHÉMA (partagé : appelé au montage des deux routeurs) ───
export function ensureExpenseTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    beneficiary TEXT NOT NULL,
    amount REAL NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    expense_date DATE,
    status TEXT NOT NULL DEFAULT 'recorded',
    acknowledged INTEGER NOT NULL DEFAULT 0,
    terminal INTEGER,
    session_id INTEGER,
    cash_movement_id INTEGER,
    in_register INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_by_role TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cancelled_by TEXT,
    cancelled_at DATETIME,
    cancel_reason TEXT
  )`);
  // Migration défensive : une table `expenses` antérieure peut exister sans les
  // colonnes du modèle « caisse POS » (terminal/session_id/cash_movement_id/in_register).
  // CREATE TABLE IF NOT EXISTS ne les ajoute pas → on les ajoute à la volée.
  for (const ddl of [
    'ALTER TABLE expenses ADD COLUMN terminal INTEGER',
    'ALTER TABLE expenses ADD COLUMN session_id INTEGER',
    'ALTER TABLE expenses ADD COLUMN cash_movement_id INTEGER',
    'ALTER TABLE expenses ADD COLUMN in_register INTEGER NOT NULL DEFAULT 1',
  ]) {
    try { db.exec(ddl); } catch { /* colonne déjà présente */ }
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_session ON expenses(session_id)');
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
}

// ─── HELPERS (partagés) ──────────────────────────────────────
export function cleanAmount(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, 1_000_000_000);
}

export function nonEmptyText(s, { min = 2, max = 500 } = {}) {
  const t = String(s ?? '').trim();
  return t.length >= min && t.length <= max ? t : null;
}

function isIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}

// Génère une réf DEP{aamm}-{0001}.
export function generateExpenseRef(db) {
  const now = new Date();
  const yymm = String(now.getFullYear() % 100).padStart(2, '0') + String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `DEP${yymm}-`;
  const max = db.prepare('SELECT MAX(ref) AS max FROM expenses WHERE ref LIKE ?').get(`${prefix}%`);
  let next = 1;
  if (max?.max) next = (parseInt(String(max.max).split('-')[1], 10) || 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

export function expenseRowToDto(r) {
  return {
    id: r.id,
    ref: r.ref,
    category: r.category,
    category_label: CATEGORY_LABELS[r.category] || r.category,
    beneficiary: r.beneficiary,
    amount: Number(r.amount),
    reason: r.reason,
    note: r.note,
    expense_date: r.expense_date,
    status: r.status,
    status_label: EXPENSE_STATUS_LABELS[r.status] || r.status,
    acknowledged: !!r.acknowledged,
    terminal: r.terminal,
    session_id: r.session_id,
    in_register: !!r.in_register,
    created_by: r.created_by,
    created_by_role: r.created_by_role,
    created_at: r.created_at,
    cancelled_by: r.cancelled_by,
    cancelled_at: r.cancelled_at,
    cancel_reason: r.cancel_reason,
  };
}

export function writeExpenseAudit(db, { expense_id, ref, action, reason, actor, snapshot }) {
  try {
    db.prepare(`INSERT INTO expense_audit_log
      (fk_expense, ref_expense, action, reason, user_id, user_name, user_role, snapshot)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      expense_id, ref || null, action, reason || null,
      actor?.id ?? null, actor?.name ?? null, actor?.role ?? null,
      snapshot ? JSON.stringify(snapshot) : null,
    );
  } catch (e) {
    console.error('[EXPENSES] échec écriture audit:', e.message);
  }
}

// Notification admins (best-effort, ne bloque jamais la création). Partagé avec le POS.
export async function notifyAdminsExpense(transporter, db, dto, siteUrl) {
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
    const origin = dto.in_register
      ? `Caisse POS ${dto.terminal ? '· Terminal ' + dto.terminal : ''}`
      : 'Hors-caisse (aucune session POS ouverte)';
    const html = `<!DOCTYPE html><html lang="fr"><body style="font-family:Arial,sans-serif;color:#374151;background:#fafafa;padding:24px">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.05)">
        <div style="background:#9a3412;padding:16px 24px"><h1 style="margin:0;color:#fff;font-size:17px">⚠️ Sortie d'argent (caisse)</h1></div>
        <div style="padding:24px">
          <p style="font-size:22px;font-weight:800;color:#9a3412;margin:0 0 12px">${esc(fmt(dto.amount))}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:6px 0;color:#6b7280">Référence</td><td style="padding:6px 0;text-align:right;font-weight:600">${esc(dto.ref)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Catégorie</td><td style="padding:6px 0;text-align:right">${esc(dto.category_label)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Bénéficiaire</td><td style="padding:6px 0;text-align:right">${esc(dto.beneficiary)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Origine</td><td style="padding:6px 0;text-align:right">${esc(origin)}</td></tr>
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

/**
 * Crée une dépense (sortie d'argent). Réutilisé par le POS.
 * Valide les champs, insère expense + audit `create`, et notifie les admins.
 * NE crée PAS le mouvement de caisse (pos_cash_movements) : c'est au POS de le faire
 * et de renvoyer cash_movement_id pour le rattachement.
 * @returns { ok:true, id, ref, dto } ou { ok:false, error }
 */
export function createExpenseRecord(db, {
  category, beneficiary, amount, reason, note,
  terminal = null, session_id = null, cash_movement_id = null, in_register = true,
  actor, // { id, name, role }
}) {
  const amt = cleanAmount(amount);
  if (!amt) return { ok: false, error: 'Montant invalide (entier positif requis)' };
  if (!CATEGORY_LABELS[category]) return { ok: false, error: 'Catégorie invalide' };
  const ben = nonEmptyText(beneficiary, { min: 2, max: 200 });
  if (!ben) return { ok: false, error: 'Bénéficiaire requis' };
  const rsn = nonEmptyText(reason, { min: 4, max: 1000 });
  if (!rsn) return { ok: false, error: 'Motif/justification requis (4 caractères min.)' };
  const cleanNote = String(note || '').trim().slice(0, 1000) || null;

  const create = db.transaction(() => {
    const ref = generateExpenseRef(db);
    const today = new Date().toISOString().slice(0, 10);
    const r = db.prepare(`INSERT INTO expenses
      (ref, category, beneficiary, amount, reason, note, expense_date, status,
       terminal, session_id, cash_movement_id, in_register, created_by, created_by_role)
      VALUES (?,?,?,?,?,?,?, 'recorded', ?,?,?,?,?,?)`).run(
      ref, category, ben, amt, rsn, cleanNote, today,
      terminal, session_id, cash_movement_id, in_register ? 1 : 0,
      actor?.name || 'POS', actor?.role || null,
    );
    const id = r.lastInsertRowid;
    writeExpenseAudit(db, {
      expense_id: id, ref, action: 'create', reason: rsn, actor,
      snapshot: { amount: amt, category, beneficiary: ben, terminal, in_register },
    });
    return { id, ref };
  });
  const { id, ref } = create();
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  return { ok: true, id, ref, dto: expenseRowToDto(row) };
}

// ─── ROUTER FACTORY (admin : consultation + rapport + annulation) ──
export function createExpensesRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();
  ensureExpenseTables(db);
  const noCsrf = csrfProtection || ((req, res, next) => next());

  const requireAdmin = (req, res) => {
    if (!ADMIN_ROLES.includes(req.admin?.role)) {
      res.status(403).json({ error: 'Action réservée aux administrateurs' });
      return false;
    }
    return true;
  };

  // ── Métadonnées (catégories) pour les <select> ──
  router.get('/meta', auth, (req, res) => {
    res.json({ categories: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })) });
  });

  // ── Rapport de caisse : recettes encaissées − dépenses = solde net ──
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
      const expenseRows = db.prepare(
        `SELECT * FROM expenses
         WHERE status='recorded' AND date(COALESCE(expense_date, created_at)) >= date(?)
           AND date(COALESCE(expense_date, created_at)) <= date(?)
         ORDER BY COALESCE(expense_date, created_at) ASC, id ASC`
      ).all(dateFrom, dateTo);
      const expenses = expenseRows.map(expenseRowToDto);
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

      res.json({
        date_from: dateFrom,
        date_to: dateTo,
        receipts_by_method: receiptsByMethod,
        receipts_total: receiptsTotal,
        expenses,
        expenses_by_category: expensesByCategory,
        expenses_total: expensesTotal,
        net: receiptsTotal - expensesTotal,
      });
    } catch (err) {
      console.error('[EXPENSES] report error:', err.message);
      res.status(500).json({ error: 'Erreur génération du rapport' });
    }
  });

  // ── Journal d'audit global ──
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

  // ── Liste + filtres + KPIs ──
  router.get('/', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.category && CATEGORY_LABELS[req.query.category]) { where.push('category = ?'); params.push(req.query.category); }
      if (req.query.status && EXPENSE_STATUS_LABELS[req.query.status]) { where.push('status = ?'); params.push(req.query.status); }
      if (req.query.terminal) { where.push('terminal = ?'); params.push(parseInt(req.query.terminal, 10)); }
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

      const kpiWhere = where.length ? whereSql + " AND status='recorded'" : "WHERE status='recorded'";
      const kpi = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS nb FROM expenses ${kpiWhere}`).get(...params);
      const byCatRows = db.prepare(
        `SELECT category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS nb FROM expenses ${kpiWhere} GROUP BY category ORDER BY total DESC`
      ).all(...params);

      res.json({
        expenses: rows.map(expenseRowToDto),
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

  // ── Détail (+ audit) ──
  router.get('/:id', auth, (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Dépense introuvable' });
      const audit = db.prepare('SELECT * FROM expense_audit_log WHERE fk_expense = ? ORDER BY id DESC').all(row.id);
      res.json({ expense: expenseRowToDto(row), audit });
    } catch (err) {
      console.error('[EXPENSES] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement de la dépense' });
    }
  });

  // ── Acquittement (admin marque le retrait comme vu → badge à zéro) ──
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

  // ── Annulation (tracée) — admin uniquement, motif requis ──
  // NB : ne re-crédite PAS automatiquement la caisse POS (le mouvement de caisse a
  // déjà été passé à la session, souvent déjà clôturée). L'annulation est comptable
  // (la dépense sort des totaux/rapports) et tracée dans l'audit.
  router.post('/:id/cancel', auth, noCsrf, (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Dépense introuvable' });
      if (row.status === 'cancelled') return res.status(409).json({ error: 'Dépense déjà annulée' });
      const reason = nonEmptyText(req.body?.reason, { min: 4, max: 500 });
      if (!reason) return res.status(400).json({ error: 'Motif d\'annulation requis (4 caractères min.)' });

      db.prepare(`UPDATE expenses SET status='cancelled', cancelled_by=?, cancelled_at=CURRENT_TIMESTAMP, cancel_reason=? WHERE id=?`)
        .run(req.admin?.username || 'admin', reason, id);
      writeExpenseAudit(db, {
        expense_id: id, ref: row.ref, action: 'cancel', reason,
        actor: { id: req.admin?.id, name: req.admin?.username, role: req.admin?.role },
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
