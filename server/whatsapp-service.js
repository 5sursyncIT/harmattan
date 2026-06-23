/**
 * Service de notifications WhatsApp.
 *
 * STUB Phase 1 : tant que les credentials Meta Cloud API ne sont pas définis,
 * toutes les fonctions sont no-op (log info uniquement). Cela permet de
 * pré-câbler les call-sites maintenant et activer la Phase 2 simplement en
 * remplissant les variables .env, sans toucher au reste du code.
 *
 * Variables attendues (Phase 2) :
 *   WHATSAPP_API_TOKEN          - token Bearer Meta Cloud API
 *   WHATSAPP_PHONE_NUMBER_ID    - ID du numéro émetteur
 *   WHATSAPP_BUSINESS_ACCOUNT_ID
 *   WHATSAPP_WEBHOOK_SECRET     - pour valider les webhooks entrants
 */

import 'dotenv/config';
import axios from 'axios';

const TOKEN = process.env.WHATSAPP_API_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

export function isWhatsAppEnabled() {
  return Boolean(TOKEN && PHONE_ID);
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  // Hypothèse : si moins de 11 chiffres, c'est un numéro local sénégalais
  if (digits.length === 9) return `221${digits}`; // 77XXXXXXX → 22177XXXXXXX
  return digits;
}

async function sendTemplate({ to, templateName, languageCode = 'fr', components = [] }) {
  if (!isWhatsAppEnabled()) {
    console.info(`[WHATSAPP] no-op (no token configured) — would send template "${templateName}" to ${to}`);
    return { ok: false, skipped: true };
  }
  const recipient = normalizePhone(to);
  if (!recipient) {
    console.warn('[WHATSAPP] sendTemplate : numéro destinataire invalide');
    return { ok: false, error: 'invalid_phone' };
  }

  try {
    const url = `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`;
    const res = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    }, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    return { ok: true, message_id: res.data?.messages?.[0]?.id };
  } catch (err) {
    console.error('[WHATSAPP] sendTemplate failed:', err.response?.data || err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Envoie un message de confirmation de commande au client.
 * Best-effort : un échec ne fait jamais planter le flow métier.
 *
 * @param {Object} params
 * @param {string} params.phone - numéro client (E.164 ou local)
 * @param {string} params.firstname
 * @param {string} params.orderRef
 * @param {string} [params.trackingUrl]
 */
export async function sendOrderConfirmation({ phone, firstname, orderRef, trackingUrl }) {
  return sendTemplate({
    to: phone,
    templateName: 'order_confirmation',
    components: [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: firstname || 'Cher client' },
          { type: 'text', text: orderRef || '' },
        ],
      },
      ...(trackingUrl ? [{
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: trackingUrl }],
      }] : []),
    ],
  });
}

export async function sendShippingUpdate({ phone, firstname, orderRef, statusLabel }) {
  return sendTemplate({
    to: phone,
    templateName: 'shipping_update',
    components: [{
      type: 'body',
      parameters: [
        { type: 'text', text: firstname || '' },
        { type: 'text', text: orderRef || '' },
        { type: 'text', text: statusLabel || '' },
      ],
    }],
  });
}

// Libellés FR des événements de commande spéciale (passés au template).
const SPECIAL_ORDER_EVENT_LABELS = {
  order_confirmation: 'enregistrée',
  validated: 'validée',
  in_processing: "en cours d'acquisition",
  available: 'disponible — à retirer en librairie',
  balance_reminder: 'solde à régler',
  pickup_confirmation: 'retirée — merci !',
  cancelled: 'annulée',
};

/**
 * Notifie le client d'une mise à jour de sa commande spéciale.
 * Best-effort : renvoie { ok, skipped?, error? } (no-op tant que non configuré).
 *
 * @param {Object} params
 * @param {string} params.phone
 * @param {string} [params.firstname]
 * @param {string} params.event
 * @param {string} params.orderRef
 */
export async function sendSpecialOrderUpdate({ phone, firstname, event, orderRef }) {
  const statusLabel = SPECIAL_ORDER_EVENT_LABELS[event] || 'mise à jour';
  return sendTemplate({
    to: phone,
    templateName: 'special_order_update',
    components: [{
      type: 'body',
      parameters: [
        { type: 'text', text: firstname || 'cher client' },
        { type: 'text', text: orderRef || '' },
        { type: 'text', text: statusLabel },
      ],
    }],
  });
}
