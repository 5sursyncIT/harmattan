import 'dotenv/config';
import { dolibarrApi } from './dolibarr-client.js';

// ─── SIMPLE IN-MEMORY CACHE ────────────────────────────────

class SimpleCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires && Date.now() > entry.expires) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlSeconds = 300) {
    this.store.set(key, {
      value,
      expires: Date.now() + ttlSeconds * 1000,
    });
  }

  del(key) {
    this.store.delete(key);
  }

  keys() {
    return [...this.store.keys()];
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}

export const cache = new SimpleCache();

// ─── DOCUMENTS PRODUIT (avec cache négatif) ─────────────────
// Dolibarr répond 404 quand un produit n'a aucun document — c'est le cas de la
// majorité du catalogue, et chaque appel coûte un bootstrap Dolibarr complet
// (2 799 requêtes pour rien en 7 jours). On mémorise la réponse, liste vide
// comprise, pour ne pas la redemander à chaque affichage de fiche.
const PRODUCT_DOCS_TTL = 3600;

export async function getProductDocuments(productId) {
  const id = parseInt(productId);
  if (!id) return [];
  const key = `docs:produit:${id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let docs = [];
  try {
    const res = await dolibarrApi.get('/documents', {
      params: { modulepart: 'produit', id },
    });
    docs = Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    // 404 = « aucun document », réponse légitime : on la met en cache comme
    // les autres. Toute autre erreur reste transitoire, on ne la fige pas.
    if (err.response?.status !== 404) throw err;
  }
  cache.set(key, docs, PRODUCT_DOCS_TTL);
  return docs;
}

export function invalidateProductDocuments(productId) {
  cache.del(`docs:produit:${parseInt(productId)}`);
}

// ─── SYNC STATE ─────────────────────────────────────────────

const syncState = {
  products: { lastSync: null, count: 0, status: 'idle', error: null },
  categories: { lastSync: null, count: 0, status: 'idle', error: null },
  stock: { lastSync: null, count: 0, status: 'idle', error: null },
};

export function getSyncStatus() {
  return {
    ...syncState,
    cache_size: cache.size(),
    uptime: process.uptime(),
  };
}

// ─── SYNC CATEGORIES ────────────────────────────────────────

export async function syncCategories() {
  syncState.categories.status = 'running';
  try {
    const res = await dolibarrApi.get('/categories', {
      params: { type: 'product', sortfield: 't.label', sortorder: 'ASC', limit: 200 },
    });

    const categories = (res.data || []).map((c) => ({
      id: parseInt(c.id, 10),
      label: c.label,
      description: c.description,
      fk_parent: c.fk_parent !== null && c.fk_parent !== undefined ? parseInt(c.fk_parent, 10) : 0,
      color: c.color,
    }));

    cache.set('categories:all', categories, 120); // 2 min (cohérent avec /api/categories)
    syncState.categories = {
      lastSync: new Date().toISOString(),
      count: categories.length,
      status: 'done',
      error: null,
    };

    return categories;
  } catch (err) {
    syncState.categories.status = 'error';
    syncState.categories.error = err.message;
    throw err;
  }
}



// ─── SYNC PRODUCTS (incremental, batch) ─────────────────────

export async function syncProducts() {
  syncState.products.status = 'running';
  try {
    let page = 0;
    let total = 0;
    const batchSize = 500;
    const allRefs = [];

    while (true) {
      const res = await dolibarrApi.get('/products', {
        params: {
          limit: batchSize,
          page,
          sortfield: 't.rowid',
          sortorder: 'ASC',
        },
      });

      const products = res.data || [];
      if (products.length === 0) break;

      // Cache product image availability
      for (const p of products) {
        allRefs.push(p.ref);
        // Check if product has images in Dolibarr documents
        try {
          const docs = await getProductDocuments(p.id);
          // Real cover = any image that is NOT default_cover.*
          const hasRealCover = docs.some((d) =>
            /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name) && !d.name.startsWith('default_cover')
          );
          const hasAnyImage = docs.some((d) =>
            /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name)
          );
          cache.set(`img:${p.ref}`, hasAnyImage, 86400);
          cache.set(`realcover:${p.ref}`, hasRealCover, 86400);
        } catch {
          cache.set(`img:${p.ref}`, false, 86400);
          cache.set(`realcover:${p.ref}`, false, 86400);
        }
      }

      total += products.length;
      if (products.length < batchSize) break;
      page++;

      // Throttle
      await new Promise((r) => setTimeout(r, 200));
    }

    // Clear product listing cache to force refresh
    cache.keys().filter((k) => k.startsWith('products:')).forEach((k) => cache.del(k));

    syncState.products = {
      lastSync: new Date().toISOString(),
      count: total,
      status: 'done',
      error: null,
    };

    console.log(`[SYNC] Products: ${total} synced`);
    return total;
  } catch (err) {
    syncState.products.status = 'error';
    syncState.products.error = err.message;
    throw err;
  }
}

// ─── SYNC STOCK ─────────────────────────────────────────────

export async function syncStock() {
  syncState.stock.status = 'running';
  try {
    // Invalidate product list cache only (individual product pages have their own TTL)
    cache.keys()
      .filter((k) => k.startsWith('products:'))
      .forEach((k) => cache.del(k));

    syncState.stock = {
      lastSync: new Date().toISOString(),
      count: 0,
      status: 'done',
      error: null,
    };
  } catch (err) {
    syncState.stock.status = 'error';
    syncState.stock.error = err.message;
    throw err;
  }
}
