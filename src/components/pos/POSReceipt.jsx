import { Fragment } from 'react';
import { FiPrinter, FiX } from 'react-icons/fi';
import './POSReceipt.css';

const PAYMENT_LABELS = {
  LIQ: 'Espèces', CB: 'Carte', CHQ: 'Chèque', WAVE: 'Wave', OM: 'Orange Money',
};

export default function POSReceipt({ sale, onClose }) {
  const handlePrint = () => window.print();

  const totalPaid = sale.payments?.reduce((s, p) => s + parseFloat(p.amount), 0) || 0;
  const change = totalPaid - (sale.total_ttc || 0);
  const itemCount = sale.items?.reduce((s, i) => s + i.qty, 0) || 0;

  return (
    <div className="pos-receipt-overlay">
      <div className="pos-receipt-panel">
        <div className="pos-receipt-actions no-print">
          <button className="pos-receipt-print" onClick={handlePrint}>
            <FiPrinter /> Imprimer
          </button>
          <button className="pos-receipt-close" onClick={onClose}>
            <FiX /> Nouveau ticket
          </button>
        </div>

        <div className="pos-receipt-ticket" id="pos-receipt-printable">
          {/* Header */}
          <div className="pos-receipt-header-section">
            <h2>L'HARMATTAN SENEGAL</h2>
            <p>Edition - Librairie - Diffusion</p>
            <p>10 VDN, Sicap Karak 45034, Dakar</p>
            <p>Tel: +221 33 825 98 58 / +221 70 953 02 40</p>
            <p>NINEA: 004067155 — RC: SN DKR 2009-B-11.042</p>
          </div>

          <div className="pos-receipt-divider" />

          {/* Meta */}
          <div className="pos-receipt-meta">
            <div className="pos-receipt-meta-row">
              <span>Facture:</span>
              <span>{sale.invoice_ref}</span>
            </div>
            <div className="pos-receipt-meta-row">
              <span>Date:</span>
              <span>{new Date().toLocaleDateString('fr-FR')} {new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="pos-receipt-meta-row">
              <span>Terminal:</span>
              <span>{sale.terminal} | {sale.staff}</span>
            </div>
            {sale.customer_name && sale.customer_name !== 'Client comptoir' && (
              <div className="pos-receipt-meta-row">
                <span>Client:</span>
                <span>{sale.customer_name}</span>
              </div>
            )}
          </div>

          <div className="pos-receipt-divider" />

          {/* Items */}
          <table className="pos-receipt-items">
            <thead>
              <tr>
                <th className="pos-receipt-th-label">Article</th>
                <th className="pos-receipt-th-qty">Qté</th>
                <th className="pos-receipt-th-pu">P.U.</th>
                <th className="pos-receipt-th-total">Total</th>
              </tr>
            </thead>
            <tbody>
              {sale.items?.map((item, i) => {
                const lineTotal = Math.round(item.line_total || item.qty * item.price_ttc * (1 - (item.discount || 0) / 100));
                return (
                  <Fragment key={i}>
                    <tr>
                      <td className="pos-receipt-item-label" colSpan={4}>
                        {item.label}
                        {item.discount > 0 && <span className="pos-receipt-discount"> (-{item.discount}%)</span>}
                      </td>
                    </tr>
                    <tr className="pos-receipt-item-detail">
                      <td></td>
                      <td className="pos-receipt-item-qty">{item.qty}</td>
                      <td className="pos-receipt-item-pu">{parseInt(item.price_ttc).toLocaleString('fr-FR')}</td>
                      <td className="pos-receipt-item-price">{lineTotal.toLocaleString('fr-FR')}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>

          <div className="pos-receipt-divider" />

          <div className="pos-receipt-item-count">{itemCount} article{itemCount > 1 ? 's' : ''}</div>

          <div className="pos-receipt-divider double" />

          {/* Total */}
          <div className="pos-receipt-total-line">
            <span>TOTAL TTC</span>
            <span>{sale.total_ttc?.toLocaleString('fr-FR')} FCFA</span>
          </div>

          <div className="pos-receipt-divider" />

          {/* Payments */}
          <div className="pos-receipt-payments-section">
            {sale.payments?.map((p, i) => (
              <div key={i} className="pos-receipt-payment-line">
                <span>{PAYMENT_LABELS[p.code] || p.code}</span>
                <span>{parseInt(p.amount).toLocaleString('fr-FR')} F</span>
              </div>
            ))}
            {change > 0 && (
              <div className="pos-receipt-payment-line pos-receipt-change">
                <span>Rendu monnaie</span>
                <span>{parseInt(change).toLocaleString('fr-FR')} F</span>
              </div>
            )}
          </div>

          <div className="pos-receipt-divider" />

          {/* Footer */}
          <div className="pos-receipt-footer">
            <p>Montants exprimés en Francs CFA BCEAO</p>
            <p>Exonéré de TVA</p>
            <p className="pos-receipt-thanks">Merci de votre visite !</p>
            <p>www.senharmattan.com</p>
          </div>
        </div>
      </div>
    </div>
  );
}
