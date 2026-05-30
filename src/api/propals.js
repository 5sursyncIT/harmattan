import api from './dolibarr';

// Devis (propositions commerciales Dolibarr)
export const listPropals = (params = {}) => api.get('/admin/propals', { params });
export const getPropal = (id) => api.get(`/admin/propals/${id}`);

// PDF servi par l'endpoint existant (document-builddoc type='propal').
export const openPropalPdf = (id) => window.open(`/api/admin/propals/${id}/pdf`, '_blank', 'noopener');
