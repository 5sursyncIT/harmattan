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

/**
 * Crée le router.
 * @param {Object} deps - { dolibarrPool, auth, csrfProtection, sanitizeBody, cache }
 */
export function createBookRouter({ dolibarrPool, auth, csrfProtection, sanitizeBody, cache }) {
  const router = Router();

  // Libraire = lecture seule sur les livres (crée/édite via admin)
  function blockLibrarianWrite(req, res, next) {
    if (req.admin?.role === 'librarian') {
      return res.status(403).json({ error: 'Accès en lecture seule pour votre profil' });
    }
    next();
  }

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

  function invalidateProductCache(productId, ref = null) {
    if (!cache) return;
    cache.del(`product:${productId}`);
    cache.del('price-range');
    cache.del('categories:all');
    cache.del('refs-with-real-covers');
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
        conditions.push('(p.label LIKE ? OR p.ref LIKE ? OR p.barcode LIKE ? OR pe.auteur LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like, like);
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

      const p = rows[0];
      let author_nom = p.auteur || '';
      let author_prenom = '';
      if (author_nom.includes(' ')) {
        const parts = author_nom.split(' ');
        author_nom = parts[0];
        author_prenom = parts.slice(1).join(' ');
      }

      const description = p.longdescript || p.description || '';

      res.json({
        id: p.id,
        title: p.label,
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
      });
    } catch (err) {
      console.error('[BOOKS] GET detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // POST /api/admin/books — Création avec rollback
  // ══════════════════════════════════════════════════════
  router.post('/', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
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

      const payload = buildDolibarrPayload(result.normalized);
      const createRes = await adminApi.post('/products', payload);
      newProductId = createRes.data;

      // Lie toutes les catégories sélectionnées. Si une seule échoue → rollback.
      for (const gid of selectedGenreIds) {
        await adminApi.post(`/categories/${gid}/objects/product/${newProductId}`);
      }

      invalidateProductCache(newProductId, result.normalized.isbn);

      res.status(201).json({
        id: newProductId,
        ref: result.normalized.isbn,
        message: 'Livre créé avec succès',
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
  router.put('/:id', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
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

      const payload = buildDolibarrPayload(result.normalized);
      await adminApi.put(`/products/${id}`, payload);

      // Diff catégories : compare actuelles vs. demandées, n'efface/ajoute que le delta
      const currentGenres = await fetchProductGenreIds(id);
      const toRemove = currentGenres.filter((g) => !selectedGenreIds.includes(g));
      const toAdd = selectedGenreIds.filter((g) => !currentGenres.includes(g));

      for (const gid of toRemove) {
        try {
          await adminApi.delete(`/categories/${gid}/objects/product/${id}`);
        } catch (catErr) {
          console.warn(`[BOOKS] Unlink category ${gid} failed:`, catErr.message);
        }
      }
      for (const gid of toAdd) {
        try {
          await adminApi.post(`/categories/${gid}/objects/product/${id}`);
        } catch (catErr) {
          console.warn(`[BOOKS] Link category ${gid} failed:`, catErr.message);
        }
      }

      // Récupère ref actuelle pour invalidation image
      const [refRows] = await dolibarrPool.query('SELECT ref FROM llx_product WHERE rowid = ? LIMIT 1', [id]);
      invalidateProductCache(id, refRows[0]?.ref);

      res.json({ id, message: 'Livre mis à jour avec succès' });
    } catch (err) {
      console.error('[BOOKS] PUT error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur mise à jour du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // DELETE /api/admin/books/:id — Suppression (soft par défaut)
  // ══════════════════════════════════════════════════════
  router.delete('/:id', auth, blockLibrarianWrite, csrfProtection, async (req, res) => {
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
  router.post('/:id/cover', auth, blockLibrarianWrite, csrfProtection, coverUpload.single('cover'), async (req, res) => {
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

      invalidateProductCache(id, ref);

      res.json({ id, ref, filename, message: 'Couverture mise à jour' });
    } catch (err) {
      console.error('[BOOKS] COVER upload error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur upload couverture' });
    }
  });

  return router;
}
