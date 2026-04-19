import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const usePosAuthStore = create(
  persist(
    (set) => ({
      staff: null,
      token: null,
      isAuthenticated: false,

      login: (data) => set({ staff: { id: data.id, name: data.name, role: data.role }, token: data.token, isAuthenticated: true }),
      logout: () => set({ staff: null, token: null, isAuthenticated: false }),
    }),
    {
      name: 'senharmattan-pos-auth',
      partialize: (state) => ({
        staff: state.staff,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

export default usePosAuthStore;
