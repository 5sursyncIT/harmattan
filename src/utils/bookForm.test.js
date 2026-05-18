import { describe, it, expect } from 'vitest';
import { hydrateBook, EMPTY_BOOK } from './bookForm.js';

describe('hydrateBook', () => {
  it('returns a fresh EMPTY_BOOK clone when book is null/undefined', () => {
    const h1 = hydrateBook(null);
    const h2 = hydrateBook(undefined);
    expect(h1).toEqual({ ...EMPTY_BOOK });
    expect(h2).toEqual({ ...EMPTY_BOOK });
    // Doit être une copie, pas la constante frozen
    expect(Object.isFrozen(h1)).toBe(false);
    h1.title = 'mutated'; // ne doit pas lancer
  });

  it('reads genre_ids[] when present', () => {
    const out = hydrateBook({ title: 'T', genre_ids: [5, 8, 12] });
    expect(out.genre_ids).toEqual([5, 8, 12]);
  });

  it('falls back to genre_id when genre_ids absent (legacy mono)', () => {
    const out = hydrateBook({ title: 'T', genre_id: 42 });
    expect(out.genre_ids).toEqual([42]);
  });

  it('prefers genre_ids over genre_id when both present', () => {
    const out = hydrateBook({ genre_ids: [1, 2], genre_id: 99 });
    expect(out.genre_ids).toEqual([1, 2]);
  });

  it('converts string IDs to numbers', () => {
    const out = hydrateBook({ genre_ids: ['5', '12'] });
    expect(out.genre_ids).toEqual([5, 12]);
  });

  it('filters out NaN entries', () => {
    const out = hydrateBook({ genre_ids: ['5', 'abc', null, undefined, 10] });
    expect(out.genre_ids).toEqual([5, 10]);
  });

  it('returns empty genre_ids when neither field set', () => {
    const out = hydrateBook({ title: 'T' });
    expect(out.genre_ids).toEqual([]);
  });

  it('empty string genre_id is ignored', () => {
    const out = hydrateBook({ genre_id: '' });
    expect(out.genre_ids).toEqual([]);
  });

  it('empty array genre_ids falls back to genre_id', () => {
    const out = hydrateBook({ genre_ids: [], genre_id: 7 });
    expect(out.genre_ids).toEqual([7]);
  });

  it('preserves other book fields', () => {
    const out = hydrateBook({
      id: 123,
      title: 'Livre test',
      isbn: '9782336127903',
      price_ttc: 5000,
      genre_id: 75,
    });
    expect(out.id).toBe(123);
    expect(out.title).toBe('Livre test');
    expect(out.isbn).toBe('9782336127903');
    expect(out.price_ttc).toBe(5000);
    expect(out.genre_ids).toEqual([75]);
  });
});
