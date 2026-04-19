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
export const listBooks = (params = {}) => api.get('/admin/books', { params });
export const getBook = (id) => api.get(`/admin/books/${id}`);
export const createBook = (data) => api.post('/admin/books', data);
export const updateBook = (id, data) => api.put(`/admin/books/${id}`, data);
export const deleteBook = (id, hard = false) => api.delete(`/admin/books/${id}`, { params: { soft: hard ? '0' : '1' } });
export const checkIsbn = (isbn, excludeId = null) =>
  api.get(`/admin/books/check-isbn/${encodeURIComponent(isbn)}`, { params: excludeId ? { exclude: excludeId } : {} });
export const searchAuthors = (q = '', limit = 10) =>
  api.get('/admin/books/authors', { params: { q, limit } });

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

// Activity log
export const getActivityLog = (limit = 50) => api.get('/admin/activity-log', { params: { limit } });

// Newsletter
export const getSubscribers = () => api.get('/admin/newsletter/subscribers');
export const deleteSubscriber = (id) => api.delete(`/admin/newsletter/${id}`);
export const exportSubscribers = () => '/api/admin/newsletter/export';

// Orders & Payments
export const confirmOrderPayment = (orderId) => api.post(`/admin/orders/${orderId}/confirm-payment`);
export const getAdminPayments = (params = {}) => api.get('/admin/payments', { params });
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

// Suppliers
export const getSuppliers = () => api.get('/admin/suppliers');
export const getSupplier = (id) => api.get(`/admin/suppliers/${id}`);
export const createSupplier = (data) => api.post('/admin/suppliers', data);
export const updateSupplier = (id, data) => api.put(`/admin/suppliers/${id}`, data);
export const deleteSupplier = (id) => api.delete(`/admin/suppliers/${id}`);

// Stats
export const getAdminStats = () => api.get('/admin/stats');
