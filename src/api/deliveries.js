import api from './dolibarr';

// Liste / détail
export const listDeliveries = (params = {}) => api.get('/admin/deliveries', { params });
export const getDelivery = (id) => api.get(`/admin/deliveries/${id}`);

// Mutations
export const createDelivery = (data) => api.post('/admin/deliveries', data);
export const validateDelivery = (id) => api.post(`/admin/deliveries/${id}/validate`);
export const deleteDelivery = (id) => api.delete(`/admin/deliveries/${id}`);

// Ressources
export const getDeliveryWarehouses = () => api.get('/admin/deliveries/warehouses');
export const searchDeliveryClients = (q) => api.get('/admin/deliveries/clients/search', { params: { q } });
export const searchDeliveryProducts = (q) => api.get('/admin/deliveries/products/search', { params: { q } });
export const searchDeliveryInvoices = (q) => api.get('/admin/deliveries/invoices/search', { params: { q } });
export const deliveryFromInvoice = (invoiceId) => api.get(`/admin/deliveries/from-invoice/${invoiceId}`);

// PDF : ouvre le document (cookie d'auth envoyé automatiquement).
export const openDeliveryPdf = (id) => window.open(`/api/admin/deliveries/${id}/pdf`, '_blank', 'noopener');
