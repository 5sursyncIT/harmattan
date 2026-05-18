// Orchestration d'impression ticket de caisse.
// Essaie QZ Tray (silencieux, thermique ESC/POS). Si indisponible, fallback
// vers window.print() sur le DOM rendu par <POSReceipt>.
import toast from 'react-hot-toast';
import usePosPrinterStore from '../store/posPrinterStore';
import { connectQz, isQzConnected, detectEpsonPrinter, printRaw } from './qz';
import { buildSaleReceipt } from './escpos';

async function ensurePrinter() {
  const { printerName } = usePosPrinterStore.getState();
  if (printerName) return printerName;
  const detected = await detectEpsonPrinter();
  if (detected) {
    usePosPrinterStore.getState().setConfig({ printerName: detected });
    return detected;
  }
  return null;
}

// Tente une impression thermique via QZ Tray.
// Retourne true si succès, false si indisponible (→ fallback).
export async function printSaleReceipt(sale, { silent = false } = {}) {
  const { paperWidth, openCashDrawer } = usePosPrinterStore.getState();
  try {
    if (!isQzConnected()) await connectQz();
  } catch {
    usePosPrinterStore.getState().setConnection({ qzAvailable: false });
    if (!silent) toast.error('QZ Tray non détecté — impression navigateur utilisée');
    return false;
  }

  const printer = await ensurePrinter();
  if (!printer) {
    usePosPrinterStore.getState().setConnection({ qzAvailable: true });
    if (!silent) toast.error('Aucune imprimante thermique détectée');
    return false;
  }

  try {
    const hasCash = (sale.payments || []).some((p) => p.code === 'LIQ' || p.code === 'ESP');
    const drawer = openCashDrawer && hasCash;
    const bytes = buildSaleReceipt(sale, { width: paperWidth, openDrawer: drawer });
    await printRaw(printer, bytes);
    usePosPrinterStore.getState().setConnection({ qzAvailable: true });
    if (!silent) toast.success('Ticket imprimé');
    return true;
  } catch (err) {
    console.error('Thermal print error:', err);
    usePosPrinterStore.getState().setConnection({ qzAvailable: false, lastError: String(err) });
    if (!silent) toast.error(`Échec impression thermique : ${err?.message || err}`);
    return false;
  }
}

// Impression de test (sans passer par une vente réelle)
export async function printTestTicket() {
  const testSale = {
    invoice_ref: 'TEST-000',
    terminal: 1,
    staff: 'TEST',
    items: [
      { label: 'Ticket de test - article exemple', qty: 1, price_ttc: 5000, line_total: 5000 },
    ],
    total_ttc: 5000,
    payments: [{ code: 'LIQ', amount: 5000 }],
  };
  return printSaleReceipt(testSale);
}

// Fallback : impression navigateur (window.print) sur le ticket DOM rendu
export function htmlPrintFallback() {
  window.print();
}
