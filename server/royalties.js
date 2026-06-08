/**
 * Calcul des droits d'auteur — SOURCE UNIQUE de vérité.
 *
 * Utilisé par la comptabilité (accounting-routes.js, qui paie réellement) ET par
 * l'espace auteur (author-routes.js, « Mes droits »), afin que les deux affichent
 * STRICTEMENT le même montant. Toute divergence ici porterait sur de l'argent dû
 * à un auteur — à éviter absolument.
 *
 * Règles : voir docs/DECISION-royalties-DLL.md (1er juin 2026).
 *  - Contrats classiques / Tamarinier : seuil de déclenchement, droits uniquement
 *    AU-DELÀ du seuil (marginal), au taux contractuel.
 *  - Contrats DLL (harmattan_dll*) : paliers — `rate` % sur les `threshold` premiers
 *    exemplaires subventionnés, puis 10 % au-delà, dès le 1er exemplaire.
 *  - Le seuil est le seuil contractuel SEUL : les exemplaires gratuits / service de
 *    presse ne sont jamais facturés, donc déjà absents du volume vendu — ne pas les
 *    ajouter au seuil (sinon double déduction).
 */

export const DLL_ROYALTY_RATE_AFTER_THRESHOLD = 10;

export function isDllContractType(contractType) {
  return String(contractType || '').startsWith('harmattan_dll');
}

/**
 * @param {object} p
 * @param {string} p.contractType   Type de contrat (détermine classique vs DLL).
 * @param {number} p.unitsSold      Exemplaires vendus SUR LA PÉRIODE.
 * @param {number} p.grossHt        CA HT de la période (somme total_ht facturé).
 * @param {number} p.cumulativeUnits Cumul d'exemplaires vendus jusqu'à la fin de la période (mode cumulatif).
 * @param {number} p.threshold      Seuil contractuel (ex. 500 classique, 1000 DLL).
 * @param {number} p.rate           Taux primaire (% papier / 1er palier DLL).
 * @param {'cumulative'|'period'} p.thresholdMode  Mode d'application du seuil.
 * @returns {{avgHtPerUnit:number, unitsOver:number, royaltyBase:number, royaltyDue:number, royaltyRateLabel:string, breakdown:Array}}
 */
export function computeRoyaltyBreakdown({ contractType, unitsSold, grossHt, cumulativeUnits, threshold, rate, thresholdMode }) {
  const units = Number(unitsSold) || 0;
  const gross = Number(grossHt) || 0;
  const avgHtPerUnit = units > 0 ? gross / units : 0;

  if (units <= 0 || gross <= 0) {
    return {
      avgHtPerUnit,
      unitsOver: 0,
      royaltyBase: 0,
      royaltyDue: 0,
      royaltyRateLabel: `${rate || 0}%`,
      breakdown: [],
    };
  }

  const safeThreshold = Math.max(0, Number(threshold) || 0);
  const primaryRate = Number(rate) || 0;

  // Contrat DLL : règle contractuelle à paliers.
  // `rate` % sur les `threshold` premiers exemplaires subventionnés, puis 10 % au-delà.
  if (isDllContractType(contractType)) {
    let firstBandUnits;
    if (thresholdMode === 'cumulative') {
      const cum = Number(cumulativeUnits) || units;
      const before = Math.max(0, cum - units);
      firstBandUnits = Math.max(0, Math.min(cum, safeThreshold) - Math.min(before, safeThreshold));
    } else {
      firstBandUnits = Math.min(units, safeThreshold);
    }

    const secondBandUnits = Math.max(0, units - firstBandUnits);
    const firstBandDue = firstBandUnits * avgHtPerUnit * (primaryRate / 100);
    const secondBandDue = secondBandUnits * avgHtPerUnit * (DLL_ROYALTY_RATE_AFTER_THRESHOLD / 100);
    const royaltyDue = firstBandDue + secondBandDue;

    return {
      avgHtPerUnit,
      unitsOver: units,
      royaltyBase: gross,
      royaltyDue,
      royaltyRateLabel: `${primaryRate}% puis ${DLL_ROYALTY_RATE_AFTER_THRESHOLD}%`,
      breakdown: [
        { label: `Premiers ${safeThreshold} ex. DLL`, units: firstBandUnits, rate: primaryRate, amount: firstBandDue },
        { label: `Au-delà de ${safeThreshold} ex.`, units: secondBandUnits, rate: DLL_ROYALTY_RATE_AFTER_THRESHOLD, amount: secondBandDue },
      ],
    };
  }

  // Contrats classiques : seuil de déclenchement, droits uniquement au-delà du seuil.
  let unitsOver = 0;
  if (thresholdMode === 'cumulative') {
    const cum = Number(cumulativeUnits) || units;
    const before = cum - units;
    if (cum > safeThreshold) {
      unitsOver = before >= safeThreshold ? units : cum - safeThreshold;
    }
  } else {
    unitsOver = Math.max(0, units - safeThreshold);
  }

  const royaltyBase = unitsOver * avgHtPerUnit;
  const royaltyDue = royaltyBase * (primaryRate / 100);
  return {
    avgHtPerUnit,
    unitsOver,
    royaltyBase,
    royaltyDue,
    royaltyRateLabel: `${primaryRate}%`,
    breakdown: [{ label: `Au-delà de ${safeThreshold} ex.`, units: unitsOver, rate: primaryRate, amount: royaltyDue }],
  };
}
