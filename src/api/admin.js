import api from './dolibarr';
import toast from 'react-hot-toast';

// Intercepteur pour gérer les erreurs 401 (Sécurité)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      const url = error.config.url;
      if (url.startsWith('/admin') && url !== '/admin/me' && url !== '/admin/login') {
        toast.error('Session expirée, veuillez vous reconnecter.');
        // On déclenche un event custom pour déconnecter l'admin
        window.dispatchEvent(new Event('admin-unauthorized'));
      }
    }
    return Promise.reject(error);
  }
);

// Auth
export const adminLogin = (username, password) => api.post('/admin/login', { username, password });
export const adminLogin2FA = (pendingToken, code) => api.post('/admin/login/2fa', { pendingToken, code });
export const adminLogout = () => api.post('/admin/logout');
export const adminMe = () => api.get('/admin/me');
export const adminChangePassword = (current, newPassword) => api.put('/admin/password', { current, newPassword });

// Site config
export const getSiteConfig = () => api.get('/admin/config');
export const getFullSiteConfig = () => api.get('/admin/config/full');
export const updateSiteConfig = (data) => api.put('/admin/config', data);
export const uploadSliderImage = (file) => {
  const fd = new FormData();
  fd.append('image', file);
  return api.post('/admin/config/slider-image', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};

export const uploadCoverImage = (file) => {
  const fd = new FormData();
  fd.append('image', file);
  return api.post('/admin/config/cover-image', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};

// ─── Books management ──────────────────────────────────
export const listBooks = (params = {}, config = {}) => api.get('/admin/books', { params, ...config });
export const getBook = (id) => api.get(`/admin/books/${id}`);
export const createBook = (data) => api.post('/admin/books', data);
export const updateBook = (id, data) => api.put(`/admin/books/${id}`, data);
export const deleteBook = (id, hard = false) => api.delete(`/admin/books/${id}`, { params: { soft: hard ? '0' : '1' } });
export const checkIsbn = (isbn, excludeId = null) =>
  api.get(`/admin/books/check-isbn/${encodeURIComponent(isbn)}`, { params: excludeId ? { exclude: excludeId } : {} });
export const createGenre = (label) => api.post('/admin/books/genres', { label });
// ── Genres (CRUD) ──
export const listGenres = () => api.get('/admin/books/genres');
export const updateGenre = (id, label) => api.put(`/admin/books/genres/${id}`, { label });
export const deleteGenre = (id, { reassignTo, force } = {}) =>
  api.delete(`/admin/books/genres/${id}`, {
    params: {
      ...(reassignTo ? { reassignTo } : {}),
      ...(force ? { force: 1 } : {}),
    },
  });
export const searchAuthors = (q = '', limit = 10, config = {}) =>
  api.get('/admin/books/authors', { params: { q, limit }, ...config });
export const getBookQualityStats = () => api.get('/admin/books/quality-stats');
export const uploadBookCover = (id, file, { side } = {}) => {
  const fd = new FormData();
  fd.append('cover', file);
  if (side) fd.append('side', side);
  return api.post(`/admin/books/${id}/cover`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};

// ─── POS management ──────────────────────────────────
// Devices
export const getPosDevices = () => api.get('/admin/pos/devices');
export const generatePosEnrollmentCode = (device_name) =>
  api.post('/admin/pos/devices/generate-code', { device_name });
export const getPosEnrollmentCodes = () => api.get('/admin/pos/devices/enrollment-codes');
export const updatePosDevice = (id, data) => api.put(`/admin/pos/devices/${id}`, data);
export const revokePosDevice = (id) => api.delete(`/admin/pos/devices/${id}`);

// Staff
export const getPosStaff = () => api.get('/admin/pos/staff');
export const createPosStaff = (data) => api.post('/admin/pos/staff', data);
export const updatePosStaff = (id, data) => api.put(`/admin/pos/staff/${id}`, data);
export const resetPosStaffPin = (id, pin) => api.put(`/admin/pos/staff/${id}/pin`, { pin });
export const deletePosStaff = (id) => api.delete(`/admin/pos/staff/${id}`);

// Sessions
export const getPosSessions = () => api.get('/admin/pos/sessions');

// ─── Admin dashboard (KPIs) ───────────────────────────
export const getAdminStatsMain = () => api.get('/admin/stats/main');
export const getAdminStatsTimeseries = () => api.get('/admin/stats/timeseries');
export const getAdminStatsChannels = () => api.get('/admin/stats/channels');
export const getAdminStatsTop = () => api.get('/admin/stats/top');

// Contact messages
export const getContactMessages = () => api.get('/admin/contact/messages');
export const markMessageRead = (id) => api.put(`/admin/contact/messages/${id}/read`);
export const deleteMessage = (id) => api.delete(`/admin/contact/messages/${id}`);

// Manuscripts
export const getManuscripts = () => api.get('/admin/manuscripts');
export const updateManuscriptStatus = (id, status) => api.put(`/admin/manuscripts/${id}/status`, { status });
export const downloadManuscript = (id) => api.get(`/admin/manuscripts/${id}/download`, { responseType: 'blob' });

// Reply to contact message
export const replyToMessage = (id, data) => api.post(`/admin/contact/messages/${id}/reply`, data);

// Admin users management
export const getAdminUsers = () => api.get('/admin/users');
export const createAdminUser = (data) => api.post('/admin/users', data);
export const updateAdminUser = (id, data) => api.put(`/admin/users/${id}`, data);
export const deleteAdminUser = (id) => api.delete(`/admin/users/${id}`);
export const setAdminUserActive = (id, isActive) => api.patch(`/admin/users/${id}/active`, { is_active: isActive });
export const forceLogoutAdminUser = (id) => api.post(`/admin/users/${id}/force-logout`);
export const forcePasswordResetAdminUser = (id) => api.post(`/admin/users/${id}/force-password-reset`);
export const resetAdminUser2FA = (id) => api.post(`/admin/users/${id}/reset-2fa`);
export const getAdminRoles = () => api.get('/admin/roles');
// Surcharges de permissions (super-admin) : élargir/restreindre un rôle×module à chaud
export const setRolePermissionOverride = (role, module, level) =>
  api.put(`/admin/roles/${role}/permissions/${module}`, { level });
export const clearRolePermissionOverride = (role, module) =>
  api.delete(`/admin/roles/${role}/permissions/${module}`);
export const clearAllRolePermissionOverrides = () => api.delete('/admin/roles/overrides');

// 2FA (TOTP) — pour l'utilisateur connecté
export const setup2FA = () => api.post('/admin/2fa/setup');
export const verify2FA = (code) => api.post('/admin/2fa/verify', { code });
export const disable2FA = (password, code) => api.post('/admin/2fa/disable', { password, code });

// Activity log
export const getActivityLog = (params = {}) => api.get('/admin/activity-log', { params });
export const getActivityStats = () => api.get('/admin/activity-log/stats');
export const getActivityExportUrl = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return `/api/admin/activity-log/export${qs ? '?' + qs : ''}`;
};

// Newsletter
export const getSubscribers = () => api.get('/admin/newsletter/subscribers');
export const deleteSubscriber = (id) => api.delete(`/admin/newsletter/${id}`);
export const exportSubscribers = () => '/api/admin/newsletter/export';

// Orders & Payments
export const confirmOrderPayment = (orderId) => api.post(`/admin/orders/${orderId}/confirm-payment`);
export const getAdminPayments = (params = {}) => api.get('/admin/payments', { params });
export const getPaymentOrphans = () => api.get('/admin/payments/orphans');
export const getAdminOrderDetail = (orderId) => api.get(`/admin/payments/order/${orderId}`);
export const rejectPayment = (id, reason = '') => api.post(`/admin/payments/${id}/reject`, { reason });

// Stock & Réapprovisionnement
export const getStockDashboard = () => api.get('/admin/stock/dashboard');
export const getStockAlerts = (params = {}) => api.get('/admin/stock/alerts', { params });
export const acknowledgeStockAlert = (id) => api.post(`/admin/stock/alerts/${id}/acknowledge`);
export const resolveStockAlert = (id) => api.post(`/admin/stock/alerts/${id}/resolve`);
export const ignoreStockAlert = (id) => api.post(`/admin/stock/alerts/${id}/ignore`);
export const getStockProducts = (params = {}) => api.get('/admin/stock/products', { params });
export const getStockPolicy = (productId) => api.get(`/admin/stock/policies/${productId}`);
export const updateStockPolicy = (productId, data) => api.put(`/admin/stock/policies/${productId}`, data);
export const getStockRecommendations = (params = {}) => api.get('/admin/stock/recommendations', { params });
export const approveRecommendation = (id) => api.post(`/admin/stock/recommendations/${id}/approve`);
export const cancelRecommendation = (id) => api.post(`/admin/stock/recommendations/${id}/cancel`);
export const runStockBatch = () => api.post('/admin/stock/batch/daily');
export const runStockClassify = () => api.post('/admin/stock/batch/classify');
export const requestReprint = (product_id, qty) => api.post('/admin/stock/reprint', { product_id, qty });
export const requestSupplierOrder = (product_id, qty, supplier_id) => api.post('/admin/stock/order-supplier', { product_id, qty, supplier_id });
export const stockEntry = (product_id, qty, reason, warehouse_id) => api.post('/admin/stock/entry', { product_id, qty, reason, warehouse_id });
// Ajustement d'inventaire : on envoie la quantité PHYSIQUE comptée, le serveur calcule l'écart.
export const adjustStock = (product_id, counted_qty, reason, warehouse_id) => api.post('/admin/stock/adjust', { product_id, counted_qty, reason, warehouse_id });
// Transfert entre entrepôts : liste des dépôts (+ stock du produit par dépôt) et déplacement
export const getStockWarehouses = (product_id) => api.get('/admin/stock/warehouses', { params: product_id ? { product_id } : {} });
export const transferStock = (payload) => api.post('/admin/stock/transfer', payload);
// Historique des transferts (mouvements appariés TRF-… + auteur réel)
export const getStockTransfers = (params = {}) => api.get('/admin/stock/transfers', { params });
// Commandes d'approvisionnement (suivi local + réception)
export const getPurchaseOrders = (params = {}) => api.get('/admin/stock/purchase-orders', { params });
export const getPurchaseOrder = (id) => api.get(`/admin/stock/purchase-orders/${id}`);
export const receivePurchaseOrder = (id, payload) => api.post(`/admin/stock/purchase-orders/${id}/receive`, payload);
export const cancelPurchaseOrder = (id) => api.post(`/admin/stock/purchase-orders/${id}/cancel`);

// Suppliers
export const getSuppliers = () => api.get('/admin/suppliers');
export const getSupplier = (id) => api.get(`/admin/suppliers/${id}`);
export const createSupplier = (data) => api.post('/admin/suppliers', data);
export const updateSupplier = (id, data) => api.put(`/admin/suppliers/${id}`, data);
export const deleteSupplier = (id) => api.delete(`/admin/suppliers/${id}`);
export const searchSupplierTiers = (q) => api.get('/admin/suppliers/search-tiers', { params: { q } });
export const addSupplierFromTier = (dolibarrId) => api.post(`/admin/suppliers/from-tier/${dolibarrId}`);

// Inventaire (comptage physique de stock)
export const getInventoryScopeOptions = () => api.get('/admin/inventory/scope-options');
export const getInventorySessions = (params = {}) => api.get('/admin/inventory/sessions', { params });
export const getInventorySession = (id) => api.get(`/admin/inventory/sessions/${id}`);
export const getInventoryLines = (id, params = {}) => api.get(`/admin/inventory/sessions/${id}/lines`, { params });
export const createInventorySession = (data) => api.post('/admin/inventory/sessions', data);
export const startInventorySession = (id, product_ids) => api.post(`/admin/inventory/sessions/${id}/start`, product_ids ? { product_ids } : {});
// Saisie : { barcode } = scan +1 · { product_id, qty } = quantité absolue
export const countInventory = (id, payload) => api.post(`/admin/inventory/sessions/${id}/count`, payload);
export const bulkCountInventory = (id, lines) => api.post(`/admin/inventory/sessions/${id}/count/bulk`, { lines });
export const resetInventoryLine = (id, lineId) => api.post(`/admin/inventory/sessions/${id}/lines/${lineId}/reset`);
export const previewInventoryClose = (id) => api.get(`/admin/inventory/sessions/${id}/preview`);
export const closeInventorySession = (id) => api.post(`/admin/inventory/sessions/${id}/close`);
export const cancelInventorySession = (id) => api.post(`/admin/inventory/sessions/${id}/cancel`);
export const deleteInventorySession = (id) => api.delete(`/admin/inventory/sessions/${id}`);
// Rapports téléchargeables (auth par cookie — ouverture directe de l'URL)
export const inventoryReportPdfUrl = (id) => `/api/admin/inventory/sessions/${id}/report.pdf`;
export const inventoryReportCsvUrl = (id) => `/api/admin/inventory/sessions/${id}/report.csv`;

// Notification badges
export const getNotificationCounts = () => api.get('/admin/notifications/counts');

// Stats
export const getAdminStats = () => api.get('/admin/stats');

// Customers & Authors (public-facing accounts)
export const getAdminCustomers = (params = {}) => api.get('/admin/customers', { params });
export const getAdminCustomer = (id) => api.get(`/admin/customers/${id}`);
export const resetCustomerPassword = (id) => api.post(`/admin/customers/${id}/reset-password`);

// Tiers Dolibarr (llx_societe)
export const getAdminSocietes = (params = {}) => api.get('/admin/societes', { params });
export const getAdminSociete = (id) => api.get(`/admin/societes/${id}`);
export const getAdminSocieteInvoices = (id, params = {}) => api.get(`/admin/societes/${id}/invoices`, { params });
export const createAdminSociete = (data) => api.post('/admin/societes', data);
export const updateAdminSociete = (id, data) => api.put(`/admin/societes/${id}`, data);
export const deleteAdminSociete = (id) => api.delete(`/admin/societes/${id}`);
export const promoteSocieteToAuthor = (id) => api.post(`/admin/societes/${id}/promote-author`);

export const getAdminAuthors = (params = {}, config = {}) => api.get('/admin/authors', { params, ...config });
export const getAdminAuthor = (id) => api.get(`/admin/authors/${id}`);
export const createAdminAuthor = (data) => api.post('/admin/authors', data);
export const resetAuthorPassword = (id) => api.post(`/admin/authors/${id}/reset-password`);
export const updateAdminAuthor = (id, data) => api.put(`/admin/authors/${id}`, data);
export const uploadAuthorPhoto = (id, file) => {
  const fd = new FormData();
  fd.append('photo', file);
  return api.post(`/admin/authors/${id}/photo`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const notifyAuthorRoyalties = (id) => api.post(`/admin/authors/${id}/notify-royalties`);

// ─── News / Actualités ─────────────────────────────────
export const listNewsArticles = (params = {}) => api.get('/admin/news', { params });
export const getNewsArticle = (id) => api.get(`/admin/news/${id}`);
export const createNewsArticle = (data) => api.post('/admin/news', data);
export const updateNewsArticle = (id, data) => api.put(`/admin/news/${id}`, data);
export const deleteNewsArticle = (id) => api.delete(`/admin/news/${id}`);
export const uploadNewsImage = (file) => {
  const fd = new FormData();
  fd.append('image', file);
  return api.post('/admin/news/upload-image', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};
