import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useAuthStore = create(
  persist(
    (set) => ({
      customer: null,
      isAuthenticated: false,

      login: (customer) => set({ customer, isAuthenticated: true }),

      logout: () => set({ customer: null, isAuthenticated: false }),

      updateCustomer: (data) =>
        set((state) => ({
          customer: { ...state.customer, ...data },
        })),
    }),
    {
      name: 'senharmattan-auth',
    }
  )
);

export default useAuthStore;
