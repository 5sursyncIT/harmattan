export const EXCLUDED_CATEGORY_LABELS = Object.freeze([
  'LIBRAIRIE',
  'LIVRES',
  'Accueil',
  'Racine',
  'Services',
  'Livres du mois',
  'http://senharmattan.com/',
]);

export const EXCLUDED_CATEGORIES_SET = new Set(EXCLUDED_CATEGORY_LABELS);

export function isExcludedCategory(label) {
  return EXCLUDED_CATEGORIES_SET.has(label);
}

export function excludedCategoryPlaceholders() {
  return EXCLUDED_CATEGORY_LABELS.map(() => '?').join(',');
}

// Liste SQL littérale avec échappement de ' (labels sont des constantes en dur — sûr)
export function excludedCategorySqlList() {
  return EXCLUDED_CATEGORY_LABELS.map((l) => `'${l.replace(/'/g, "''")}'`).join(',');
}
