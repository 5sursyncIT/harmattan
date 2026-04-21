import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const useAuthorAuthStore = create(
  persist(
    (set) => ({
      author: null,
      isAuthenticated: false,

      login: (author) => set({ author, isAuthenticated: true }),
      logout: () => set({ author: null, isAuthenticated: false }),
      update: (data) =>
        set((state) => ({ author: { ...state.author, ...data } })),
    }),
    { name: 'senharmattan-author-auth' }
  )
);

export default useAuthorAuthStore;
