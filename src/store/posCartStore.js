import { create } from 'zustand';
import { persist } from 'zustand/middleware';

function calcLineTotal(price, qty, discount) {
  // Le franc CFA (XOF) n'a pas de décimales — arrondir chaque total de ligne à l'entier.
  return Math.round(qty * price * (1 - (discount || 0) / 100));
}

// Identifiant unique de vente — sert de clé d'idempotence côté serveur.
// crypto.getRandomValues fonctionne aussi en contexte non sécurisé (HTTP).
function genSaleId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* fallback ci-dessous */ }
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const usePosCartStore = create(persist((set, get) => ({
  items: [],
  customer: null,
  held: [],
  saleId: null,
  selectedItemId: null,

  setSelectedItem: (id) => set({ selectedItemId: id }),

  getSelectedItem: () => {
    const id = get().selectedItemId;
    if (!id) return null;
    return get().items.find((i) => i.product_id === id) || null;
  },

  // Modifie le prix d'une ligne. Pour les produits référencés (non `is_free`),
  // un `reason` non vide est requis : il est attaché à la ligne pour l'audit
  // (envoyé au serveur et tracé dans la note de facture). Pour les produits
  // libres, le prix est libre par construction et `reason` est optionnel.
  setPrice: (productId, price, reason) => {
    const p = Math.max(0, parseInt(price, 10) || 0);
    set({
      items: get().items.map((i) => {
        if (i.product_id !== productId) return i;
        const overridden = !i.is_free && p !== Math.round(i.price_original ?? i.price_ttc);
        return {
          ...i,
          price_ttc: p,
          // Conserve le prix de référence initial à la première modification
          price_original: i.price_original ?? (i.is_free ? null : i.price_ttc),
          price_override_reason: overridden ? (reason || i.price_override_reason || null) : null,
          line_total: calcLineTotal(p, i.qty, i.discount),
        };
      }),
    });
  },

  addItem: (product) => {
    const items = get().items;
    const existing = items.find((i) => i.product_id === product.id);
    if (existing) {
      set({
        items: items.map((i) =>
          i.product_id === product.id
            ? { ...i, qty: i.qty + 1, line_total: calcLineTotal(i.price_ttc, i.qty + 1, i.discount) }
            : i
        ),
      });
    } else {
      set({
        items: [
          ...items,
          {
            product_id: product.id,
            ref: product.ref,
            label: product.label,
            price_ttc: parseFloat(product.price_ttc),
            qty: 1,
            discount: 0,
            line_total: calcLineTotal(parseFloat(product.price_ttc), 1, 0),
            stock: product.stock_reel,
            is_free: product.is_free === true,
          },
        ],
        saleId: get().saleId || genSaleId(),
      });
    }
  },

  removeItem: (productId) => {
    set({
      items: get().items.filter((i) => i.product_id !== productId),
      selectedItemId: get().selectedItemId === productId ? null : get().selectedItemId,
    });
  },

  updateQty: (productId, qty) => {
    if (qty <= 0) {
      get().removeItem(productId);
      return;
    }
    set({
      items: get().items.map((i) =>
        i.product_id === productId
          ? { ...i, qty, line_total: calcLineTotal(i.price_ttc, qty, i.discount) }
          : i
      ),
    });
  },

  setDiscount: (productId, discount) => {
    const d = Math.max(0, Math.min(100, discount || 0));
    set({
      items: get().items.map((i) =>
        i.product_id === productId
          ? { ...i, discount: d, line_total: calcLineTotal(i.price_ttc, i.qty, d) }
          : i
      ),
    });
  },

  setCustomer: (customer) => set({ customer }),

  clearTicket: () => set({ items: [], customer: null, saleId: null, selectedItemId: null }),

  holdTicket: () => {
    const { items, customer, held, saleId } = get();
    if (items.length === 0) return;
    set({
      held: [...held, { items, customer, saleId, timestamp: Date.now() }],
      items: [],
      customer: null,
      saleId: null,
      selectedItemId: null,
    });
  },

  recallTicket: (index) => {
    const held = [...get().held];
    if (index < 0 || index >= held.length) return;
    const ticket = held.splice(index, 1)[0];
    set({ items: ticket.items, customer: ticket.customer, saleId: ticket.saleId || null, held });
  },

  // Garantit un identifiant de vente stable (pour les paniers déjà persistés
  // avant l'introduction de l'idempotence).
  ensureSaleId: () => {
    let id = get().saleId;
    if (!id) { id = genSaleId(); set({ saleId: id }); }
    return id;
  },

  getTotal: () => get().items.reduce((sum, i) => sum + i.line_total, 0),

  getItemCount: () => get().items.reduce((sum, i) => sum + i.qty, 0),
}), { name: 'senharmattan-pos-cart' }));

export default usePosCartStore;
