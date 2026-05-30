import { useState, useEffect, useRef } from 'react';
import { FiX, FiSearch, FiArrowLeft, FiCheck, FiClock } from 'react-icons/fi';
import { posGetUnpaidInvoices, posSettleInvoice, posGetConfig } from '../../api/pos';
import toast from 'react-hot-toast';
import './POSSettleUnpaid.css';

const FALLBACK_METHODS = [
  { code: 'LIQ', label: 'Espèces' }, { code: 'CB', label: 'Carte bancaire' },
  { code: 'CHQ', label: 'Chèque' }, { code: 'WAVE', label: 'Wave' }, { code: 'OM', label: 'Orange Money' },
];

export default function POSSettleUnpaid({ onClose, onSettled, initialRef = '' }) {
  const [q, setQ] = useState(initialRef);
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [methods, setMethods] = useState(FALLBACK_METHODS);
  const [method, setMethod] = useState('LIQ');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const autoPicked = useRef(false);

  const load = (query) => {
    setLoading(true);
    posGetUnpaidInvoices(query)
      .then(r => {
        const invoices = r.data.invoices || [];
        setList(invoices);
        // Ouvert depuis l'historique sur une réf précise : sélection directe si
        // la recherche ne renvoie que cette facture (évite un clic de plus).
        if (initialRef && !autoPicked.current && invoices.length === 1) {
          autoPicked.current = true;
          pick(invoices[0]);
        }
      })
      .catch(() => toast.error('Erreur chargement'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(initialRef); posGetConfig().then(r => { if (r.data?.paymentMethods?.length) setMethods(r.data.paymentMethods); }).catch(() => {}); }, []);

  const onSearch = (v) => {
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => load(v), 300);
  };

  const pick = (inv) => { setSelected(inv); setAmount(String(Math.round(inv.remaining))); setMethod('LIQ'); };

  const settle = async () => {
    const amt = Math.min(parseInt(amount, 10) || 0, Math.round(selected.remaining));
    if (amt <= 0) return toast.error('Montant invalide');
    setBusy(true);
    try {
      const { data } = await posSettleInvoice(selected.id, [{ code: method, amount: amt }]);
      toast.success(data.fully_paid ? `Facture ${data.invoice_ref} soldée` : `Règlement partiel — reste ${Math.round(data.remaining).toLocaleString('fr-FR')} F`);
      onSettled?.();
      setSelected(null);
      load(q);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur règlement');
    } finally { setBusy(false); }
  };

  return (
    <div className="pos-su-overlay" onClick={onClose}>
      <div className="pos-su-panel" onClick={e => e.stopPropagation()}>
        <div className="pos-su-header">
          <h2>{selected ? <><button className="pos-su-back" onClick={() => setSelected(null)}><FiArrowLeft /></button> Règlement</> : <><FiClock /> Encaisser un impayé</>}</h2>
          <button className="pos-su-close" onClick={onClose}><FiX size={22} /></button>
        </div>

        {!selected ? (
          <>
            <div className="pos-su-search">
              <FiSearch size={16} />
              <input autoFocus value={q} onChange={e => onSearch(e.target.value)} placeholder="N° facture ou nom du client..." />
            </div>
            {loading ? (
              <div className="pos-su-empty">Chargement…</div>
            ) : list.length === 0 ? (
              <div className="pos-su-empty"><FiCheck size={32} /><p>Aucune facture impayée</p></div>
            ) : (
              <div className="pos-su-list">
                {list.map(inv => (
                  <button key={inv.id} className="pos-su-item" onClick={() => pick(inv)}>
                    <div className="pos-su-item-main">
                      <span className="pos-su-ref">{inv.ref}</span>
                      <span className="pos-su-cust">{inv.customer_name}</span>
                    </div>
                    <div className="pos-su-item-amt">
                      <span className="pos-su-remaining">{Math.round(inv.remaining).toLocaleString('fr-FR')} F</span>
                      {inv.paid > 0 && <span className="pos-su-paid">déjà {Math.round(inv.paid).toLocaleString('fr-FR')} F</span>}
                      <span className="pos-su-date">{inv.date}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="pos-su-settle">
            <div className="pos-su-inv-card">
              <div><strong>{selected.ref}</strong> · {selected.customer_name}</div>
              <div className="pos-su-due">Reste à payer : <strong>{Math.round(selected.remaining).toLocaleString('fr-FR')} FCFA</strong></div>
            </div>

            <label className="pos-su-label">Moyen de paiement</label>
            <div className="pos-su-methods">
              {methods.map(m => (
                <button key={m.code} className={`pos-su-method ${method === m.code ? 'active' : ''}`} onClick={() => setMethod(m.code)}>{m.label}</button>
              ))}
            </div>

            <label className="pos-su-label">Montant reçu</label>
            <input className="pos-su-amount" type="number" min={1} max={Math.round(selected.remaining)} value={amount}
              onChange={e => setAmount(e.target.value)} />
            <div className="pos-su-quick">
              <button onClick={() => setAmount(String(Math.round(selected.remaining)))}>Tout ({Math.round(selected.remaining).toLocaleString('fr-FR')} F)</button>
            </div>

            <button className="pos-su-confirm" onClick={settle} disabled={busy}>
              {busy ? 'Règlement…' : <><FiCheck /> Enregistrer le règlement</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
