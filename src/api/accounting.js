import api from './dolibarr';

// Dashboard
export const getAccountingDashboard = () => api.get('/admin/accounting/dashboard');

// Journaux
export const getSalesJournal = (params = {}) => api.get('/admin/accounting/sales-journal', { params });
export const getPaymentsJournal = (params = {}) => api.get('/admin/accounting/payments-journal', { params });

// Balance âgée
export const getReceivables = (params = {}) => api.get('/admin/accounting/receivables', { params });

// Trésorerie
export const getTreasury = (params = {}) => api.get('/admin/accounting/treasury', { params });

// Royalties
export const getRoyalties = (params = {}) => api.get('/admin/accounting/royalties', { params });
export const getRoyaltyDetails = (contractId, params = {}) => api.get(`/admin/accounting/royalties/${contractId}/details`, { params });

// Exports CSV
export const exportAccounting = (journal, params = {}) =>
  api.get(`/admin/accounting/export/${journal}`, { params, responseType: 'blob' });
