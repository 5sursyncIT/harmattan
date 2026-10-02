/**
 * Remise auteur — saisie manuelle par l'agent.
 *
 * Un tiers Dolibarr « de profil auteur » est un tiers lié à une fiche auteur
 * (SQLite `authors.dolibarr_thirdparty_id`, cf. author-tier.js). Il n'existe
 * pas UN taux de remise auteur : plusieurs niveaux coexistent (contrat,
 * fidélité, négociation…). La règle maison est donc :
 *
 *   dès que le client facturé est un auteur, l'agent DOIT saisir le taux
 *   (0–100 %) avant que la facture / le devis ne soit créé.
 *
 * Le serveur fait foi : un flux qui facture un auteur sans taux saisi répond
 * 409 `AUTHOR_DISCOUNT_REQUIRED` ; l'interface ouvre alors la saisie et
 * renvoie la requête avec `author_discount`. 0 % est accepté s'il est saisi
 * explicitement (l'agent a tranché « pas de remise »).
 */

export const AUTHOR_DISCOUNT_REQUIRED = 'AUTHOR_DISCOUNT_REQUIRED';

/**
 * Fiche auteur liée au tiers, ou null. Plusieurs fiches peuvent partager un
 * tiers (doublons historiques) : on renvoie la première, seul le fait
 * « c'est un auteur » compte ici.
 */
export function findAuthorForTier(db, socid) {
  const id = parseInt(socid, 10);
  if (!db || !id) return null;
  try {
    return db.prepare(
      `SELECT id, firstname, lastname, display_name FROM authors
        WHERE dolibarr_thirdparty_id = ? ORDER BY id ASC LIMIT 1`,
    ).get(id) || null;
  } catch {
    return null; // table absente (tests, base neuve) → pas d'auteur
  }
}

/** Ensemble des ids de tiers liés à un auteur parmi `socids` (pour annoter des listes). */
export function authorTierIds(db, socids) {
  const ids = [...new Set((socids || []).map((s) => parseInt(s, 10)).filter(Boolean))];
  if (!db || ids.length === 0) return new Set();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT dolibarr_thirdparty_id AS id FROM authors
        WHERE dolibarr_thirdparty_id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids);
    return new Set(rows.map((r) => Number(r.id)));
  } catch {
    return new Set();
  }
}

/**
 * Taux saisi → nombre dans [0, 100] (2 décimales max), ou null si absent /
 * invalide. Une chaîne vide n'est PAS 0 : l'agent doit taper une valeur.
 */
export function parseAuthorDiscount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** Corps de la réponse 409 qui déclenche la saisie côté interface. */
export function authorDiscountRequiredBody(author) {
  const name = author
    ? ([author.firstname, author.lastname].filter(Boolean).join(' ').trim() || author.display_name || '')
    : '';
  return {
    error: `Ce client est un auteur${name ? ` (${name})` : ''} : saisissez le taux de remise auteur.`,
    code: AUTHOR_DISCOUNT_REQUIRED,
    author_name: name || null,
  };
}

/** Mention de traçabilité ajoutée à la note privée du document. */
export function authorDiscountNote(pct, by) {
  return `[REMISE AUTEUR] ${pct} % saisie par ${by || 'agent'}`;
}

/** Mention de traçabilité quand le caissier a saisi des prix négociés ligne à ligne. */
export function authorNegotiatedNote(by) {
  return `[REMISE AUTEUR] prix négociés saisis par ${by || 'agent'}`;
}

/** Vrai si la note porte déjà une remise auteur saisie (devis → facture). */
export function noteHasAuthorDiscount(note) {
  return /\[REMISE AUTEUR\]/.test(String(note || ''));
}

/** Prix net d'une ligne après remise, arrondi au franc (XOF sans décimales). */
export function netAmount(unitPrice, qty, pct) {
  return Math.round((Number(unitPrice) || 0) * (Number(qty) || 0) * (1 - (Number(pct) || 0) / 100));
}
