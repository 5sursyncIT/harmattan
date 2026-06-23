/**
 * Service d'envoi d'emails liés aux commandes.
 * Réutilise le transporter Nodemailer initialisé dans server/index.js.
 *
 * Tous les envois sont best-effort (try/catch interne) — un échec n'interrompt
 * jamais le flow métier (création de facture, etc.).
 */

const SITE_NAME = "L'Harmattan Sénégal";

// Libellés lisibles des moyens de paiement (clés alignées sur getPaymentModeId).
const PAYMENT_LABELS = {
  wave: 'Wave',
  orange_money: 'Orange Money',
  virement: 'Virement bancaire',
  cb: 'Carte bancaire',
  paytech: 'PayTech (en ligne)',
  cash: 'Espèces',
  especes: 'Espèces',
  cod: 'Paiement à la livraison',
};

function fmtPrice(n) {
  const v = parseInt(n, 10) || 0;
  return v.toLocaleString('fr-FR') + ' FCFA';
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function itemsHtml(items = []) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0">
    <thead><tr style="background:#f3f4f6;text-align:left">
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb">Titre</th>
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:center">Qté</th>
      <th style="padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:right">Prix</th>
    </tr></thead>
    <tbody>
      ${items.map((it) => `
        <tr>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6">${escapeHtml(it.label || it.title || '—')}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:center">${parseInt(it.quantity || it.qty || 1)}</td>
          <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${fmtPrice((it.price_ttc || it.price || 0) * (it.quantity || it.qty || 1))}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>`;
}

function shellHtml({ title, body, ctaUrl, ctaLabel }) {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:Lato,Arial,sans-serif;color:#374151;background:#fafafa;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
    <div style="background:#10531a;padding:18px 24px">
      <h1 style="margin:0;color:#fff;font-size:18px;font-weight:800">${escapeHtml(SITE_NAME)}</h1>
    </div>
    <div style="padding:24px">
      <h2 style="margin:0 0 12px;color:#111827;font-size:20px">${escapeHtml(title)}</h2>
      ${body}
      ${ctaUrl ? `<div style="text-align:center;margin:20px 0">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 24px;background:#10531a;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${escapeHtml(ctaLabel || 'Voir ma commande')}</a>
      </div>` : ''}
      <p style="margin-top:24px;font-size:13px;color:#6b7280;border-top:1px solid #f3f4f6;padding-top:16px">
        Une question ? Réponds à ce mail ou contacte-nous via WhatsApp.
      </p>
    </div>
  </div>
</body></html>`;
}

/**
 * Envoie un email de confirmation au client après paiement validé.
 *
 * @param {Object} deps
 * @param {Object} deps.transporter - nodemailer transporter
 * @param {Object} deps.order - { ref, total, items, customer: {email, firstname, lastname} }
 * @param {Object} [deps.invoice] - { ref } (Dolibarr)
 * @param {string} [deps.siteUrl]
 */
export async function sendOrderConfirmationToCustomer({ transporter, order, invoice, siteUrl }) {
  if (!transporter) return;
  const customerEmail = order?.customer?.email;
  if (!customerEmail) {
    console.warn('[MAIL] sendOrderConfirmationToCustomer : email client manquant');
    return;
  }

  const fullName = [order.customer.firstname, order.customer.lastname].filter(Boolean).join(' ').trim() || 'Cher client';
  const trackingUrl = siteUrl ? `${siteUrl}/compte/commandes` : null;

  const body = `
    <p>Bonjour ${escapeHtml(fullName)},</p>
    <p>Merci pour votre commande, votre paiement a bien été reçu.</p>
    ${itemsHtml(order.items)}
    <p style="font-size:16px;font-weight:700;color:#111827">Total payé : ${fmtPrice(order.total)}</p>
    ${order.ref ? `<p style="color:#6b7280">Référence commande : <strong>${escapeHtml(order.ref)}</strong></p>` : ''}
    ${invoice?.ref ? `<p style="color:#6b7280">Référence facture : <strong>${escapeHtml(invoice.ref)}</strong></p>` : ''}
  `;

  try {
    await transporter.sendMail({
      from: `"${SITE_NAME}" <commandes@senharmattan.com>`,
      to: customerEmail,
      subject: `Commande ${order.ref || ''} confirmée — ${SITE_NAME}`.trim(),
      html: shellHtml({
        title: 'Votre commande est confirmée',
        body,
        ctaUrl: trackingUrl,
        ctaLabel: 'Suivre ma commande',
      }),
    });
  } catch (err) {
    console.error('[MAIL] sendOrderConfirmationToCustomer failed:', err.message);
  }
}

/**
 * Notifie l'équipe admin d'une nouvelle commande payée.
 *
 * @param {Object} deps
 * @param {Object} deps.transporter
 * @param {Object} deps.order - structure identique
 * @param {string[]} deps.adminEmails - liste des destinataires (depuis site-config.json)
 * @param {string} [deps.siteUrl]
 * @param {Object} [deps.paymentInfo] - { provider, transaction_id, amount, method }
 * @param {('pending'|'paid')} [deps.status] - 'pending' (commande passée, paiement
 *        à confirmer — ex. Wave/OM/virement) ou 'paid' (paiement déjà confirmé — ex. PayTech).
 */
export async function sendNewOrderNotificationToAdmin({ transporter, order, adminEmails, siteUrl, paymentInfo, status = 'paid' }) {
  if (!transporter) return;
  if (!Array.isArray(adminEmails) || adminEmails.length === 0) {
    console.info('[MAIL] sendNewOrderNotificationToAdmin : aucun destinataire admin configuré');
    return;
  }

  const isPending = status === 'pending';
  const fullName = [order.customer?.firstname, order.customer?.lastname].filter(Boolean).join(' ').trim() || '—';
  // Commande à traiter → /admin/orders ; paiement déjà encaissé → /admin/payments.
  const adminUrl = siteUrl ? `${siteUrl}/admin/${isPending ? 'orders' : 'payments'}` : null;
  const methodLabel = paymentInfo?.method ? (PAYMENT_LABELS[paymentInfo.method] || paymentInfo.method) : null;
  const intro = isPending
    ? "Une nouvelle commande web vient d'être passée. Le paiement est en attente de confirmation."
    : "Une nouvelle commande vient d'être confirmée.";

  const body = `
    <p>${intro}</p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0">
      <tr><td style="padding:6px 10px;color:#6b7280">Client</td><td style="padding:6px 10px;font-weight:600">${escapeHtml(fullName)}</td></tr>
      <tr><td style="padding:6px 10px;color:#6b7280">Email</td><td style="padding:6px 10px">${escapeHtml(order.customer?.email || '—')}</td></tr>
      <tr><td style="padding:6px 10px;color:#6b7280">Téléphone</td><td style="padding:6px 10px">${escapeHtml(order.customer?.phone || '—')}</td></tr>
      <tr><td style="padding:6px 10px;color:#6b7280">Référence</td><td style="padding:6px 10px"><strong>${escapeHtml(order.ref || '—')}</strong></td></tr>
      ${methodLabel ? `<tr><td style="padding:6px 10px;color:#6b7280">Paiement</td><td style="padding:6px 10px">${escapeHtml(methodLabel)}</td></tr>` : ''}
      ${paymentInfo?.provider ? `<tr><td style="padding:6px 10px;color:#6b7280">Provider</td><td style="padding:6px 10px">${escapeHtml(paymentInfo.provider)}</td></tr>` : ''}
      ${paymentInfo?.transaction_id ? `<tr><td style="padding:6px 10px;color:#6b7280">Transaction</td><td style="padding:6px 10px;font-family:monospace;font-size:12px">${escapeHtml(paymentInfo.transaction_id)}</td></tr>` : ''}
    </table>
    ${itemsHtml(order.items)}
    <p style="font-size:16px;font-weight:700;color:#111827">${isPending ? 'Montant à encaisser' : 'Total'} : ${fmtPrice(order.total)}</p>
  `;

  const subject = isPending
    ? `🛒 Nouvelle commande ${order.ref || ''} à confirmer — ${fmtPrice(order.total)}`.trim()
    : `Nouvelle commande ${order.ref || ''} — ${fmtPrice(order.total)}`.trim();

  try {
    await transporter.sendMail({
      from: `"${SITE_NAME} — Notifications" <commandes@senharmattan.com>`,
      to: adminEmails.join(','),
      subject,
      html: shellHtml({
        title: isPending ? `Nouvelle commande à traiter — ${fmtPrice(order.total)}` : `Nouvelle commande — ${fmtPrice(order.total)}`,
        body,
        ctaUrl: adminUrl,
        ctaLabel: isPending ? 'Voir les commandes' : "Ouvrir l'administration",
      }),
    });
  } catch (err) {
    console.error('[MAIL] sendNewOrderNotificationToAdmin failed:', err.message);
  }
}

// ─── Commandes spéciales (livres indisponibles en stock) ─────────────────────
// Coordonnées librairie pour l'invitation au retrait.
const STORE_ADDRESS = '10 VDN, après le pont de Fann (à côté de la Pédiatrie 24), Sicap Karak, Dakar';
const STORE_PHONE = '+221 33 825 98 58';

function fmtDateLong(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Contenu (titre/corps/sujet) par événement du cycle de vie d'une commande spéciale.
function buildSpecialOrderEmail({ order, event, siteUrl }) {
  const greet = `Bonjour ${escapeHtml(order.customer?.firstname || order.customer?.name || 'cher client')},`;
  const balanceBlock = order.balance > 0
    ? `<p style="margin:10px 0;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e">
         Solde restant à régler : <strong>${fmtPrice(order.balance)}</strong>${order.paid > 0 ? ` (déjà réglé : ${fmtPrice(order.paid)} sur ${fmtPrice(order.total)})` : ''}
       </p>`
    : (order.total > 0
      ? `<p style="margin:10px 0;color:#166534"><strong>Commande réglée intégralement.</strong></p>` : '');
  const delay = order.expected_date ? fmtDateLong(order.expected_date) : (order.delay_estimate || '');
  const ref = order.ref ? `<p style="color:#6b7280">Référence : <strong>${escapeHtml(order.ref)}</strong></p>` : '';
  const trackingUrl = siteUrl ? `${siteUrl}/suivi-commande` : null;

  switch (event) {
    case 'order_confirmation':
      return {
        subject: `Commande spéciale ${order.ref || ''} enregistrée — ${SITE_NAME}`.trim(),
        title: 'Votre commande spéciale est enregistrée',
        body: `${greet}
          <p>Nous avons bien enregistré votre demande pour le(s) ouvrage(s) ci-dessous, actuellement indisponible(s) en stock. Nous lançons les démarches pour vous le(s) procurer.</p>
          ${itemsHtml(order.items)}
          <p style="font-size:16px;font-weight:700;color:#111827">Total : ${fmtPrice(order.total)}</p>
          ${balanceBlock}
          ${delay ? `<p style="color:#6b7280">Disponibilité estimée : <strong>${escapeHtml(delay)}</strong></p>` : ''}
          ${ref}
          <p>Nous vous tiendrons informé(e) à chaque étape jusqu'à la mise à disposition de votre commande.</p>`,
        ctaUrl: trackingUrl, ctaLabel: 'Suivre ma commande',
      };
    case 'validated':
      return {
        subject: `Commande spéciale ${order.ref || ''} validée — ${SITE_NAME}`.trim(),
        title: 'Votre commande est validée',
        body: `${greet}
          <p>Votre commande spéciale <strong>${escapeHtml(order.ref || '')}</strong> a été validée et transmise à notre service d'approvisionnement.</p>
          ${delay ? `<p style="color:#6b7280">Disponibilité estimée : <strong>${escapeHtml(delay)}</strong></p>` : ''}
          ${balanceBlock}`,
        ctaUrl: trackingUrl, ctaLabel: 'Suivre ma commande',
      };
    case 'in_processing':
      return {
        subject: `Commande spéciale ${order.ref || ''} en cours de traitement — ${SITE_NAME}`.trim(),
        title: 'Votre livre est en cours d\'acquisition',
        body: `${greet}
          <p>Bonne nouvelle : votre commande spéciale <strong>${escapeHtml(order.ref || '')}</strong> est en cours d'acquisition auprès de notre réseau.</p>
          ${delay ? `<p style="color:#6b7280">Disponibilité estimée : <strong>${escapeHtml(delay)}</strong></p>` : ''}`,
        ctaUrl: trackingUrl, ctaLabel: 'Suivre ma commande',
      };
    case 'available':
      return {
        subject: `📚 Votre commande ${order.ref || ''} est disponible — ${SITE_NAME}`.trim(),
        title: 'Votre livre est disponible !',
        body: `${greet}
          <p>Votre commande spéciale <strong>${escapeHtml(order.ref || '')}</strong> est arrivée et vous attend à notre librairie.</p>
          ${itemsHtml(order.items)}
          ${balanceBlock}
          <p style="margin-top:12px">Vous pouvez venir la retirer à :</p>
          <p style="padding:10px 14px;background:#f0fdf4;border-left:3px solid #10531a;border-radius:6px">
            <strong>${escapeHtml(SITE_NAME)}</strong><br>${escapeHtml(STORE_ADDRESS)}<br>Tél : ${escapeHtml(STORE_PHONE)}
          </p>`,
        ctaUrl: trackingUrl, ctaLabel: 'Suivre ma commande',
      };
    case 'balance_reminder':
      return {
        subject: `Rappel — solde à régler pour la commande ${order.ref || ''}`.trim(),
        title: 'Rappel : solde à régler',
        body: `${greet}
          <p>Nous vous rappelons qu'un solde reste à régler pour votre commande spéciale <strong>${escapeHtml(order.ref || '')}</strong>.</p>
          ${balanceBlock}
          ${ref}
          <p>Vous pouvez régler ce solde directement à la librairie. Merci de votre confiance.</p>`,
        ctaUrl: trackingUrl, ctaLabel: 'Suivre ma commande',
      };
    case 'pickup_confirmation':
      return {
        subject: `Merci ! Commande ${order.ref || ''} retirée — ${SITE_NAME}`.trim(),
        title: 'Votre commande a bien été retirée',
        body: `${greet}
          <p>Nous vous confirmons le retrait de votre commande spéciale <strong>${escapeHtml(order.ref || '')}</strong>. Nous espérons que cet ouvrage vous comblera.</p>
          ${itemsHtml(order.items)}
          <p>Merci d'avoir fait confiance à ${escapeHtml(SITE_NAME)}. À très bientôt !</p>`,
        ctaUrl: null, ctaLabel: null,
      };
    case 'cancelled':
      return {
        subject: `Commande spéciale ${order.ref || ''} annulée — ${SITE_NAME}`.trim(),
        title: 'Votre commande a été annulée',
        body: `${greet}
          <p>Votre commande spéciale <strong>${escapeHtml(order.ref || '')}</strong> a été annulée.</p>
          ${order.paid > 0 ? `<p>Un règlement de <strong>${fmtPrice(order.paid)}</strong> avait été enregistré : notre équipe vous recontactera pour les modalités de remboursement.</p>` : ''}
          <p>Pour toute question, n'hésitez pas à nous contacter.</p>`,
        ctaUrl: null, ctaLabel: null,
      };
    default:
      return null;
  }
}

/**
 * Envoie une notification client liée à une commande spéciale.
 * Renvoie true si l'email est parti, false sinon. Best-effort (ne throw pas).
 *
 * @param {Object} deps
 * @param {Object} deps.transporter
 * @param {Object} deps.order - { ref, customer:{name,firstname,email,phone}, items, total, paid, balance, expected_date, delay_estimate }
 * @param {string} deps.event - order_confirmation | validated | in_processing | available | balance_reminder | pickup_confirmation | cancelled
 * @param {string} [deps.siteUrl]
 */
export async function sendSpecialOrderNotification({ transporter, order, event, siteUrl }) {
  if (!transporter) return false;
  const to = order?.customer?.email;
  if (!to) {
    console.warn('[MAIL] sendSpecialOrderNotification : email client manquant');
    return false;
  }
  const tpl = buildSpecialOrderEmail({ order, event, siteUrl });
  if (!tpl) {
    console.warn('[MAIL] sendSpecialOrderNotification : événement inconnu', event);
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"${SITE_NAME}" <commandes@senharmattan.com>`,
      to,
      subject: tpl.subject,
      html: shellHtml({ title: tpl.title, body: tpl.body, ctaUrl: tpl.ctaUrl, ctaLabel: tpl.ctaLabel }),
    });
    return true;
  } catch (err) {
    console.error('[MAIL] sendSpecialOrderNotification failed:', err.message);
    return false;
  }
}
