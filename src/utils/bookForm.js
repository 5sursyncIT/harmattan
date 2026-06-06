/**
 * Helpers purs pour le formulaire de livre (testables indépendamment).
 */

export const EMPTY_BOOK = Object.freeze({
  title: '',
  author_nom: '',
  author_prenom: '',
  authors: [], // Phase 4 : [{ id, display_name, slug }]
  isbn: '',
  editeur: "L'Harmattan Sénégal",
  publication_year: new Date().getFullYear(),
  genre_ids: [],
  nombre_pages: '',
  price_ttc: '',
  soustitre: '',
  description: '',
  // Section « Ouvrages à paraître » (pilotée depuis la fiche produit)
  is_upcoming: false,
  release_date: '',
  upcoming_summary: '',
  preorder_discount_pct: '',
});

/**
 * Normalise un livre reçu du backend en une structure uniforme pour le formulaire.
 * Accepte genre_ids[] (nouveau format multi) OU genre_id (legacy mono).
 */
export function hydrateBook(book) {
  if (!book) return { ...EMPTY_BOOK };
  const ids =
    Array.isArray(book.genre_ids) && book.genre_ids.length > 0
      ? book.genre_ids.map((g) => parseInt(g, 10)).filter((n) => !Number.isNaN(n))
      : book.genre_id
        ? [parseInt(book.genre_id, 10)].filter((n) => !Number.isNaN(n))
        : [];
  const authors = Array.isArray(book.authors) ? book.authors : [];
  return { ...EMPTY_BOOK, ...book, genre_ids: ids, authors };
}

/**
 * Décode les entités HTML d'une chaîne de manière sûre (utilise DOMParser si dispo).
 * Utilisable en navigateur ; en Node-only, retourne l'original.
 */
export function decodeEntities(str) {
  if (!str) return '';
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
  }
  return str;
}
