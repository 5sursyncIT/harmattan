import api from './dolibarr';

// Devis (propositions commerciales Dolibarr)
export const listPropals = (params = {}) => api.get('/admin/propals', { params });
export const getPropal = (id) => api.get(`/admin/propals/${id}`);

// Création d'un devis (brouillon Dolibarr) + recherches pour le formulaire
export const createPropal = (data) => api.post('/admin/propals', data);

// Valider un devis et le transformer en facture (facture validée / impayée).
export const invoicePropal = (id) => api.post(`/admin/propals/${id}/invoice`);
// Refuser / invalider un devis (statut « Non signé »).
export const refusePropal = (id, reason) => api.post(`/admin/propals/${id}/refuse`, { reason });
export const searchPropalClients = (q) => api.get('/admin/propals/clients/search', { params: { q } });
export const searchPropalProducts = (q) => api.get('/admin/propals/products/search', { params: { q } });

// PDF servi par l'endpoint existant (document-builddoc type='propal').
export const openPropalPdf = (id) => window.open(`/api/admin/propals/${id}/pdf`, '_blank', 'noopener');

// Proformas POS (devis de caisse stockés en SQLite).
export const listPosQuotes = (params = {}) => api.get('/admin/propals/pos-quotes', { params });
export const getPosQuote = (ref) => api.get(`/admin/propals/pos-quotes/${encodeURIComponent(ref)}`);
export const deletePosQuote = (ref) => api.delete(`/admin/propals/pos-quotes/${encodeURIComponent(ref)}`);
// Transformer une proforma POS en facture / la refuser.
export const invoicePosQuote = (ref, socid) => api.post(`/admin/propals/pos-quotes/${encodeURIComponent(ref)}/invoice`, socid ? { socid } : {});
export const refusePosQuote = (ref) => api.post(`/admin/propals/pos-quotes/${encodeURIComponent(ref)}/refuse`, {});
