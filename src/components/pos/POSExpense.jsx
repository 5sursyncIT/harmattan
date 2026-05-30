import { useState, useEffect } from 'react';
import { FiX, FiTrendingDown, FiAlertTriangle } from 'react-icons/fi';
import { posGetExpenseCategories, posRecordExpense } from '../../api/pos';
import usePosAuthStore from '../../store/posAuthStore';
import './CashRegister.css';

// Sortie d'argent prise dans la caisse POS : montant + catégorie + bénéficiaire +
// motif obligatoires. Réservée aux managers. Notifie automatiquement les admins.
export default function POSExpense({ session, onClose, onDone }) {
  const staff = usePosAuthStore((s) => s.staff);
  const isManager = staff?.role === 'manager';

  const [categories, setCategories] = useState([]);
  const [form, setForm] = useState({ amount: '', category: '', beneficiary: '', reason: '', note: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);

  useEffect(() => {
    posGetExpenseCategories().then((r) => setCategories(r.data.categories || [])).catch(() => {});
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.amount || parseInt(form.amount, 10) <= 0) return setError('Montant invalide');
    if (!form.category) return setError('Catégorie requise');
    if (!form.beneficiary.trim()) return setError('Bénéficiaire requis');
    if (form.reason.trim().length < 4) return setError('Motif requis (4 caractères min.)');
    setLoading(true); setError('');
    try {
      const res = await posRecordExpense({
        amount: parseInt(form.amount, 10),
        category: form.category,
        beneficiary: form.beneficiary,
        reason: form.reason,
        note: form.note,
      });
      setDone(res.data);
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur enregistrement');
    } finally { setLoading(false); }
  };

  return (
    <div className="pos-cr-overlay" onClick={onClose}>
      <div className="pos-cr-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pos-cr-header">
          <h3><FiTrendingDown /> Sortie d'argent</h3>
          <button onClick={onClose}><FiX size={20} /></button>
        </div>

        {!isManager ? (
          <div className="pos-cr-tab-content">
            <p className="pos-cr-error">Les sorties d'argent sont réservées aux managers.</p>
            <button className="pos-cr-btn secondary" onClick={onClose}>Fermer</button>
          </div>
        ) : done ? (
          <div className="pos-cr-tab-content">
            <h4>Sortie enregistrée — {done.ref}</h4>
            <p className="pos-cr-info">
              {done.in_register
                ? 'Déduite de la caisse en cours. Les administrateurs ont été notifiés.'
                : 'Aucune session de caisse ouverte : enregistrée hors-caisse. Les administrateurs ont été notifiés.'}
            </p>
            <button className="pos-cr-btn primary" onClick={onClose}>Fermer</button>
          </div>
        ) : (
          <div className="pos-cr-tab-content">
            {!session && (
              <p className="pos-cr-info" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <FiAlertTriangle /> Aucune session de caisse ouverte : la dépense sera enregistrée hors-caisse.
              </p>
            )}
            <div className="pos-cr-field">
              <label>Montant (FCFA)</label>
              <input type="number" min="1" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0" autoFocus />
            </div>
            <div className="pos-cr-field">
              <label>Catégorie</label>
              <select value={form.category} onChange={(e) => set('category', e.target.value)}>
                <option value="">— Choisir —</option>
                {categories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="pos-cr-field">
              <label>Bénéficiaire</label>
              <input type="text" value={form.beneficiary} onChange={(e) => set('beneficiary', e.target.value)} placeholder="Fournisseur / personne" />
            </div>
            <div className="pos-cr-field">
              <label>Motif / justification</label>
              <input type="text" value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="Pourquoi cette dépense ?" />
            </div>
            <div className="pos-cr-field">
              <label>Note (facultatif)</label>
              <input type="text" value={form.note} onChange={(e) => set('note', e.target.value)} placeholder="" />
            </div>
            {error && <div className="pos-cr-error">{error}</div>}
            <button className="pos-cr-btn primary" onClick={submit} disabled={loading}>
              {loading ? 'Enregistrement…' : 'Enregistrer la sortie'}
            </button>
            <p className="pos-cr-info" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
              <FiAlertTriangle /> Les administrateurs seront notifiés de ce retrait.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
