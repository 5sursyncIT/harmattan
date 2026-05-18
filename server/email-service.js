/**
 * Service d'envoi d'emails liés aux commandes.
 * Réutilise le transporter Nodemailer initialisé dans server/index.js.
 *
 * Tous les envois sont best-effort (try/catch interne) — un échec n'interrompt
 * jamais le flow métier (création de facture, etc.).
 */

const SITE_NAME = "L'Harmattan Sénégal";

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
 * @param {Object} [deps.paymentInfo] - { provider, transaction_id, amount }
 */
export async function sendNewOrderNotificationToAdmin({ transporter, order, adminEmails, siteUrl, paymentInfo }) {
  if (!transporter) return;
  if (!Array.isArray(adminEmails) || adminEmails.length === 0) {
    console.info('[MAIL] sendNewOrderNotificationToAdmin : aucun destinataire admin configuré');
    return;
  }

  const fullName = [order.customer?.firstname, order.customer?.lastname].filter(Boolean).join(' ').trim() || '—';
  const adminUrl = siteUrl ? `${siteUrl}/admin/payments` : null;

  const body = `
    <p>Une nouvelle commande vient d'être confirmée.</p>
    <table style="width:100%;border-collapse:collapse;margin:12px 0">
      <tr><td style="padding:6px 10px;color:#6b7280">Client</td><td style="padding:6px 10px;font-weight:600">${escapeHtml(fullName)}</td></tr>
      <tr><td style="padding:6px 10px;color:#6b7280">Email</td><td style="padding:6px 10px">${escapeHtml(order.customer?.email || '—')}</td></tr>
      <tr><td style="padding:6px 10px;color:#6b7280">Téléphone</td><td style="padding:6px 10px">${escapeHtml(order.customer?.phone || '—')}</td></tr>
      <tr><td style="padding:6px 10px;color:#6b7280">Référence</td><td style="padding:6px 10px"><strong>${escapeHtml(order.ref || '—')}</strong></td></tr>
      ${paymentInfo?.provider ? `<tr><td style="padding:6px 10px;color:#6b7280">Provider</td><td style="padding:6px 10px">${escapeHtml(paymentInfo.provider)}</td></tr>` : ''}
      ${paymentInfo?.transaction_id ? `<tr><td style="padding:6px 10px;color:#6b7280">Transaction</td><td style="padding:6px 10px;font-family:monospace;font-size:12px">${escapeHtml(paymentInfo.transaction_id)}</td></tr>` : ''}
    </table>
    ${itemsHtml(order.items)}
    <p style="font-size:16px;font-weight:700;color:#111827">Total : ${fmtPrice(order.total)}</p>
  `;

  try {
    await transporter.sendMail({
      from: `"${SITE_NAME} — Notifications" <commandes@senharmattan.com>`,
      to: adminEmails.join(','),
      subject: `Nouvelle commande ${order.ref || ''} — ${fmtPrice(order.total)}`.trim(),
      html: shellHtml({
        title: `Nouvelle commande — ${fmtPrice(order.total)}`,
        body,
        ctaUrl: adminUrl,
        ctaLabel: "Ouvrir l'administration",
      }),
    });
  } catch (err) {
    console.error('[MAIL] sendNewOrderNotificationToAdmin failed:', err.message);
  }
}
