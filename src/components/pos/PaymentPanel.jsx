import { useState, useEffect, useRef } from 'react';
import { posCreateSale, posGetConfig } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import usePosAuthStore from '../../store/posAuthStore';
import { enqueueSale } from '../../utils/offlineQueue';
import { FiX, FiCheck, FiClock } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './PaymentPanel.css';

const METHOD_ICONS = {
  LIQ: { emoji: '\u{1F4B5}', color: '#27ae60' },
  CB: { emoji: '\u{1F4B3}', color: '#2980b9' },
  CHQ: { emoji: '\u{1F4DD}', color: '#8e44ad' },
  WAVE: { img: '/images/wave.png', color: '#1dcfe1' },
  OM: { img: '/images/om.png', color: '#e67e22' },
};

// Liste de repli des moyens de paiement — utilisée si /pos/config est
// injoignable (mode hors ligne), pour ne jamais bloquer l'encaissement.
const FALLBACK_METHODS = [
  { code: 'LIQ', label: 'Espèces' },
  { code: 'CB', label: 'Carte bancaire' },
  { code: 'CHQ', label: 'Chèque' },
  { code: 'WAVE', label: 'Wave' },
  { code: 'OM', label: 'Orange Money' },
];
const METHODS_CACHE_KEY = 'pos-payment-methods';

export default function PaymentPanel({ onClose, onComplete, splitMode = false }) {
  const items = usePosCartStore((s) => s.items);
  const customer = usePosCartStore((s) => s.customer);
  const getTotal = usePosCartStore((s) => s.getTotal);
  const ensureSaleId = usePosCartStore((s) => s.ensureSaleId);
  // const staff = usePosAuthStore((s) => s.staff);

  const [methods, setMethods] = useState([]);
  const [selectedMethod, setSelectedMethod] = useState('LIQ');
  const [inputAmount, setInputAmount] = useState('');
  const [payments, setPayments] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  // Garde synchrone : neutralise un double-tap avant que `processing` ne soit rendu.
  const submittingRef = useRef(false);

  const total = getTotal();
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const remaining = total - totalPaid;
  const change = remaining < 0 ? Math.abs(remaining) : 0;

  useEffect(() => {
    posGetConfig()
      .then((res) => {
        const m = res.data?.paymentMethods?.length ? res.data.paymentMethods : FALLBACK_METHODS;
        setMethods(m);
        try { localStorage.setItem(METHODS_CACHE_KEY, JSON.stringify(m)); } catch { /* ignore */ }
      })
      .catch(() => {
        // Hors ligne : réutiliser le dernier config connu, sinon la liste de repli.
        let cached = [];
        try { cached = JSON.parse(localStorage.getItem(METHODS_CACHE_KEY) || '[]'); } catch { /* ignore */ }
        setMethods(cached.length ? cached : FALLBACK_METHODS);
      });
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

  // Mapping commun ticket → lignes serveur (réutilisé encaissement / crédit / offline).
  const buildItems = () => items.map((i) => i.is_free ? ({
    is_free: true, label: i.label, subprice: i.price_ttc, qty: i.qty, discount: i.discount || 0,
  }) : ({
    product_id: i.product_id, qty: i.qty, price_ttc: i.price_ttc, label: i.label, discount: i.discount || 0,
    price_override_reason: i.price_override_reason || undefined,
    price_original: i.price_original || undefined,
  }));

  // Émet une facture IMPAYÉE (à crédit) — aucun encaissement, réglable plus tard.
  // Exige un client identifié (la créance doit être attribuable).
  const handleCredit = async () => {
    if (submittingRef.current) return;
    if (!customer?.id) { setError('Sélectionnez un client pour une facture à crédit.'); return; }
    if (!window.confirm(`Émettre une facture IMPAYÉE de ${total.toLocaleString('fr-FR')} F au nom de ${customer.name} ?\nLe client réglera plus tard.`)) return;
    submittingRef.current = true;
    setProcessing(true);
    setError('');
    const saleId = ensureSaleId();
    try {
      const result = await posCreateSale({
        client_sale_id: saleId,
        items: buildItems(),
        customer_id: customer.id,
        payments: [],
        unpaid: true,
      });
      onComplete(result.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur lors de la facturation à crédit');
    } finally {
      submittingRef.current = false;
      setProcessing(false);
    }
  };

  const handleValidate = async () => {
    if (remaining > 0 || submittingRef.current) return;
    submittingRef.current = true;
    setProcessing(true);
    setError('');
    // Identifiant stable de la vente — clé d'idempotence partagée par les
    // chemins en ligne et hors ligne (rejeu, double soumission).
    const saleId = ensureSaleId();
    try {
      const result = await posCreateSale({
        client_sale_id: saleId,
        items: items.map((i) => i.is_free ? ({
          is_free: true,
          label: i.label,
          subprice: i.price_ttc,
          qty: i.qty,
          discount: i.discount || 0,
        }) : ({
          product_id: i.product_id,
          qty: i.qty,
          price_ttc: i.price_ttc,
          label: i.label,
          discount: i.discount || 0,
          // Le serveur n'applique l'override que si motif fourni (3-200 chars),
          // sinon repli sur le prix catalogue de confiance.
          price_override_reason: i.price_override_reason || undefined,
          price_original: i.price_original || undefined,
        })),
        customer_id: customer?.id || null,
        payments: payments.map((p) => ({ code: p.code, amount: p.amount })),
      });
      onComplete(result.data);
    } catch (err) {
      // Network error — queue for later
      if (!err.response) {
        const saleData = {
          client_sale_id: saleId,
          items: items.map((i) => i.is_free ? ({
            is_free: true,
            label: i.label,
            subprice: i.price_ttc,
            qty: i.qty,
            discount: i.discount || 0,
          }) : ({
            product_id: i.product_id,
            qty: i.qty,
            price_ttc: i.price_ttc,
            label: i.label,
            discount: i.discount,
            price_override_reason: i.price_override_reason || undefined,
            price_original: i.price_original || undefined,
          })),
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
      submittingRef.current = false;
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

        {splitMode && payments.length === 0 && (
          <div className="pos-payment-split-banner">
            Mode fractionné — saisissez le 1<sup>er</sup> montant puis touchez « Ajouter ». Répétez pour chaque moyen.
          </div>
        )}

        {/* Payment methods */}
        <div className="pos-payment-methods">
          {methods.map((m) => {
            const icon = METHOD_ICONS[m.code] || { emoji: '\u{1F4B0}', color: '#555' };
            return (
              <button
                key={m.code}
                className={`pos-pm-btn ${selectedMethod === m.code ? 'active' : ''}`}
                style={{ '--pm-color': icon.color }}
                onClick={() => {
                  if (remaining <= 0) return;
                  setSelectedMethod(m.code);
                  // En mode split : juste sélectionner, pas de quick-pay.
                  if (!splitMode && payments.length === 0) handleQuickPay(m.code);
                }}
              >
                <span className="pos-pm-emoji">
                  {icon.img ? <img src={icon.img} alt="" /> : icon.emoji}
                </span>
                {m.label}
              </button>
            );
          })}
        </div>

        {/* Numpad : visible dès l'ouverture en mode split, sinon après 1er paiement */}
        {((splitMode && remaining > 0) || (payments.length > 0 && remaining > 0)) && (
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
                <span>
                  {METHOD_ICONS[p.code]?.img
                    ? <img src={METHOD_ICONS[p.code].img} alt="" className="pos-pm-line-icon" />
                    : METHOD_ICONS[p.code]?.emoji} {p.label}
                </span>
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

        {/* Facturer à crédit (impayé) — réglable plus tard */}
        <button
          className="pos-payment-credit"
          onClick={handleCredit}
          disabled={processing || !customer?.id}
          title={!customer?.id ? 'Sélectionnez un client pour facturer à crédit' : ''}
        >
          <FiClock /> Facturer à crédit (impayé)
        </button>
        {!customer?.id && (
          <p className="pos-payment-credit-hint">Un client doit être sélectionné pour une facture à crédit.</p>
        )}
      </div>
    </div>
  );
}
