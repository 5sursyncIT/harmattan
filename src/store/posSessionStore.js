import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const usePosSessionStore = create(
  persist(
    (set) => ({
      session: null,
      isOpen: false,

      openSession: (session) => set({ session, isOpen: true }),
      closeSession: () => set({ session: null, isOpen: false }),
    }),
    { name: 'senharmattan-pos-session' }
  )
);

export default usePosSessionStore;
