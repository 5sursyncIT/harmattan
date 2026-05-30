import api from './dolibarr';

// Module Sorties d'argent — écran admin EN CONSULTATION.
// La création se fait au POS (voir src/api/pos.js → posRecordExpense).

// Liste paginée + filtres (category, status, terminal, search, date_from, date_to, page, limit)
export const listExpenses = (params = {}) => api.get('/admin/expenses', { params });

// Métadonnées (catégories) pour les <select> de filtre
export const getExpenseMeta = () => api.get('/admin/expenses/meta');

// Rapport de caisse (recettes encaissées − dépenses = solde net) sur une période
export const getCashReport = (params = {}) => api.get('/admin/expenses/report', { params });

// Journal d'audit global
export const getExpensesAuditLog = (params = {}) => api.get('/admin/expenses/audit-log', { params });

// Détail (+ audit de la dépense)
export const getExpense = (id) => api.get(`/admin/expenses/${id}`);

// Mutations admin
export const cancelExpense = (id, reason) => api.post(`/admin/expenses/${id}/cancel`, { reason });
export const acknowledgeExpense = (id) => api.post(`/admin/expenses/${id}/acknowledge`);
