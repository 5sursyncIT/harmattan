import api from './dolibarr';

// Liste paginée + filtres (status, unpaid, socid, search, date_from, date_to, source, type, page, limit)
export const listInvoices = (params = {}) => api.get('/admin/invoices', { params });

// Rapport jour/mois — factures + paiements détaillés par méthode (max 5 000 lignes)
export const getInvoicesReport = (params = {}) => api.get('/admin/invoices/report', { params });

// Détail facture + lignes + paiements + audit local
export const getInvoice = (id) => api.get(`/admin/invoices/${id}`);

// Audit log global
export const getInvoicesAuditLog = (params = {}) => api.get('/admin/invoices/audit-log', { params });

// Ressources annexes
export const getInvoiceBanks = () => api.get('/admin/invoices/banks');
export const searchInvoiceCustomers = (q) => api.get('/admin/invoices/customers/search', { params: { q } });

// Mutations (toutes exigent un motif)
export const payInvoice = (id, payload) => api.post(`/admin/invoices/${id}/pay`, payload);
export const createCreditNote = (id, reason) => api.post(`/admin/invoices/${id}/credit-note`, { reason });
export const setInvoiceToDraft = (id, reason) => api.post(`/admin/invoices/${id}/settodraft`, { reason });
export const updateInvoiceLines = (id, lines, reason) => api.put(`/admin/invoices/${id}/lines`, { lines, reason });
export const reassignInvoiceCustomer = (id, socid, reason) => api.put(`/admin/invoices/${id}/customer`, { socid, reason });
export const deleteInvoiceDraft = (id, reason) => api.delete(`/admin/invoices/${id}`, { data: { reason } });
