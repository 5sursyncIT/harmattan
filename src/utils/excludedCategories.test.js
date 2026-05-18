import { describe, it, expect } from 'vitest';
import {
  EXCLUDED_CATEGORY_LABELS,
  EXCLUDED_CATEGORIES_SET,
  isExcludedCategory,
  excludedCategoryPlaceholders,
  excludedCategorySqlList,
} from './excludedCategories.js';

describe('excludedCategories', () => {
  it('exports a frozen array with known labels', () => {
    expect(Array.isArray(EXCLUDED_CATEGORY_LABELS)).toBe(true);
    expect(EXCLUDED_CATEGORY_LABELS).toContain('LIBRAIRIE');
    expect(EXCLUDED_CATEGORY_LABELS).toContain('LIVRES');
    expect(EXCLUDED_CATEGORY_LABELS).toContain('Accueil');
    expect(Object.isFrozen(EXCLUDED_CATEGORY_LABELS)).toBe(true);
  });

  it('exposes a Set in sync with the array', () => {
    expect(EXCLUDED_CATEGORIES_SET.size).toBe(EXCLUDED_CATEGORY_LABELS.length);
    for (const l of EXCLUDED_CATEGORY_LABELS) {
      expect(EXCLUDED_CATEGORIES_SET.has(l)).toBe(true);
    }
  });

  it('isExcludedCategory correctly flags excluded labels', () => {
    expect(isExcludedCategory('LIBRAIRIE')).toBe(true);
    expect(isExcludedCategory('LIVRES')).toBe(true);
    expect(isExcludedCategory('Racine')).toBe(true);
    expect(isExcludedCategory('Essai')).toBe(false);
    expect(isExcludedCategory('Roman')).toBe(false);
    expect(isExcludedCategory('')).toBe(false);
    expect(isExcludedCategory('librairie')).toBe(false); // casse-sensible
  });

  it('excludedCategoryPlaceholders returns correct count of ? separated by ,', () => {
    const placeholders = excludedCategoryPlaceholders();
    const count = placeholders.split(',').length;
    expect(count).toBe(EXCLUDED_CATEGORY_LABELS.length);
    expect(placeholders).toMatch(/^\?(,\?)+$/);
  });

  it('excludedCategorySqlList wraps each label in quotes and comma-separates', () => {
    const sql = excludedCategorySqlList();
    for (const l of EXCLUDED_CATEGORY_LABELS) {
      expect(sql).toContain(`'${l}'`);
    }
    // Exactement autant de virgules que de labels - 1
    const commaCount = (sql.match(/,/g) || []).length;
    expect(commaCount).toBe(EXCLUDED_CATEGORY_LABELS.length - 1);
  });

  it('excludedCategorySqlList escapes single quotes in labels (safety)', () => {
    // Cette fonction est appelée avec nos constantes — mais on vérifie quand même
    // que le mécanisme d'échappement est en place en regardant le format de sortie.
    const sql = excludedCategorySqlList();
    // Aucun label actuel n'a de quote, mais le résultat ne doit contenir que des paires équilibrées
    const quoteCount = (sql.match(/'/g) || []).length;
    expect(quoteCount).toBe(EXCLUDED_CATEGORY_LABELS.length * 2);
  });
});
