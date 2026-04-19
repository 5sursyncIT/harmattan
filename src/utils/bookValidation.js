/**
 * Validation et normalisation des enregistrements de livres.
 *
 * Toutes les fonctions sont pures et isomorphes (client + serveur).
 * Les messages d'erreur sont en français.
 */

const MAX_TITLE = 200;
const MAX_AUTHOR = 80;
const MAX_PUBLISHER = 100;
const MAX_SUBTITLE = 200;
const MAX_DESCRIPTION = 5000;
const MIN_YEAR = 1000;

/* ─── Helpers ──────────────────────────────────────── */

export function trim(str) {
  return typeof str === 'string' ? str.replace(/\s+/g, ' ').trim() : '';
}

export function capitalizeFirst(str) {
  const t = trim(str);
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function titleCase(str) {
  const t = trim(str);
  if (!t) return '';
  return t
    .toLocaleLowerCase('fr-FR')
    .split(' ')
    .map((word) => {
      if (!word) return word;
      // preserve single-quote words like "d'Ivoire" → "d'Ivoire"
      return word.charAt(0).toLocaleUpperCase('fr-FR') + word.slice(1);
    })
    .join(' ');
}

/* ─── Validators ───────────────────────────────────── */

export function validateTitle(title) {
  const t = trim(title);
  if (!t) return { valid: false, error: 'Le titre est requis' };
  if (t.length > MAX_TITLE) return { valid: false, error: `Le titre doit contenir entre 1 et ${MAX_TITLE} caractères` };
  return { valid: true };
}

export function validateAuthor(nom, prenom) {
  const n = trim(nom);
  const p = trim(prenom || '');
  if (!n) return { valid: false, error: 'Le nom de l\'auteur est requis' };
  if (n.length > MAX_AUTHOR) return { valid: false, error: `Le nom de l'auteur ne doit pas dépasser ${MAX_AUTHOR} caractères` };
  if (p.length > MAX_AUTHOR) return { valid: false, error: `Le prénom de l'auteur ne doit pas dépasser ${MAX_AUTHOR} caractères` };
  return { valid: true };
}

/**
 * Normalise et valide un ISBN (10 ou 13 chiffres).
 * Retourne { valid, error?, normalized? }
 */
export function validateISBN(isbn) {
  if (isbn == null || isbn === '') {
    return { valid: false, error: 'L\'ISBN est requis' };
  }
  // Strip hyphens, spaces
  const raw = String(isbn).replace(/[\s-]/g, '');

  if (raw.length === 10) {
    if (!/^\d{9}[\dX]$/i.test(raw)) {
      return { valid: false, error: 'ISBN-10 invalide : 9 chiffres suivis d\'un chiffre ou de X' };
    }
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(raw[i], 10) * (10 - i);
    }
    const last = raw[9].toUpperCase();
    sum += last === 'X' ? 10 : parseInt(last, 10);
    if (sum % 11 !== 0) {
      return { valid: false, error: 'ISBN invalide : la clé de contrôle ne correspond pas' };
    }
    return { valid: true, normalized: raw.toUpperCase() };
  }

  if (raw.length === 13) {
    if (!/^\d{13}$/.test(raw)) {
      return { valid: false, error: 'ISBN-13 invalide : doit contenir 13 chiffres' };
    }
    let sum = 0;
    for (let i = 0; i < 13; i++) {
      sum += parseInt(raw[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    if (sum % 10 !== 0) {
      return { valid: false, error: 'ISBN invalide : la clé de contrôle ne correspond pas' };
    }
    return { valid: true, normalized: raw };
  }

  return { valid: false, error: 'L\'ISBN doit contenir 10 ou 13 chiffres' };
}

export function validatePublisher(editeur) {
  const t = trim(editeur);
  if (!t) return { valid: false, error: 'L\'éditeur est requis' };
  if (t.length > MAX_PUBLISHER) return { valid: false, error: `L'éditeur ne doit pas dépasser ${MAX_PUBLISHER} caractères` };
  return { valid: true };
}

export function validateYear(year, currentYear = new Date().getFullYear()) {
  const n = typeof year === 'string' ? parseInt(year, 10) : year;
  if (n === null || n === undefined || Number.isNaN(n)) {
    return { valid: false, error: 'L\'année de publication est requise' };
  }
  if (!Number.isInteger(n)) {
    return { valid: false, error: 'L\'année de publication doit être un entier' };
  }
  if (typeof year === 'number' && !Number.isInteger(year)) {
    return { valid: false, error: 'L\'année de publication doit être un entier' };
  }
  if (n < MIN_YEAR || n > currentYear) {
    return { valid: false, error: `L'année de publication doit être comprise entre ${MIN_YEAR} et ${currentYear}` };
  }
  return { valid: true };
}

export function validateGenre(genreId, allowedIds) {
  if (genreId === null || genreId === undefined || genreId === '') {
    return { valid: false, error: 'Le genre est requis' };
  }
  const id = typeof genreId === 'string' ? parseInt(genreId, 10) : genreId;
  if (Number.isNaN(id)) {
    return { valid: false, error: 'Genre invalide' };
  }
  if (Array.isArray(allowedIds) && allowedIds.length > 0 && !allowedIds.includes(id)) {
    return { valid: false, error: 'Le genre sélectionné n\'existe pas dans le catalogue' };
  }
  return { valid: true };
}

export function validatePages(pages) {
  if (pages === null || pages === undefined || pages === '') {
    return { valid: false, error: 'Le nombre de pages est requis' };
  }
  const n = typeof pages === 'string' ? Number(pages) : pages;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { valid: false, error: 'Le nombre de pages doit être un entier positif' };
  }
  return { valid: true };
}

export function validatePrice(price) {
  if (price === null || price === undefined || price === '') {
    return { valid: false, error: 'Le prix est requis' };
  }
  const n = typeof price === 'string' ? Number(price) : price;
  if (!Number.isFinite(n) || n <= 0) {
    return { valid: false, error: 'Le prix doit être un nombre positif' };
  }
  // Vérifie qu'on n'a pas plus de 2 décimales
  const rounded = Math.round(n * 100) / 100;
  if (Math.abs(rounded - n) > 1e-9) {
    return { valid: false, error: 'Le prix doit être positif avec au maximum 2 décimales' };
  }
  return { valid: true };
}

/* ─── Normalization ────────────────────────────────── */

export function normalizeBook(book) {
  const b = book || {};
  const isbnResult = validateISBN(b.isbn);
  return {
    title: capitalizeFirst(trim(b.title)),
    author_nom: titleCase(b.author_nom),
    author_prenom: titleCase(b.author_prenom),
    isbn: isbnResult.valid ? isbnResult.normalized : trim(String(b.isbn || '')).replace(/[\s-]/g, ''),
    editeur: titleCase(b.editeur),
    publication_year: b.publication_year !== null && b.publication_year !== undefined && b.publication_year !== ''
      ? parseInt(b.publication_year, 10) || null
      : null,
    genre_id: b.genre_id !== null && b.genre_id !== undefined && b.genre_id !== ''
      ? parseInt(b.genre_id, 10)
      : null,
    nombre_pages: b.nombre_pages !== null && b.nombre_pages !== undefined && b.nombre_pages !== ''
      ? parseInt(b.nombre_pages, 10)
      : null,
    price_ttc: b.price_ttc !== null && b.price_ttc !== undefined && b.price_ttc !== ''
      ? Number(b.price_ttc)
      : null,
    soustitre: trim(b.soustitre).slice(0, MAX_SUBTITLE),
    description: trim(b.description).slice(0, MAX_DESCRIPTION),
  };
}

/* ─── Aggregator ───────────────────────────────────── */

export function validateBook(book, options = {}) {
  const normalized = normalizeBook(book);
  const errors = {};

  const titleCheck = validateTitle(normalized.title);
  if (!titleCheck.valid) errors.title = titleCheck.error;

  const authorCheck = validateAuthor(normalized.author_nom, normalized.author_prenom);
  if (!authorCheck.valid) errors.author = authorCheck.error;

  const isbnCheck = validateISBN(normalized.isbn);
  if (!isbnCheck.valid) errors.isbn = isbnCheck.error;

  const publisherCheck = validatePublisher(normalized.editeur);
  if (!publisherCheck.valid) errors.editeur = publisherCheck.error;

  const yearCheck = validateYear(normalized.publication_year, options.currentYear);
  if (!yearCheck.valid) errors.publication_year = yearCheck.error;

  const genreCheck = validateGenre(normalized.genre_id, options.allowedGenreIds);
  if (!genreCheck.valid) errors.genre_id = genreCheck.error;

  const pagesCheck = validatePages(normalized.nombre_pages);
  if (!pagesCheck.valid) errors.nombre_pages = pagesCheck.error;

  const priceCheck = validatePrice(normalized.price_ttc);
  if (!priceCheck.valid) errors.price_ttc = priceCheck.error;

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalized,
  };
}
