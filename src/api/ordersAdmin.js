import api from './dolibarr';

// Gestion des commandes web (admin).
export const listWebOrders = (params = {}) => api.get('/admin/orders', { params });
export const getWebOrder = (id) => api.get(`/admin/orders/${id}`);
