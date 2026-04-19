import api from './dolibarr';

// POS-specific API functions
// Uses the same axios instance with CSRF token management

const getTerminal = () => parseInt(localStorage.getItem('pos-terminal') || '1');

export const posLogin = (pin) => api.post('/pos/auth/login', { pin });

export const posLogout = () => api.post('/pos/auth/logout');

export const posSearchProducts = (q, category) =>
  api.get('/pos/products/search', { params: { q, category, limit: 50 } });

export const posLookupBarcode = (code) => api.get(`/pos/products/barcode/${code}`);

export const posGetCategories = () => api.get('/pos/categories');

export const posSearchCustomers = (q) => api.get('/pos/customers/search', { params: { q } });

export const posCreateCustomer = (data) => api.post('/pos/customers', data);

export const posCreateSale = (data) => api.post('/pos/sales', {
  ...data,
  terminal: getTerminal(),
});

export const posGetTodaySales = () => api.get('/pos/sales/today', { params: { terminal: getTerminal() } });

export const posGetConfig = () => api.get('/pos/config', { params: { terminal: getTerminal() } });

export const posOpenSession = (data) => api.post('/pos/session/open', { ...data, terminal: getTerminal() });

export const posCloseSession = (data) => api.post('/pos/session/close', { ...data, terminal: getTerminal() });

export const posGetCurrentSession = () => api.get('/pos/session/current', { params: { terminal: getTerminal() } });

export const posCashInOut = (data) => api.post('/pos/session/cash-in-out', data);

export const posCreateQuote = (data) => api.post('/pos/quotes', {
  ...data,
  terminal: getTerminal(),
});

export const posGetTodayQuotes = () => api.get('/pos/quotes/today');

export const posChangePin = (currentPin, newPin) => api.put('/pos/auth/change-pin', { currentPin, newPin });

export const posLookupInvoice = (ref) => api.get(`/pos/invoices/lookup/${ref}`);

export const posCreateReturn = (data) => api.post('/pos/returns', data);

// Device management
export const posEnrollDevice = (code, device_name) => api.post('/pos/devices/enroll', { code, device_name });
export const posGenerateEnrollCode = (device_name) => api.post('/pos/devices/generate-code', { device_name });
export const posListDevices = () => api.get('/pos/devices');
export const posRevokeDevice = (id) => api.delete(`/pos/devices/${id}`);
