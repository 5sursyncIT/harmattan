import api from './dolibarr';

// Dépôt légal (registre par titre)
export const listLegalDeposits = (params = {}) => api.get('/admin/legal-deposits', { params });
export const getLegalDeposit = (id) => api.get(`/admin/legal-deposits/${id}`);
export const createLegalDeposit = (data) => api.post('/admin/legal-deposits', data);
export const updateLegalDeposit = (id, data) => api.put(`/admin/legal-deposits/${id}`, data);
export const deleteLegalDeposit = (id) => api.delete(`/admin/legal-deposits/${id}`);

// Ressources pour le formulaire
export const getLegalDepositInstitutions = () => api.get('/admin/legal-deposits/institutions');
export const searchLegalDepositBooks = (q) => api.get('/admin/legal-deposits/books/search', { params: { q } });
