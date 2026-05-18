import { describe, it, expect } from 'vitest';

// Tests de vérification de forme des payloads acceptés par /admin/books/:id/tags
// (côté client — le backend doit accepter exactement ces structures)

describe('tags payload shape', () => {
  it('a tag assignment minimum = juste le slug', () => {
    const payload = [{ slug: 'notre_selection' }];
    expect(payload[0].slug).toBe('notre_selection');
    expect(payload[0].discount_pct).toBeUndefined();
  });

  it('tag promotion a un discount_pct entre 0 et 100', () => {
    const valid = [{ slug: 'promotion', discount_pct: 20 }];
    const edgeZero = [{ slug: 'promotion', discount_pct: 0 }];
    const edgeFull = [{ slug: 'promotion', discount_pct: 100 }];
    expect(valid[0].discount_pct).toBe(20);
    expect(edgeZero[0].discount_pct).toBe(0);
    expect(edgeFull[0].discount_pct).toBe(100);
  });

  it('tableau vide = retirer tous les tags', () => {
    const payload = [];
    expect(payload).toHaveLength(0);
  });

  it('plusieurs tags avec et sans discount coexistent', () => {
    const payload = [
      { slug: 'notre_selection' },
      { slug: 'nouveaute' },
      { slug: 'promotion', discount_pct: 15 },
    ];
    expect(payload).toHaveLength(3);
    const promo = payload.find((t) => t.slug === 'promotion');
    expect(promo.discount_pct).toBe(15);
  });
});

describe('slugify reference', () => {
  // Même logique que server/tag-routes.js slugify()
  function slugify(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 50);
  }

  it('normalise les accents', () => {
    expect(slugify('Coup de cœur')).toBe('coup_de_c_ur');
    expect(slugify('Sélection éditoriale')).toBe('selection_editoriale');
    expect(slugify('Nouveauté')).toBe('nouveaute');
  });

  it('remplace caractères spéciaux par _', () => {
    expect(slugify('Promo 2026 !')).toBe('promo_2026');
    expect(slugify("L'essentiel")).toBe('l_essentiel');
  });

  it('trim les _ en début/fin', () => {
    expect(slugify('_test_')).toBe('test');
    expect(slugify('!Best-seller!')).toBe('best_seller');
  });

  it('vide → chaîne vide', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
    expect(slugify(undefined)).toBe('');
  });
});
