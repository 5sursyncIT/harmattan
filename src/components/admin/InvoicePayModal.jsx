import { useState, useEffect } from 'react';
import { FiX, FiAlertTriangle } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { getInvoiceBanks, payInvoice } from '../../api/invoices';
import '../../pages/admin/panels/Accounting.css';

const METHODS = [
  { value: 'LIQ',  label: 'Espèces' },
  { value: 'CB',   label: 'Carte bancaire' },
  { value: 'CHQ',  label: 'Chèque' },
  { value: 'WAVE', label: 'Wave' },
  { value: 'OM',   label: 'Orange Money' },
  { value: 'VIR',  label: 'Virement' },
];

function formatPrice(n) {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n)) + ' XOF';
}
function today() {
  return new Date().toISOString().split('T')[0];
}

export default function InvoicePayModal({ invoice, onClose, onSuccess }) {
  const remaining = Number(invoice.total_ttc) - Number(invoice.paid_amount || 0);
  const [banks, setBanks] = useState([]);
  const [amount, setAmount] = useState(remaining);
  const [method, setMethod] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [date, setDate] = useState(today());
  const [numPayment, setNumPayment] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getInvoiceBanks()
      .then(r => setBanks(r.data.accounts || []))
      .catch(() => toast.error('Erreur chargement comptes bancaires'));
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (reason.trim().length < 4) {
      toast.error('Motif obligatoire (min. 4 caractères)');
      return;
    }
    setSubmitting(true);
    try {
      await payInvoice(invoice.id, {
        reason: reason.trim(),
        amount: Number(amount),
        method,
        bank_account: Number(bankAccount),
        date,
        num_payment: numPayment || undefined,
      });
      toast.success('Paiement enregistré');
      onSuccess?.();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur enregistrement paiement');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
      zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit} style={{
        background: '#fff', borderRadius: 12, width: '100%', maxWidth: 640,
        boxShadow: '0 10px 40px rgba(0,0,0,0.3)', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid #e5e7eb',
        }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>Marquer la facture payée</h3>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Fermer"><FiX /></button>
        </div>

        <div style={{ padding: 18 }}>
          <div style={{
            display: 'flex', gap: 10, padding: '10px 14px', marginBottom: 16,
            background: '#fef3c7', borderRadius: 8, color: '#92400e', fontSize: 13,
          }}>
            <FiAlertTriangle style={{ flexShrink: 0, marginTop: 2 }} />
            <div>Enregistre un paiement manuel sur la facture <strong>{invoice.ref}</strong>. Le paiement sera comptabilisé dans le journal de banque.</div>
          </div>

          <div className="ac-form-grid">
            <div>
              <label className="ac-form-label">Montant *</label>
              <input type="number" className="ac-form-input" step="1" min="1" max={remaining}
                required value={amount}
                onChange={e => setAmount(Number(e.target.value))} />
              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Reste à payer : {formatPrice(remaining)}</div>
            </div>
            <div>
              <label className="ac-form-label">Méthode *</label>
              <select className="ac-form-select" required value={method} onChange={e => setMethod(e.target.value)}>
                <option value="">—</option>
                {METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label className="ac-form-label">Compte bancaire *</label>
              <select className="ac-form-select" required value={bankAccount} onChange={e => setBankAccount(e.target.value)}>
                <option value="">—</option>
                {banks.map(b => <option key={b.id} value={b.id}>{b.label || b.ref}</option>)}
              </select>
            </div>
            <div>
              <label className="ac-form-label">Date</label>
              <input type="date" className="ac-form-input" value={date} onChange={e => setDate(e.target.value)} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="ac-form-label">N° de transaction (chèque, virement…)</label>
              <input type="text" className="ac-form-input" maxLength={64}
                value={numPayment} onChange={e => setNumPayment(e.target.value)} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="ac-form-label">Motif de la régularisation <span style={{ color: '#dc2626' }}>*</span></label>
              <textarea className="ac-form-input" rows={3} maxLength={500} required
                value={reason} onChange={e => setReason(e.target.value)} />
              <div style={{ fontSize: '0.7rem', color: '#64748b' }}>{reason.length} / 500 — sera tracé dans le journal d'audit</div>
            </div>
          </div>
        </div>

        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          padding: '14px 18px', borderTop: '1px solid #e5e7eb',
        }}>
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Enregistrement…' : 'Enregistrer le paiement'}
          </button>
        </div>
      </form>
    </div>
  );
}
