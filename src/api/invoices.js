import api from './dolibarr';

// Liste paginée + filtres (status, unpaid, socid, search, date_from, date_to, source, type, page, limit)
export const listInvoices = (params = {}) => api.get('/admin/invoices', { params });

// Rapport jour/mois — factures + paiements détaillés par méthode (max 5 000 lignes)
export const getInvoicesReport = (params = {}) => api.get('/admin/invoices/report', { params });

// Détail facture + lignes + paiements + audit local
export const getInvoice = (id) => api.get(`/admin/invoices/${id}`);

// PDF de la facture (Dolibarr) — renvoyé en blob pour téléchargement
export const getInvoicePdf = (id) => api.get(`/admin/invoices/${id}/pdf`, { responseType: 'blob' });

// Audit log global
export const getInvoicesAuditLog = (params = {}) => api.get('/admin/invoices/audit-log', { params });

// Ressources annexes
export const getInvoiceBanks = () => api.get('/admin/invoices/banks');
export const searchInvoiceCustomers = (q) => api.get('/admin/invoices/customers/search', { params: { q } });

// Crédits disponibles d'un client (acomptes/avoirs non encore imputés)
export const getCustomerCredits = (socid) => api.get(`/admin/invoices/customers/${socid}/credits`);

// Mutations (toutes exigent un motif)
// payInvoice accepte { reason, bank_account, date, splits:[{method, amount, num_payment}] }
// (rétro-compat { reason, method, amount, bank_account, num_payment }).
export const payInvoice = (id, payload) => api.post(`/admin/invoices/${id}/pay`, payload);

// Corriger le moyen de paiement d'un règlement déjà enregistré (ex. saisi « Wave »
// au lieu d'« espèces »). Déplace aussi la ligne de trésorerie vers le bon compte.
// payload : { reason, method, bank_account, num_payment? } — admins seuls.
export const correctPaymentMethod = (invoiceId, paymentId, payload) =>
  api.post(`/admin/invoices/${invoiceId}/payments/${paymentId}/correct-method`, payload);

// Acompte : créer (+ encaisser) une facture d'acompte type=3 convertie en avoir disponible
export const createDeposit = (payload) => api.post('/admin/invoices/deposit', payload);

// Imputer un acompte/avoir disponible sur une facture finale
export const applyCredit = (id, discountid, reason) => api.post(`/admin/invoices/${id}/apply-credit`, { discountid, reason });
export const createCreditNote = (id, reason) => api.post(`/admin/invoices/${id}/credit-note`, { reason });
export const setInvoiceToDraft = (id, reason) => api.post(`/admin/invoices/${id}/settodraft`, { reason });
export const updateInvoiceLines = (id, lines, reason) => api.put(`/admin/invoices/${id}/lines`, { lines, reason });
export const reassignInvoiceCustomer = (id, socid, reason) => api.put(`/admin/invoices/${id}/customer`, { socid, reason });
// Revalide un brouillon (contrepartie de setInvoiceToDraft) : ressort le stock.
export const validateInvoice = (id, reason) => api.post(`/admin/invoices/${id}/validate`, { reason });
// Révision des montants d'une facture émise impayée, après renégociation avec le
// tiers : dévalidation + réécriture des lignes + réémission en une opération.
export const renegotiateInvoice = (id, lines, reason) => api.post(`/admin/invoices/${id}/renegotiate`, { lines, reason });
export const deleteInvoiceDraft = (id, reason) => api.delete(`/admin/invoices/${id}`, { data: { reason } });

// Neutralise une facture déjà numérotée (validée au moins une fois) : elle ne peut
// plus être supprimée sans trouer la numérotation. L'abandon la sort des créances
// et restitue le stock qu'elle avait sorti.
export const abandonInvoice = (id, reason) => api.post(`/admin/invoices/${id}/abandon`, { reason });
