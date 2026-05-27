/**
 * Espace public des auteurs.
 *
 * Expose deux routes publiques :
 *   - GET /api/authors           → annuaire (auteurs publics avec au moins 1 livre)
 *   - GET /api/authors/:slug     → profil + bibliographie
 *
 * S'appuie sur :
 *   - SQLite `authors` (étendue avec slug, bio, photo_url, website, socials, public_listed)
 *   - Dolibarr `llx_product_extrafields.auteur` pour la bibliographie (match texte sur display_name)
 *
 * Le rattachement livre ↔ auteur reste textuel (champ `pe.auteur` est une chaîne libre dans Dolibarr).
 * On match sur display_name OU "firstname lastname" pour ratisser large, en restant insensible à la casse.
 */
import { Router } from 'express';

// Construit un slug ASCII kebab-case stable. Utilisé pour générer les URLs /auteur/:slug.
export function slugify(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Étend la table authors avec les colonnes nécessaires au profil public.
 * Idempotent — chaque ALTER est wrappé dans un try/catch.
 * À appeler une fois au démarrage, après ensureNotificationsSchema().
 */
export function ensureAuthorPublicSchema(db) {
  // CREATE TABLE de secours : sur une base neuve, ce schéma est appelé AVANT
  // setupAdminRoutes (qui contient l'autre CREATE TABLE authors). On garde une
  // version minimale ici pour que les ALTER + le backfill ci-dessous ne plantent
  // pas. setupAdminRoutes complétera/recréera de façon idempotente plus tard.
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      firstname TEXT NOT NULL,
      lastname TEXT NOT NULL,
      phone TEXT,
      dolibarr_thirdparty_id INTEGER,
      email_verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (e) { void e; }

  const cols = [
    'ALTER TABLE authors ADD COLUMN slug TEXT',
    'ALTER TABLE authors ADD COLUMN display_name TEXT',
    'ALTER TABLE authors ADD COLUMN photo_url TEXT',
    'ALTER TABLE authors ADD COLUMN website TEXT',
    'ALTER TABLE authors ADD COLUMN social_twitter TEXT',
    'ALTER TABLE authors ADD COLUMN social_instagram TEXT',
    'ALTER TABLE authors ADD COLUMN social_linkedin TEXT',
    'ALTER TABLE authors ADD COLUMN social_facebook TEXT',
    'ALTER TABLE authors ADD COLUMN public_listed INTEGER NOT NULL DEFAULT 0',
  ];
  for (const ddl of cols) {
    try { db.exec(ddl); } catch (e) { void e; /* column already exists */ }
  }
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_authors_slug ON authors(slug) WHERE slug IS NOT NULL'); } catch (e) { void e; }

  // Backfill slug + display_name pour les auteurs existants
  const rows = db.prepare("SELECT id, firstname, lastname, slug, display_name FROM authors WHERE slug IS NULL OR slug = '' OR display_name IS NULL OR display_name = ''").all();
  for (const r of rows) {
    const display = `${r.firstname || ''} ${r.lastname || ''}`.trim();
    let slug = r.slug && r.slug.trim() ? r.slug.trim() : slugify(display || `auteur-${r.id}`);
    // Évite les collisions
    let candidate = slug || `auteur-${r.id}`;
    let suffix = 1;
    while (db.prepare('SELECT 1 FROM authors WHERE slug = ? AND id != ?').get(candidate, r.id)) {
      suffix += 1;
      candidate = `${slug}-${suffix}`;
    }
    db.prepare('UPDATE authors SET slug = ?, display_name = COALESCE(NULLIF(display_name, \'\'), ?) WHERE id = ?')
      .run(candidate, display, r.id);
  }
}

/**
 * Génère un slug unique pour un auteur, en se basant sur display_name (ou firstname+lastname).
 */
export function generateUniqueSlug(db, base, excludeId = null) {
  let slug = slugify(base) || 'auteur';
  let candidate = slug;
  let suffix = 1;
  while (true) {
    const params = excludeId ? [candidate, excludeId] : [candidate, -1];
    const exists = db.prepare('SELECT id FROM authors WHERE slug = ? AND id != ?').get(...params);
    if (!exists) return candidate;
    suffix += 1;
    candidate = `${slug}-${suffix}`;
  }
}

export function createAuthorPublicRouter({ db, dolibarrPool, cache }) {
  const router = Router();

  // GET /api/authors — annuaire des auteurs publics
  router.get('/', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().slice(0, 100);
      const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

      let where = "WHERE a.public_listed = 1 AND a.slug IS NOT NULL AND a.slug != ''";
      const params = [];
      if (q) {
        const pat = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
        where += ' AND (a.firstname LIKE ? OR a.lastname LIKE ? OR a.display_name LIKE ?)';
        params.push(pat, pat, pat);
      }

      const total = db.prepare(`SELECT COUNT(*) AS n FROM authors a ${where}`).get(...params).n;

      const rows = db.prepare(
        `SELECT a.id, a.slug, a.firstname, a.lastname, a.display_name,
                a.bio, a.photo_url
         FROM authors a
         ${where}
         ORDER BY a.lastname COLLATE NOCASE ASC, a.firstname COLLATE NOCASE ASC
         LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      // Comptage de livres par auteur : Phase 3 — via FK book_authors (JOIN Dolibarr pour
      // ne compter que les produits réellement en vente). Plus de LIKE sur pe.auteur.
      const cacheKey = 'public_authors_book_counts_fk';
      let counts = cache?.get(cacheKey);
      if (!counts) {
        counts = new Map(); // author_id (number) → count (number)
        try {
          const baRows = db.prepare(
            `SELECT author_id, GROUP_CONCAT(product_id) AS product_ids, COUNT(*) AS n
             FROM book_authors GROUP BY author_id`
          ).all();
          // Pour chaque auteur, vérifie côté Dolibarr que les produits sont bien tosell=1
          // (la table book_authors peut contenir des refs périmées si un produit a été supprimé/désactivé)
          if (dolibarrPool && baRows.length > 0) {
            const allIds = baRows.flatMap((r) => String(r.product_ids).split(',').map(Number));
            const uniqIds = [...new Set(allIds)];
            const placeholders = uniqIds.map(() => '?').join(',');
            const [activeRows] = await dolibarrPool.query(
              `SELECT rowid FROM llx_product
               WHERE rowid IN (${placeholders}) AND tosell = 1 AND fk_product_type = 0`,
              uniqIds
            );
            const activeSet = new Set(activeRows.map((r) => Number(r.rowid)));
            for (const r of baRows) {
              const ids = String(r.product_ids).split(',').map(Number);
              const activeCount = ids.filter((id) => activeSet.has(id)).length;
              if (activeCount > 0) counts.set(Number(r.author_id), activeCount);
            }
          }
          cache?.set(cacheKey, counts, 5 * 60 * 1000);
        } catch (e) {
          console.warn('[PUBLIC-AUTHORS] book counts FK:', e.message);
        }
      }

      const enriched = rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.display_name || `${r.firstname} ${r.lastname}`.trim(),
        bio_excerpt: r.bio ? String(r.bio).slice(0, 180) : null,
        photo_url: r.photo_url || null,
        book_count: counts.get(r.id) || 0,
      }));

      res.json({ total, authors: enriched, q, limit, offset });
    } catch (err) {
      console.error('[PUBLIC-AUTHORS] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement annuaire' });
    }
  });

  // GET /api/authors/:slug — profil + bibliographie
  router.get('/:slug', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').slice(0, 80);
      if (!slug) return res.status(404).json({ error: 'Auteur introuvable' });

      const author = db.prepare(
        `SELECT id, slug, firstname, lastname, display_name, bio, photo_url, website,
                social_twitter, social_instagram, social_linkedin, social_facebook,
                public_listed, created_at
         FROM authors WHERE slug = ?`
      ).get(slug);

      if (!author || !author.public_listed) {
        return res.status(404).json({ error: 'Auteur introuvable' });
      }

      const displayName = (author.display_name || `${author.firstname} ${author.lastname}`).trim();

      // Bibliographie : Phase 3 — via FK book_authors. Plus de LIKE.
      let books = [];
      if (dolibarrPool) {
        const linkedIds = db.prepare(
          `SELECT product_id FROM book_authors WHERE author_id = ?`
        ).all(author.id).map((r) => r.product_id);

        if (linkedIds.length > 0) {
          const placeholders = linkedIds.map(() => '?').join(',');
          try {
            const [rows] = await dolibarrPool.query(
              `SELECT p.rowid AS id, p.ref, p.label, p.barcode, p.price_ttc, p.price,
                      pe.publication_year, pe.nombre_pages, pe.editeur, pe.soustitre
               FROM llx_product p
               LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
               WHERE p.rowid IN (${placeholders})
                 AND p.tosell = 1 AND p.fk_product_type = 0
               ORDER BY pe.publication_year DESC, p.label ASC
               LIMIT 200`,
              linkedIds
            );
            books = rows.map((b) => ({
              id: b.id,
              ref: b.ref,
              label: b.label,
              subtitle: b.soustitre || null,
              price: Number(b.price_ttc || b.price || 0),
              year: b.publication_year || null,
              pages: b.nombre_pages || null,
              editor: b.editeur || null,
            }));
          } catch (e) {
            console.warn('[PUBLIC-AUTHORS] bibliography FK:', e.message);
          }
        }
      }

      res.json({
        author: {
          id: author.id,
          slug: author.slug,
          name: displayName,
          firstname: author.firstname,
          lastname: author.lastname,
          bio: author.bio || null,
          photo_url: author.photo_url || null,
          website: author.website || null,
          socials: {
            twitter: author.social_twitter || null,
            instagram: author.social_instagram || null,
            linkedin: author.social_linkedin || null,
            facebook: author.social_facebook || null,
          },
        },
        books,
      });
    } catch (err) {
      console.error('[PUBLIC-AUTHORS] profile error:', err.message);
      res.status(500).json({ error: 'Erreur chargement profil auteur' });
    }
  });

  return router;
}
