import { describe, it, expect } from 'vitest';
import {
  trim,
  capitalizeFirst,
  titleCase,
  validateTitle,
  validateAuthor,
  validateISBN,
  validatePublisher,
  validateYear,
  validateGenre,
  validatePages,
  validatePrice,
  normalizeBook,
  validateBook,
} from './bookValidation.js';

// ─── Helpers ──────────────────────────────────────────────

describe('trim', () => {
  it('supprime les espaces en début et fin', () => {
    expect(trim('  hello  ')).toBe('hello');
  });
  it('collapse les espaces multiples internes', () => {
    expect(trim('foo    bar')).toBe('foo bar');
  });
  it('retourne chaîne vide pour null/undefined', () => {
    expect(trim(null)).toBe('');
    expect(trim(undefined)).toBe('');
  });
});

describe('capitalizeFirst', () => {
  it('capitalise la première lettre', () => {
    expect(capitalizeFirst('mayanga')).toBe('Mayanga');
  });
  it('préserve les autres lettres', () => {
    expect(capitalizeFirst('mAYANGA')).toBe('MAYANGA');
  });
  it('trim en même temps', () => {
    expect(capitalizeFirst('  roman  ')).toBe('Roman');
  });
});

describe('titleCase', () => {
  it('met en forme correcte un nom', () => {
    expect(titleCase('diop')).toBe('Diop');
  });
  it('gère plusieurs mots', () => {
    expect(titleCase('mame goumba sarr kane')).toBe('Mame Goumba Sarr Kane');
  });
  it('trim et normalise', () => {
    expect(titleCase('  PAPA  youssoupha  ')).toBe('Papa Youssoupha');
  });
});

// ─── validateTitle ────────────────────────────────────────

describe('validateTitle', () => {
  it('accepte un titre normal', () => {
    expect(validateTitle('Mayanga').valid).toBe(true);
  });
  it('rejette un titre vide', () => {
    const r = validateTitle('');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('requis');
  });
  it('rejette une chaîne de whitespace seulement', () => {
    expect(validateTitle('   ').valid).toBe(false);
  });
  it('accepte 200 caractères', () => {
    expect(validateTitle('a'.repeat(200)).valid).toBe(true);
  });
  it('rejette 201 caractères', () => {
    const r = validateTitle('a'.repeat(201));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('200');
  });
});

// ─── validateAuthor ───────────────────────────────────────

describe('validateAuthor', () => {
  it('accepte nom + prénom', () => {
    expect(validateAuthor('DIOP', 'Papa').valid).toBe(true);
  });
  it('accepte nom seul', () => {
    expect(validateAuthor('DIOP').valid).toBe(true);
  });
  it('rejette nom vide', () => {
    expect(validateAuthor('').valid).toBe(false);
  });
  it('rejette nom > 80 caractères', () => {
    expect(validateAuthor('a'.repeat(81)).valid).toBe(false);
  });
  it('rejette prénom > 80 caractères', () => {
    expect(validateAuthor('DIOP', 'a'.repeat(81)).valid).toBe(false);
  });
});

// ─── validateISBN ─────────────────────────────────────────

describe('validateISBN', () => {
  it('accepte un ISBN-13 valide (Paroles de flics)', () => {
    const r = validateISBN('9782035842169');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('9782035842169');
  });
  it('accepte un ISBN-13 avec tirets', () => {
    const r = validateISBN('978-2-03-584216-9');
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe('9782035842169');
  });
  it('accepte un ISBN-13 avec espaces', () => {
    expect(validateISBN('978 2 03 584216 9').valid).toBe(true);
  });
  it('accepte un ISBN-10 valide', () => {
    // ISBN-10 valide : 0306406152
    expect(validateISBN('0306406152').valid).toBe(true);
  });
  it('accepte un ISBN-10 avec X en clé de contrôle', () => {
    // ISBN-10 dont la clé est X : 043942089X (Harry Potter)
    expect(validateISBN('043942089X').valid).toBe(true);
  });
  it('accepte un ISBN-10 avec X minuscule', () => {
    expect(validateISBN('043942089x').valid).toBe(true);
  });
  it('rejette un ISBN-13 avec checksum invalide', () => {
    const r = validateISBN('9782035842160');
    expect(r.valid).toBe(false);
    expect(r.error).toContain('clé de contrôle');
  });
  it('rejette un ISBN-10 avec checksum invalide', () => {
    const r = validateISBN('0306406150');
    expect(r.valid).toBe(false);
  });
  it('rejette une longueur incorrecte', () => {
    expect(validateISBN('12345').valid).toBe(false);
    expect(validateISBN('12345678').valid).toBe(false);
    expect(validateISBN('123456789012').valid).toBe(false);
    expect(validateISBN('12345678901234').valid).toBe(false);
  });
  it('rejette les caractères non numériques', () => {
    expect(validateISBN('abcdefghij').valid).toBe(false);
    expect(validateISBN('978abc5842169').valid).toBe(false);
  });
  it('rejette un ISBN vide ou null', () => {
    expect(validateISBN('').valid).toBe(false);
    expect(validateISBN(null).valid).toBe(false);
    expect(validateISBN(undefined).valid).toBe(false);
  });
});

// ─── validatePublisher ────────────────────────────────────

describe('validatePublisher', () => {
  it('accepte un éditeur normal', () => {
    expect(validatePublisher('L\'Harmattan Sénégal').valid).toBe(true);
  });
  it('rejette un éditeur vide', () => {
    expect(validatePublisher('').valid).toBe(false);
  });
  it('rejette > 100 caractères', () => {
    expect(validatePublisher('a'.repeat(101)).valid).toBe(false);
  });
});

// ─── validateYear ─────────────────────────────────────────

describe('validateYear', () => {
  const now = new Date().getFullYear();

  it('accepte l\'année courante', () => {
    expect(validateYear(now).valid).toBe(true);
  });
  it('accepte 1000', () => {
    expect(validateYear(1000).valid).toBe(true);
  });
  it('accepte 1450', () => {
    expect(validateYear(1450).valid).toBe(true);
  });
  it('accepte une string parseable', () => {
    expect(validateYear('2024').valid).toBe(true);
  });
  it('rejette 999', () => {
    expect(validateYear(999).valid).toBe(false);
  });
  it('rejette une année future', () => {
    expect(validateYear(now + 1).valid).toBe(false);
  });
  it('rejette un nombre décimal', () => {
    expect(validateYear(2024.5).valid).toBe(false);
  });
  it('rejette une string non numérique', () => {
    expect(validateYear('abc').valid).toBe(false);
  });
  it('rejette null/undefined', () => {
    expect(validateYear(null).valid).toBe(false);
    expect(validateYear(undefined).valid).toBe(false);
  });
});

// ─── validateGenre ────────────────────────────────────────

describe('validateGenre', () => {
  it('accepte un ID valide dans la liste', () => {
    expect(validateGenre(3, [1, 2, 3, 4]).valid).toBe(true);
  });
  it('accepte une string numérique', () => {
    expect(validateGenre('3', [1, 2, 3]).valid).toBe(true);
  });
  it('rejette un ID vide', () => {
    expect(validateGenre('').valid).toBe(false);
    expect(validateGenre(null).valid).toBe(false);
  });
  it('rejette un ID hors de la liste', () => {
    expect(validateGenre(99, [1, 2, 3]).valid).toBe(false);
  });
  it('accepte tout ID si pas de liste fournie', () => {
    expect(validateGenre(99).valid).toBe(true);
  });
});

// ─── validatePages ────────────────────────────────────────

describe('validatePages', () => {
  it('accepte 150 pages', () => {
    expect(validatePages(150).valid).toBe(true);
  });
  it('accepte "150" (string)', () => {
    expect(validatePages('150').valid).toBe(true);
  });
  it('rejette 0', () => {
    expect(validatePages(0).valid).toBe(false);
  });
  it('rejette une valeur négative', () => {
    expect(validatePages(-5).valid).toBe(false);
  });
  it('rejette un décimal', () => {
    expect(validatePages(150.5).valid).toBe(false);
  });
  it('rejette vide/null', () => {
    expect(validatePages('').valid).toBe(false);
    expect(validatePages(null).valid).toBe(false);
  });
});

// ─── validatePrice ────────────────────────────────────────

describe('validatePrice', () => {
  it('accepte 5000', () => {
    expect(validatePrice(5000).valid).toBe(true);
  });
  it('accepte 4999.99', () => {
    expect(validatePrice(4999.99).valid).toBe(true);
  });
  it('accepte "4999.99" string', () => {
    expect(validatePrice('4999.99').valid).toBe(true);
  });
  it('rejette 0', () => {
    expect(validatePrice(0).valid).toBe(false);
  });
  it('rejette une valeur négative', () => {
    expect(validatePrice(-100).valid).toBe(false);
  });
  it('rejette plus de 2 décimales', () => {
    expect(validatePrice(4999.999).valid).toBe(false);
  });
  it('rejette vide/null', () => {
    expect(validatePrice('').valid).toBe(false);
    expect(validatePrice(null).valid).toBe(false);
  });
});

// ─── normalizeBook ────────────────────────────────────────

describe('normalizeBook', () => {
  it('trim tous les champs string', () => {
    const b = normalizeBook({
      title: '  Mayanga  ',
      author_nom: '  KANE  ',
      author_prenom: '  Mame  ',
      isbn: '978-2-343-56789-7',
      editeur: '  L\'Harmattan  ',
      soustitre: '  Sous-titre  ',
    });
    expect(b.title).toBe('Mayanga');
    expect(b.author_nom).toBe('Kane');
    expect(b.author_prenom).toBe('Mame');
    expect(b.editeur).toBe('L\'harmattan');
    expect(b.soustitre).toBe('Sous-titre');
  });

  it('coerce le prix en Number sans arrondir (validation le rejettera si > 2 décimales)', () => {
    expect(normalizeBook({ price_ttc: '5000' }).price_ttc).toBe(5000);
    expect(normalizeBook({ price_ttc: 4999.99 }).price_ttc).toBe(4999.99);
    // La valeur est préservée telle quelle pour que validatePrice puisse signaler l'erreur
    expect(normalizeBook({ price_ttc: 4999.999 }).price_ttc).toBeCloseTo(4999.999);
  });

  it('retire les tirets et espaces de l\'ISBN', () => {
    expect(normalizeBook({ isbn: '978-2-03-584216-9' }).isbn).toBe('9782035842169');
    expect(normalizeBook({ isbn: '978 2 03 584216 9' }).isbn).toBe('9782035842169');
  });

  it('convertit les strings numériques en nombres', () => {
    const b = normalizeBook({
      publication_year: '2024',
      nombre_pages: '150',
      genre_id: '3',
    });
    expect(b.publication_year).toBe(2024);
    expect(b.nombre_pages).toBe(150);
    expect(b.genre_id).toBe(3);
  });

  it('gère les valeurs nulles sans crash', () => {
    const b = normalizeBook({});
    expect(b.title).toBe('');
    expect(b.price_ttc).toBe(null);
  });
});

// ─── validateBook (aggregator) ───────────────────────────

describe('validateBook', () => {
  const validBook = {
    title: 'Mayanga',
    author_nom: 'Kane',
    author_prenom: 'Mame Goumba Sarr',
    isbn: '9782035842169',
    editeur: 'L\'Harmattan Sénégal',
    publication_year: 2022,
    genre_id: 3,
    nombre_pages: 150,
    price_ttc: 10000,
  };

  it('retourne valid=true pour un livre complet valide', () => {
    const r = validateBook(validBook);
    expect(r.valid).toBe(true);
    expect(Object.keys(r.errors).length).toBe(0);
  });

  it('normalise les données', () => {
    const r = validateBook({ ...validBook, title: '  mayanga  ', isbn: '978-2-03-584216-9' });
    expect(r.normalized.title).toBe('Mayanga');
    expect(r.normalized.isbn).toBe('9782035842169');
  });

  it('retourne toutes les erreurs sur un livre vide', () => {
    const r = validateBook({});
    expect(r.valid).toBe(false);
    expect(r.errors.title).toBeDefined();
    expect(r.errors.author).toBeDefined();
    expect(r.errors.isbn).toBeDefined();
    expect(r.errors.editeur).toBeDefined();
    expect(r.errors.publication_year).toBeDefined();
    expect(r.errors.genre_id).toBeDefined();
    expect(r.errors.nombre_pages).toBeDefined();
    expect(r.errors.price_ttc).toBeDefined();
  });

  it('rejette un ISBN invalide uniquement', () => {
    const r = validateBook({ ...validBook, isbn: '1234567890' });
    expect(r.valid).toBe(false);
    expect(r.errors.isbn).toBeDefined();
    expect(r.errors.title).toBeUndefined();
  });

  it('rejette une année future', () => {
    const r = validateBook({ ...validBook, publication_year: new Date().getFullYear() + 1 });
    expect(r.valid).toBe(false);
    expect(r.errors.publication_year).toBeDefined();
  });

  it('rejette un prix avec 3 décimales', () => {
    const r = validateBook({ ...validBook, price_ttc: 4999.999 });
    expect(r.valid).toBe(false);
    expect(r.errors.price_ttc).toBeDefined();
  });

  it('respecte une liste de genres autorisés', () => {
    const r = validateBook({ ...validBook, genre_id: 99 }, { allowedGenreIds: [1, 2, 3] });
    expect(r.valid).toBe(false);
    expect(r.errors.genre_id).toBeDefined();
  });

  it('accepte un genre si pas de liste d\'autorisation', () => {
    const r = validateBook(validBook);
    expect(r.valid).toBe(true);
  });
});
