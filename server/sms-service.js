/**
 * Service de notifications SMS.
 *
 * STUB Phase 1 : tant qu'aucun fournisseur SMS n'est configuré, toutes les
 * fonctions sont no-op (log info uniquement). Cela permet de pré-câbler les
 * call-sites (commandes spéciales, etc.) dès maintenant et d'activer un vrai
 * envoi plus tard simplement en remplissant les variables .env + en branchant
 * l'appel HTTP du fournisseur retenu, sans toucher au reste du code.
 *
 * Variables attendues (Phase 2 — selon le fournisseur sénégalais retenu :
 * Orange SMS API, Twilio, Vonage, etc.) :
 *   SMS_PROVIDER       - identifiant du fournisseur ('orange' | 'twilio' | ...)
 *   SMS_API_URL        - endpoint d'envoi
 *   SMS_API_TOKEN      - jeton d'authentification
 *   SMS_SENDER         - nom/numéro émetteur (sender ID)
 */

import 'dotenv/config';

const PROVIDER = process.env.SMS_PROVIDER;
const API_URL = process.env.SMS_API_URL;
const API_TOKEN = process.env.SMS_API_TOKEN;
const SENDER = process.env.SMS_SENDER || "L'Harmattan";

export function isSmsEnabled() {
  return Boolean(PROVIDER && API_URL && API_TOKEN);
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9) return `221${digits}`; // 77XXXXXXX → 22177XXXXXXX (Sénégal)
  return digits;
}

// Gabarits texte courts par événement de commande spéciale.
function buildText({ event, order }) {
  const ref = order?.ref || '';
  const balance = order?.balance > 0 ? ` Solde à régler : ${(order.balance).toLocaleString('fr-FR')} FCFA.` : '';
  switch (event) {
    case 'order_confirmation': return `L'Harmattan Senegal : votre commande speciale ${ref} est enregistree. Nous vous tiendrons informe.${balance}`;
    case 'validated':          return `L'Harmattan Senegal : votre commande ${ref} est validee et en cours d'approvisionnement.${balance}`;
    case 'in_processing':      return `L'Harmattan Senegal : votre commande ${ref} est en cours d'acquisition.`;
    case 'available':          return `L'Harmattan Senegal : votre commande ${ref} est disponible ! Venez la retirer a la librairie.${balance}`;
    case 'balance_reminder':   return `L'Harmattan Senegal : rappel, un solde reste a regler pour votre commande ${ref}.${balance}`;
    case 'pickup_confirmation':return `L'Harmattan Senegal : votre commande ${ref} a bien ete retiree. Merci !`;
    case 'cancelled':          return `L'Harmattan Senegal : votre commande ${ref} a ete annulee. Contactez-nous pour toute question.`;
    default:                   return `L'Harmattan Senegal : mise a jour de votre commande ${ref}.`;
  }
}

/**
 * Envoie un SMS lié à une commande spéciale.
 * Best-effort : ne throw jamais ; renvoie { ok, skipped?, error? }.
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} params.event
 * @param {Object} params.order
 */
export async function sendSpecialOrderSms({ phone, event, order }) {
  const recipient = normalizePhone(phone);
  const text = buildText({ event, order });
  if (!isSmsEnabled()) {
    console.info(`[SMS] no-op (non configuré) — destinataire ${recipient || '?'} : ${text}`);
    return { ok: false, skipped: true };
  }
  if (!recipient) {
    return { ok: false, error: 'invalid_phone' };
  }
  // Phase 2 : brancher ici l'appel HTTP réel du fournisseur retenu.
  // Exemple (à adapter) :
  //   await axios.post(API_URL, { from: SENDER, to: recipient, text },
  //     { headers: { Authorization: `Bearer ${API_TOKEN}` }, timeout: 10000 });
  try {
    console.warn('[SMS] provider configuré mais envoi non implémenté (Phase 2) — message non parti');
    return { ok: false, skipped: true, error: 'provider_not_implemented' };
  } catch (err) {
    console.error('[SMS] sendSpecialOrderSms failed:', err.message);
    return { ok: false, error: err.message };
  }
}
