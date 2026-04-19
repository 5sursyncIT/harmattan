import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Send cookies (CSRF session)
});

// ─── CSRF TOKEN MANAGEMENT ─────────────────────────────────
let csrfToken = null;

async function ensureCsrfToken() {
  if (!csrfToken) {
    try {
      const res = await api.get('/csrf-token');
      csrfToken = res.data.csrfToken;
    } catch (err) {
      console.warn('Could not fetch CSRF token:', err);
    }
  }
  return csrfToken;
}

// Interceptor: attach CSRF token + POS staff ID
api.interceptors.request.use(async (config) => {
  const method = config.method?.toLowerCase();
  if (method === 'post' || method === 'put' || method === 'delete') {
    const token = await ensureCsrfToken();
    if (token) {
      config.headers['X-CSRF-Token'] = token;
    }
  }
  // Attach POS device token + session token (for /api/pos/* routes)
  if (config.url?.startsWith('/pos/')) {
    const deviceToken = localStorage.getItem('pos-device-token');
    if (deviceToken) {
      config.headers['X-POS-Device'] = deviceToken;
    }
    try {
      const stored = JSON.parse(localStorage.getItem('senharmattan-pos-auth') || '{}');
      if (stored.state?.token) {
        config.headers['X-POS-Token'] = stored.state.token;
      }
    } catch (err) {
      console.warn('POS store read error:', err);
    }
  }
  return config;
});

// If CSRF token is rejected (403), refresh and retry once
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (
      error.response?.status === 403 &&
      error.response?.data?.error?.includes('CSRF') &&
      !original._csrfRetry
    ) {
      original._csrfRetry = true;
      csrfToken = null;
      await ensureCsrfToken();
      if (csrfToken) {
        original.headers['X-CSRF-Token'] = csrfToken;
      }
      return api(original);
    }
    // POS device not registered — redirect to enrollment
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === 'DEVICE_REQUIRED' &&
      error.config?.url?.startsWith('/pos/')
    ) {
      localStorage.removeItem('pos-device-token');
      if (window.location.pathname.startsWith('/pos') && !window.location.pathname.includes('connexion')) {
        window.location.href = '/pos/connexion';
      }
    }
    // POS device revoked
    if (
      error.response?.status === 403 &&
      error.response?.data?.code === 'DEVICE_INVALID' &&
      error.config?.url?.startsWith('/pos/')
    ) {
      localStorage.removeItem('pos-device-token');
      if (window.location.pathname.startsWith('/pos')) {
        window.location.href = '/pos/connexion';
      }
    }
    // POS token expired — retry once, then logout and redirect
    if (
      error.response?.status === 401 &&
      error.config?.url?.startsWith('/pos/') &&
      !error.config?.url?.includes('/auth/login')
    ) {
      // Retry once in case of transient server error (restart, etc.)
      if (!error.config._posRetry) {
        error.config._posRetry = true;
        await new Promise((r) => setTimeout(r, 1000));
        return api(error.config);
      }
      // After retry failed — actually logout
      try {
        const store = JSON.parse(localStorage.getItem('senharmattan-pos-auth') || '{}');
        if (store.state?.isAuthenticated) {
          localStorage.setItem('senharmattan-pos-auth', JSON.stringify({ state: { staff: null, token: null, isAuthenticated: false }, version: 0 }));
          if (window.location.pathname.startsWith('/pos') && !window.location.pathname.includes('connexion')) {
            window.location.href = '/pos/connexion';
          }
        }
      } catch (err) {
        console.warn('POS Auth sync error:', err);
      }
    }
    return Promise.reject(error);
  }
);

// Pre-fetch CSRF token on module load
ensureCsrfToken();

// ─── API FUNCTIONS ──────────────────────────────────────────

// Products
export const getProducts = (params = {}) =>
  api.get('/products', { params: { limit: 20, ...params } });

// In-memory product cache (avoids refetching on back-navigation)
const productCache = new Map();
const PRODUCT_CACHE_TTL = 5 * 60 * 1000; // 5 min

export const getProduct = (id) => {
  const entry = productCache.get(id);
  if (entry && Date.now() - entry.ts < PRODUCT_CACHE_TTL) {
    return Promise.resolve(entry.res);
  }
  return api.get(`/products/${id}`).then((res) => {
    productCache.set(id, { res, ts: Date.now() });
    if (productCache.size > 100) {
      const oldest = productCache.keys().next().value;
      productCache.delete(oldest);
    }
    return res;
  });
};

export const getFeaturedProducts = (limit = 8) =>
  api.get('/products/featured', { params: { limit } });

export const searchProducts = (query, params = {}) =>
  api.get('/products', { params: { q: query, limit: 20, ...params } });

export const getBooksOfTheMonth = () => api.get('/products/livre-du-mois');

export const getEvenements = () => api.get('/evenements');

export const getPriceRange = () => api.get('/products/price-range');

// Categories
export const getCategories = () => api.get('/categories');

export const getCategory = (id) => api.get(`/categories/${id}`);

export const getCategoryProducts = (id, params = {}) =>
  api.get('/products', { params: { category: id, limit: 20, ...params } });

// Orders
export const createOrder = (data) => api.post('/orders', data);
export const createPreorder = (data) => api.post('/preorders', data);
export const cancelPreorder = (reference, data) => api.post(`/preorders/${reference}/cancel`, data);

export const getOrder = (id) => api.get(`/orders/${id}`);

// Auth
export const loginCustomer = (email, password) => api.post('/auth/login', { email, password });

export const registerCustomer = (data) => api.post('/auth/register', data);

export const updateProfile = (data) => api.put('/auth/profile', data);

export const changePassword = (data) => api.put('/auth/password', data);

export const forgotPassword = (email) => api.post('/auth/forgot-password', { email });

export const resetPassword = (data) => api.post('/auth/reset-password', data);

// Customer orders & invoices
export const getCustomerOrders = (customerId) => api.get(`/customers/${customerId}/orders`);
export const getCustomerInvoices = (customerId) => api.get(`/customers/${customerId}/invoices`);
export const getInvoicePdfUrl = (invoiceId) => `/api/invoices/${invoiceId}/pdf`;

// Image URL helper - uses product ID, auto-finds image on backend
export const getProductImageUrl = (productId, title = '') => {
  const params = title ? `?title=${encodeURIComponent(title)}` : '';
  return `/api/image/${productId}${params}`;
};

// Sync status
export const getSyncStatus = () => api.get('/sync/status');

export default api;
