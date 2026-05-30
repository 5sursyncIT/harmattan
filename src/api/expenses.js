import api from './dolibarr';

// Liste paginée + filtres (category, method, source_id, status, search, date_from, date_to, page, limit)
export const listExpenses = (params = {}) => api.get('/admin/expenses', { params });

// Métadonnées pour les <select> (catégories + méthodes)
export const getExpenseMeta = () => api.get('/admin/expenses/meta');

// Sources de fonds avec soldes calculés
export const getCashSources = () => api.get('/admin/expenses/sources');
export const createCashSource = (payload) => api.post('/admin/expenses/sources', payload);
export const createTopup = (payload) => api.post('/admin/expenses/topups', payload);

// Rapport de caisse (recettes encaissées − dépenses = solde net) sur une période
export const getCashReport = (params = {}) => api.get('/admin/expenses/report', { params });

// Journal d'audit global
export const getExpensesAuditLog = (params = {}) => api.get('/admin/expenses/audit-log', { params });

// Détail (+ audit de la dépense)
export const getExpense = (id) => api.get(`/admin/expenses/${id}`);

// Mutations
export const createExpense = (payload) => api.post('/admin/expenses', payload);
export const cancelExpense = (id, reason) => api.post(`/admin/expenses/${id}/cancel`, { reason });
export const acknowledgeExpense = (id) => api.post(`/admin/expenses/${id}/acknowledge`);
