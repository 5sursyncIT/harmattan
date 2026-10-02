import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  parseAuthorDiscount, findAuthorForTier, authorTierIds, authorDiscountRequiredBody,
  authorDiscountNote, noteHasAuthorDiscount, netAmount, AUTHOR_DISCOUNT_REQUIRED,
} from './author-discount.js';

function memDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE authors (id INTEGER PRIMARY KEY, firstname TEXT, lastname TEXT, display_name TEXT, dolibarr_thirdparty_id INTEGER)');
  db.prepare('INSERT INTO authors (firstname, lastname, dolibarr_thirdparty_id) VALUES (?,?,?)').run('Awa', 'Ndiaye', 120);
  db.prepare('INSERT INTO authors (firstname, lastname, dolibarr_thirdparty_id) VALUES (?,?,?)').run('Moussa', 'Fall', null);
  return db;
}

describe('parseAuthorDiscount', () => {
  it('exige une saisie : vide / absent → null (jamais 0 implicite)', () => {
    expect(parseAuthorDiscount(undefined)).toBeNull();
    expect(parseAuthorDiscount(null)).toBeNull();
    expect(parseAuthorDiscount('')).toBeNull();
    expect(parseAuthorDiscount('  ')).toBeNull();
  });
  it('accepte 0 saisi explicitement et les décimales (virgule comprise)', () => {
    expect(parseAuthorDiscount('0')).toBe(0);
    expect(parseAuthorDiscount(0)).toBe(0);
    expect(parseAuthorDiscount('25,5')).toBe(25.5);
    expect(parseAuthorDiscount(30)).toBe(30);
    expect(parseAuthorDiscount('100')).toBe(100);
  });
  it('refuse hors bornes et non numérique', () => {
    expect(parseAuthorDiscount(-1)).toBeNull();
    expect(parseAuthorDiscount(101)).toBeNull();
    expect(parseAuthorDiscount('abc')).toBeNull();
  });
});

describe('détection du tiers auteur', () => {
  const db = memDb();
  it('reconnaît un tiers lié à une fiche auteur', () => {
    expect(findAuthorForTier(db, 120)?.lastname).toBe('Ndiaye');
    expect(findAuthorForTier(db, '120')).not.toBeNull();
  });
  it('ignore les tiers non liés et les entrées vides', () => {
    expect(findAuthorForTier(db, 999)).toBeNull();
    expect(findAuthorForTier(db, null)).toBeNull();
    expect(findAuthorForTier(null, 120)).toBeNull();
  });
  it('ne plante pas sans table authors', () => {
    expect(findAuthorForTier(new Database(':memory:'), 120)).toBeNull();
  });
  it('annote une liste de tiers', () => {
    const set = authorTierIds(db, [120, 5, null, '120']);
    expect([...set]).toEqual([120]);
    expect(authorTierIds(db, []).size).toBe(0);
  });
});

describe('réponse 409 et traçabilité', () => {
  it('porte le code attendu par les interfaces', () => {
    const body = authorDiscountRequiredBody({ firstname: 'Awa', lastname: 'Ndiaye' });
    expect(body.code).toBe(AUTHOR_DISCOUNT_REQUIRED);
    expect(body.error).toContain('Awa Ndiaye');
  });
  it('note de facture détectable (devis → facture)', () => {
    const note = authorDiscountNote(25, 'fatou');
    expect(note).toBe('[REMISE AUTEUR] 25 % saisie par fatou');
    expect(noteHasAuthorDiscount(`Devis\n${note}`)).toBe(true);
    expect(noteHasAuthorDiscount('Devis classique')).toBe(false);
    expect(noteHasAuthorDiscount(null)).toBe(false);
  });
  it('montant net arrondi au franc', () => {
    expect(netAmount(7500, 2, 30)).toBe(10500);
    expect(netAmount(7333, 3, 30)).toBe(15399);
    expect(netAmount(5000, 1, 0)).toBe(5000);
  });
});
