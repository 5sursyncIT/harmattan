/**
 * Legal Deposit Routes — Gestion du dépôt légal (registre par titre).
 *
 * Chaque ouvrage publié doit être déposé auprès des institutions habilitées
 * (Direction du Livre, Archives nationales, BNF, Bibliothèque/IFAN…). Ce module
 * tient le registre : n° de dépôt légal, date, trimestre/année, institutions
 * destinataires (avec nb d'exemplaires), statut (à faire / déposé) et note.
 *
 * Données stockées en SQLite (table locale legal_deposits). Le titre peut être
 * relié au catalogue Dolibarr (llx_product) via product_id + isbn.
 *
 * Sécurité : monté sur /api/admin/legal-deposits (whitelist RBAC : super_admin,
 * admin, editor, gestionnaire_stock, imprimeur).
 */

import { Router } from 'express';

const STATUS_VALUES = ['todo', 'deposited'];
const STATUS_LABELS = { todo: 'À faire', deposited: 'Déposé' };

// Institutions de dépôt pré-listées (le formulaire les propose ; saisie libre possible).
const INSTITUTIONS = [
  'Direction du Livre et de la Lecture (DLL)',
  'Archives nationales du Sénégal',
  'BNF (France)',
  'Bibliothèque / IFAN',
];

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS legal_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    isbn TEXT,
    title TEXT NOT NULL,
    author TEXT,
    dl_number TEXT,
    deposit_date TEXT,
    dl_quarter TEXT,
    dl_year INTEGER,
    institutions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'todo',
    note TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_legal_deposits_status ON legal_deposits(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_legal_deposits_product ON legal_deposits(product_id)`);
}

// Parse sûr du JSON des institutions → tableau de { name, copies }.
function parseInstitutions(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) return [];
    return arr
      .map((i) => ({ name: String(i?.name || '').slice(0, 200), copies: Math.max(0, parseInt(i?.copies, 10) || 0) }))
      .filter((i) => i.name);
  } catch {
    return [];
  }
}

function sanitizeInstitutions(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((i) => ({ name: String(i?.name || '').trim().slice(0, 200), copies: Math.max(0, parseInt(i?.copies, 10) || 0) }))
    .filter((i) => i.name)
    .slice(0, 20);
}

function rowToDto(row) {
  const institutions = parseInstitutions(row.institutions_json);
  return {
    id: row.id,
    product_id: row.product_id || null,
    isbn: row.isbn || null,
    title: row.title,
    author: row.author || null,
    dl_number: row.dl_number || null,
    deposit_date: row.deposit_date || null,
    dl_quarter: row.dl_quarter || null,
    dl_year: row.dl_year || null,
    institutions,
    total_copies: institutions.reduce((s, i) => s + i.copies, 0),
    status: row.status,
    status_label: STATUS_LABELS[row.status] || row.status,
    note: row.note || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createLegalDepositRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();
  ensureTables(db);
  const csrf = csrfProtection || ((req, res, next) => next());

  // ═══════════════════════════════════════════════════════════
  // LISTE DES INSTITUTIONS (pour le formulaire)
  // ═══════════════════════════════════════════════════════════
  router.get('/institutions', auth, (req, res) => {
    // Liste prédéfinie + institutions déjà saisies dans le registre, pour qu'une
    // institution ajoutée une fois reste proposée lors des saisies suivantes.
    const rows = db.prepare('SELECT institutions_json FROM legal_deposits').all();
    const used = new Set();
    for (const r of rows) parseInstitutions(r.institutions_json).forEach((i) => used.add(i.name));
    const merged = [...new Set([...INSTITUTIONS, ...used])];
    res.json({ institutions: merged });
  });

  // ═══════════════════════════════════════════════════════════
  // RECHERCHE D'UN TITRE DANS LE CATALOGUE (réf, titre, ISBN)
  // ═══════════════════════════════════════════════════════════
  router.get('/books/search', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ books: [] });
      const pat = `%${q}%`;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, barcode
         FROM llx_product
         WHERE ref LIKE ? OR label LIKE ? OR barcode LIKE ?
         ORDER BY label ASC LIMIT 20`,
        [pat, pat, pat]
      );
      res.json({ books: rows.map((r) => ({
        id: r.id, label: r.label, isbn: r.barcode || r.ref || null,
      })) });
    } catch (err) {
      console.error('[LEGAL_DEPOSIT] books search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche titre' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LISTE + KPIs
  // ═══════════════════════════════════════════════════════════
  router.get('/', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.status && STATUS_VALUES.includes(req.query.status)) {
        where.push('status = ?'); params.push(req.query.status);
      }
      if (req.query.year) {
        const y = parseInt(req.query.year, 10);
        if (y) { where.push('dl_year = ?'); params.push(y); }
      }
      if (req.query.search) {
        where.push('(title LIKE ? OR isbn LIKE ? OR dl_number LIKE ? OR author LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat, pat, pat);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM legal_deposits ${whereSql}`).get(...params).n;
      const rows = db.prepare(
        `SELECT * FROM legal_deposits ${whereSql} ORDER BY (status = 'todo') DESC, deposit_date DESC, id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      const kpis = db.prepare(`SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo,
          SUM(CASE WHEN status = 'deposited' THEN 1 ELSE 0 END) AS deposited
        FROM legal_deposits`).get();

      res.json({
        deposits: rows.map(rowToDto),
        total, page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: {
          total: Number(kpis.total || 0),
          todo: Number(kpis.todo || 0),
          deposited: Number(kpis.deposited || 0),
        },
      });
    } catch (err) {
      console.error('[LEGAL_DEPOSIT] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement du registre' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', auth, (req, res) => {
    const row = db.prepare('SELECT * FROM legal_deposits WHERE id = ?').get(parseInt(req.params.id, 10));
    if (!row) return res.status(404).json({ error: 'Entrée introuvable' });
    res.json({ deposit: rowToDto(row) });
  });

  // ═══════════════════════════════════════════════════════════
  // CRÉATION
  // ═══════════════════════════════════════════════════════════
  router.post('/', auth, csrf, (req, res) => {
    try {
      const b = req.body || {};
      const title = String(b.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Titre requis' });
      const status = STATUS_VALUES.includes(b.status) ? b.status : 'todo';
      const institutions = sanitizeInstitutions(b.institutions);

      const info = db.prepare(`INSERT INTO legal_deposits
        (product_id, isbn, title, author, dl_number, deposit_date, dl_quarter, dl_year, institutions_json, status, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.product_id ? parseInt(b.product_id, 10) : null,
        b.isbn ? String(b.isbn).trim().slice(0, 30) : null,
        title.slice(0, 300),
        b.author ? String(b.author).trim().slice(0, 200) : null,
        b.dl_number ? String(b.dl_number).trim().slice(0, 60) : null,
        b.deposit_date ? String(b.deposit_date).slice(0, 10) : null,
        b.dl_quarter ? String(b.dl_quarter).trim().slice(0, 10) : null,
        b.dl_year ? parseInt(b.dl_year, 10) : null,
        JSON.stringify(institutions),
        status,
        b.note ? String(b.note).trim().slice(0, 2000) : null,
        req.admin?.username || null,
      );
      const row = db.prepare('SELECT * FROM legal_deposits WHERE id = ?').get(info.lastInsertRowid);
      res.status(201).json({ deposit: rowToDto(row) });
    } catch (err) {
      console.error('[LEGAL_DEPOSIT] create error:', err.message);
      res.status(500).json({ error: "Erreur lors de l'enregistrement" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // MISE À JOUR
  // ═══════════════════════════════════════════════════════════
  router.put('/:id', auth, csrf, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = db.prepare('SELECT * FROM legal_deposits WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Entrée introuvable' });

      const b = req.body || {};
      const title = b.title !== undefined ? String(b.title).trim() : existing.title;
      if (!title) return res.status(400).json({ error: 'Titre requis' });
      const status = STATUS_VALUES.includes(b.status) ? b.status : existing.status;
      const institutions = b.institutions !== undefined
        ? sanitizeInstitutions(b.institutions)
        : parseInstitutions(existing.institutions_json);

      db.prepare(`UPDATE legal_deposits SET
        product_id = ?, isbn = ?, title = ?, author = ?, dl_number = ?, deposit_date = ?,
        dl_quarter = ?, dl_year = ?, institutions_json = ?, status = ?, note = ?,
        updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        b.product_id !== undefined ? (b.product_id ? parseInt(b.product_id, 10) : null) : existing.product_id,
        b.isbn !== undefined ? (b.isbn ? String(b.isbn).trim().slice(0, 30) : null) : existing.isbn,
        title.slice(0, 300),
        b.author !== undefined ? (b.author ? String(b.author).trim().slice(0, 200) : null) : existing.author,
        b.dl_number !== undefined ? (b.dl_number ? String(b.dl_number).trim().slice(0, 60) : null) : existing.dl_number,
        b.deposit_date !== undefined ? (b.deposit_date ? String(b.deposit_date).slice(0, 10) : null) : existing.deposit_date,
        b.dl_quarter !== undefined ? (b.dl_quarter ? String(b.dl_quarter).trim().slice(0, 10) : null) : existing.dl_quarter,
        b.dl_year !== undefined ? (b.dl_year ? parseInt(b.dl_year, 10) : null) : existing.dl_year,
        JSON.stringify(institutions),
        status,
        b.note !== undefined ? (b.note ? String(b.note).trim().slice(0, 2000) : null) : existing.note,
        id,
      );
      const row = db.prepare('SELECT * FROM legal_deposits WHERE id = ?').get(id);
      res.json({ deposit: rowToDto(row) });
    } catch (err) {
      console.error('[LEGAL_DEPOSIT] update error:', err.message);
      res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SUPPRESSION
  // ═══════════════════════════════════════════════════════════
  router.delete('/:id', auth, csrf, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const info = db.prepare('DELETE FROM legal_deposits WHERE id = ?').run(id);
      if (info.changes === 0) return res.status(404).json({ error: 'Entrée introuvable' });
      res.json({ success: true });
    } catch (err) {
      console.error('[LEGAL_DEPOSIT] delete error:', err.message);
      res.status(500).json({ error: 'Erreur lors de la suppression' });
    }
  });

  return router;
}
