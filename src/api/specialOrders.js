import api from './dolibarr';

// ─── Méta (statuts ordonnés + méthodes de paiement) ─────────────
export const getSpecialOrderMeta = () => api.get('/admin/special-orders/meta');

// ─── Liste + dashboard ──────────────────────────────────────────
export const listSpecialOrders = (params = {}) => api.get('/admin/special-orders', { params });
export const getSpecialOrder = (id) => api.get(`/admin/special-orders/${id}`);

// ─── Cycle de vie ───────────────────────────────────────────────
export const createSpecialOrder = (data) => api.post('/admin/special-orders', data);
export const updateSpecialOrder = (id, data) => api.patch(`/admin/special-orders/${id}`, data);
export const changeSpecialOrderStatus = (id, status, comment) =>
  api.post(`/admin/special-orders/${id}/status`, { status, comment });
export const deleteSpecialOrder = (id) => api.delete(`/admin/special-orders/${id}`);

// ─── Paiements ──────────────────────────────────────────────────
export const addSpecialOrderPayment = (id, data) => api.post(`/admin/special-orders/${id}/payments`, data);
export const deleteSpecialOrderPayment = (id, paymentId) =>
  api.delete(`/admin/special-orders/${id}/payments/${paymentId}`);
// Rejoue l'écriture comptable d'un règlement resté hors du livre (Dolibarr indisponible).
export const accountSpecialOrderPayment = (id, paymentId) =>
  api.post(`/admin/special-orders/${id}/payments/${paymentId}/account`);

// ─── Livraison ──────────────────────────────────────────────────
// Constate la remise du livre au client. `force` est requis s'il reste un solde dû.
export const confirmSpecialOrderDelivery = (id, { force = false, comment } = {}) =>
  api.post(`/admin/special-orders/${id}/deliver`, { force, comment });

// ─── Notifications ──────────────────────────────────────────────
export const notifySpecialOrder = (id, data) => api.post(`/admin/special-orders/${id}/notify`, data);

// Contact manuel : l'équipe a appelé le client (le SMS/WhatsApp n'étant pas branchés,
// c'est cette trace qui vaut notification et éteint l'alerte « Client à prévenir »).
// data : { channel, event, outcome: 'reached' | 'no_answer', note }
export const logSpecialOrderContact = (id, data) => api.post(`/admin/special-orders/${id}/contacts`, data);

// ─── Recherche tiers + produits Dolibarr ────────────────────────
export const searchSpecialOrderCustomers = (q) =>
  api.get('/admin/special-orders/search/customers', { params: { q } });
export const searchSpecialOrderProducts = (q) =>
  api.get('/admin/special-orders/search/products', { params: { q } });

// PDF : ouvre le bon de commande (cookie d'auth envoyé automatiquement).
export const openSpecialOrderPdf = (id) =>
  window.open(`/api/admin/special-orders/${id}/pdf`, '_blank', 'noopener');
