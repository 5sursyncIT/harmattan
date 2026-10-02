import { describe, it, expect } from 'vitest';
import { creditableLines } from './invoices-routes.js';

// Faux pool : 1re requête = lignes de la facture, 2e = déjà crédité par les avoirs.
function fakePool(lines, credited) {
  return {
    query: async (sql) => [/fk_facture_source/.test(sql) ? credited : lines],
  };
}

const book = (fk_product, qty, subprice = 5000) => ({
  fk_product, qty, subprice, remise_percent: 0, tva_tx: 0, product_type: 0,
  description: '', total_ttc: qty * subprice, product_ref: `REF${fk_product}`, product_label: `Livre ${fk_product}`,
});

describe('creditableLines', () => {
  it('sans avoir antérieur, reprend toute la facture', async () => {
    const out = await creditableLines(fakePool([book(1, 5), book(2, 2)], []), 10);
    expect(out.map(l => l.qty)).toEqual([5, 2]);
    expect(out.every(l => l.credited_qty === 0)).toBe(true);
  });

  it('déduit un retour caisse partiel', async () => {
    const out = await creditableLines(fakePool([book(1, 5), book(2, 2)], [{ fk_product: 1, qty: 2, amount: 10000 }]), 10);
    expect(out.map(l => l.qty)).toEqual([3, 2]);
    expect(out[0].credited_qty).toBe(2);
  });

  it('ne reprend rien si tout a déjà été crédité (second avoir)', async () => {
    const out = await creditableLines(fakePool(
      [book(1, 5), book(2, 2)],
      [{ fk_product: 1, qty: 5, amount: 25000 }, { fk_product: 2, qty: 2, amount: 10000 }],
    ), 10);
    expect(out.filter(l => l.qty > 0)).toHaveLength(0);
  });

  it('répartit un même produit présent sur plusieurs lignes', async () => {
    const out = await creditableLines(fakePool([book(1, 3), book(1, 4)], [{ fk_product: 1, qty: 5, amount: 0 }]), 10);
    expect(out.map(l => l.qty)).toEqual([0, 2]);
  });

  it('déduit les lignes libres en montant', async () => {
    const free = { ...book(null, 1, 20000), fk_product: null, product_label: null, description: 'Frais' };
    const full = await creditableLines(fakePool([free], [{ fk_product: null, qty: 1, amount: 20000 }]), 10);
    expect(full[0].qty).toBe(0);
    const part = await creditableLines(fakePool([free], [{ fk_product: null, qty: 1, amount: 5000 }]), 10);
    expect(part[0]).toMatchObject({ qty: 1, subprice: 15000 });
  });
});
