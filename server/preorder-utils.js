const FRENCH_MONTHS = {
  janvier: 0,
  fevrier: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
};

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function endOfDay(date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(value, locale = 'fr-FR') {
  const amount = Number(value) || 0;
  const hasDecimals = Math.round(amount * 100) % 100 !== 0;

  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount)} FCFA`;
}

function getCustomerDisplayName(preorder) {
  return [preorder?.firstname, preorder?.lastname].filter(Boolean).join(' ').trim() || 'client';
}

function resolvePaymentLabel(paymentMethod, paymentMethods = []) {
  const normalizedMethod = String(paymentMethod || '').trim();
  const selectedMethod = paymentMethods.find((method) => String(method?.id || '').trim() === normalizedMethod);
  return selectedMethod?.label || normalizedMethod || 'Non communiqué';
}

function buildEmailShell(title, intro, details, outro) {
  return `
    <p>${title}</p>
    <p>${intro}</p>
    <ul>${details}</ul>
    <p>${outro}</p>
    <p>L’équipe L’Harmattan Sénégal</p>
  `;
}

export function parseReleaseDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const slashMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch.map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const normalized = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const frenchMatch = normalized.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (frenchMatch) {
    const day = Number(frenchMatch[1]);
    const monthIndex = FRENCH_MONTHS[frenchMatch[2]];
    const year = Number(frenchMatch[3]);
    if (monthIndex !== undefined) {
      return new Date(year, monthIndex, day, 12, 0, 0, 0);
    }
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  return null;
}

export function formatReleaseDate(value, locale = 'fr-FR') {
  const parsed = parseReleaseDate(value);
  if (!parsed) return value || 'Date à confirmer';

  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
}

export function isUpcomingRelease(value, now = new Date()) {
  const parsed = parseReleaseDate(value);
  if (!parsed) return false;
  return parsed.getTime() > endOfDay(now).getTime();
}

export function calculatePreorderPricing(originalUnitPrice, discountRate = 0, quantity = 1) {
  const safeOriginal = roundMoney(originalUnitPrice);
  const safeDiscount = Math.min(100, Math.max(0, Number(discountRate) || 0));
  const safeQuantity = Math.max(1, parseInt(quantity, 10) || 1);
  const preorderUnitPrice = roundMoney(safeOriginal * (1 - safeDiscount / 100));

  return {
    originalUnitPrice: safeOriginal,
    preorderUnitPrice,
    discountRate: safeDiscount,
    quantity: safeQuantity,
    totalPrice: roundMoney(preorderUnitPrice * safeQuantity),
  };
}

export function validatePreorderPayload(payload = {}) {
  const errors = {};
  const customer = payload.customer || {};

  if (!payload.product_id || !/^\d+$/.test(String(payload.product_id))) {
    errors.product_id = 'Livre invalide pour la précommande';
  }

  if (!customer.firstname || customer.firstname.trim().length < 2) {
    errors.firstname = 'Le prénom est requis';
  }

  if (!customer.lastname || customer.lastname.trim().length < 2) {
    errors.lastname = 'Le nom est requis';
  }

  if (!customer.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    errors.email = 'Veuillez saisir une adresse email valide';
  }

  if (customer.phone && customer.phone.trim().length < 6) {
    errors.phone = 'Le numéro de téléphone est trop court';
  }

  if (!customer.address || customer.address.trim().length < 6) {
    errors.address = 'L’adresse de livraison est requise';
  }

  if (!customer.city || customer.city.trim().length < 2) {
    errors.city = 'La ville de livraison est requise';
  }

  if (!customer.country || customer.country.trim().length < 2) {
    errors.country = 'Le pays de livraison est requis';
  }

  const quantity = parseInt(payload.quantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    errors.quantity = 'La quantité doit être comprise entre 1 et 10';
  }

  if (!payload.payment_method) {
    errors.payment_method = 'Veuillez choisir un moyen de paiement';
  }

  return errors;
}

export function resolvePreorderPayment(paymentMethod, availablePaymentMethods = [], options = {}) {
  const normalizedMethod = String(paymentMethod || '').trim();
  if (!normalizedMethod) {
    return {
      ok: false,
      statusCode: 400,
      error: 'Veuillez choisir un moyen de paiement pour la précommande.',
    };
  }

  const selectedMethod = availablePaymentMethods.find((method) => method.id === normalizedMethod && method.enabled);
  if (!selectedMethod) {
    return {
      ok: false,
      statusCode: 402,
      error: 'Le mode de paiement sélectionné n’est pas disponible pour cette précommande.',
    };
  }

  if (options.forceFailure) {
    return {
      ok: false,
      statusCode: 402,
      error: 'Le paiement de la précommande a échoué. Veuillez réessayer ou choisir un autre moyen de paiement.',
    };
  }

  return {
    ok: true,
    paymentStatus: 'pending',
    preorderStatus: 'preorder',
  };
}

export function buildReleasedStatus(preorder, now = new Date()) {
  if (!preorder?.status) return null;
  if (preorder.status !== 'preorder') return preorder.status;

  const releaseDate = parseReleaseDate(preorder.estimated_release_date);
  if (!releaseDate) return preorder.status;

  return releaseDate.getTime() <= endOfDay(now).getTime() ? 'available' : preorder.status;
}

export function buildCancellationUpdate(preorder, reason = '', now = new Date()) {
  if (!preorder) {
    return {
      ok: false,
      statusCode: 404,
      error: 'Précommande introuvable',
    };
  }

  if (preorder.status === 'cancelled') {
    return {
      ok: false,
      statusCode: 409,
      error: 'Cette précommande est déjà annulée',
    };
  }

  if (preorder.status === 'available') {
    return {
      ok: false,
      statusCode: 409,
      error: 'Cette précommande ne peut plus être annulée car le livre est déjà disponible',
    };
  }

  return {
    ok: true,
    status: 'cancelled',
    cancelReason: String(reason || '').trim().slice(0, 500),
    cancelledAt: now.toISOString(),
  };
}

export function buildPreorderConfirmationEmail(preorder, paymentMethods = [], options = {}) {
  const locale = options.locale || 'fr-FR';
  const estimatedDate = formatReleaseDate(preorder?.estimated_release_date, locale);
  const paymentLabel = resolvePaymentLabel(preorder?.payment_method, paymentMethods);
  const customerName = escapeHtml(getCustomerDisplayName(preorder));
  const subject = `Confirmation de précommande ${preorder?.preorder_ref || ''}`.trim();
  const details = [
    `<li><strong>Référence :</strong> ${escapeHtml(preorder?.preorder_ref || '')}</li>`,
    `<li><strong>Livre :</strong> ${escapeHtml(preorder?.product_label || '')}</li>`,
    `<li><strong>Quantité :</strong> ${escapeHtml(String(preorder?.quantity || 1))}</li>`,
    `<li><strong>Montant :</strong> ${escapeHtml(formatMoney(preorder?.total_price_ttc, locale))}</li>`,
    `<li><strong>Mode de paiement :</strong> ${escapeHtml(paymentLabel)}</li>`,
    `<li><strong>Disponibilité estimée :</strong> ${escapeHtml(estimatedDate)}</li>`,
    `<li><strong>Adresse de livraison :</strong> ${escapeHtml([preorder?.address, preorder?.city, preorder?.country].filter(Boolean).join(', '))}</li>`,
  ].join('');

  return {
    subject,
    html: buildEmailShell(
      `Bonjour ${customerName},`,
      'Votre précommande a bien été enregistrée.',
      details,
      'Nous vous recontacterons dès que l’ouvrage sera officiellement disponible.'
    ),
  };
}

export function buildPreorderCancellationEmail(preorder, paymentMethods = [], options = {}) {
  const locale = options.locale || 'fr-FR';
  const paymentLabel = resolvePaymentLabel(preorder?.payment_method, paymentMethods);
  const customerName = escapeHtml(getCustomerDisplayName(preorder));
  const subject = `Annulation de la précommande ${preorder?.preorder_ref || ''}`.trim();
  const details = [
    `<li><strong>Référence :</strong> ${escapeHtml(preorder?.preorder_ref || '')}</li>`,
    `<li><strong>Livre :</strong> ${escapeHtml(preorder?.product_label || '')}</li>`,
    `<li><strong>Montant estimé :</strong> ${escapeHtml(formatMoney(preorder?.total_price_ttc, locale))}</li>`,
    `<li><strong>Mode de paiement :</strong> ${escapeHtml(paymentLabel)}</li>`,
    preorder?.cancel_reason ? `<li><strong>Motif :</strong> ${escapeHtml(preorder.cancel_reason)}</li>` : '',
  ].join('');

  return {
    subject,
    html: buildEmailShell(
      `Bonjour ${customerName},`,
      'Votre demande d’annulation de précommande a bien été prise en compte.',
      details,
      'Si vous souhaitez réserver un autre titre, vous pouvez revenir sur notre catalogue à tout moment.'
    ),
  };
}

export function buildPreorderReleaseEmail(preorder, paymentMethods = [], options = {}) {
  const locale = options.locale || 'fr-FR';
  const paymentLabel = resolvePaymentLabel(preorder?.payment_method, paymentMethods);
  const customerName = escapeHtml(getCustomerDisplayName(preorder));
  const releaseDate = formatReleaseDate(preorder?.estimated_release_date, locale);
  const subject = `Votre livre précommandé est disponible : ${preorder?.product_label || ''}`.trim();
  const details = [
    `<li><strong>Référence :</strong> ${escapeHtml(preorder?.preorder_ref || '')}</li>`,
    `<li><strong>Livre :</strong> ${escapeHtml(preorder?.product_label || '')}</li>`,
    `<li><strong>Date de disponibilité :</strong> ${escapeHtml(releaseDate)}</li>`,
    `<li><strong>Montant estimé :</strong> ${escapeHtml(formatMoney(preorder?.total_price_ttc, locale))}</li>`,
    `<li><strong>Mode de paiement :</strong> ${escapeHtml(paymentLabel)}</li>`,
  ].join('');

  return {
    subject,
    html: buildEmailShell(
      `Bonjour ${customerName},`,
      'Bonne nouvelle : votre livre précommandé est désormais disponible.',
      details,
      'Notre équipe vous contactera pour finaliser la suite de votre commande et la livraison.'
    ),
  };
}
