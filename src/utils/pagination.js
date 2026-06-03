// Construit la liste des numéros de page à afficher (1-based) avec des « … »
// pour les longues listes : ex. [1, '…', 33, 34, 35, '…', 323]
// `current` est 0-based, `total` est le nombre total de pages.
export function getPageItems(current, total, delta = 1) {
  const cur = current + 1;
  const pages = [];
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || (i >= cur - delta && i <= cur + delta)) {
      pages.push(i);
    }
  }
  const out = [];
  let prev;
  for (const i of pages) {
    if (prev) {
      if (i - prev === 2) out.push(prev + 1); // pas de « … » pour un seul trou
      else if (i - prev > 2) out.push('…');
    }
    out.push(i);
    prev = i;
  }
  return out;
}
