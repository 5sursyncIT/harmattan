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
export const createRoyaltySupplierInvoices = (data = {}) => api.post('/admin/accounting/royalties/supplier-invoices', data);

// Plan comptable
export const getChartOfAccounts = (params = {}) => api.get('/admin/accounting/chart-of-accounts', { params });

// Transfert en comptabilité
export const getTransferStatus = () => api.get('/admin/accounting/transfer/status');
export const runTransfer = (data = {}) => api.post('/admin/accounting/transfer', data);
// Exercices fiscaux (verrouillage natif par clôture d'exercice)
export const getFiscalYears = () => api.get('/admin/accounting/fiscal-years');
export const createFiscalYear = (data) => api.post('/admin/accounting/fiscal-years', data);
export const closeFiscalYear = (id) => api.post(`/admin/accounting/fiscal-years/${id}/close`);

// Grand livre
export const getLedger = (params = {}) => api.get('/admin/accounting/ledger', { params });

// Balance générale
export const getBalance = (params = {}) => api.get('/admin/accounting/balance', { params });

// États financiers
export const getIncomeStatement = (params = {}) => api.get('/admin/accounting/income-statement', { params });
export const getBalanceSheet = (params = {}) => api.get('/admin/accounting/balance-sheet', { params });

// Écritures manuelles (journal OD)
export const getEntries = (params = {}) => api.get('/admin/accounting/entries', { params });
export const createEntry = (data) => api.post('/admin/accounting/entries', data);
export const deleteEntry = (piece) => api.delete(`/admin/accounting/entries/${piece}`);

// Factures fournisseurs
export const getSuppliers = () => api.get('/admin/accounting/suppliers');
export const getSupplierInvoices = (params = {}) => api.get('/admin/accounting/supplier-invoices', { params });
export const createSupplierInvoice = (data) => api.post('/admin/accounting/supplier-invoices', data);

// Déclaration TVA
export const getVatReport = (params = {}) => api.get('/admin/accounting/vat-report', { params });

// Exports CSV / FEC
export const exportAccounting = (journal, params = {}) =>
  api.get(`/admin/accounting/export/${journal}`, { params, responseType: 'blob' });
