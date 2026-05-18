import api from './dolibarr';

/**
 * Initialise un checkout PayTech pour une commande existante.
 * Retourne { redirect_url, token } — le frontend doit faire window.location = redirect_url.
 */
export const initPaytechCheckout = (orderId) =>
  api.post('/payments/paytech/init', { order_id: orderId });

/**
 * Récupère le statut courant d'une commande (polling après retour PayTech).
 * Retourne { payment_status, external_status, invoice_ref, ... }
 */
export const getOrderPaymentStatus = (orderId) =>
  api.get(`/payments/status/${orderId}`);
