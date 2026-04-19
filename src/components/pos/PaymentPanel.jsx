import { useState, useEffect } from 'react';
import { posCreateSale, posGetConfig } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import usePosAuthStore from '../../store/posAuthStore';
import { enqueueSale } from '../../utils/offlineQueue';
import { FiX, FiCheck, FiDelete, FiWifiOff } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './PaymentPanel.css';

const METHOD_ICONS = {
  LIQ: { emoji: '\u{1F4B5}', color: '#27ae60' },
  CB: { emoji: '\u{1F4B3}', color: '#2980b9' },
  CHQ: { emoji: '\u{1F4DD}', color: '#8e44ad' },
  WAVE: { emoji: '\u{1F30A}', color: '#3498db' },
  OM: { emoji: '\u{1F4F1}', color: '#e67e22' },
};

export default function PaymentPanel({ onClose, onComplete }) {
  const items = usePosCartStore((s) => s.items);
  const customer = usePosCartStore((s) => s.customer);
  const getTotal = usePosCartStore((s) => s.getTotal);
  // const staff = usePosAuthStore((s) => s.staff);

  const [methods, setMethods] = useState([]);
  const [selectedMethod, setSelectedMethod] = useState('LIQ');
  const [inputAmount, setInputAmount] = useState('');
  const [payments, setPayments] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');

  const total = getTotal();
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const remaining = total - totalPaid;
  const change = remaining < 0 ? Math.abs(remaining) : 0;

  useEffect(() => {
    posGetConfig()
      .then((res) => setMethods(res.data.paymentMethods))
      .catch(() => {});
  }, []);

  const handleNumpad = (val) => {
    if (val === 'C') { setInputAmount(''); return; }
    if (val === 'DEL') { setInputAmount((v) => v.slice(0, -1)); return; }
    if (val === '00') { setInputAmount((v) => v + '00'); return; }
    setInputAmount((v) => v + val);
  };

  const handleAddPayment = () => {
    const amount = parseInt(inputAmount) || remaining;
    if (amount <= 0) return;
    setPayments([...payments, { code: selectedMethod, amount, label: methods.find((m) => m.code === selectedMethod)?.label }]);
    setInputAmount('');
  };

  const handleRemovePayment = (index) => {
    setPayments(payments.filter((_, i) => i !== index));
  };

  const handleQuickPay = (code) => {
    // Quick pay: full remaining amount with selected method
    setPayments([...payments, { code, amount: remaining, label: methods.find((m) => m.code === code)?.label }]);
  };

  const handleValidate = async () => {
    if (remaining > 0) return;
    setProcessing(true);
    setError('');
    try {
      const result = await posCreateSale({
        items: items.map((i) => ({
          product_id: i.product_id,
          qty: i.qty,
          price_ttc: i.price_ttc,
          label: i.label,
        })),
        customer_id: customer?.id || null,
        payments: payments.map((p) => ({ code: p.code, amount: p.amount })),
      });
      onComplete(result.data);
    } catch (err) {
      // Network error — queue for later
      if (!err.response) {
        const saleData = {
          items: items.map((i) => ({ product_id: i.product_id, qty: i.qty, price_ttc: i.price_ttc, label: i.label, discount: i.discount })),
          customer_id: customer?.id || null,
          payments: payments.map((p) => ({ code: p.code, amount: p.amount })),
        };
        const count = enqueueSale(saleData);
        toast(`Hors ligne — vente mise en file d'attente (${count} en attente)`, { icon: '📡' });
        onComplete({ invoice_ref: `OFFLINE-${Date.now()}`, total_ttc: total, payments, staff: usePosAuthStore.getState().staff?.name, terminal: '-', offline: true });
        return;
      }
      setError(err.response?.data?.error || 'Erreur lors de la vente');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="pos-payment-overlay">
      <div className="pos-payment-panel">
        <div className="pos-payment-header">
          <h2>Encaissement</h2>
          <button className="pos-payment-close" onClick={onClose}><FiX size={22} /></button>
        </div>

        <div className="pos-payment-total">
          <span>Total</span>
          <span>{total.toLocaleString('fr-FR')} FCFA</span>
        </div>

        {/* Payment methods */}
        <div className="pos-payment-methods">
          {methods.map((m) => {
            const icon = METHOD_ICONS[m.code] || { emoji: '\u{1F4B0}', color: '#555' };
            return (
              <button
                key={m.code}
                className={`pos-pm-btn ${selectedMethod === m.code ? 'active' : ''}`}
                style={{ '--pm-color': icon.color }}
                onClick={() => { if (remaining > 0) { setSelectedMethod(m.code); if (payments.length === 0) handleQuickPay(m.code); } }}
              >
                <span className="pos-pm-emoji">{icon.emoji}</span>
                {m.label}
              </button>
            );
          })}
        </div>

        {/* Numpad for split payments */}
        {payments.length > 0 && remaining > 0 && (
          <div className="pos-payment-split">
            <div className="pos-payment-split-header">
              <span>Reste : {remaining.toLocaleString('fr-FR')} F</span>
              <select value={selectedMethod} onChange={(e) => setSelectedMethod(e.target.value)}>
                {methods.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
              </select>
            </div>
            <div className="pos-payment-input-row">
              <input
                type="text"
                className="pos-payment-amount-input"
                value={inputAmount}
                readOnly
                placeholder={remaining.toLocaleString('fr-FR')}
              />
              <button className="pos-payment-add-btn" onClick={handleAddPayment}>Ajouter</button>
            </div>
            <div className="pos-numpad-grid">
              {['7','8','9','4','5','6','1','2','3','C','0','00'].map((k) => (
                <button key={k} className="pos-numpad-key" onClick={() => handleNumpad(k)}>{k}</button>
              ))}
            </div>
          </div>
        )}

        {/* Added payments */}
        {payments.length > 0 && (
          <div className="pos-payment-list">
            {payments.map((p, i) => (
              <div key={i} className="pos-payment-line">
                <span>{METHOD_ICONS[p.code]?.emoji} {p.label}</span>
                <span>{p.amount.toLocaleString('fr-FR')} F</span>
                <button onClick={() => handleRemovePayment(i)}><FiX size={14} /></button>
              </div>
            ))}
          </div>
        )}

        {/* Change */}
        {change > 0 && (
          <div className="pos-payment-change">
            Rendu monnaie : <strong>{change.toLocaleString('fr-FR')} FCFA</strong>
          </div>
        )}

        {error && <div className="pos-payment-error">{error}</div>}

        {/* Validate */}
        <button
          className="pos-payment-validate"
          onClick={handleValidate}
          disabled={remaining > 0 || processing}
        >
          {processing ? 'Traitement...' : (
            <><FiCheck /> VALIDER LA VENTE</>
          )}
        </button>
      </div>
    </div>
  );
}
