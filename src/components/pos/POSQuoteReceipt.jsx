import { FiPrinter, FiX, FiDownload } from 'react-icons/fi';
import api from '../../api/dolibarr';
import './POSQuoteReceipt.css';

const BANK_INFO = {
  bank: 'CBAO CLAIR DE LUNE, AVENUE CHEIKH ANTA DIOP',
  iban: 'SN08 SN012 01212 036199352101 46',
  swift: 'CBAOSNDA',
  mobile: 'Code marchand OM 413513 ou WAVE 77 242 25 08',
};

export default function POSQuoteReceipt({ quote, onClose }) {
  const handlePrint = () => {
    const printContent = document.getElementById('pos-receipt-printable');
    if (!printContent) return;
    const win = window.open('', '_blank', 'width=800,height=1100');
    win.document.write(`<!DOCTYPE html><html><head><title>Facture Proforma ${quote.ref}</title>
      <style>
        body { margin: 0; padding: 0; background: #fff; font-family: 'Segoe UI', Tahoma, sans-serif; }
        .quote-a4 { width: 210mm; padding: 12mm 15mm; margin: 0 auto; font-size: 11pt; color: #222; position: relative; display: flex; flex-direction: column; min-height: 297mm; }
        .quote-watermark { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 380px; height: 380px; object-fit: contain; opacity: 0.05; pointer-events: none; z-index: 0; }
        .quote-accent-bar { height: 6px; background: linear-gradient(90deg, #1e3a2f 0%, #0b6e4f 40%, #0b4f6c 100%); border-radius: 3px; margin-bottom: 20px; }
        .quote-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 2px solid #1e3a2f; }
        .quote-company { display: flex; gap: 14px; align-items: flex-start; }
        .quote-logo { width: 100px; height: auto; }
        .quote-company h1 { margin: 0; font-size: 18pt; color: #1e3a2f; font-weight: 800; }
        .quote-company .subtitle { margin: 2px 0 0; font-size: 9.5pt; color: #0b6e4f; font-weight: 600; font-style: italic; }
        .quote-company .contact-line { margin: 1px 0; font-size: 8.5pt; color: #555; }
        .quote-ref-box { text-align: right; }
        .quote-ref-label { font-size: 13pt; font-weight: 800; color: #fff; background: linear-gradient(135deg, #1e3a2f, #0b4f6c); padding: 8px 18px; border-radius: 6px; letter-spacing: 1.5px; display: inline-block; }
        .quote-ref-num { font-size: 12pt; font-weight: 700; color: #e8772e; margin: 8px 0 2px; }
        .quote-ref-date { font-size: 9pt; color: #666; }
        .quote-client-box { background: linear-gradient(135deg, #f0f7f4, #eef4f8); border: 1px solid #c8ddd4; border-left: 4px solid #0b6e4f; border-radius: 6px; padding: 12px 16px; margin-bottom: 24px; max-width: 300px; margin-left: auto; }
        .quote-client-label { font-size: 8pt; text-transform: uppercase; letter-spacing: 1.5px; color: #0b6e4f; margin-bottom: 4px; font-weight: 700; }
        .quote-client-name { font-size: 12pt; font-weight: 700; color: #1e3a2f; }
        .quote-client-detail { font-size: 9pt; color: #555; margin-top: 2px; }
        .quote-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        .quote-table thead tr { background: linear-gradient(135deg, #1e3a2f, #0b4f6c); color: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .quote-table th { padding: 10px 12px; font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .quote-table td { padding: 10px 12px; border-bottom: 1px solid #e2ebe7; font-size: 10pt; }
        .quote-table tbody tr:nth-child(even) { background: #f8fbf9; }
        .quote-table tbody tr:last-child td { border-bottom: 2px solid #1e3a2f; }
        .quote-col-num { width: 30px; text-align: center; }
        .quote-col-isbn { width: 110px; text-align: left; font-family: monospace; font-size: 8.5pt; }
        .quote-col-desc { text-align: left; }
        .quote-col-qty { width: 50px; text-align: center; }
        .quote-col-pu { width: 90px; text-align: right; }
        .quote-col-discount { width: 60px; text-align: center; font-weight: 600; color: #e8772e; }
        .quote-col-total { width: 90px; text-align: right; font-weight: 700; }
        .quote-totals { display: flex; flex-direction: column; align-items: flex-end; margin-bottom: 12px; }
        .quote-total-row { display: flex; justify-content: space-between; width: 260px; padding: 6px 12px; font-size: 10pt; }
        .quote-total-row.main { background: linear-gradient(135deg, #1e3a2f, #0b4f6c); color: #fff; font-size: 13pt; font-weight: 800; border-radius: 6px; padding: 10px 16px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .quote-amount-words { font-size: 9pt; font-style: italic; color: #666; text-align: right; margin-bottom: 24px; }
        .quote-conditions { background: linear-gradient(135deg, #f0f7f4, #eef4f8); border-radius: 8px; padding: 14px 18px; margin-bottom: 20px; border: 1px solid #d4e5dc; }
        .quote-conditions h4 { margin: 0 0 6px; font-size: 10pt; color: #1e3a2f; }
        .quote-conditions ul { margin: 0; padding-left: 18px; }
        .quote-conditions li { font-size: 9pt; color: #555; margin-bottom: 3px; }
        .quote-page-footer { margin-top: auto; padding-top: 0; }
        .quote-bank-section { background: #f8fbf9; border: 1px solid #d4e5dc; border-radius: 6px; padding: 10px 16px; margin-bottom: 12px; display: flex; gap: 24px; align-items: center; }
        .quote-bank-title { font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; color: #0b6e4f; font-weight: 700; margin-bottom: 4px; }
        .quote-bank-detail { font-size: 8.5pt; color: #444; }
        .quote-bank-detail strong { color: #1e3a2f; }
        .quote-signature { margin-bottom: 12px; font-size: 9pt; color: #555; }
        .quote-signature strong { color: #222; }
        .quote-footer-bar { background: linear-gradient(135deg, #1e3a2f, #0b4f6c); color: #fff; border-radius: 4px; padding: 8px 14px; text-align: center; line-height: 1.5; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        .quote-footer-bar .footer-line { font-size: 7.5pt; font-weight: 500; }
        .quote-footer-bar .footer-line.legal { font-size: 7pt; opacity: 0.8; margin-top: 1px; }
        @page { size: A4 portrait; margin: 0; }
      </style></head><body>`);
    win.document.write(printContent.outerHTML);
    win.document.write('</body></html>');
    win.document.close();
    setTimeout(() => { win.print(); win.close(); }, 500);
  };

  const handleDownloadODT = async () => {
    try {
      const res = await api.get(`/pos/quotes/${quote.ref}/odt`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${quote.ref}.odt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Erreur lors du téléchargement');
    }
  };

  const validityDate = new Date(quote.date);
  validityDate.setDate(validityDate.getDate() + (quote.validity_days || 30));
  const createdDate = new Date(quote.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

  return (
    <div className="quote-overlay">
      <div className="quote-actions no-print">
        <button className="quote-btn-print" onClick={handlePrint}>
          <FiPrinter /> Imprimer
        </button>
        <button className="quote-btn-download" onClick={handleDownloadODT}>
          <FiDownload /> Telecharger ODT
        </button>
        <button className="quote-btn-close" onClick={onClose}>
          <FiX /> Fermer
        </button>
      </div>

      <div className="quote-a4" id="pos-receipt-printable">
        <img src="/images/logo.png" alt="" className="quote-watermark" />

        {/* Accent bar */}
        <div className="quote-accent-bar" />

        {/* Header */}
        <div className="quote-header">
          <div className="quote-company">
            <img src="/images/logo.png" alt="Logo" className="quote-logo" />
            <div>
              <h1>L'Harmattan Sénégal</h1>
              <p className="subtitle">Édition - Librairie - Diffusion</p>
              <p className="contact-line">Tél : +221 33 825 98 58 / +221 70 953 02 40</p>
              <p className="contact-line">Email : commandes@senharmattan.com</p>
            </div>
          </div>
          <div className="quote-ref-box">
            <div className="quote-ref-label">FACTURE PROFORMA</div>
            <div className="quote-ref-num">{quote.ref}</div>
            <div className="quote-ref-date">Dakar, le {createdDate}</div>
          </div>
        </div>

        {/* Client */}
        <div className="quote-client-box">
          <div className="quote-client-label">Client</div>
          <div className="quote-client-name">{quote.customer_name}</div>
          {quote.customer_phone && <div className="quote-client-detail">{quote.customer_phone}</div>}
          {quote.customer_email && <div className="quote-client-detail">{quote.customer_email}</div>}
        </div>

        {/* Table */}
        <table className="quote-table">
          <thead>
            <tr>
              <th className="quote-col-num">#</th>
              <th className="quote-col-isbn">ISBN</th>
              <th className="quote-col-desc">Désignation</th>
              <th className="quote-col-qty">Qté</th>
              <th className="quote-col-pu">Prix Unitaire</th>
              {quote.items?.some(i => i.discount > 0) && <th className="quote-col-discount">Remise</th>}
              <th className="quote-col-total">Total</th>
            </tr>
          </thead>
          <tbody>
            {quote.items?.map((item, i) => {
              const lineTotal = item.line_total || item.qty * item.price_ttc * (1 - (item.discount || 0) / 100);
              return (
                <tr key={i}>
                  <td className="quote-col-num">{i + 1}</td>
                  <td className="quote-col-isbn">{item.ref || ''}</td>
                  <td className="quote-col-desc">
                    <span className="quote-item-label">{item.label}</span>
                  </td>
                  <td className="quote-col-qty">{item.qty}</td>
                  <td className="quote-col-pu">{parseInt(item.price_ttc).toLocaleString('fr-FR')}</td>
                  {quote.items?.some(i => i.discount > 0) && <td className="quote-col-discount">{item.discount > 0 ? `-${item.discount}%` : ''}</td>}
                  <td className="quote-col-total">{Math.round(lineTotal).toLocaleString('fr-FR')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Totals */}
        <div className="quote-totals">
          <div className="quote-total-row main">
            <span>Total TTC</span>
            <span>{quote.total_ttc?.toLocaleString('fr-FR')} FCFA</span>
          </div>
        </div>

        {/* Amount in words */}
        <div className="quote-amount-words">
          Montant en lettres : {quote.total_ttc ? numberToWordsFR(quote.total_ttc) + ' Francs CFA' : '—'}
        </div>

        {/* Conditions */}
        <div className="quote-conditions">
          <h4>Conditions</h4>
          <ul>
            <li>Cette facture proforma est valable <strong>{quote.validity_days || 30} jours</strong> à compter de sa date d'émission (jusqu'au {validityDate.toLocaleDateString('fr-FR')}).</li>
            <li>Paiement accepté par : Espèces, Carte bancaire, Wave, Orange Money, Virement bancaire.</li>
          </ul>
        </div>

        {/* Footer */}
        <div className="quote-page-footer">
          {/* Signature */}
          <div className="quote-signature">
            <p>Établi par : <strong>{quote.staff}</strong> — Terminal {quote.terminal}</p>
          </div>

          {/* Bank info */}
          <div className="quote-bank-section">
            <div>
              <div className="quote-bank-title">Coordonnées bancaires</div>
              <div className="quote-bank-detail">
                <strong>Banque : {BANK_INFO.bank}</strong>
              </div>
              <div className="quote-bank-detail">
                IBAN : {BANK_INFO.iban} — SWIFT : {BANK_INFO.swift}
              </div>
              <div className="quote-bank-detail" style={{ marginTop: 3 }}>
                {BANK_INFO.mobile}
              </div>
            </div>
          </div>

          {/* Footer bar */}
          <div className="quote-footer-bar">
            <div className="footer-line">Immeuble L'HARMATTAN, 10 VDN Sicap Amitié 3, Lotissement Cité Police — BP 45034 Dakar Fann</div>
            <div className="footer-line">Tél : (+221) 33 825 98 58 / (+221) 77 242 25 08 — www.senharmattan.com</div>
            <div className="footer-line legal">SARL au Capital de 1 000 000 FCFA — NINEA : 004067155 — RC : SN DKR 2009-B-11.042</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function numberToWordsFR(n) {
  n = Math.round(n);
  if (n === 0) return 'zéro';
  const units = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
  const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];
  function chunk(num) {
    if (num === 0) return '';
    if (num < 20) return units[num];
    if (num < 70) return tens[Math.floor(num / 10)] + (num % 10 === 1 ? ' et un' : num % 10 ? '-' + units[num % 10] : '');
    if (num < 80) return 'soixante' + (num % 20 === 1 ? ' et onze' : '-' + units[10 + num % 10]);
    if (num < 100) return 'quatre-vingt' + (num % 20 === 0 ? 's' : '-' + units[num % 20 < 20 ? num % 20 : num % 10]);
    if (num < 200) return 'cent' + (num % 100 === 0 ? '' : ' ' + chunk(num % 100));
    if (num < 1000) return units[Math.floor(num / 100)] + ' cent' + (num % 100 === 0 ? 's' : ' ' + chunk(num % 100));
    if (num < 2000) return 'mille' + (num % 1000 === 0 ? '' : ' ' + chunk(num % 1000));
    if (num < 1000000) return chunk(Math.floor(num / 1000)) + ' mille' + (num % 1000 === 0 ? '' : ' ' + chunk(num % 1000));
    return String(num);
  }
  return chunk(n);
}
