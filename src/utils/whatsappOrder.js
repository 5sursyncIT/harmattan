/**
 * Helpers purs pour construire un message de commande WhatsApp (wa.me).
 * Aucune dépendance React → testable directement par Vitest.
 */

function fmtPrice(n) {
  const v = parseInt(n, 10) || 0;
  return v.toLocaleString('fr-FR') + ' FCFA';
}

/**
 * Génère le texte du message envoyé au shop.
 * @param {Array} items - { label, quantity, price_ttc }
 * @returns {string}
 */
export function buildWhatsAppOrderMessage(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'Bonjour, je souhaite passer une commande.';
  }
  const lines = items.map((it) => {
    const title = (it.label || it.title || 'Article').trim();
    const qty = parseInt(it.quantity || it.qty || 1, 10);
    const lineTotal = (parseInt(it.price_ttc || it.price || 0, 10)) * qty;
    return `• ${title} × ${qty} — ${fmtPrice(lineTotal)}`;
  });
  const total = items.reduce((sum, it) => {
    const qty = parseInt(it.quantity || it.qty || 1, 10);
    const price = parseInt(it.price_ttc || it.price || 0, 10);
    return sum + qty * price;
  }, 0);

  return [
    'Bonjour, je souhaite commander :',
    '',
    ...lines,
    '',
    `Total : ${fmtPrice(total)}`,
    '',
    'Merci !',
  ].join('\n');
}

/**
 * Normalise un numéro de téléphone vers le format wa.me (chiffres uniquement, sans +).
 */
export function normalizeWhatsAppPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  // Si 9 chiffres → on suppose Sénégal (221)
  if (digits.length === 9) return `221${digits}`;
  return digits;
}

/**
 * Construit l'URL wa.me complète.
 */
export function buildWhatsAppOrderUrl(phone, message) {
  const normalized = normalizeWhatsAppPhone(phone);
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}
