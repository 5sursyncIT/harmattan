/**
 * Caractéristiques de fabrication d'un ouvrage : vocabulaire des formats et
 * normalisation des valeurs comparables entre le CONTRAT et le DEVIS.
 *
 * Deux graphies du format coexistent, et c'est volontaire — chacune est reprise
 * telle quelle dans le document qu'elle sert :
 *   - contrat (extrafield `format_ouvrage`)   → « 15,5 × 24 cm »      (typographie FR du contrat)
 *   - devis   (`contract_quotes.book_format`) → « 15.5 cm sur 24 cm » (phrasé de la fiche de fabrication)
 * Les comparer littéralement signalerait un écart sur TOUS les dossiers. Toute
 * comparaison passe donc par normalizeFormat(), qui ne retient que les dimensions.
 *
 * Module partagé front ↔ serveur (même convention que src/utils/excludedCategories.js).
 */

export const FCFA_PER_EUR = 655.957;

// Remise auteur (%) appliquée à la ligne « achat d'exemplaires » quand le contrat
// ne la renseigne pas. Doit rester alignée avec DEFAULT_AUTHOR_DISCOUNT côté devis.
export const DEFAULT_AUTHOR_DISCOUNT = 30;

// Sentinelle « Autre » des menus déroulants : bascule le champ en saisie libre.
export const FORMAT_CUSTOM = '__custom__';

// Formats proposés sur le CONTRAT. `value` est le texte imprimé dans le PDF du
// contrat : ne jamais le modifier sans régénérer les contrats concernés.
//
// Les trois premiers sont ceux réellement présents en base au 2026-08-07
// (15 × 21 cm : 48 contrats — le plus courant ; 13,5 × 21,5 : 31 ; 15,5 × 24 : 20).
// Les suivants complètent avec les formats d'édition usuels, pour éviter d'avoir
// à passer en saisie libre au moindre ouvrage un peu différent.
export const CONTRACT_FORMAT_OPTIONS = [
  { label: '15 × 21 cm (courant)', value: '15 × 21 cm' },
  { label: '13,5 × 21,5 cm (Harmattan classique)', value: '13,5 × 21,5 cm' },
  { label: '15,5 × 24 cm (grand format)', value: '15,5 × 24 cm' },
  { label: '11 × 18 cm (poche)', value: '11 × 18 cm' },
  { label: '14 × 21 cm (A5)', value: '14 × 21 cm' },
  { label: '16 × 24 cm', value: '16 × 24 cm' },
  { label: '17 × 24 cm', value: '17 × 24 cm' },
  { label: '19 × 26 cm (beau livre)', value: '19 × 26 cm' },
  { label: '21 × 29,7 cm (A4)', value: '21 × 29,7 cm' },
];

// Formats proposés sur le DEVIS : MÊMES dimensions que le contrat, dans la
// graphie de la fiche de fabrication. Les deux listes doivent rester alignées —
// un format présent d'un seul côté produirait un écart de conformité artificiel.
export const QUOTE_FORMAT_OPTIONS = [
  { label: '150 × 210 mm (courant)', value: '15 cm sur 21 cm' },
  { label: '135 × 215 mm (Harmattan classique)', value: '13.5 cm sur 21.5 cm' },
  { label: '155 × 240 mm (grand format)', value: '15.5 cm sur 24 cm' },
  { label: '110 × 180 mm (poche)', value: '11 cm sur 18 cm' },
  { label: '140 × 210 mm (A5)', value: '14 cm sur 21 cm' },
  { label: '160 × 240 mm', value: '16 cm sur 24 cm' },
  { label: '170 × 240 mm', value: '17 cm sur 24 cm' },
  { label: '190 × 260 mm (beau livre)', value: '19 cm sur 26 cm' },
  { label: 'A4 (210 × 297 mm)', value: 'A4 (21 cm sur 29.7 cm)' },
];

// Capture « 15,5 × 24 cm », « 13.5 cm sur 21.5 cm », « 21x29.7 », « 155 mm x 240 mm »…
// L'unité est optionnelle sur chaque dimension (elle n'est souvent portée que par
// la seconde). Le préfixe éventuel — « A4 (…) » — est ignoré : la regex accroche
// la première PAIRE de nombres séparée par ×/x/*/sur, jamais un nombre isolé.
const DIMENSIONS_RE = /(\d+(?:[.,]\d+)?)\s*(mm|cm)?\s*(?:[x×*]|sur)\s*(\d+(?:[.,]\d+)?)\s*(mm|cm)?/i;

/**
 * Réduit un format, quelle que soit sa graphie, à ses deux dimensions en millimètres.
 * Renvoie `null` si la valeur est illisible — l'appelant traite alors le format
 * comme « non comparable » plutôt que d'inventer un écart.
 */
export function normalizeFormat(raw) {
  if (raw === null || raw === undefined) return null;
  const match = String(raw).match(DIMENSIONS_RE);
  if (!match) return null;

  const [, aValue, aUnit, bValue, bUnit] = match;
  // Unité implicite : « 15,5 × 24 cm » ne porte l'unité que sur la 2ᵉ dimension.
  const toMm = (value, ownUnit, otherUnit) => {
    const n = parseFloat(String(value).replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return NaN;
    const unit = (ownUnit || otherUnit || 'cm').toLowerCase();
    return Math.round(unit === 'mm' ? n : n * 10);
  };

  const dims = [toMm(aValue, aUnit, bUnit), toMm(bValue, bUnit, aUnit)];
  if (dims.some(d => !Number.isFinite(d) || d <= 0)) return null;

  // L'ordre largeur/hauteur n'identifie pas le format : « 15,5 × 24 » = « 24 × 15,5 ».
  dims.sort((x, y) => x - y);
  return { widthMm: dims[0], heightMm: dims[1], key: `${dims[0]}x${dims[1]}` };
}

/**
 * Compare deux formats sur leurs dimensions seules.
 * → true / false, ou `null` si l'un des deux est illisible (non comparable).
 */
export function formatsMatch(a, b) {
  const na = normalizeFormat(a);
  const nb = normalizeFormat(b);
  if (!na || !nb) return null;
  return na.key === nb.key;
}

/** Libellé neutre « 155 × 240 mm » pour afficher un écart sans favoriser une graphie. */
export function formatLabel(raw) {
  const n = normalizeFormat(raw);
  if (!n) return raw ? String(raw) : '—';
  return `${n.widthMm} × ${n.heightMm} mm`;
}

/**
 * Traduit un format (n'importe quelle graphie) vers la graphie CONTRAT lorsque
 * ses dimensions correspondent à une option connue. Sinon renvoie la valeur telle
 * quelle : mieux vaut un format hors liste qu'une dimension silencieusement changée.
 */
export function toContractFormat(raw) {
  const n = normalizeFormat(raw);
  if (!n) return raw;
  const known = CONTRACT_FORMAT_OPTIONS.find(o => normalizeFormat(o.value)?.key === n.key);
  return known ? known.value : raw;
}

/**
 * Options à afficher dans un menu déroulant de format, en garantissant que la
 * valeur courante y figure TOUJOURS.
 *
 * Why: un `<select>` dont la valeur n'existe dans aucune option affiche la
 * première — et l'enregistrement écrase alors le format d'origine sans que
 * personne ne l'ait demandé. Plutôt que de basculer en saisie libre (ce qui
 * privait l'utilisateur du menu), on ajoute la valeur inconnue comme option à
 * part entière, explicitement signalée.
 *
 * La reconnaissance se fait sur les DIMENSIONS : « 15 cm sur 21 cm » est déjà
 * couvert par l'option « 15 × 21 cm », ce n'est pas un format hors liste.
 */
export function buildFormatChoices(currentValue, options) {
  const current = String(currentValue || '').trim();
  if (!current) return options;
  const key = normalizeFormat(current)?.key;
  const known = options.some(o => o.value === current || (key && normalizeFormat(o.value)?.key === key));
  if (known) return options;
  return [{ value: current, label: `${current} (format spécifique)`, offList: true }, ...options];
}

/** Symétrique : graphie DEVIS. Sert à pré-remplir un devis depuis son contrat. */
export function toQuoteFormat(raw) {
  const n = normalizeFormat(raw);
  if (!n) return raw;
  const known = QUOTE_FORMAT_OPTIONS.find(o => normalizeFormat(o.value)?.key === n.key);
  return known ? known.value : raw;
}

/**
 * Prix public porté par le contrat, en EUROS.
 *
 * L'euro est l'unité de référence du contrat — décision de la direction : le prix
 * catalogue Paris fait foi, la conversion en FCFA n'intervient qu'au devis
 * (ligne « achat d'exemplaires », via FCFA_PER_EUR).
 *
 * Aucune requalification d'unité ici. Une heuristique « au-delà de N, c'est du
 * FCFA » a existé pour d'anciens contrats : la base n'en contient plus aucun
 * (99 contrats renseignés, de 10 à 100 €) et elle aurait divisé par 656 le prix
 * d'un ouvrage légitimement cher. Ce que la direction saisit en euros reste en euros.
 */
export function contractPriceEur(raw) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
