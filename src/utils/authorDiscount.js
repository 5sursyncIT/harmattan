// Remise auteur saisie à la main (cf. server/author-discount.js) : quand le
// client facturé est un auteur, l'agent doit taper le taux (0–100 %).

export const AUTHOR_DISCOUNT_REQUIRED = 'AUTHOR_DISCOUNT_REQUIRED';

/** Taux saisi → nombre dans [0, 100], ou null si vide / invalide (vide ≠ 0). */
export function parseAuthorDiscount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** Vrai si l'erreur axios est le refus « remise auteur à saisir ». */
export function isAuthorDiscountRequired(err) {
  return err?.response?.status === 409 && err.response.data?.code === AUTHOR_DISCOUNT_REQUIRED;
}

/** Montant net d'une ligne (XOF, arrondi au franc). */
export function netLine(unitPrice, qty, pct) {
  return Math.round((Number(unitPrice) || 0) * (Number(qty) || 0) * (1 - (Number(pct) || 0) / 100));
}
