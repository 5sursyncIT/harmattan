/**
 * Router pour la gestion des livres (CRUD complet)
 * Écrit directement dans Dolibarr via l'API REST avec l'admin key.
 */

import { Router } from 'express';
import axios from 'axios';
import multer from 'multer';
import sharp from 'sharp';
import 'dotenv/config';
import { validateBook, validateISBN } from '../src/utils/bookValidation.js';
import {
  EXCLUDED_CATEGORY_LABELS,
  excludedCategoryPlaceholders,
} from '../src/utils/excludedCategories.js';

const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
const DOLIBARR_URL = process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php';

if (!ADMIN_API_KEY) {
  console.warn('[BOOKS] DOLIBARR_ADMIN_API_KEY non définie — les écritures dans Dolibarr échoueront');
}

const adminApi = axios.create({
  baseURL: DOLIBARR_URL,
  headers: { 'DOLAPIKEY': ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Detect real image format via magic bytes. Returns 'jpeg'|'png'|'webp'|'gif'|null
function detectImageFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}

const excludedListSql = `(${excludedCategoryPlaceholders()})`;

// Décodage minimal des entités HTML : les libellés Dolibarr historiques sont
// stockés encodés (« Po&eacute;sie », « Th&eacute;&acirc;tre »). Utilisé pour
// un dédoublonnage fiable des genres, insensible à la casse et aux accents.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å', atilde: 'ã',
  ugrave: 'ù', ucirc: 'û', uuml: 'ü', uacute: 'ú',
  icirc: 'î', iuml: 'ï', igrave: 'ì', iacute: 'í',
  ocirc: 'ô', ouml: 'ö', ograve: 'ò', oacute: 'ó', otilde: 'õ',
  ccedil: 'ç', ntilde: 'ñ', oelig: 'œ', aelig: 'æ',
};

function decodeEntitiesServer(str) {
  if (!str) return '';
  return String(str).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const cp = (code[1] === 'x' || code[1] === 'X')
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const key = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

// Forme normalisée d'un libellé pour comparaison : décodé, sans accents,
// minuscule, espaces compactés. « Po&eacute;sie » et « poesie » → « poesie ».
function normalizeLabel(str) {
  return decodeEntitiesServer(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crée le router.
 * @param {Object} deps - { dolibarrPool, auth, csrfProtection, cache, db }
 */
export function createBookRouter({ dolibarrPool, auth, csrfProtection, cache, db }) {
  const router = Router();

  // Garde « administrateurs uniquement » : réservé aux profils super_admin / admin.
  // Utilisé pour les données sensibles de pilotage (ex. quantités écoulées).
  const adminOnly = (req, res, next) => {
    const role = req.admin?.role;
    if (role !== 'super_admin' && role !== 'admin') {
      return res.status(403).json({ error: 'Réservé aux administrateurs' });
    }
    next();
  };

  async function fetchAllowedGenreIds() {
    const [rows] = await dolibarrPool.query(
      `SELECT rowid FROM llx_categorie WHERE type = 0 AND label NOT IN ${excludedListSql}`,
      EXCLUDED_CATEGORY_LABELS
    );
    return rows.map((r) => r.rowid);
  }

  async function fetchProductGenreIds(productId) {
    const [rows] = await dolibarrPool.query(
      `SELECT c.rowid
       FROM llx_categorie c
       INNER JOIN llx_categorie_product cp ON cp.fk_categorie = c.rowid
       WHERE cp.fk_product = ? AND c.type = 0 AND c.label NOT IN ${excludedListSql}`,
      [productId, ...EXCLUDED_CATEGORY_LABELS]
    );
    return rows.map((r) => r.rowid);
  }

  // ── Helper: parent sous lequel rattacher un nouveau genre ──
  // On choisit le parent qui regroupe déjà le plus de genres : la liste
  // s'auto-corrige si l'arborescence Dolibarr évolue (pas d'ID en dur).
  // Fallback racine (0) si aucun genre existant.
  async function resolveGenreParentId() {
    const [rows] = await dolibarrPool.query(
      `SELECT fk_parent, COUNT(*) AS n
         FROM llx_categorie
        WHERE type = 0 AND label NOT IN ${excludedListSql}
        GROUP BY fk_parent
        ORDER BY n DESC, fk_parent ASC
        LIMIT 1`,
      EXCLUDED_CATEGORY_LABELS
    );
    return rows.length ? rows[0].fk_parent : 0;
  }

  // ── Helper: lit un genre (catégorie produit) par id, ou null ──
  async function fetchGenreById(id) {
    const [rows] = await dolibarrPool.query(
      'SELECT rowid, label, fk_parent FROM llx_categorie WHERE rowid = ? AND type = 0 LIMIT 1',
      [id]
    );
    return rows.length ? rows[0] : null;
  }

  // ── Helper: ids des produits rattachés à un genre ──
  async function fetchGenreProductIds(genreId) {
    const [rows] = await dolibarrPool.query(
      'SELECT fk_product FROM llx_categorie_product WHERE fk_categorie = ?',
      [genreId]
    );
    return rows.map((r) => r.fk_product);
  }

  // ── Helper: nombre de sous-genres (catégories enfants non système) ──
  async function countGenreChildren(genreId) {
    const [rows] = await dolibarrPool.query(
      `SELECT COUNT(*) AS n FROM llx_categorie
        WHERE fk_parent = ? AND type = 0 AND label NOT IN ${excludedListSql}`,
      [genreId, ...EXCLUDED_CATEGORY_LABELS]
    );
    return rows[0]?.n || 0;
  }

  // ── Helper: un libellé correspond-il à une catégorie système réservée ? ──
  function isReservedLabel(label) {
    const target = normalizeLabel(label);
    return EXCLUDED_CATEGORY_LABELS.some((l) => normalizeLabel(l) === target);
  }

  // ── Helper: invalide les caches liés aux catégories/genres ──
  function invalidateCategoryCaches() {
    if (!cache) return;
    cache.del('categories:all');
    for (const k of cache.keys()) {
      if (k.startsWith('products:') || k.startsWith('suggest:') || k.startsWith('catimg:')) {
        cache.del(k);
      }
    }
  }

  // ── Helper: check ISBN uniqueness (exclude self for updates) ──
  async function isIsbnDuplicate(isbn, excludeId = null) {
    const [rows] = await dolibarrPool.query(
      'SELECT rowid, ref FROM llx_product WHERE (barcode = ? OR ref = ?) AND rowid != ? LIMIT 1',
      [isbn, isbn, excludeId || 0]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  // ── Helper: build Dolibarr payload from validated book ──
  function buildDolibarrPayload(normalized) {
    const authorFull = [normalized.author_nom, normalized.author_prenom]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      ref: normalized.isbn,
      label: normalized.title,
      description: normalized.description || '',
      price: normalized.price_ttc,
      price_ttc: normalized.price_ttc,
      tva_tx: 0,
      barcode: normalized.isbn,
      type: 0, // product
      status: 1, // tosell
      status_buy: 1,
      array_options: {
        options_auteur: authorFull,
        options_soustitre: normalized.soustitre || '',
        options_longdescript: normalized.description || '',
        options_publication_year: normalized.publication_year,
        options_nombre_pages: normalized.nombre_pages,
        options_editeur: normalized.editeur,
      },
    };
  }

  // ── Helper: marqueur « Ouvrage à paraître » (table SQLite book_upcoming) ──
  // Pilote la section home + la précommande directement depuis la fiche produit.
  function normalizeReleaseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }

  function syncUpcomingFlag(productId, body) {
    const isUpcoming = body?.is_upcoming === true || body?.is_upcoming === 'true'
      || body?.is_upcoming === 1 || body?.is_upcoming === '1';

    if (!isUpcoming) {
      db.prepare('DELETE FROM book_upcoming WHERE product_id = ?').run(productId);
      cache?.del('upcoming_books:public');
      return;
    }

    const releaseDate = normalizeReleaseDate(body?.release_date);
    const summary = typeof body?.upcoming_summary === 'string'
      ? body.upcoming_summary.trim().slice(0, 2000) : '';
    let pct = parseFloat(body?.preorder_discount_pct);
    if (!Number.isFinite(pct) || pct < 0) pct = 0;
    if (pct > 100) pct = 100;

    db.prepare(`
      INSERT INTO book_upcoming (product_id, release_date, summary, preorder_discount_pct, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(product_id) DO UPDATE SET
        release_date = excluded.release_date,
        summary = excluded.summary,
        preorder_discount_pct = excluded.preorder_discount_pct,
        updated_at = datetime('now')
    `).run(productId, releaseDate, summary, pct);
    cache?.del('upcoming_books:public');
  }

  // ══════════════════════════════════════════════════════
  // Dual-write Auteur (Phase 1 refactor) — sync vers book_authors SQLite
  // ══════════════════════════════════════════════════════

  // Normalisation pour matching : minuscules, sans accents, espaces tassés
  function normalizeAuthorName(s) {
    if (!s) return '';
    return String(s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip combining diacritics
      .toLowerCase()
      .replace(/[\s,;\-_]+/g, ' ')
      .trim();
  }

  // Cherche un SQLite authors.id qui matche le nom de l'auteur sur display_name
  // ou la combinaison "lastname firstname". Renvoie l'ID ou null.
  function matchAuthorIdByName(authorFull) {
    if (!authorFull) return null;
    const target = normalizeAuthorName(authorFull);
    if (!target) return null;
    const rows = db.prepare(
      `SELECT id, firstname, lastname, display_name FROM authors`
    ).all();
    for (const r of rows) {
      const cand1 = normalizeAuthorName(r.display_name);
      const cand2 = normalizeAuthorName(`${r.firstname || ''} ${r.lastname || ''}`);
      const cand3 = normalizeAuthorName(`${r.lastname || ''} ${r.firstname || ''}`);
      if (cand1 === target || cand2 === target || cand3 === target) return r.id;
    }
    return null;
  }

  // Met à jour book_authors pour ce produit : 0 ou 1 entrée selon match.
  // Pas d'exception remontée : la legacy pe.auteur reste source de vérité.
  function syncBookAuthorsLink(productId, authorFull) {
    try {
      const authorId = matchAuthorIdByName(authorFull);
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM book_authors WHERE product_id = ?`).run(productId);
        if (authorId) {
          db.prepare(
            `INSERT INTO book_authors (product_id, author_id, role, position) VALUES (?, ?, 'author', 0)`
          ).run(productId, authorId);
        }
      });
      tx();
      return { matched: !!authorId, authorId };
    } catch (e) {
      console.warn(`[BOOKS] syncBookAuthorsLink p=${productId} err:`, e.message);
      return { matched: false, authorId: null, error: e.message };
    }
  }

  // Version multi-auteurs (Phase 4) : prend un tableau d'IDs valides
  // (déjà créés/sélectionnés côté UI), conserve l'ordre comme position.
  // Vérifie l'existence de chaque ID avant insert (anti-orphelins).
  function syncBookAuthorsLinks(productId, authorIds) {
    try {
      const validIds = [];
      for (const id of authorIds) {
        const n = parseInt(id, 10);
        if (!Number.isInteger(n) || n <= 0) continue;
        const exists = db.prepare(`SELECT 1 FROM authors WHERE id = ?`).get(n);
        if (exists) validIds.push(n);
      }
      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM book_authors WHERE product_id = ?`).run(productId);
        for (let i = 0; i < validIds.length; i++) {
          db.prepare(
            `INSERT INTO book_authors (product_id, author_id, role, position) VALUES (?, ?, 'author', ?)`
          ).run(productId, validIds[i], i);
        }
      });
      tx();
      return { matched: validIds.length > 0, authorIds: validIds };
    } catch (e) {
      console.warn(`[BOOKS] syncBookAuthorsLinks p=${productId} err:`, e.message);
      return { matched: false, authorIds: [], error: e.message };
    }
  }

  // Construit la chaîne display pour pe.auteur depuis une liste d'IDs SQLite.
  function buildAuteurFieldFromIds(authorIds) {
    if (!Array.isArray(authorIds) || authorIds.length === 0) return '';
    const placeholders = authorIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, display_name, firstname, lastname FROM authors WHERE id IN (${placeholders})`
    ).all(...authorIds);
    const byId = new Map(rows.map((r) => [r.id, r.display_name || `${r.firstname} ${r.lastname}`.trim()]));
    return authorIds.map((id) => byId.get(parseInt(id, 10))).filter(Boolean).join(' ; ');
  }

  function invalidateProductCache(productId, ref = null) {
    if (!cache) return;
    cache.del(`product:${productId}`);
    cache.del('price-range');
    cache.del('categories:all');
    cache.del('refs-with-real-covers');
    cache.del('public_authors_book_counts_fk'); // bibliographie auteur via JOIN
    if (ref) {
      cache.del(`img:${ref}`);
      cache.del(`realcover:${ref}`);
    }
    for (const k of cache.keys()) {
      if (
        k.startsWith('products:') ||
        k.startsWith('suggest:') ||
        k.startsWith(`imgdata:${productId}:`) ||
        k.startsWith('catimg:')
      ) {
        cache.del(k);
      }
    }
  }

  // Normalise un payload genre_ids[] accepté, en gardant la rétrocompat genre_id
  function resolveGenreIds(body) {
    if (Array.isArray(body.genre_ids) && body.genre_ids.length > 0) {
      return body.genre_ids.map((g) => parseInt(g, 10)).filter((n) => !Number.isNaN(n));
    }
    if (body.genre_id !== undefined && body.genre_id !== null && body.genre_id !== '') {
      const n = parseInt(body.genre_id, 10);
      return Number.isNaN(n) ? [] : [n];
    }
    return [];
  }

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books — Liste paginée
  // ══════════════════════════════════════════════════════
  router.get('/', auth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const q = req.query.q ? String(req.query.q).trim() : '';
      const genre = req.query.genre ? parseInt(req.query.genre) : null;

      const conditions = ['p.fk_product_type = 0'];
      const params = [];

      if (q) {
        const like = `%${q}%`;
        // Un livre peut porter plusieurs ISBN (rééditions/réimpressions L'Harmattan) :
        // l'ISBN alternatif figure souvent dans la description et non dans ref/barcode.
        // Quand la requête ressemble à un ISBN (≥10 chiffres), on cherche aussi la
        // description, sur les seuls chiffres, pour tolérer tirets/espaces saisis.
        const digits = String(q).replace(/[^0-9Xx]/g, '');
        if (digits.length >= 10) {
          conditions.push('(p.label LIKE ? OR p.ref LIKE ? OR p.barcode LIKE ? OR pe.auteur LIKE ? OR p.description LIKE ?)');
          params.push(like, like, like, like, `%${digits}%`);
        } else {
          conditions.push('(p.label LIKE ? OR p.ref LIKE ? OR p.barcode LIKE ? OR pe.auteur LIKE ?)');
          params.push(like, like, like, like);
        }
      }

      const joins = ['FROM llx_product p', 'LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid'];
      if (genre) {
        joins.push('INNER JOIN llx_categorie_product cp ON cp.fk_product = p.rowid');
        conditions.push('cp.fk_categorie = ?');
        params.push(genre);
      }

      const countSql = `SELECT COUNT(DISTINCT p.rowid) AS total ${joins.join(' ')} WHERE ${conditions.join(' AND ')}`;
      const [countRows] = await dolibarrPool.query(countSql, params);
      const total = countRows[0]?.total || 0;

      const dataSql = `
        SELECT DISTINCT p.rowid AS id, p.ref, p.label, p.barcode, p.price_ttc, p.tosell AS status,
          pe.auteur, pe.publication_year, pe.nombre_pages, pe.editeur,
          (SELECT c.label FROM llx_categorie c
            INNER JOIN llx_categorie_product cp2 ON cp2.fk_categorie = c.rowid
            WHERE cp2.fk_product = p.rowid
              AND c.label NOT IN ${excludedListSql}
            LIMIT 1) AS genre_label
        ${joins.join(' ')}
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.tms DESC
        LIMIT ? OFFSET ?
      `;
      // L'ordre des placeholders dans le SQL final (important) :
      //   1. SELECT sous-requête corrélée NOT IN (...)  → EXCLUDED_CATEGORY_LABELS
      //   2. WHERE principal (q + genre)               → params
      //   3. LIMIT, OFFSET
      const dataParams = [...EXCLUDED_CATEGORY_LABELS, ...params, limit, page * limit];
      const [rows] = await dolibarrPool.query(dataSql, dataParams);
      res.json({ books: rows, page, limit, total });
    } catch (err) {
      console.error('[BOOKS] GET list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des livres' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books/quality-stats — Conformité globale catalogue
  // ══════════════════════════════════════════════════════
  router.get('/quality-stats', auth, async (req, res) => {
    try {
      const [[{ total }]] = await dolibarrPool.query(
        'SELECT COUNT(*) AS total FROM llx_product WHERE fk_product_type = 0'
      );
      const [[{ compliant }]] = await dolibarrPool.query(
        `SELECT COUNT(DISTINCT p.rowid) AS compliant
         FROM llx_product p
         LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.fk_product_type = 0
           AND p.label IS NOT NULL AND p.label != ''
           AND p.ref IS NOT NULL AND p.ref != ''
           AND pe.publication_year IS NOT NULL AND pe.publication_year > 0
           AND pe.nombre_pages IS NOT NULL AND pe.nombre_pages > 0
           AND pe.editeur IS NOT NULL AND pe.editeur != ''
           AND EXISTS (
             SELECT 1 FROM llx_categorie_product cp
             INNER JOIN llx_categorie c ON c.rowid = cp.fk_categorie
             WHERE cp.fk_product = p.rowid
               AND c.label NOT IN ${excludedListSql}
           )`,
        EXCLUDED_CATEGORY_LABELS
      );
      const pct = total > 0 ? Math.round((compliant / total) * 100) : 100;
      res.json({ total, compliant, pct });
    } catch (err) {
      console.error('[BOOKS] quality-stats error:', err.message);
      res.status(500).json({ error: 'Erreur calcul conformité' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books/authors — Recherche auteurs existants
  // ══════════════════════════════════════════════════════
  router.get('/authors', auth, async (req, res) => {
    try {
      const q = req.query.q ? String(req.query.q).trim() : '';
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);

      let sql, params;
      if (q.length >= 1) {
        sql = `
          SELECT pe.auteur AS name, COUNT(*) AS book_count
          FROM llx_product_extrafields pe
          INNER JOIN llx_product p ON p.rowid = pe.fk_object
          WHERE pe.auteur IS NOT NULL
            AND pe.auteur != ''
            AND pe.auteur LIKE ?
          GROUP BY pe.auteur
          ORDER BY book_count DESC, pe.auteur ASC
          LIMIT ?
        `;
        params = [`%${q}%`, limit];
      } else {
        sql = `
          SELECT pe.auteur AS name, COUNT(*) AS book_count
          FROM llx_product_extrafields pe
          INNER JOIN llx_product p ON p.rowid = pe.fk_object
          WHERE pe.auteur IS NOT NULL AND pe.auteur != ''
          GROUP BY pe.auteur
          ORDER BY book_count DESC
          LIMIT ?
        `;
        params = [limit];
      }

      const [rows] = await dolibarrPool.query(sql, params);
      res.json({ authors: rows });
    } catch (err) {
      console.error('[BOOKS] GET authors error:', err.message);
      res.status(500).json({ error: 'Erreur recherche auteurs' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books/check-isbn/:isbn
  // ══════════════════════════════════════════════════════
  router.get('/check-isbn/:isbn', auth, async (req, res) => {
    try {
      const isbnCheck = validateISBN(req.params.isbn);
      if (!isbnCheck.valid) {
        return res.status(400).json({ error: isbnCheck.error });
      }
      const excludeId = req.query.exclude ? parseInt(req.query.exclude) : null;
      const duplicate = await isIsbnDuplicate(isbnCheck.normalized, excludeId);
      if (duplicate) {
        return res.json({ exists: true, product_id: duplicate.rowid, ref: duplicate.ref });
      }
      res.json({ exists: false });
    } catch (err) {
      console.error('[BOOKS] check-isbn error:', err.message);
      res.status(500).json({ error: 'Erreur vérification ISBN' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books/genres — Liste des genres + nb de livres liés
  // ⚠ Placé AVANT GET /:id pour ne pas être capturé par la route paramétrée.
  // ══════════════════════════════════════════════════════
  router.get('/genres', auth, async (req, res) => {
    try {
      const [rows] = await dolibarrPool.query(
        `SELECT c.rowid AS id, c.label,
                (SELECT COUNT(*) FROM llx_categorie_product cp WHERE cp.fk_categorie = c.rowid) AS count
           FROM llx_categorie c
          WHERE c.type = 0 AND c.label NOT IN ${excludedListSql}`,
        EXCLUDED_CATEGORY_LABELS
      );
      const genres = rows
        .map((r) => ({ id: r.rowid, label: decodeEntitiesServer(r.label), count: Number(r.count) || 0 }))
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
      res.json({ genres });
    } catch (err) {
      console.error('[BOOKS] GET /genres error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des genres' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books/:id — Détail complet (multi-catégories)
  // ══════════════════════════════════════════════════════
  router.get('/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const [rows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.label, p.description, p.barcode, p.price_ttc, p.tosell AS status,
          pe.auteur, pe.soustitre, pe.publication_year, pe.nombre_pages, pe.editeur, pe.longdescript
         FROM llx_product p
         LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid = ? LIMIT 1`,
        [id]
      );

      if (rows.length === 0) return res.status(404).json({ error: 'Livre introuvable' });

      const genreIds = await fetchProductGenreIds(id);

      // Multi-auteurs (Phase 4) : lit book_authors triés par position pour pré-remplir l'UI
      const authorRows = db.prepare(
        `SELECT a.id, a.display_name, a.firstname, a.lastname, a.slug, ba.position
         FROM book_authors ba JOIN authors a ON a.id = ba.author_id
         WHERE ba.product_id = ? ORDER BY ba.position ASC, a.id ASC`
      ).all(id);
      const authors = authorRows.map((a) => ({
        id: a.id,
        display_name: a.display_name || `${a.firstname || ''} ${a.lastname || ''}`.trim(),
        slug: a.slug,
      }));

      const p = rows[0];
      let author_nom = p.auteur || '';
      let author_prenom = '';
      if (author_nom.includes(' ')) {
        const parts = author_nom.split(' ');
        author_nom = parts[0];
        author_prenom = parts.slice(1).join(' ');
      }

      const description = p.longdescript || p.description || '';

      // Marqueur « à paraître » (table SQLite) pour pré-remplir le formulaire
      const upcoming = db.prepare(
        'SELECT release_date, summary, preorder_discount_pct FROM book_upcoming WHERE product_id = ?'
      ).get(id);

      res.json({
        id: p.id,
        title: p.label,
        is_upcoming: !!upcoming,
        release_date: upcoming?.release_date || '',
        upcoming_summary: upcoming?.summary || '',
        preorder_discount_pct: upcoming?.preorder_discount_pct || 0,
        author_nom,
        author_prenom,
        isbn: p.barcode || p.ref,
        editeur: p.editeur || '',
        publication_year: p.publication_year,
        genre_id: genreIds[0] || null, // rétrocompat
        genre_ids: genreIds,            // nouveau : multi
        nombre_pages: p.nombre_pages,
        price_ttc: parseFloat(p.price_ttc) || 0,
        soustitre: p.soustitre || '',
        description,
        status: p.status,
        ref: p.ref,
        authors,                              // Phase 4 : objets { id, display_name, slug }
        author_ids: authors.map((a) => a.id), // raccourci pour la UI
      });
    } catch (err) {
      console.error('[BOOKS] GET detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /:id/sales — Quantité écoulée (toute facturation confondue) + stock
  // Réservé aux administrateurs. Net = ventes (factures standard/remplacement
  // validées ou payées) − retours (avoirs validés/payés). Les brouillons et
  // acomptes (type 3) n'entrent pas dans le calcul.
  // ══════════════════════════════════════════════════════
  router.get('/:id/sales', auth, adminOnly, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const [[agg]] = await dolibarrPool.query(
        `SELECT
           SUM(CASE WHEN f.type IN (0,1) AND f.fk_statut IN (1,2) THEN fd.qty ELSE 0 END) AS gross_sold,
           SUM(CASE WHEN f.type IN (0,1) AND f.fk_statut = 2 THEN fd.qty ELSE 0 END)       AS paid_qty,
           SUM(CASE WHEN f.type IN (0,1) AND f.fk_statut = 1 THEN fd.qty ELSE 0 END)       AS validated_unpaid_qty,
           SUM(CASE WHEN f.type = 2     AND f.fk_statut IN (1,2) THEN fd.qty ELSE 0 END)    AS returned_qty,
           COUNT(DISTINCT CASE WHEN f.fk_statut IN (1,2) THEN f.rowid END)                  AS invoices_count
         FROM llx_facturedet fd
         JOIN llx_facture f ON f.rowid = fd.fk_facture
         WHERE fd.fk_product = ?`,
        [id]
      );

      const [[stockRow]] = await dolibarrPool.query(
        'SELECT COALESCE(SUM(reel), 0) AS stock FROM llx_product_stock WHERE fk_product = ?',
        [id]
      );

      const grossSold = Number(agg?.gross_sold) || 0;
      const returned = Number(agg?.returned_qty) || 0;

      res.json({
        product_id: id,
        stock: Number(stockRow?.stock) || 0,
        total_sold: grossSold - returned,         // net écoulé, toute facturation confondue
        gross_sold: grossSold,
        paid_qty: Number(agg?.paid_qty) || 0,
        validated_unpaid_qty: Number(agg?.validated_unpaid_qty) || 0,
        returned_qty: returned,
        invoices_count: Number(agg?.invoices_count) || 0,
      });
    } catch (err) {
      console.error('[BOOKS] GET sales error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des ventes' });
    }
  });

  // ══════════════════════════════════════════════════════
  // POST /api/admin/books/genres — Crée un nouveau genre
  // (catégorie produit Dolibarr, rattachée au même parent que les genres existants)
  // ══════════════════════════════════════════════════════
  router.post('/genres', auth, csrfProtection, async (req, res) => {
    try {
      const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
      if (!label) {
        return res.status(400).json({ error: 'Le nom du genre est obligatoire' });
      }
      if (label.length > 80) {
        return res.status(400).json({ error: 'Nom de genre trop long (80 caractères maximum)' });
      }
      // Refuse les libellés techniques réservés (catégories système)
      const target = normalizeLabel(label);
      if (EXCLUDED_CATEGORY_LABELS.some((l) => normalizeLabel(l) === target)) {
        return res.status(400).json({ error: 'Ce nom est réservé et ne peut pas être utilisé comme genre' });
      }

      // Anti-doublon insensible à la casse / aux accents / aux entités HTML,
      // sur l'ensemble des genres existants (évite « Roman » vs « ROMAN »).
      const [existing] = await dolibarrPool.query(
        `SELECT rowid, label FROM llx_categorie WHERE type = 0 AND label NOT IN ${excludedListSql}`,
        EXCLUDED_CATEGORY_LABELS
      );
      const dup = existing.find((c) => normalizeLabel(c.label) === target);
      if (dup) {
        return res.status(409).json({
          error: `Le genre « ${decodeEntitiesServer(dup.label)} » existe déjà`,
          genre: { id: dup.rowid, label: decodeEntitiesServer(dup.label) },
        });
      }

      const fkParent = await resolveGenreParentId();
      const createRes = await adminApi.post('/categories', {
        label,
        type: 'product',
        fk_parent: fkParent,
        visible: 1,
      });
      const newId = parseInt(createRes.data, 10);
      if (!Number.isInteger(newId) || newId <= 0) {
        throw new Error(`Réponse Dolibarr inattendue à la création de catégorie: ${JSON.stringify(createRes.data)}`);
      }

      // Relit le libellé canonique tel que stocké (Dolibarr peut ré-encoder les accents)
      const [row] = await dolibarrPool.query(
        'SELECT label FROM llx_categorie WHERE rowid = ? LIMIT 1', [newId]
      );
      const storedLabel = row.length ? decodeEntitiesServer(row[0].label) : label;

      // Invalide les caches catégories partagés pour rafraîchir partout
      invalidateCategoryCaches();

      res.status(201).json({ id: newId, label: storedLabel });
    } catch (err) {
      console.error('[BOOKS] POST /genres error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur lors de la création du genre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // PUT /api/admin/books/genres/:id — Renomme un genre
  // (catégorie produit Dolibarr ; mêmes garde-fous que la création)
  // ══════════════════════════════════════════════════════
  router.put('/genres/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
      if (!label) return res.status(400).json({ error: 'Le nom du genre est obligatoire' });
      if (label.length > 80) return res.status(400).json({ error: 'Nom de genre trop long (80 caractères maximum)' });
      if (isReservedLabel(label)) {
        return res.status(400).json({ error: 'Ce nom est réservé et ne peut pas être utilisé comme genre' });
      }

      const genre = await fetchGenreById(id);
      if (!genre || isReservedLabel(genre.label)) {
        return res.status(404).json({ error: 'Genre introuvable' });
      }

      // Anti-doublon insensible casse/accents/entités sur les AUTRES genres
      const target = normalizeLabel(label);
      const [existing] = await dolibarrPool.query(
        `SELECT rowid, label FROM llx_categorie WHERE type = 0 AND rowid != ? AND label NOT IN ${excludedListSql}`,
        [id, ...EXCLUDED_CATEGORY_LABELS]
      );
      const dup = existing.find((c) => normalizeLabel(c.label) === target);
      if (dup) {
        return res.status(409).json({
          error: `Le genre « ${decodeEntitiesServer(dup.label)} » existe déjà`,
          genre: { id: dup.rowid, label: decodeEntitiesServer(dup.label) },
        });
      }

      await adminApi.put(`/categories/${id}`, { label });

      // Relit le libellé canonique stocké (Dolibarr peut ré-encoder les accents)
      const [row] = await dolibarrPool.query('SELECT label FROM llx_categorie WHERE rowid = ? LIMIT 1', [id]);
      const storedLabel = row.length ? decodeEntitiesServer(row[0].label) : label;

      invalidateCategoryCaches();
      res.json({ id, label: storedLabel });
    } catch (err) {
      console.error('[BOOKS] PUT /genres error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur lors du renommage du genre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // DELETE /api/admin/books/genres/:id — Supprime un genre
  // Query: ?reassignTo=<id>  → réaffecte d'abord les livres vers ce genre (fusion)
  //        ?force=1          → supprime même si des livres y sont rattachés
  // Sans l'un ni l'autre, un genre utilisé renvoie 409 (anti-suppression silencieuse).
  // ══════════════════════════════════════════════════════
  router.delete('/genres/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const genre = await fetchGenreById(id);
      if (!genre || isReservedLabel(genre.label)) {
        return res.status(404).json({ error: 'Genre introuvable' });
      }

      // Refuse si le genre a des sous-genres (éviter d'orphaniser l'arborescence)
      const children = await countGenreChildren(id);
      if (children > 0) {
        return res.status(409).json({
          error: `Ce genre contient ${children} sous-genre(s) : renommez-les ou supprimez-les d'abord`,
        });
      }

      const reassignTo = req.query.reassignTo ? parseInt(req.query.reassignTo, 10) : null;
      const force = req.query.force === '1' || req.query.force === 'true';

      const productIds = await fetchGenreProductIds(id);

      // Cas fusion : valide la destination puis relie les livres avant suppression
      let reassigned = 0;
      if (reassignTo) {
        if (reassignTo === id) {
          return res.status(400).json({ error: 'Le genre de destination doit être différent' });
        }
        const dest = await fetchGenreById(reassignTo);
        if (!dest || isReservedLabel(dest.label)) {
          return res.status(400).json({ error: 'Genre de destination invalide' });
        }
        const destProducts = new Set(await fetchGenreProductIds(reassignTo));
        for (const pid of productIds) {
          if (destProducts.has(pid)) continue; // déjà dans la destination
          try {
            await adminApi.post(`/categories/${reassignTo}/objects/product/${pid}`);
            reassigned += 1;
          } catch (linkErr) {
            console.warn(`[BOOKS] reassign p=${pid} → cat ${reassignTo} failed:`, linkErr.message);
          }
        }
      } else if (productIds.length > 0 && !force) {
        // Anti-suppression silencieuse d'un genre utilisé
        return res.status(409).json({
          error: `Ce genre est utilisé par ${productIds.length} livre(s)`,
          count: productIds.length,
        });
      }

      // Détache le genre de tous ses livres (état propre quelle que soit la cascade Dolibarr)
      for (const pid of productIds) {
        try {
          await adminApi.delete(`/categories/${id}/objects/product/${pid}`);
        } catch (unlinkErr) {
          console.warn(`[BOOKS] unlink p=${pid} from cat ${id} failed:`, unlinkErr.message);
        }
      }

      await adminApi.delete(`/categories/${id}`);

      invalidateCategoryCaches();
      res.json({
        id,
        deleted: true,
        label: decodeEntitiesServer(genre.label),
        unlinked: productIds.length,
        reassigned: reassignTo ? reassigned : 0,
        reassignedTo: reassignTo || null,
      });
    } catch (err) {
      console.error('[BOOKS] DELETE /genres error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur lors de la suppression du genre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // POST /api/admin/books — Création avec rollback
  // ══════════════════════════════════════════════════════
  router.post('/', auth, csrfProtection, async (req, res) => {
    let newProductId = null;
    try {
      const allowedGenreIds = await fetchAllowedGenreIds();
      const selectedGenreIds = resolveGenreIds(req.body);

      // Validate + normalize (compat mono : si genre_ids vide mais genre_id présent, fallback)
      const bodyForValidation = { ...req.body, genre_id: selectedGenreIds[0] || '' };
      const result = validateBook(bodyForValidation, { allowedGenreIds });
      if (!result.valid) {
        return res.status(400).json({ error: 'Validation échouée', errors: result.errors });
      }

      // Valide multi : chaque ID doit être dans allowedGenreIds
      const invalidGenres = selectedGenreIds.filter((g) => !allowedGenreIds.includes(g));
      if (invalidGenres.length > 0) {
        return res.status(400).json({
          error: 'Un ou plusieurs genres sélectionnés sont invalides',
          errors: { genre_id: 'Un ou plusieurs genres sélectionnés sont invalides' },
        });
      }

      const duplicate = await isIsbnDuplicate(result.normalized.isbn);
      if (duplicate) {
        return res.status(409).json({
          error: `Cet ISBN existe déjà dans le catalogue`,
          errors: { isbn: `ISBN déjà utilisé par "${duplicate.ref}"` },
        });
      }

      // Multi-auteurs (Phase 4) : si author_ids[] fourni, il prend le dessus.
      // Le pe.auteur Dolibarr est alors construit depuis les display_names des auteurs SQLite.
      const explicitAuthorIds = Array.isArray(req.body.author_ids)
        ? req.body.author_ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (explicitAuthorIds.length > 0) {
        const derived = buildAuteurFieldFromIds(explicitAuthorIds);
        if (derived) {
          // Réécrit author_nom (= chaîne complète) pour que pe.auteur reflète la sélection
          result.normalized.author_nom = derived;
          result.normalized.author_prenom = '';
        }
      }

      const payload = buildDolibarrPayload(result.normalized);
      const createRes = await adminApi.post('/products', payload);
      newProductId = createRes.data;

      // Lie toutes les catégories sélectionnées. Si une seule échoue → rollback.
      for (const gid of selectedGenreIds) {
        await adminApi.post(`/categories/${gid}/objects/product/${newProductId}`);
      }

      // Dual-write : prend explicit author_ids si présent, sinon fallback au matching mono
      const authorLink = explicitAuthorIds.length > 0
        ? syncBookAuthorsLinks(newProductId, explicitAuthorIds)
        : syncBookAuthorsLink(newProductId, [result.normalized.author_nom, result.normalized.author_prenom].filter(Boolean).join(' ').trim());

      invalidateProductCache(newProductId, result.normalized.isbn);

      // Marqueur « Ouvrage à paraître » (non bloquant)
      try { syncUpcomingFlag(newProductId, req.body); }
      catch (e) { console.warn('[BOOKS] syncUpcomingFlag (create) échec:', e.message); }

      res.status(201).json({
        id: newProductId,
        ref: result.normalized.isbn,
        message: 'Livre créé avec succès',
        author_link: authorLink,
      });
    } catch (err) {
      console.error('[BOOKS] POST error:', err.response?.data || err.message);
      // Compensation : si le produit a été créé mais qu'une erreur est survenue après,
      // on tente de le supprimer pour ne pas laisser d'orphelin
      if (newProductId) {
        try {
          await adminApi.delete(`/products/${newProductId}`);
          console.warn(`[BOOKS] Rollback produit ${newProductId} suite à erreur`);
        } catch (rollbackErr) {
          console.error(`[BOOKS] Rollback produit ${newProductId} échoué:`, rollbackErr.message);
        }
      }
      res.status(500).json({ error: 'Erreur création du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // PUT /api/admin/books/:id — Édition avec diff catégories
  // ══════════════════════════════════════════════════════
  router.put('/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const allowedGenreIds = await fetchAllowedGenreIds();
      const selectedGenreIds = resolveGenreIds(req.body);

      const bodyForValidation = { ...req.body, genre_id: selectedGenreIds[0] || '' };
      const result = validateBook(bodyForValidation, { allowedGenreIds });
      if (!result.valid) {
        return res.status(400).json({ error: 'Validation échouée', errors: result.errors });
      }

      const invalidGenres = selectedGenreIds.filter((g) => !allowedGenreIds.includes(g));
      if (invalidGenres.length > 0) {
        return res.status(400).json({
          error: 'Un ou plusieurs genres sélectionnés sont invalides',
          errors: { genre_id: 'Un ou plusieurs genres sélectionnés sont invalides' },
        });
      }

      const duplicate = await isIsbnDuplicate(result.normalized.isbn, id);
      if (duplicate) {
        return res.status(409).json({
          error: `Cet ISBN existe déjà dans le catalogue`,
          errors: { isbn: `ISBN déjà utilisé par "${duplicate.ref}"` },
        });
      }

      // Multi-auteurs (Phase 4) : si author_ids[] fourni, réécrit pe.auteur depuis SQLite display_names
      const explicitAuthorIdsPut = Array.isArray(req.body.author_ids)
        ? req.body.author_ids.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      if (explicitAuthorIdsPut.length > 0) {
        const derived = buildAuteurFieldFromIds(explicitAuthorIdsPut);
        if (derived) {
          result.normalized.author_nom = derived;
          result.normalized.author_prenom = '';
        }
      }

      const payload = buildDolibarrPayload(result.normalized);
      await adminApi.put(`/products/${id}`, payload);

      // Diff catégories : compare actuelles vs. demandées, n'efface/ajoute que le delta
      const currentGenres = await fetchProductGenreIds(id);
      const toRemove = currentGenres.filter((g) => !selectedGenreIds.includes(g));
      const toAdd = selectedGenreIds.filter((g) => !currentGenres.includes(g));

      const genreFailures = { unlink: [], link: [] };
      for (const gid of toRemove) {
        try {
          await adminApi.delete(`/categories/${gid}/objects/product/${id}`);
        } catch (catErr) {
          console.warn(`[BOOKS] Unlink category ${gid} failed:`, catErr.message);
          genreFailures.unlink.push({ id: gid, error: catErr.message });
        }
      }
      for (const gid of toAdd) {
        try {
          await adminApi.post(`/categories/${gid}/objects/product/${id}`);
        } catch (catErr) {
          console.warn(`[BOOKS] Link category ${gid} failed:`, catErr.message);
          genreFailures.link.push({ id: gid, error: catErr.message });
        }
      }

      // Récupère ref actuelle pour invalidation image
      const [refRows] = await dolibarrPool.query('SELECT ref FROM llx_product WHERE rowid = ? LIMIT 1', [id]);
      invalidateProductCache(id, refRows[0]?.ref);

      // Dual-write : prend explicit author_ids[] (Phase 4) sinon fallback matching mono
      const authorLink = explicitAuthorIdsPut.length > 0
        ? syncBookAuthorsLinks(id, explicitAuthorIdsPut)
        : syncBookAuthorsLink(id, [result.normalized.author_nom, result.normalized.author_prenom].filter(Boolean).join(' ').trim());

      // Marqueur « Ouvrage à paraître » (non bloquant)
      try { syncUpcomingFlag(id, req.body); }
      catch (e) { console.warn('[BOOKS] syncUpcomingFlag (update) échec:', e.message); }

      // Si la sync des genres a partiellement échoué, le signaler explicitement
      if (genreFailures.unlink.length > 0 || genreFailures.link.length > 0) {
        // Relire l'état réel pour informer l'UI
        const finalGenres = await fetchProductGenreIds(id);
        return res.status(207).json({
          id,
          message: 'Livre mis à jour mais synchronisation des genres incomplète',
          warning: 'genres_partial_sync',
          genres_failures: genreFailures,
          genres_now: finalGenres,
          genres_requested: selectedGenreIds,
          author_link: authorLink,
        });
      }

      res.json({ id, message: 'Livre mis à jour avec succès', author_link: authorLink });
    } catch (err) {
      console.error('[BOOKS] PUT error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur mise à jour du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // DELETE /api/admin/books/:id — Suppression (soft par défaut)
  // ══════════════════════════════════════════════════════
  router.delete('/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const hardDelete = req.query.soft === '0';
      const [refRows] = await dolibarrPool.query('SELECT ref FROM llx_product WHERE rowid = ? LIMIT 1', [id]);

      if (hardDelete) {
        await adminApi.delete(`/products/${id}`);
      } else {
        await adminApi.put(`/products/${id}`, { status: 0 });
      }

      invalidateProductCache(id, refRows[0]?.ref);
      res.json({ id, message: hardDelete ? 'Livre supprimé' : 'Livre masqué' });
    } catch (err) {
      console.error('[BOOKS] DELETE error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur suppression du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // POST /api/admin/books/:id/cover — Upload sécurisé
  // ══════════════════════════════════════════════════════
  router.post('/:id/cover', auth, csrfProtection, coverUpload.single('cover'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });
      if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

      // 1) Validation magic bytes
      const detected = detectImageFormat(req.file.buffer);
      if (!detected) {
        return res.status(400).json({ error: 'Format image non reconnu (JPG, PNG, WEBP acceptés)' });
      }
      if (!['jpeg', 'png', 'webp'].includes(detected)) {
        return res.status(400).json({ error: 'Format non supporté (JPG, PNG, WEBP uniquement)' });
      }

      // 2) Re-encode via sharp : strip EXIF + normalise + limite taille
      let safeBuffer;
      let safeExt;
      try {
        const pipeline = sharp(req.file.buffer, { failOn: 'error' })
          .rotate() // auto-orient avant de stripper EXIF
          .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true });

        if (detected === 'png') {
          safeBuffer = await pipeline.png({ compressionLevel: 9 }).toBuffer();
          safeExt = 'png';
        } else if (detected === 'webp') {
          safeBuffer = await pipeline.webp({ quality: 85 }).toBuffer();
          safeExt = 'webp';
        } else {
          safeBuffer = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
          safeExt = 'jpg';
        }
      } catch (encodeErr) {
        console.error('[BOOKS] Re-encode failed:', encodeErr.message);
        return res.status(400).json({ error: 'Image corrompue ou non décodable' });
      }

      const [rows] = await dolibarrPool.query('SELECT ref FROM llx_product WHERE rowid = ? LIMIT 1', [id]);
      if (rows.length === 0) return res.status(404).json({ error: 'Livre introuvable' });
      const ref = rows[0].ref;

      // side=recto (défaut) ou side=verso — influence le nom du fichier
      const rawSide = (req.body?.side || req.query?.side || 'recto').toString().toLowerCase();
      const side = rawSide === 'verso' ? 'verso' : 'recto';
      const filename = side === 'verso'
        ? `cover-verso-${Date.now()}.${safeExt}`
        : `cover-${Date.now()}.${safeExt}`;

      await adminApi.post('/documents/upload', {
        filename,
        modulepart: 'produit',
        ref,
        subdir: '',
        filecontent: safeBuffer.toString('base64'),
        fileencoding: 'base64',
        overwriteifexists: 1,
        createdirifnotexists: 1,
      });

      // Règle « 1 recto + 1 verso » : on supprime les autres images du MÊME côté
      // (sinon chaque upload horodaté s'accumule — ex. doublons issus de la migration).
      // Non bloquant : un échec de nettoyage n'invalide pas l'upload réussi.
      try {
        const listRes = await adminApi.get('/documents', { params: { modulepart: 'produit', id } });
        const isVerso = (n) => /(^|[-_. ])(verso|back|dos|arriere|arrière)([-_. ]|\.)/i.test(n);
        const stale = (listRes.data || []).filter((d) => {
          const n = d.name || '';
          if (n === filename) return false;                          // garder le fichier qu'on vient d'uploader
          if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(n)) return false;  // images uniquement
          if (n.startsWith('default_cover')) return false;           // placeholder Dolibarr
          return side === 'verso' ? isVerso(n) : !isVerso(n);        // même côté que l'upload
        });
        for (const d of stale) {
          try {
            await adminApi.delete('/documents', {
              params: { modulepart: 'produit', original_file: `${ref}/${d.name}` },
            });
          } catch (delErr) {
            console.warn(`[BOOKS] cover cleanup: échec suppression ${d.name}:`, delErr.response?.data?.error || delErr.message);
          }
        }
      } catch (listErr) {
        console.warn('[BOOKS] cover cleanup: liste documents échouée:', listErr.message);
      }

      invalidateProductCache(id, ref);

      res.json({ id, ref, filename, message: 'Couverture mise à jour' });
    } catch (err) {
      console.error('[BOOKS] COVER upload error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur upload couverture' });
    }
  });

  return router;
}
