/**
 * Router pour la gestion des livres (CRUD complet)
 * Écrit directement dans Dolibarr via l'API REST avec l'admin key.
 */

import { Router } from 'express';
import axios from 'axios';
import 'dotenv/config';
import { validateBook, validateISBN } from '../src/utils/bookValidation.js';

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

/**
 * Crée le router.
 * @param {Object} deps - { dolibarrPool, auth, csrfProtection, sanitizeBody, cache }
 */
export function createBookRouter({ dolibarrPool, auth, csrfProtection, sanitizeBody, cache }) {
  const router = Router();

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

  // ── Helper: invalidate cache after write ──
  function invalidateProductCache(productId) {
    if (!cache) return;
    cache.del(`product:${productId}`);
    for (const k of cache.keys()) {
      if (k.startsWith('products:') || k.startsWith('suggest:')) {
        cache.del(k);
      }
    }
    cache.del('price-range');
    cache.del('categories:all');
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
              AND c.label NOT IN ('LIBRAIRIE','LIVRES','Accueil','Racine','Services','Livres du mois','http://senharmattan.com/')
            LIMIT 1) AS genre_label
        ${joins.join(' ')}
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.tms DESC
        LIMIT ? OFFSET ?
      `;
      params.push(limit, page * limit);

      const [rows] = await dolibarrPool.query(dataSql, params);
      res.json({ books: rows, page, limit, total });
    } catch (err) {
      console.error('[BOOKS] GET list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des livres' });
    }
  });

  // ══════════════════════════════════════════════════════
  // GET /api/admin/books/authors — Recherche auteurs existants
  // ══════════════════════════════════════════════════════
  router.get('/authors', auth, async (req, res) => {
    try {
      const q = req.query.q ? String(req.query.q).trim() : '';
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);

      // Recherche insensible à la casse dans pe.auteur
      // Renvoie les auteurs distincts avec le nombre de livres
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
        // Sans query, retourner les plus populaires
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
  // GET /api/admin/books/:id — Détail complet
  // ══════════════════════════════════════════════════════
  router.get('/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const [rows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.label, p.description, p.barcode, p.price_ttc, p.tosell AS status,
          pe.auteur, pe.soustitre, pe.publication_year, pe.nombre_pages, pe.editeur, pe.longdescript,
          (SELECT c.rowid FROM llx_categorie c
            INNER JOIN llx_categorie_product cp ON cp.fk_categorie = c.rowid
            WHERE cp.fk_product = p.rowid
              AND c.label NOT IN ('LIBRAIRIE','LIVRES','Accueil','Racine','Services','Livres du mois','http://senharmattan.com/')
            LIMIT 1) AS genre_id
         FROM llx_product p
         LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid = ? LIMIT 1`,
        [id]
      );

      if (rows.length === 0) return res.status(404).json({ error: 'Livre introuvable' });

      const p = rows[0];
      // Split author name if in "NOM Prénom" format (first word = nom)
      let author_nom = p.auteur || '';
      let author_prenom = '';
      if (author_nom.includes(' ')) {
        const parts = author_nom.split(' ');
        author_nom = parts[0];
        author_prenom = parts.slice(1).join(' ');
      }

      // Prefer longdescript extrafield, fallback to standard description
      const description = p.longdescript || p.description || '';

      res.json({
        id: p.id,
        title: p.label,
        author_nom,
        author_prenom,
        isbn: p.barcode || p.ref,
        editeur: p.editeur || '',
        publication_year: p.publication_year,
        genre_id: p.genre_id,
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
  // POST /api/admin/books — Création
  // ══════════════════════════════════════════════════════
  router.post('/', auth, csrfProtection, async (req, res) => {
    try {
      // Get allowed genre IDs from Dolibarr categories
      const [genreRows] = await dolibarrPool.query(
        "SELECT rowid FROM llx_categorie WHERE type = 0 AND label NOT IN ('LIBRAIRIE','LIVRES','Accueil','Racine','Services','Livres du mois','http://senharmattan.com/')"
      );
      const allowedGenreIds = genreRows.map((r) => r.rowid);

      // Validate + normalize
      const result = validateBook(req.body, { allowedGenreIds });
      if (!result.valid) {
        return res.status(400).json({ error: 'Validation échouée', errors: result.errors });
      }

      // Check ISBN uniqueness
      const duplicate = await isIsbnDuplicate(result.normalized.isbn);
      if (duplicate) {
        return res.status(409).json({
          error: `Cet ISBN existe déjà dans le catalogue (livre ID ${duplicate.rowid}, réf ${duplicate.ref})`,
          errors: { isbn: `ISBN déjà utilisé par "${duplicate.ref}"` },
        });
      }

      // Build payload and create in Dolibarr
      const payload = buildDolibarrPayload(result.normalized);
      const createRes = await adminApi.post('/products', payload);
      const newProductId = createRes.data;

      // Link category
      if (result.normalized.genre_id) {
        try {
          await adminApi.post(`/categories/${result.normalized.genre_id}/objects/product/${newProductId}`);
        } catch (catErr) {
          console.warn('[BOOKS] Category link failed:', catErr.response?.data || catErr.message);
        }
      }

      invalidateProductCache(newProductId);

      res.status(201).json({
        id: newProductId,
        ref: result.normalized.isbn,
        message: 'Livre créé avec succès',
      });
    } catch (err) {
      console.error('[BOOKS] POST error:', err.response?.data || err.message);
      res.status(500).json({ error: err.response?.data?.error?.message || 'Erreur création du livre' });
    }
  });

  // ══════════════════════════════════════════════════════
  // PUT /api/admin/books/:id — Édition
  // ══════════════════════════════════════════════════════
  router.put('/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const [genreRows] = await dolibarrPool.query(
        "SELECT rowid FROM llx_categorie WHERE type = 0 AND label NOT IN ('LIBRAIRIE','LIVRES','Accueil','Racine','Services','Livres du mois','http://senharmattan.com/')"
      );
      const allowedGenreIds = genreRows.map((r) => r.rowid);

      const result = validateBook(req.body, { allowedGenreIds });
      if (!result.valid) {
        return res.status(400).json({ error: 'Validation échouée', errors: result.errors });
      }

      // Check ISBN uniqueness (excluding self)
      const duplicate = await isIsbnDuplicate(result.normalized.isbn, id);
      if (duplicate) {
        return res.status(409).json({
          error: `Cet ISBN existe déjà dans le catalogue (livre ID ${duplicate.rowid}, réf ${duplicate.ref})`,
          errors: { isbn: `ISBN déjà utilisé par "${duplicate.ref}"` },
        });
      }

      const payload = buildDolibarrPayload(result.normalized);
      await adminApi.put(`/products/${id}`, payload);

      // Update category: remove old ones, add new
      if (result.normalized.genre_id) {
        try {
          // Remove existing category links for this product (only genre cats)
          await dolibarrPool.query(
            `DELETE cp FROM llx_categorie_product cp
             INNER JOIN llx_categorie c ON c.rowid = cp.fk_categorie
             WHERE cp.fk_product = ? AND c.rowid IN (${allowedGenreIds.join(',') || '0'})`,
            [id]
          );
          await adminApi.post(`/categories/${result.normalized.genre_id}/objects/product/${id}`);
        } catch (catErr) {
          console.warn('[BOOKS] Category update failed:', catErr.response?.data || catErr.message);
        }
      }

      invalidateProductCache(id);

      res.json({ id, message: 'Livre mis à jour avec succès' });
    } catch (err) {
      console.error('[BOOKS] PUT error:', err.response?.data || err.message);
      res.status(500).json({ error: err.response?.data?.error?.message || 'Erreur mise à jour du livre' });
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

      if (hardDelete) {
        await adminApi.delete(`/products/${id}`);
      } else {
        // Soft delete: set tosell = 0
        await adminApi.put(`/products/${id}`, { status: 0 });
      }

      invalidateProductCache(id);
      res.json({ id, message: hardDelete ? 'Livre supprimé' : 'Livre masqué' });
    } catch (err) {
      console.error('[BOOKS] DELETE error:', err.response?.data || err.message);
      res.status(500).json({ error: err.response?.data?.error?.message || 'Erreur suppression du livre' });
    }
  });

  return router;
}
