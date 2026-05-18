/**
 * Routes pour l'agrégateur de paiement PayTech (paytech.sn)
 *
 * Mode : Checkout HOSTED. Le client est redirigé vers paytech.sn, paie,
 * revient sur /commande/succes (ou /commande/echec) et l'IPN webhook
 * confirme côté serveur.
 *
 * Endpoints :
 *   POST /api/payments/paytech/init        — initialisation checkout (auth client + CSRF)
 *   POST /api/webhooks/paytech             — IPN PayTech (validé par SHA256 des credentials)
 *   GET  /api/payments/status/:orderId     — polling client
 */

import { Router } from 'express';
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';

const PAYTECH_API_KEY = process.env.PAYTECH_API_KEY || '';
const PAYTECH_API_SECRET = process.env.PAYTECH_API_SECRET || '';
const PAYTECH_ENV = (process.env.PAYTECH_ENV || 'test').toLowerCase(); // 'test' | 'prod'
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';
const PAYTECH_RETURN_URL = process.env.PAYTECH_RETURN_URL || `${SITE_URL}/commande/succes`;
const PAYTECH_CANCEL_URL = process.env.PAYTECH_CANCEL_URL || `${SITE_URL}/commande/echec`;
const PAYTECH_IPN_URL = process.env.PAYTECH_IPN_URL || `${SITE_URL}/api/webhooks/paytech`;

const PAYTECH_BASE = 'https://paytech.sn/api/payment';

export function isPaytechConfigured() {
  return Boolean(PAYTECH_API_KEY && PAYTECH_API_SECRET);
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

function safeEqualHex(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'hex');
  const bBuf = Buffer.from(String(b || ''), 'hex');
  if (aBuf.length === 0 || aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Vérifie que le webhook IPN provient bien de PayTech.
 * PayTech envoie api_key_sha256 et api_secret_sha256 — on compare aux SHA256
 * de nos credentials locaux.
 *
 * Exporté pour permettre un test unitaire avec credentials injectés.
 */
export function verifyPaytechWebhook(body, opts = {}) {
  const apiKey = opts.apiKey ?? PAYTECH_API_KEY;
  const apiSecret = opts.apiSecret ?? PAYTECH_API_SECRET;
  if (!apiKey || !apiSecret) return false;
  const expectedKey = sha256(apiKey);
  const expectedSecret = sha256(apiSecret);
  return (
    safeEqualHex(body.api_key_sha256, expectedKey) &&
    safeEqualHex(body.api_secret_sha256, expectedSecret)
  );
}

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many webhook requests',
});

/**
 * @param {Object} deps
 * @param {Database} deps.db - better-sqlite3
 * @param {Object} deps.dolibarrApi - axios admin client
 * @param {Function} deps.csrfProtection
 * @param {Function} deps.requireCustomerAuth
 * @param {Object} deps.cache
 * @param {Object} deps.transporter - nodemailer
 * @param {Function} deps.getAdminEmails - retourne string[] depuis site-config
 * @param {Object} deps.whatsapp - { sendOrderConfirmation }
 */
export function createPaytechRouter({
  db,
  dolibarrApi,
  csrfProtection,
  requireCustomerAuth,
  cache,
  transporter,
  getAdminEmails,
  emailService, // { sendOrderConfirmationToCustomer, sendNewOrderNotificationToAdmin }
  whatsapp,     // { sendOrderConfirmation }
}) {
  const router = Router();

  // ════════════════════════════════════════════════════════════
  // POST /api/payments/paytech/init
  // ════════════════════════════════════════════════════════════
  router.post('/payments/paytech/init', csrfProtection, async (req, res) => {
    try {
      if (!isPaytechConfigured()) {
        return res.status(503).json({
          error: 'PayTech non configuré sur ce serveur (PAYTECH_API_KEY/SECRET manquants)',
        });
      }

      const { order_id } = req.body || {};
      if (!order_id) return res.status(400).json({ error: 'order_id requis' });

      const op = db.prepare('SELECT * FROM order_payments WHERE dolibarr_order_id = ? LIMIT 1').get(String(order_id));
      if (!op) return res.status(404).json({ error: 'Commande introuvable' });

      // Si déjà confirmé, ne pas re-initier
      if (op.payment_status === 'confirmed') {
        return res.status(409).json({ error: 'Commande déjà payée', payment_status: 'confirmed' });
      }

      const total = parseFloat(op.amount_expected || 0);
      if (total <= 0) return res.status(400).json({ error: 'Montant invalide' });

      const refCommand = op.order_ref || `SO-${order_id}`;
      const itemName = `Commande ${refCommand}`;

      const payload = {
        item_name: itemName,
        item_price: Math.round(total),     // PayTech : entier en XOF
        currency: 'XOF',
        ref_command: refCommand,
        command_name: itemName,
        env: PAYTECH_ENV,
        ipn_url: PAYTECH_IPN_URL,
        success_url: `${PAYTECH_RETURN_URL}?ref=${encodeURIComponent(refCommand)}`,
        cancel_url: `${PAYTECH_CANCEL_URL}?ref=${encodeURIComponent(refCommand)}`,
        custom_field: JSON.stringify({ order_id: String(order_id), order_ref: refCommand }),
      };

      let ptRes;
      try {
        ptRes = await axios.post(`${PAYTECH_BASE}/request-payment`, payload, {
          headers: {
            API_KEY: PAYTECH_API_KEY,
            API_SECRET: PAYTECH_API_SECRET,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        });
      } catch (err) {
        console.error('[PAYTECH] init request failed:', err.response?.data || err.message);
        return res.status(502).json({ error: 'Service de paiement indisponible' });
      }

      const data = ptRes.data || {};
      if (data.success !== 1 || !data.redirect_url) {
        console.error('[PAYTECH] init unexpected response:', data);
        return res.status(502).json({ error: 'Réponse inattendue du service de paiement' });
      }

      // Persister le token PayTech
      db.prepare(
        `UPDATE order_payments
         SET external_transaction_id = ?, external_provider = 'paytech', external_status = 'pending'
         WHERE dolibarr_order_id = ?`
      ).run(data.token || '', String(order_id));

      res.json({
        success: true,
        redirect_url: data.redirect_url,
        token: data.token,
      });
    } catch (err) {
      console.error('[PAYTECH] init error:', err.message);
      res.status(500).json({ error: 'Erreur init paiement' });
    }
  });

  // ════════════════════════════════════════════════════════════
  // POST /api/webhooks/paytech (IPN)
  // ════════════════════════════════════════════════════════════
  // PayTech envoie en application/x-www-form-urlencoded
  router.post(
    '/webhooks/paytech',
    webhookLimiter,
    express.urlencoded({ extended: true }),
    express.json(),
    async (req, res) => {
      const body = req.body || {};
      try {
        if (!verifyPaytechWebhook(body)) {
          console.warn('[PAYTECH-IPN] signature invalide ou config manquante');
          return res.status(401).json({ error: 'Invalid signature' });
        }

        const eventType = String(body.type_event || '').toLowerCase();
        const refCommand = String(body.ref_command || '');
        const token = String(body.token || '');
        const paymentMethod = String(body.payment_method || '');
        const clientPhone = String(body.client_phone || '');
        let customField = {};
        try { customField = body.custom_field ? JSON.parse(body.custom_field) : {}; } catch { /* ignore */ }
        const orderId = customField.order_id || null;

        if (!refCommand && !orderId) {
          return res.status(400).json({ error: 'Référence commande manquante' });
        }

        // Lookup en SQLite
        const op = orderId
          ? db.prepare('SELECT * FROM order_payments WHERE dolibarr_order_id = ? LIMIT 1').get(String(orderId))
          : db.prepare('SELECT * FROM order_payments WHERE order_ref = ? LIMIT 1').get(refCommand);

        if (!op) {
          console.warn(`[PAYTECH-IPN] commande introuvable : ref=${refCommand} order_id=${orderId}`);
          return res.status(404).json({ error: 'Commande introuvable' });
        }

        // ── Idempotence : si déjà confirmé sur ce token, on retourne 200
        if (op.payment_status === 'confirmed' && op.external_transaction_id === token) {
          console.info(`[PAYTECH-IPN] déjà confirmé (idempotent), order=${op.dolibarr_order_id}`);
          return res.json({ ok: true, idempotent: true });
        }

        // ── Sale canceled / failed ──
        if (eventType === 'sale_canceled' || eventType === 'sale_failed') {
          db.prepare(
            `UPDATE order_payments
             SET external_status = ?, external_payload = ?
             WHERE id = ?`
          ).run(eventType, JSON.stringify(body), op.id);
          return res.json({ ok: true, status: eventType });
        }

        // ── Sale complete : create facture + emails ──
        if (eventType !== 'sale_complete') {
          console.warn(`[PAYTECH-IPN] type_event inattendu : ${eventType}`);
          // On accuse réception sans erreur pour ne pas faire retry
          return res.json({ ok: true, ignored: eventType });
        }

        let invoiceRef = null;

        // Création de la facture Dolibarr depuis la commande
        try {
          const invoiceRes = await dolibarrApi.post('/invoices/createfromorder/' + op.dolibarr_order_id);
          const invoiceId = invoiceRes.data;
          // Validate the invoice
          try { await dolibarrApi.post(`/invoices/${invoiceId}/validate`); } catch (e) { console.warn('[PAYTECH-IPN] invoice validate warning:', e.response?.data || e.message); }
          // Récup ref humaine
          try {
            const inv = await dolibarrApi.get(`/invoices/${invoiceId}`);
            invoiceRef = inv.data?.ref || null;
          } catch { /* ignore */ }
        } catch (err) {
          console.error('[PAYTECH-IPN] création facture échouée:', err.response?.data || err.message);
          // On marque malgré tout le paiement comme confirmé pour ne pas relancer le client.
          // Un admin pourra créer la facture manuellement depuis /admin/payments.
        }

        const adminId = null; // confirmé par PayTech, pas par un admin
        db.prepare(
          `UPDATE order_payments
           SET payment_status = 'confirmed',
               external_status = 'success',
               external_payment_id = ?,
               external_transaction_id = ?,
               external_payload = ?,
               invoice_ref = COALESCE(?, invoice_ref),
               confirmed_by = 'paytech',
               confirmed_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        ).run(
          String(body.payment_id || body.transaction_id || ''),
          token || op.external_transaction_id,
          JSON.stringify(body),
          invoiceRef,
          op.id
        );

        // Cache invalidations
        if (cache) {
          for (const k of cache.keys()) {
            if (k.startsWith('customer-orders:') || k.startsWith('customer-invoices:')) cache.del(k);
          }
        }

        // ── Envoi des notifications ──
        // Reconstitue un objet "order" minimal pour les emails
        const orderForMail = {
          ref: op.order_ref,
          total: op.amount_expected,
          items: [], // on n'a pas la liste détaillée localement
          customer: {
            email: op.customer_email,
            firstname: (op.customer_name || '').split(' ')[0],
            lastname: (op.customer_name || '').split(' ').slice(1).join(' '),
            phone: op.customer_phone || clientPhone,
          },
        };

        // Fire-and-forget (best-effort)
        if (emailService?.sendOrderConfirmationToCustomer) {
          emailService.sendOrderConfirmationToCustomer({
            transporter,
            order: orderForMail,
            invoice: invoiceRef ? { ref: invoiceRef } : null,
            siteUrl: SITE_URL,
          });
        }
        if (emailService?.sendNewOrderNotificationToAdmin) {
          const adminEmails = typeof getAdminEmails === 'function' ? getAdminEmails() : [];
          emailService.sendNewOrderNotificationToAdmin({
            transporter,
            order: orderForMail,
            adminEmails,
            siteUrl: SITE_URL,
            paymentInfo: { provider: 'paytech', transaction_id: token, amount: op.amount_expected },
          });
        }
        if (whatsapp?.sendOrderConfirmation) {
          whatsapp.sendOrderConfirmation({
            phone: orderForMail.customer.phone,
            firstname: orderForMail.customer.firstname,
            orderRef: op.order_ref,
            trackingUrl: `${SITE_URL}/compte/commandes`,
          }).catch(() => {});
        }

        res.json({ ok: true, status: 'confirmed', invoice_ref: invoiceRef });
      } catch (err) {
        console.error('[PAYTECH-IPN] error:', err.message);
        // Retourner 500 → PayTech retentera. Préférable pour les erreurs transitoires.
        res.status(500).json({ error: 'Internal error' });
      }
    }
  );

  // ════════════════════════════════════════════════════════════
  // GET /api/payments/status/:orderId — polling client
  // ════════════════════════════════════════════════════════════
  router.get('/payments/status/:orderId', async (req, res) => {
    try {
      const orderId = req.params.orderId;
      const op = db.prepare(
        'SELECT dolibarr_order_id, order_ref, payment_status, external_status, invoice_ref, amount_expected FROM order_payments WHERE dolibarr_order_id = ? OR order_ref = ? LIMIT 1'
      ).get(String(orderId), String(orderId));
      if (!op) return res.status(404).json({ error: 'Commande introuvable' });
      res.json({
        order_id: op.dolibarr_order_id,
        order_ref: op.order_ref,
        payment_status: op.payment_status,
        external_status: op.external_status,
        invoice_ref: op.invoice_ref,
        amount: op.amount_expected,
      });
    } catch (err) {
      console.error('[PAYTECH] status error:', err.message);
      res.status(500).json({ error: 'Erreur récupération statut' });
    }
  });

  return router;
}
