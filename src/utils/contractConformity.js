/**
 * Contrôle de conformité DEVIS ↔ CONTRAT.
 *
 * Le devis de contribution reprend les caractéristiques de fabrication du contrat
 * (pages, format, prix public, remise auteur) puis les laisse librement négocier.
 * Rien ne les remontait au contrat : le PDF du contrat pouvait annoncer 200 pages
 * à 15 € pendant que le devis facturait 320 pages à 20 €.
 *
 * Ce module est l'unique juge de l'écart. Il est volontairement PUR (aucune
 * dépendance serveur) et partagé :
 *   - le serveur l'appelle pour le verdict qui fait foi (liste des devis, alerte
 *     à la création/révision, alignement du contrat) ;
 *   - la modale de devis l'appelle pour avertir en direct pendant la saisie.
 * Une seule implémentation, donc aucun risque que l'avertissement à l'écran et le
 * verdict enregistré divergent.
 *
 * Ce contrôle N'INTERDIT RIEN : un écart est le plus souvent une négociation
 * légitime. Il le rend visible, traçable, et propose de réaligner le contrat.
 */

import {
  formatsMatch, formatLabel, contractPriceEur, DEFAULT_AUTHOR_DISCOUNT, FCFA_PER_EUR,
} from './bookFormats.js';

export const CONFORMITY_OK = 'ok';
export const CONFORMITY_DIVERGENT = 'divergent';
// Contrat sans caractéristiques de fabrication exploitables (contrats anciens,
// créés avant ces champs) : on ne peut ni confirmer ni infirmer la conformité.
export const CONFORMITY_UNKNOWN = 'unknown';

// Tolérance sur les décimaux : neutralise le bruit de représentation
// (14.999999 ≠ 15), pas un vrai écart commercial.
const EPSILON = 0.011;

/**
 * Champs que l'enregistrement d'un devis RECOPIE sur le contrat (quantité
 * d'exemplaires et remise auteur, cf. persistPurchaseTerms côté serveur).
 *
 * Pendant la saisie, les signaler serait une fausse alerte : ils se réconcilient
 * à l'enregistrement. Après coup en revanche, un écart sur ces champs signifie
 * que la recopie a ÉCHOUÉ — et là, c'est le signal le plus important de tous,
 * puisque ces deux valeurs sont celles qu'imprime l'annexe du contrat.
 */
export const QUOTE_SYNCED_FIELDS = ['copies', 'discount'];

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const toPct = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};
// Comme toInt, mais 0 est une valeur légitime et non « champ vide ».
const toCount = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const eur = (n) => `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Caractéristiques côté CONTRAT depuis les extrafields camelCase de l'API (front). */
export function specFromContractExtrafields(ef = {}) {
  return {
    pages: toInt(ef.nombrePagesEstime),
    format: ef.formatOuvrage ?? null,
    priceEur: contractPriceEur(ef.prixPublicPrevisionnel),
    discountPct: toPct(ef.authorPurchaseDiscount),
    copies: toCount(ef.authorPurchaseQty),
  };
}

/** Caractéristiques côté CONTRAT depuis une ligne llx_contrat_extrafields (serveur). */
export function specFromContractRow(row = {}) {
  return {
    pages: toInt(row.nombre_pages_estime),
    format: row.format_ouvrage ?? null,
    priceEur: contractPriceEur(row.prix_public_previsionnel),
    discountPct: toPct(row.author_purchase_discount),
    // 0 est une valeur SIGNIFICATIVE ici (« aucun engagement d'achat »), à la
    // différence des pages ou du prix où 0 traduit un champ non renseigné.
    copies: toCount(row.author_purchase_qty),
  };
}

/** Caractéristiques côté DEVIS depuis une ligne contract_quotes ou le formulaire. */
export function specFromQuote(quote = {}) {
  return {
    pages: toInt(quote.book_pages),
    format: quote.book_format ?? null,
    priceEur: (() => {
      const n = parseFloat(quote.book_price_eur);
      return Number.isFinite(n) && n > 0 ? n : null;
    })(),
    // Devis antérieurs à la colonne `discount_pct` : la remise n'est nulle part,
    // mais elle est RECALCULABLE depuis le montant de la ligne 4. Sans ce repli,
    // le contrôle était simplement sauté — et le contrat gardait « moins 0.00 % »
    // alors que le devis avait bel et bien appliqué 30 %.
    discountPct: toPct(quote.discount_pct) ?? discountFromItems(quote),
    // Idem pour la quantité, avant la colonne `copies_qty` : elle n'existe que
    // dans le libellé de la ligne 4.
    copies: toCount(quote.copies_qty) ?? copiesFromItems(quote.items),
  };
}

// « 4 - Achat de 50 exemplaires contractuels » → 50.
function copiesFromItems(items) {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const m = String(it?.label || '').match(/achat\s+de\s+(\d+)\s+exemplaires/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/**
 * Remise effectivement appliquée, déduite de la ligne 4 :
 *   montant = qty × prix€ × FCFA_PER_EUR × (1 − remise)
 *
 * N'est retenue QUE si elle tombe sur un taux franc (à 0,1 point près). Un
 * résultat bancal — 27,34 % — signale une ligne renégociée à la main : la
 * « remise » n'y a alors plus de sens et il vaut mieux ne rien conclure que
 * d'inscrire un taux inventé dans un contrat.
 */
function discountFromItems(quote) {
  const items = quote?.items;
  if (!Array.isArray(items)) return null;
  const line = items.find(i => /achat\s+de\s+\d+\s+exemplaires/i.test(String(i?.label || '')));
  if (!line) return null;
  const copies = copiesFromItems(items);
  const priceEur = parseFloat(quote.book_price_eur);
  const amount = parseFloat(line.price);
  if (!copies || !Number.isFinite(priceEur) || priceEur <= 0 || !Number.isFinite(amount)) return null;

  const full = copies * priceEur * FCFA_PER_EUR;
  if (full <= 0) return null;
  const pct = (1 - amount / full) * 100;
  const rounded = Math.round(pct);
  if (Math.abs(pct - rounded) > 0.1) return null;
  return rounded >= 0 && rounded <= 100 ? rounded : null;
}

/**
 * Compare les deux jeux de caractéristiques.
 *
 * Un champ absent d'un côté n'est PAS un écart : il est simplement exclu de la
 * comparaison (et compté dans `checked`). Un contrat sans aucune donnée
 * comparable ressort en `unknown`, jamais en « conforme » par défaut — un verdict
 * vert obtenu faute de données serait le pire des résultats.
 */
export function compareSpecs(contractSpec, quoteSpec) {
  const c = contractSpec || {};
  const q = quoteSpec || {};
  const diffs = [];
  let checked = 0;

  // Pages — pèse 2 500 FCFA/page dans le devis (lignes 1 et 2).
  if (c.pages !== null && c.pages !== undefined && q.pages !== null && q.pages !== undefined) {
    checked++;
    if (c.pages !== q.pages) {
      diffs.push({
        field: 'pages',
        label: 'Nombre de pages',
        severity: 'major',
        contract: c.pages,
        quote: q.pages,
        contractDisplay: `${c.pages} p.`,
        quoteDisplay: `${q.pages} p.`,
        delta: q.pages - c.pages,
        // Lignes 1 (relecture, 1 500 F/p.) + 2 (mise en pages, 1 000 F/p.).
        impactFcfa: (q.pages - c.pages) * 2500,
      });
    }
  }

  // Format — comparé sur les dimensions seules (graphies différentes de part et d'autre).
  const sameFormat = formatsMatch(c.format, q.format);
  if (sameFormat !== null) {
    checked++;
    if (sameFormat === false) {
      diffs.push({
        field: 'format',
        label: 'Format de l\'ouvrage',
        severity: 'minor',
        contract: c.format,
        quote: q.format,
        contractDisplay: formatLabel(c.format),
        quoteDisplay: formatLabel(q.format),
      });
    }
  }

  // Exemplaires contractuels — c'est LA valeur imprimée dans l'annexe
  // « Engagement d'achat de l'Auteur » du contrat. Le devis la recopie sur le
  // contrat, mais ce report est best-effort : sans ce contrôle, un échec de
  // recopie laissait l'annexe annoncer « 0 exemplaires » en silence.
  if (c.copies !== null && c.copies !== undefined && q.copies !== null && q.copies !== undefined) {
    checked++;
    if (c.copies !== q.copies) {
      diffs.push({
        field: 'copies',
        label: 'Exemplaires contractuels',
        severity: 'major',
        contract: c.copies,
        quote: q.copies,
        contractDisplay: `${c.copies} ex.`,
        quoteDisplay: `${q.copies} ex.`,
        delta: q.copies - c.copies,
        annexe: true,
      });
    }
  }

  // Prix public — pilote la ligne 4 « achat d'exemplaires contractuels ».
  if (c.priceEur !== null && c.priceEur !== undefined && q.priceEur !== null && q.priceEur !== undefined) {
    checked++;
    if (Math.abs(c.priceEur - q.priceEur) > EPSILON) {
      diffs.push({
        field: 'price',
        label: 'Prix public',
        severity: 'major',
        contract: c.priceEur,
        quote: q.priceEur,
        contractDisplay: eur(c.priceEur),
        quoteDisplay: eur(q.priceEur),
        delta: Math.round((q.priceEur - c.priceEur) * 100) / 100,
      });
    }
  }

  // Remise auteur — le contrat muet vaut le défaut maison, pas « pas de remise ».
  const discountInferred = c.discountPct === null || c.discountPct === undefined;
  const cDiscount = discountInferred ? DEFAULT_AUTHOR_DISCOUNT : c.discountPct;
  if (q.discountPct !== null && q.discountPct !== undefined) {
    // Une remise déduite d'un défaut ne compte PAS comme donnée vérifiée : sans
    // ça, un contrat vide de toute caractéristique ressortirait « conforme » sur
    // la seule foi d'une valeur que personne n'a saisie.
    if (!discountInferred) checked++;
    if (Math.abs(cDiscount - q.discountPct) > EPSILON) {
      diffs.push({
        field: 'discount',
        label: 'Remise auteur',
        severity: 'major',
        contract: cDiscount,
        quote: q.discountPct,
        contractDisplay: `${cDiscount} %`,
        quoteDisplay: `${q.discountPct} %`,
        delta: Math.round((q.discountPct - cDiscount) * 100) / 100,
        // Le contrat ne portait pas la remise : c'est un défaut appliqué, à confirmer.
        inferred: discountInferred,
        // Imprimée dans l'annexe « … sur la base du prix public moins N % ».
        annexe: true,
      });
    }
  }

  // Un écart constaté prime sur l'absence de données : on ne renvoie jamais
  // « non vérifiable » alors qu'une différence a déjà été relevée.
  const status = diffs.length > 0
    ? CONFORMITY_DIVERGENT
    : checked === 0 ? CONFORMITY_UNKNOWN : CONFORMITY_OK;

  return {
    status,
    checked,
    diffs,
    hasMajor: diffs.some(d => d.severity === 'major'),
  };
}

/** Raccourci : ligne contract_quotes + extrafields camelCase (front). */
export function compareQuoteToContractExtrafields(ef, quote) {
  return compareSpecs(specFromContractExtrafields(ef), specFromQuote(quote));
}

/** Résumé court, pour un badge ou une ligne de journal. */
export function conformitySummary(result) {
  if (!result || result.status === CONFORMITY_UNKNOWN) return 'Conformité non vérifiable';
  if (result.status === CONFORMITY_OK) return 'Conforme au contrat';
  return result.diffs
    .map(d => `${d.label} : contrat ${d.contractDisplay} → devis ${d.quoteDisplay}`)
    .join(' ; ');
}
