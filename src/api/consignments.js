import api from './dolibarr';

// ─── Stats ───────────────────────────────────────────────────
export const getConsignmentStats = () => api.get('/admin/consignments/stats');

// ─── Ressources ──────────────────────────────────────────────
export const getConsignmentWarehouses = () => api.get('/admin/consignments/warehouses');
export const searchConsignmentProducts = (q) => api.get('/admin/consignments/products/search', { params: { q } });

// ─── Déposants ───────────────────────────────────────────────
export const listConsignors = (params = {}) => api.get('/admin/consignments/consignors', { params });
export const getConsignor = (id) => api.get(`/admin/consignments/consignors/${id}`);
export const createConsignor = (data) => api.post('/admin/consignments/consignors', data);
export const updateConsignor = (id, data) => api.put(`/admin/consignments/consignors/${id}`, data);
export const deleteConsignor = (id) => api.delete(`/admin/consignments/consignors/${id}`);
export const searchConsignorTiers = (q) => api.get('/admin/consignments/consignors/search-tiers', { params: { q } });

// ─── Dépôts ──────────────────────────────────────────────────
export const listDeposits = (params = {}) => api.get('/admin/consignments/deposits', { params });
export const getDeposit = (id) => api.get(`/admin/consignments/deposits/${id}`);
export const createDeposit = (data) => api.post('/admin/consignments/deposits', data);
export const updateDeposit = (id, data) => api.put(`/admin/consignments/deposits/${id}`, data);
export const deleteDeposit = (id) => api.delete(`/admin/consignments/deposits/${id}`);
export const validateDeposit = (id) => api.post(`/admin/consignments/deposits/${id}/validate`);
export const returnDeposit = (id, lines) => api.post(`/admin/consignments/deposits/${id}/return`, { lines });

// ─── Reversements ────────────────────────────────────────────
export const previewSettlement = (params) => api.get('/admin/consignments/settlements/preview', { params });
export const listSettlements = (params = {}) => api.get('/admin/consignments/settlements', { params });
export const getSettlement = (id) => api.get(`/admin/consignments/settlements/${id}`);
export const createSettlement = (data) => api.post('/admin/consignments/settlements', data);
export const paySettlement = (id, payment_ref) => api.post(`/admin/consignments/settlements/${id}/pay`, { payment_ref });
export const deleteSettlement = (id) => api.delete(`/admin/consignments/settlements/${id}`);

// PDF : ouvre le relevé (cookie d'auth envoyé automatiquement).
export const openSettlementPdf = (id) => window.open(`/api/admin/consignments/settlements/${id}/pdf`, '_blank', 'noopener');
