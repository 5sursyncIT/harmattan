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
      id: c.id,
      label: c.label,
      description: c.description,
      fk_parent: c.fk_parent,
      color: c.color,
    }));

    cache.set('categories:all', categories, 3600); // 1 hour
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
          const docRes = await dolibarrApi.get('/documents', {
            params: { modulepart: 'produit', id: parseInt(p.id) },
          });
          // Real cover = any image that is NOT default_cover.*
          const hasRealCover = (docRes.data || []).some((d) =>
            /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name) && !d.name.startsWith('default_cover')
          );
          const hasAnyImage = (docRes.data || []).some((d) =>
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
