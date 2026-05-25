import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import multer from 'multer';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NEWS_IMAGES_DIR = join(__dirname, '..', 'public', 'images', 'news');
if (!existsSync(NEWS_IMAGES_DIR)) mkdirSync(NEWS_IMAGES_DIR, { recursive: true });

const newsImageUpload = multer({
  storage: multer.diskStorage({
    destination: NEWS_IMAGES_DIR,
    filename: (req, file, cb) => {
      const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase();
      cb(null, `news-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(jpg|jpeg|png|webp)$/i.test(file.originalname));
  },
});

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function uniqueSlug(db, base, excludeId = null) {
  let slug = base || `actualite-${Date.now()}`;
  let i = 1;
  const stmt = excludeId
    ? db.prepare('SELECT id FROM news_articles WHERE slug = ? AND id != ?')
    : db.prepare('SELECT id FROM news_articles WHERE slug = ?');
  while (true) {
    const row = excludeId ? stmt.get(slug, excludeId) : stmt.get(slug);
    if (!row) return slug;
    i += 1;
    slug = `${base}-${i}`;
  }
}

function logActivity(db, username, action, details = '') {
  try {
    db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
      .run(username, action, details);
  } catch (err) {
    console.warn('logActivity (news) failed:', err.message);
  }
}

function sanitizeBoolean(value, def = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return def;
}

function rowToArticle(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    category: row.category || '',
    excerpt: row.excerpt || '',
    content: row.content || '',
    cover_image: row.cover_image || '',
    status: row.status,
    published_at: row.published_at,
    pinned: !!row.pinned,
    author_username: row.author_username || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createNewsRouter({ db, cache, adminAuth, csrfProtection }) {
  const router = Router();

  // ─── SCHEMA ──────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS news_articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    category TEXT,
    excerpt TEXT,
    content TEXT,
    cover_image TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    pinned INTEGER NOT NULL DEFAULT 0,
    published_at DATETIME,
    author_username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_news_status ON news_articles(status, published_at DESC)'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_news_slug ON news_articles(slug)'); } catch (e) { void e; }

  const invalidatePublicCache = () => {
    try { cache.del('news:public:list'); } catch { /* ignore */ }
  };

  // ─── PUBLIC ──────────────────────────────────────────────
  router.get('/api/news', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
      const cacheKey = `news:public:list:${limit}`;
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);

      const rows = db.prepare(
        `SELECT * FROM news_articles
         WHERE status = 'published'
         ORDER BY pinned DESC, COALESCE(published_at, created_at) DESC
         LIMIT ?`
      ).all(limit);
      const articles = rows.map(rowToArticle);
      cache.set(cacheKey, articles, 300);
      res.json(articles);
    } catch (err) {
      console.error('GET /api/news error:', err.message);
      res.status(500).json({ error: 'Erreur chargement actualités' });
    }
  });

  router.get('/api/news/:slug', (req, res) => {
    try {
      const row = db.prepare(
        `SELECT * FROM news_articles WHERE slug = ? AND status = 'published'`
      ).get(req.params.slug);
      if (!row) return res.status(404).json({ error: 'Actualité introuvable' });
      res.json(rowToArticle(row));
    } catch (err) {
      console.error('GET /api/news/:slug error:', err.message);
      res.status(500).json({ error: 'Erreur chargement actualité' });
    }
  });

  // ─── ADMIN ───────────────────────────────────────────────
  router.get('/api/admin/news', adminAuth, (req, res) => {
    try {
      const { status, search } = req.query;
      const filters = [];
      const params = [];
      if (status && ['draft', 'published'].includes(status)) {
        filters.push('status = ?');
        params.push(status);
      }
      if (search && String(search).trim()) {
        filters.push('(title LIKE ? OR excerpt LIKE ? OR content LIKE ?)');
        const q = `%${String(search).trim()}%`;
        params.push(q, q, q);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const rows = db.prepare(
        `SELECT * FROM news_articles ${where}
         ORDER BY pinned DESC, COALESCE(published_at, updated_at) DESC`
      ).all(...params);
      res.json(rows.map(rowToArticle));
    } catch (err) {
      console.error('GET /api/admin/news error:', err.message);
      res.status(500).json({ error: 'Erreur chargement' });
    }
  });

  router.get('/api/admin/news/:id', adminAuth, (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Introuvable' });
      res.json(rowToArticle(row));
    } catch (err) {
      console.error('GET /api/admin/news/:id error:', err.message);
      res.status(500).json({ error: 'Erreur' });
    }
  });

  router.post('/api/admin/news', adminAuth, csrfProtection, (req, res) => {
    try {
      const { title, category, excerpt, content, cover_image, status, pinned } = req.body || {};
      if (!title || !String(title).trim()) {
        return res.status(400).json({ error: 'Le titre est requis' });
      }
      const finalStatus = status === 'published' ? 'published' : 'draft';
      const slug = uniqueSlug(db, slugify(title));
      const publishedAt = finalStatus === 'published' ? new Date().toISOString() : null;
      const info = db.prepare(`
        INSERT INTO news_articles
          (title, slug, category, excerpt, content, cover_image, status, pinned, published_at, author_username)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        String(title).trim(),
        slug,
        category ? String(category).trim() : null,
        excerpt ? String(excerpt).trim() : null,
        content ? String(content) : null,
        cover_image || null,
        finalStatus,
        sanitizeBoolean(pinned) ? 1 : 0,
        publishedAt,
        req.admin?.username || null,
      );
      logActivity(db, req.admin?.username || 'system', 'news.create', `id=${info.lastInsertRowid} title="${title}"`);
      invalidatePublicCache();
      const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(info.lastInsertRowid);
      res.status(201).json(rowToArticle(row));
    } catch (err) {
      console.error('POST /api/admin/news error:', err.message);
      res.status(500).json({ error: 'Erreur création' });
    }
  });

  router.put('/api/admin/news/:id', adminAuth, csrfProtection, (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Introuvable' });

      const { title, category, excerpt, content, cover_image, status, pinned } = req.body || {};
      const newTitle = title !== undefined ? String(title).trim() : existing.title;
      if (!newTitle) return res.status(400).json({ error: 'Le titre est requis' });

      const newSlug = title !== undefined && newTitle !== existing.title
        ? uniqueSlug(db, slugify(newTitle), existing.id)
        : existing.slug;

      const newStatus = status === 'published' || status === 'draft' ? status : existing.status;
      let newPublishedAt = existing.published_at;
      if (existing.status !== 'published' && newStatus === 'published') {
        newPublishedAt = new Date().toISOString();
      } else if (newStatus === 'draft') {
        newPublishedAt = null;
      }

      db.prepare(`
        UPDATE news_articles SET
          title = ?,
          slug = ?,
          category = ?,
          excerpt = ?,
          content = ?,
          cover_image = ?,
          status = ?,
          pinned = ?,
          published_at = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        newTitle,
        newSlug,
        category !== undefined ? (category ? String(category).trim() : null) : existing.category,
        excerpt !== undefined ? (excerpt ? String(excerpt).trim() : null) : existing.excerpt,
        content !== undefined ? (content ? String(content) : null) : existing.content,
        cover_image !== undefined ? (cover_image || null) : existing.cover_image,
        newStatus,
        pinned !== undefined ? (sanitizeBoolean(pinned) ? 1 : 0) : existing.pinned,
        newPublishedAt,
        existing.id,
      );
      logActivity(db, req.admin?.username || 'system', 'news.update', `id=${existing.id}`);
      invalidatePublicCache();
      const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(existing.id);
      res.json(rowToArticle(row));
    } catch (err) {
      console.error('PUT /api/admin/news/:id error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour' });
    }
  });

  router.delete('/api/admin/news/:id', adminAuth, csrfProtection, (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM news_articles WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Introuvable' });
      db.prepare('DELETE FROM news_articles WHERE id = ?').run(req.params.id);
      logActivity(db, req.admin?.username || 'system', 'news.delete', `id=${row.id} title="${row.title}"`);
      invalidatePublicCache();
      res.json({ ok: true });
    } catch (err) {
      console.error('DELETE /api/admin/news/:id error:', err.message);
      res.status(500).json({ error: 'Erreur suppression' });
    }
  });

  router.post('/api/admin/news/upload-image', adminAuth, csrfProtection, newsImageUpload.single('image'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
      res.json({ path: `/images/news/${req.file.filename}` });
    } catch (err) {
      console.error('POST /api/admin/news/upload-image error:', err.message);
      res.status(500).json({ error: 'Erreur upload' });
    }
  });

  return router;
}
