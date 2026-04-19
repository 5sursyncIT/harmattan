import { create } from 'zustand';
import { persist } from 'zustand/middleware';

function calcLineTotal(price, qty, discount) {
  return qty * price * (1 - (discount || 0) / 100);
}

const usePosCartStore = create(persist((set, get) => ({
  items: [],
  customer: null,
  held: [],

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
            line_total: parseFloat(product.price_ttc),
            stock: product.stock_reel,
          },
        ],
      });
    }
  },

  removeItem: (productId) => {
    set({ items: get().items.filter((i) => i.product_id !== productId) });
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

  clearTicket: () => set({ items: [], customer: null }),

  holdTicket: () => {
    const { items, customer, held } = get();
    if (items.length === 0) return;
    set({
      held: [...held, { items, customer, timestamp: Date.now() }],
      items: [],
      customer: null,
    });
  },

  recallTicket: (index) => {
    const held = [...get().held];
    if (index < 0 || index >= held.length) return;
    const ticket = held.splice(index, 1)[0];
    set({ items: ticket.items, customer: ticket.customer, held });
  },

  getTotal: () => get().items.reduce((sum, i) => sum + i.line_total, 0),

  getItemCount: () => get().items.reduce((sum, i) => sum + i.qty, 0),
}), { name: 'senharmattan-pos-cart' }));

export default usePosCartStore;
