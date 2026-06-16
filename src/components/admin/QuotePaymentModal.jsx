import { useState, useEffect } from 'react';
import { FiX, FiDollarSign } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { getQuote, getQuoteBanks, payQuote } from '../../api/quotes';
import { formatPrice } from '../../utils/formatters';

const METHODS = [
  { code: 'LIQ', label: 'Espèces' },
  { code: 'WAVE', label: 'Wave' },
  { code: 'OM', label: 'Orange Money' },
  { code: 'CB', label: 'Carte bancaire' },
  { code: 'CHQ', label: 'Chèque' },
  { code: 'VIR', label: 'Virement' },
];

// Modale d'encaissement d'un devis de contribution. Au premier encaissement, le
// backend crée la facture Dolibarr de l'auteur ; les appels suivants ajoutent des
// acomptes sur le reste à payer.
export default function QuotePaymentModal({ quote, onClose, onPaid }) {
  const [detail, setDetail] = useState(quote);
  const [banks, setBanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const total = Number(detail?.total) || 0;
  const remaining = detail?.remaining != null ? Number(detail.remaining) : total;
  const alreadyInvoiced = !!detail?.dolibarr_invoice_id;

  const [form, setForm] = useState({
    bank_account: '',
    method: 'LIQ',
    amount: '',
    date: new Date().toISOString().slice(0, 10),
    num_payment: '',
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([getQuote(quote.id), getQuoteBanks()])
      .then(([q, b]) => {
        if (cancelled) return;
        setDetail(q.data);
        const accts = b.data?.accounts || [];
        setBanks(accts);
        const rem = q.data?.remaining != null ? Number(q.data.remaining) : Number(q.data.total) || 0;
        setForm(f => ({ ...f, amount: String(Math.round(rem)), bank_account: accts[0] ? String(accts[0].id) : '' }));
      })
      .catch(() => { if (!cancelled) toast.error('Erreur de chargement'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [quote.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !submitting) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    const amount = Math.round(Number(form.amount));
    if (!(amount > 0)) return toast.error('Montant invalide');
    if (!form.bank_account) return toast.error('Compte bancaire requis');
    if (alreadyInvoiced && amount > remaining + 1) return toast.error(`Maximum ${formatPrice(remaining)} (reste à payer)`);
    setSubmitting(true);
    try {
      const res = await payQuote(quote.id, {
        bank_account: parseInt(form.bank_account),
        method: form.method,
        amount,
        date: form.date,
        num_payment: form.num_payment,
      });
      toast.success(res.data?.status === 'paid' ? 'Devis soldé' : 'Acompte enregistré');
      onPaid?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de l\'encaissement');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ct-modal-overlay" onClick={() => !submitting && onClose?.()}>
      <div className="ct-modal" style={{ maxWidth: 460, width: '100%' }} role="dialog" aria-modal="true" aria-label="Encaisser le devis" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h4 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiDollarSign /> Encaisser {detail?.ref}</h4>
          <button type="button" className="ct-btn-ghost" onClick={onClose} aria-label="Fermer"><FiX size={18} /></button>
        </div>

        {loading ? <p style={{ color: '#94a3b8' }}>Chargement…</p> : (
          <>
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 14, fontSize: '0.88rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#64748b' }}>Total du devis</span><strong>{formatPrice(total)}</strong></div>
              {alreadyInvoiced && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}><span style={{ color: '#64748b' }}>Déjà encaissé</span><strong>{formatPrice(total - remaining)}</strong></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}><span style={{ color: '#64748b' }}>Reste à payer</span><strong style={{ color: '#b45309' }}>{formatPrice(remaining)}</strong></div>
                </>
              )}
              {detail?.invoice_ref && <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#94a3b8' }}>Facture {detail.invoice_ref}</div>}
            </div>

            <div className="ct-form-row cols-2">
              <div className="ct-field">
                <label>Montant (FCFA) *</label>
                <input type="number" min={1} value={form.amount} onChange={e => set('amount', e.target.value)} />
              </div>
              <div className="ct-field">
                <label>Date</label>
                <input type="date" value={form.date} onChange={e => set('date', e.target.value)} />
              </div>
            </div>
            <div className="ct-form-row cols-2">
              <div className="ct-field">
                <label>Méthode *</label>
                <select value={form.method} onChange={e => set('method', e.target.value)}>
                  {METHODS.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
                </select>
              </div>
              <div className="ct-field">
                <label>Compte *</label>
                <select value={form.bank_account} onChange={e => set('bank_account', e.target.value)}>
                  <option value="">— choisir —</option>
                  {banks.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </div>
            </div>
            <div className="ct-form-row">
              <div className="ct-field">
                <label>Référence transaction (optionnel)</label>
                <input value={form.num_payment} onChange={e => set('num_payment', e.target.value)} maxLength={64} placeholder="N° Wave/OM, chèque…" />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button type="button" className="ct-btn ct-btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
              <button type="button" className="ct-btn ct-btn-dark" onClick={submit} disabled={submitting}>
                {submitting ? 'Enregistrement…' : 'Enregistrer le paiement'}
              </button>
            </div>
            {!alreadyInvoiced && (
              <p style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: 10, marginBottom: 0 }}>
                Une facture sera créée pour l'auteur lors de ce premier encaissement.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
