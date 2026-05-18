// Configuration locale (par poste caisse) du bridge d'impression QZ Tray.
// Persistée dans localStorage — chaque terminal peut avoir sa propre imprimante.
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const usePosPrinterStore = create(
  persist(
    (set) => ({
      // Connexion QZ Tray
      qzAvailable: false,   // QZ Tray installé + websocket joignable
      connecting: false,
      lastError: null,

      // Config
      printerName: '',      // ex: "EPSON TM-T20III Receipt"
      paperWidth: 80,       // 58 ou 80 (mm)
      autoPrint: true,      // Imprimer automatiquement après encaissement
      openCashDrawer: false, // Ouvrir le tiroir-caisse sur vente espèces

      // Actions
      setConfig: (patch) => set(patch),
      setConnection: ({ qzAvailable, connecting = false, lastError = null }) =>
        set({ qzAvailable, connecting, lastError }),
    }),
    {
      name: 'pos-printer-config',
      partialize: (s) => ({
        printerName: s.printerName,
        paperWidth: s.paperWidth,
        autoPrint: s.autoPrint,
        openCashDrawer: s.openCashDrawer,
      }),
    }
  )
);

export default usePosPrinterStore;
