/**
 * Routes pour les tags de curation éditoriale (Notre sélection, Livres du mois, etc.)
 *
 * Les tags sont stockés en SQLite local (table book_tags) avec une relation
 * N:N vers les produits Dolibarr via book_tag_products (product_id = llx_product.rowid).
 *
 * 4 tags système sont créés au boot : notre_selection, livre_du_mois, nouveaute, promotion.
 * Ces tags ont is_system=1 et ne peuvent pas être supprimés.
 */

import { Router } from 'express';
import { EXCLUDED_CATEGORY_LABELS } from '../src/utils/excludedCategories.js';

function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 50);
}

/**
 * @param {Object} deps
 * @param {Database} deps.db — better-sqlite3 instance
 * @param {Function} deps.auth — admin auth middleware
 * @param {Function} deps.csrfProtection — CSRF middleware
 * @param {Pool} deps.dolibarrPool — MariaDB pool pour enrichir les produits
 * @param {Function} deps.enrichProduct — enrichisseur produit Dolibarr
 * @param {Object} deps.dolibarrApi — axios client Dolibarr
 * @param {Object} deps.cache — SimpleCache
 */
export function createTagRouter({ db, auth, csrfProtection, dolibarrPool, enrichProduct, dolibarrApi, cache }) {
  const router = Router();

  function blockLibrarianWrite(req, res, next) {
    if (req.admin?.role === 'librarian') {
      return res.status(403).json({ error: 'Accès en lecture seule pour votre profil' });
    }
    next();
  }

  function invalidateTagCaches() {
    if (!cache) return;
    for (const k of cache.keys()) {
      if (k.startsWith('home:tags') || k.startsWith('tag:')) cache.del(k);
    }
    cache.del('products:livre-du-mois');
  }

  // ════════════════════════════════════════════════════════════════════
  // ADMIN : CRUD tags
  // ════════════════════════════════════════════════════════════════════

  router.get('/admin/tags', auth, (req, res) => {
    try {
      const tags = db.prepare(`
        SELECT t.*,
          (SELECT COUNT(*) FROM book_tag_products btp WHERE btp.tag_id = t.id) AS book_count
        FROM book_tags t
        ORDER BY t.sort_order ASC, t.id ASC
      `).all();
      res.json(tags);
    } catch (err) {
      console.error('[TAGS] GET list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement tags' });
    }
  });

  router.post('/admin/tags', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    try {
      const { label, slug: rawSlug, description, color, icon, sort_order, show_on_home, max_items } = req.body;
      if (!label || String(label).trim().length < 2) {
        return res.status(400).json({ error: 'Label requis (≥ 2 caractères)' });
      }
      const slug = (rawSlug && slugify(rawSlug)) || slugify(label);
      if (!slug) return res.status(400).json({ error: 'Slug invalide' });
      const exists = db.prepare('SELECT 1 FROM book_tags WHERE slug = ?').get(slug);
      if (exists) return res.status(409).json({ error: `Un tag avec ce slug existe déjà (${slug})` });

      const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM book_tags').get().m;
      const result = db.prepare(`INSERT INTO book_tags
        (slug, label, description, color, icon, sort_order, is_active, is_system, show_on_home, max_items)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
      ).run(
        slug,
        String(label).trim(),
        description || null,
        color || '#10531a',
        icon || 'FiTag',
        Number.isFinite(+sort_order) ? +sort_order : maxOrder + 1,
        show_on_home === undefined ? 1 : (show_on_home ? 1 : 0),
        Number.isFinite(+max_items) ? +max_items : 12,
      );
      invalidateTagCaches();
      const created = db.prepare('SELECT * FROM book_tags WHERE id = ?').get(result.lastInsertRowid);
      res.status(201).json(created);
    } catch (err) {
      console.error('[TAGS] POST error:', err.message);
      res.status(500).json({ error: 'Erreur création tag' });
    }
  });

  router.put('/admin/tags/:id', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const tag = db.prepare('SELECT * FROM book_tags WHERE id = ?').get(id);
      if (!tag) return res.status(404).json({ error: 'Tag introuvable' });

      const fields = {};
      if (req.body.label !== undefined) fields.label = String(req.body.label).trim();
      if (req.body.description !== undefined) fields.description = req.body.description || null;
      if (req.body.color !== undefined) fields.color = req.body.color || '#10531a';
      if (req.body.icon !== undefined) fields.icon = req.body.icon || 'FiTag';
      if (req.body.sort_order !== undefined) fields.sort_order = parseInt(req.body.sort_order) || 0;
      if (req.body.is_active !== undefined) fields.is_active = req.body.is_active ? 1 : 0;
      if (req.body.show_on_home !== undefined) fields.show_on_home = req.body.show_on_home ? 1 : 0;
      if (req.body.max_items !== undefined) fields.max_items = Math.max(1, Math.min(50, parseInt(req.body.max_items) || 12));

      // Le slug d'un tag système ne peut pas être changé
      if (req.body.slug !== undefined) {
        if (tag.is_system) {
          return res.status(403).json({ error: 'Le slug d\'un tag système ne peut être modifié' });
        }
        const newSlug = slugify(req.body.slug);
        if (!newSlug) return res.status(400).json({ error: 'Slug invalide' });
        const conflict = db.prepare('SELECT 1 FROM book_tags WHERE slug = ? AND id != ?').get(newSlug, id);
        if (conflict) return res.status(409).json({ error: `Slug déjà utilisé (${newSlug})` });
        fields.slug = newSlug;
      }

      const keys = Object.keys(fields);
      if (keys.length === 0) return res.json(tag);

      const setClause = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => fields[k]);
      db.prepare(`UPDATE book_tags SET ${setClause} WHERE id = ?`).run(...values, id);

      invalidateTagCaches();
      const updated = db.prepare('SELECT * FROM book_tags WHERE id = ?').get(id);
      res.json(updated);
    } catch (err) {
      console.error('[TAGS] PUT error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour tag' });
    }
  });

  router.delete('/admin/tags/:id', auth, blockLibrarianWrite, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const tag = db.prepare('SELECT * FROM book_tags WHERE id = ?').get(id);
      if (!tag) return res.status(404).json({ error: 'Tag introuvable' });
      if (tag.is_system) {
        return res.status(403).json({ error: 'Tag système non supprimable' });
      }
      db.prepare('DELETE FROM book_tags WHERE id = ?').run(id);
      invalidateTagCaches();
      res.json({ id, message: 'Tag supprimé' });
    } catch (err) {
      console.error('[TAGS] DELETE error:', err.message);
      res.status(500).json({ error: 'Erreur suppression tag' });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // ADMIN : assignation livre <-> tags
  // ════════════════════════════════════════════════════════════════════

  router.get('/admin/books/:id/tags', auth, (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      if (!productId) return res.status(400).json({ error: 'ID invalide' });
      const rows = db.prepare(`
        SELECT t.id, t.slug, t.label, t.color, t.icon, btp.discount_pct, btp.pinned
        FROM book_tag_products btp
        INNER JOIN book_tags t ON t.id = btp.tag_id
        WHERE btp.product_id = ?
        ORDER BY t.sort_order
      `).all(productId);
      res.json(rows);
    } catch (err) {
      console.error('[TAGS] GET book tags error:', err.message);
      res.status(500).json({ error: 'Erreur chargement tags du livre' });
    }
  });

  /**
   * body = [{ slug: 'promotion', discount_pct: 20 }, { slug: 'nouveaute' }]
   * Calcule le diff add/remove et applique atomiquement.
   */
  router.put('/admin/books/:id/tags', auth, csrfProtection, (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      if (!productId) return res.status(400).json({ error: 'ID invalide' });
      const desired = Array.isArray(req.body) ? req.body : (req.body?.tags || []);
      if (!Array.isArray(desired)) {
        return res.status(400).json({ error: 'Body doit être un tableau de tags' });
      }

      // Résolution slug → id
      const allTags = db.prepare('SELECT id, slug FROM book_tags WHERE is_active = 1').all();
      const bySlug = new Map(allTags.map((t) => [t.slug, t.id]));

      const normalized = [];
      for (const d of desired) {
        const slug = d.slug || d.tag_slug;
        const tagId = bySlug.get(slug);
        if (!tagId) {
          return res.status(400).json({ error: `Tag inconnu ou désactivé : ${slug}` });
        }
        const discount = d.discount_pct !== undefined && d.discount_pct !== null && d.discount_pct !== ''
          ? Math.max(0, Math.min(100, parseFloat(d.discount_pct)))
          : null;
        normalized.push({ tagId, discount_pct: Number.isFinite(discount) ? discount : null });
      }

      const currentRows = db.prepare('SELECT tag_id, discount_pct FROM book_tag_products WHERE product_id = ?').all(productId);
      const currentMap = new Map(currentRows.map((r) => [r.tag_id, r]));
      const desiredMap = new Map(normalized.map((n) => [n.tagId, n]));

      const adminId = req.admin?.id || null;
      const trx = db.transaction(() => {
        // Remove
        for (const [tagId] of currentMap) {
          if (!desiredMap.has(tagId)) {
            db.prepare('DELETE FROM book_tag_products WHERE tag_id = ? AND product_id = ?').run(tagId, productId);
          }
        }
        // Add or update
        for (const [tagId, { discount_pct }] of desiredMap) {
          const existing = currentMap.get(tagId);
          if (!existing) {
            db.prepare(`INSERT INTO book_tag_products (tag_id, product_id, discount_pct, added_by)
              VALUES (?, ?, ?, ?)`).run(tagId, productId, discount_pct, adminId);
          } else if ((existing.discount_pct || null) !== (discount_pct || null)) {
            db.prepare(`UPDATE book_tag_products SET discount_pct = ? WHERE tag_id = ? AND product_id = ?`)
              .run(discount_pct, tagId, productId);
          }
        }
      });
      trx();

      invalidateTagCaches();
      res.json({ product_id: productId, tags: normalized.length });
    } catch (err) {
      console.error('[TAGS] PUT book tags error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour tags du livre' });
    }
  });

  router.get('/admin/tags/:slug/products', auth, async (req, res) => {
    try {
      const slug = req.params.slug;
      const page = parseInt(req.query.page) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const tag = db.prepare('SELECT * FROM book_tags WHERE slug = ?').get(slug);
      if (!tag) return res.status(404).json({ error: 'Tag introuvable' });

      const rows = db.prepare(`
        SELECT product_id, discount_pct, pinned, sort_order, added_at
        FROM book_tag_products WHERE tag_id = ?
        ORDER BY pinned DESC, sort_order ASC, added_at DESC
        LIMIT ? OFFSET ?
      `).all(tag.id, limit, page * limit);
      const total = db.prepare('SELECT COUNT(*) AS c FROM book_tag_products WHERE tag_id = ?').get(tag.id).c;

      if (rows.length === 0) return res.json({ tag, products: [], total });

      const ids = rows.map((r) => r.product_id);
      const [prodRows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.label, p.barcode, p.price_ttc, p.tosell AS status,
          pe.auteur, pe.publication_year
         FROM llx_product p
         LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      const byId = new Map(prodRows.map((p) => [p.id, p]));
      const products = rows
        .map((r) => {
          const p = byId.get(r.product_id);
          if (!p) return null;
          return { ...p, discount_pct: r.discount_pct, pinned: r.pinned };
        })
        .filter(Boolean);

      res.json({ tag, products, total });
    } catch (err) {
      console.error('[TAGS] GET tag products error:', err.message);
      res.status(500).json({ error: 'Erreur chargement produits du tag' });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // PUBLIC (home)
  // ════════════════════════════════════════════════════════════════════

  router.get('/home/tags', (req, res) => {
    try {
      const cached = cache?.get('home:tags');
      if (cached) return res.json(cached);
      const rows = db.prepare(`
        SELECT id, slug, label, description, color, icon, sort_order, max_items
        FROM book_tags
        WHERE is_active = 1 AND show_on_home = 1
        ORDER BY sort_order ASC, id ASC
      `).all();
      cache?.set('home:tags', rows, 300);
      res.json(rows);
    } catch (err) {
      console.error('[TAGS] GET home tags error:', err.message);
      res.status(500).json({ error: 'Erreur chargement tags' });
    }
  });

  router.get('/home/tags/:slug/products', async (req, res) => {
    try {
      const slug = req.params.slug;
      const cacheKey = `home:tags:${slug}:${req.query.limit || 'default'}`;
      const cached = cache?.get(cacheKey);
      if (cached) return res.json(cached);

      const tag = db.prepare('SELECT * FROM book_tags WHERE slug = ? AND is_active = 1').get(slug);
      if (!tag) return res.status(404).json({ error: 'Tag introuvable' });

      const limit = Math.min(parseInt(req.query.limit) || tag.max_items || 12, 50);
      const rows = db.prepare(`
        SELECT product_id, discount_pct FROM book_tag_products
        WHERE tag_id = ?
        ORDER BY pinned DESC, sort_order ASC, added_at DESC
        LIMIT ?
      `).all(tag.id, limit);

      if (rows.length === 0) {
        const payload = { tag, products: [] };
        cache?.set(cacheKey, payload, 300);
        return res.json(payload);
      }

      const ids = rows.map((r) => r.product_id);
      const inPlaceholders = ids.map(() => '?').join(',');
      const notInPlaceholders = EXCLUDED_CATEGORY_LABELS.map(() => '?').join(',');
      const [prodRows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.label, p.description, p.price, p.price_ttc, p.tva_tx,
          p.barcode, p.stock AS stock_reel, p.tosell AS status,
          pe.auteur, pe.soustitre, pe.longdescript, pe.publication_year, pe.nombre_pages, pe.editeur,
          (SELECT c.label FROM llx_categorie c
           INNER JOIN llx_categorie_product cp ON cp.fk_categorie = c.rowid
           WHERE cp.fk_product = p.rowid
             AND c.label NOT IN (${notInPlaceholders})
           LIMIT 1) AS genre_category
         FROM llx_product p
         LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
         WHERE p.rowid IN (${inPlaceholders}) AND p.tosell = 1`,
        [...EXCLUDED_CATEGORY_LABELS, ...ids]
      );
      const byId = new Map(prodRows.map((p) => [p.id, p]));

      const products = rows
        .map((r) => {
          const p = byId.get(r.product_id);
          if (!p) return null;
          const pages = p.nombre_pages ? parseInt(p.nombre_pages) : null;
          const year = p.publication_year ? parseInt(p.publication_year) : null;
          const enriched = {
            id: p.id,
            ref: p.ref,
            label: p.label,
            description: p.longdescript || p.description,
            price: parseFloat(p.price) || 0,
            price_ttc: parseFloat(p.price_ttc) || 0,
            barcode: p.barcode,
            stock_reel: p.stock_reel,
            array_options: {
              options_auteur: p.auteur || '',
              options_soustitre: p.soustitre || '',
              options_publication_year: p.publication_year,
              options_nombre_pages: p.nombre_pages,
              options_editeur: p.editeur,
            },
            author: p.auteur || '',
            genre_category: p.genre_category || null,
            parsed_meta: {
              pages,
              publication_year: year,
              editeur: p.editeur || null,
              language: 'Français',
            },
          };
          if (r.discount_pct && r.discount_pct > 0) {
            enriched.discount_pct = r.discount_pct;
            enriched.price_ttc_original = enriched.price_ttc;
            enriched.price_ttc = Math.round(enriched.price_ttc * (1 - r.discount_pct / 100));
          }
          return enriched;
        })
        .filter(Boolean);

      const payload = { tag, products };
      cache?.set(cacheKey, payload, 300);
      res.json(payload);
    } catch (err) {
      console.error('[TAGS] GET home tag products error:', err.message);
      res.status(500).json({ error: 'Erreur chargement produits du tag' });
    }
  });

  return router;
}
