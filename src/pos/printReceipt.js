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

// Fallback : impression via une fenêtre dédiée contenant uniquement le
// ticket. Évite toute interaction CSS avec le DOM principal (overlay, modales,
// portails toast, Suspense…). Le pilote thermique (NetumScan POS-80) reçoit
// alors un document propre, paginé selon @page 80mm.
export function htmlPrintFallback(saleArg) {
  // On accepte un objet `sale` ; à défaut, on copie le contenu du ticket
  // actuellement affiché dans le DOM (#pos-receipt-printable).
  let receiptHtml = '';
  if (saleArg && typeof saleArg === 'object' && saleArg.invoice_ref) {
    receiptHtml = buildReceiptHtml(saleArg);
  } else {
    const src = document.getElementById('pos-receipt-printable');
    if (!src) {
      // Rien à imprimer : fallback ultime sur window.print() standard.
      window.print();
      return;
    }
    receiptHtml = src.outerHTML;
  }

  const w = window.open('', 'pos-print', 'width=420,height=700');
  if (!w) {
    // Popup bloquée — repli sur l'impression standard.
    window.print();
    return;
  }
  w.document.open();
  w.document.write(`<!doctype html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Ticket de caisse</title>
<style>
  @page { size: 80mm 3276mm; margin: 2mm; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    font-family: "Courier New", monospace;
  }
  body {
    width: 80mm;
    min-height: 20mm;
    padding: 4mm;
  }
  .no-print,
  .pos-receipt-actions {
    display: none !important;
  }
  #pos-receipt-printable {
    width: 72mm;
    max-width: 72mm;
    margin: 0;
    padding: 0;
    background: #fff;
    color: #000;
    font-size: 11px;
    line-height: 1.35;
    overflow: visible;
    box-shadow: none;
    border-radius: 0;
  }
  #pos-receipt-printable,
  #pos-receipt-printable * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    color: #000;
  }
  .pos-receipt-header-section { text-align: center; margin-bottom: 6px; }
  .pos-receipt-header-section h2 { margin: 0; font-size: 14px; letter-spacing: 1px; }
  .pos-receipt-header-section p { margin: 1px 0; font-size: 9px; }
  .pos-receipt-divider { border-bottom: 1px dashed #000; margin: 5px 0; }
  .pos-receipt-divider.double { border-bottom: 2px double #000; }
  .pos-receipt-meta { font-size: 10px; }
  .pos-receipt-meta-row,
  .pos-receipt-payment-line,
  .pos-receipt-total-line {
    display: flex;
    justify-content: space-between;
    gap: 4px;
  }
  .pos-receipt-meta-row span:last-child {
    text-align: right;
    word-break: break-word;
  }
  .pos-receipt-items {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  .pos-receipt-items th {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    padding: 3px 0;
    border-bottom: 1px solid #000;
  }
  .pos-receipt-items td {
    padding: 1px 0;
    font-size: 10px;
    vertical-align: top;
  }
  .pos-receipt-th-label { text-align: left; width: auto; }
  .pos-receipt-th-qty { text-align: center; width: 9mm; }
  .pos-receipt-th-pu { text-align: right; width: 16mm; }
  .pos-receipt-th-total { text-align: right; width: 17mm; }
  .pos-receipt-item-label {
    font-weight: 600;
    padding-top: 4px !important;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .pos-receipt-discount { font-weight: 400; font-size: 9px; }
  .pos-receipt-item-detail td { padding-bottom: 3px !important; }
  .pos-receipt-item-qty { text-align: center; }
  .pos-receipt-item-pu,
  .pos-receipt-item-price { text-align: right; }
  .pos-receipt-item-price { font-weight: 700; }
  .pos-receipt-item-count { text-align: center; font-size: 9px; padding: 2px 0; }
  .pos-receipt-total-line { font-size: 13px; font-weight: 900; padding: 4px 0; }
  .pos-receipt-payments-section { font-size: 10px; }
  .pos-receipt-change { font-weight: 700; border-top: 1px dashed #000; margin-top: 2px; padding-top: 3px; }
  .pos-receipt-footer { text-align: center; margin-top: 8px; font-size: 9px; }
  .pos-receipt-footer p { margin: 1px 0; }
  .pos-receipt-thanks { font-size: 11px; font-weight: 700; margin-top: 6px !important; }
  @media print {
    html, body {
      width: 80mm;
      margin: 0;
      padding: 0;
      overflow: visible;
    }
    body { padding: 0; }
    #pos-receipt-printable {
      width: 76mm;
      max-width: 76mm;
    }
  }
</style>
</head>
<body>
${receiptHtml}
</body>
</html>`);
  w.document.close();

  // Attend le rendu puis lance l'impression. On ne ferme la fenêtre qu'après
  // l'événement afterprint : fermer trop tôt rend l'aperçu Chrome blanc.
  const closeAfterPrint = () => {
    setTimeout(() => { try { w.close(); } catch { /* noop */ } }, 250);
  };
  w.onafterprint = closeAfterPrint;
  w.addEventListener?.('afterprint', closeAfterPrint);

  const startPrint = () => {
    w.focus();
    w.requestAnimationFrame(() => {
      w.requestAnimationFrame(() => w.print());
    });
  };

  if (w.document.readyState === 'complete') {
    startPrint();
  } else {
    w.onload = startPrint;
  }
}

// Construit le HTML du ticket à partir d'un objet sale (utilisé pour la
// réimpression sans avoir le DOM #pos-receipt-printable sous la main).
function buildReceiptHtml(sale) {
  const PAYMENT_LABELS = { LIQ: 'Espèces', CB: 'Carte', CHQ: 'Chèque', WAVE: 'Wave', OM: 'Orange Money' };
  const totalPaid = (sale.payments || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);
  const change = totalPaid - (sale.total_ttc || 0);
  const itemCount = (sale.items || []).reduce((s, i) => s + (i.qty || 0), 0);
  const now = new Date();
  const fmt = (n) => (parseInt(n) || 0).toLocaleString('fr-FR');
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const itemRows = (sale.items || []).map((it) => {
    const lineTotal = Math.round(it.line_total || (it.qty * it.price_ttc * (1 - (it.discount || 0) / 100)));
    return `
      <tr><td class="pos-receipt-item-label" colspan="4">${escape(it.label)}${it.discount > 0 ? ` <span class="pos-receipt-discount">(-${it.discount}%)</span>` : ''}</td></tr>
      <tr class="pos-receipt-item-detail"><td></td><td class="pos-receipt-item-qty">${it.qty}</td><td class="pos-receipt-item-pu">${fmt(it.price_ttc)}</td><td class="pos-receipt-item-price">${fmt(lineTotal)}</td></tr>
    `;
  }).join('');

  const paymentRows = (sale.payments || []).map((p) =>
    `<div class="pos-receipt-payment-line"><span>${escape(PAYMENT_LABELS[p.code] || p.code)}</span><span>${fmt(p.amount)} F</span></div>`,
  ).join('');

  return `
<div class="pos-receipt-ticket" id="pos-receipt-printable">
  <div class="pos-receipt-header-section">
    <h2>L'HARMATTAN SENEGAL</h2>
    <p>Edition - Librairie - Diffusion</p>
    <p>10 VDN, Sicap Karak 45034, Dakar</p>
    <p>Tel: +221 33 825 98 58 / +221 70 953 02 40</p>
    <p>NINEA: 004067155 — RC: SN DKR 2009-B-11.042</p>
  </div>
  <div class="pos-receipt-divider"></div>
  <div class="pos-receipt-meta">
    <div class="pos-receipt-meta-row"><span>Facture:</span><span>${escape(sale.invoice_ref || '')}</span></div>
    <div class="pos-receipt-meta-row"><span>Date:</span><span>${now.toLocaleDateString('fr-FR')} ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span></div>
    <div class="pos-receipt-meta-row"><span>Terminal:</span><span>${escape(sale.terminal || '')} | ${escape(sale.staff || '')}</span></div>
    ${sale.customer_name && sale.customer_name !== 'Client comptoir' ? `<div class="pos-receipt-meta-row"><span>Client:</span><span>${escape(sale.customer_name)}</span></div>` : ''}
  </div>
  <div class="pos-receipt-divider"></div>
  <table class="pos-receipt-items">
    <thead>
      <tr><th class="pos-receipt-th-label">Article</th><th class="pos-receipt-th-qty">Qté</th><th class="pos-receipt-th-pu">P.U.</th><th class="pos-receipt-th-total">Total</th></tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>
  <div class="pos-receipt-divider"></div>
  <div class="pos-receipt-item-count">${itemCount} article${itemCount > 1 ? 's' : ''}</div>
  <div class="pos-receipt-divider double"></div>
  <div class="pos-receipt-total-line"><span>TOTAL TTC</span><span>${fmt(sale.total_ttc)} FCFA</span></div>
  <div class="pos-receipt-divider"></div>
  <div class="pos-receipt-payments-section">
    ${paymentRows}
    ${change > 0 ? `<div class="pos-receipt-payment-line pos-receipt-change"><span>Rendu monnaie</span><span>${fmt(change)} F</span></div>` : ''}
  </div>
  <div class="pos-receipt-divider"></div>
  <div class="pos-receipt-footer">
    <p>Montants exprimés en Francs CFA BCEAO</p>
    <p>Exonéré de TVA</p>
    <p class="pos-receipt-thanks">Merci de votre visite !</p>
    <p>www.senharmattan.com</p>
  </div>
</div>`;
}
