import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// La session POS est portée par un cookie HttpOnly côté serveur — aucun token
// n'est conservé côté client. Le store ne garde que l'identité (affichage/UI).
const usePosAuthStore = create(
  persist(
    (set) => ({
      staff: null,
      isAuthenticated: false,

      login: (data) => set({ staff: { id: data.id, name: data.name, role: data.role }, isAuthenticated: true }),
      logout: () => set({ staff: null, isAuthenticated: false }),
    }),
    {
      name: 'senharmattan-pos-auth',
      partialize: (state) => ({
        staff: state.staff,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

export default usePosAuthStore;
