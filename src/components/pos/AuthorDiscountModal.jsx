import { useState } from 'react';
import { FiX, FiBookOpen } from 'react-icons/fi';
import usePosCartStore from '../../store/posCartStore';
import './CustomerSelect.css';

// Saisie OBLIGATOIRE de la remise auteur quand le client du ticket est un
// auteur. Il existe plusieurs niveaux de remise : aucun taux n'est appliqué
// d'office, le caissier tape la valeur (0 accepté s'il est saisi). Le serveur
// refuse la vente (409) tant que le taux n'est pas renseigné.
export default function AuthorDiscountModal() {
  const customer = usePosCartStore((s) => s.customer);
  const current = usePosCartStore((s) => s.authorDiscount);
  const setAuthorDiscount = usePosCartStore((s) => s.setAuthorDiscount);
  const closeAuthorPrompt = usePosCartStore((s) => s.closeAuthorPrompt);
  const [value, setValue] = useState(current != null ? String(current) : '');
  const [error, setError] = useState('');

  const submit = (e) => {
    e.preventDefault();
    const raw = value.trim().replace(',', '.');
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100) {
      setError('Saisissez un taux entre 0 et 100 %.');
      return;
    }
    setAuthorDiscount(Math.round(n * 100) / 100);
  };

  return (
    <div className="pos-cust-overlay">
      <form className="pos-cust-panel" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="pos-author-discount-title">
        <div className="pos-cust-header">
          <h3 id="pos-author-discount-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FiBookOpen /> Remise auteur
          </h3>
          <button type="button" onClick={closeAuthorPrompt} aria-label="Fermer"><FiX size={20} /></button>
        </div>
        <div className="pos-cust-form">
          <p className="pos-cust-hint" style={{ marginTop: 0 }}>
            <strong>{customer?.name || 'Ce client'}</strong> est un auteur. Saisissez le taux de remise
            qui lui est accordé : il sera appliqué à toutes les lignes du ticket.
          </p>
          <div className="pos-cust-field">
            <label htmlFor="pos-author-discount">Taux de remise (%) *</label>
            <input
              id="pos-author-discount"
              type="number" inputMode="decimal" min={0} max={100} step="0.5"
              value={value}
              onChange={(e) => { setValue(e.target.value); setError(''); }}
              placeholder="ex. 30"
              autoFocus required
            />
          </div>
          {error && <p className="pos-cust-hint" role="alert" style={{ color: 'var(--color-danger, #b91c1c)' }}>{error}</p>}
          <div className="pos-cust-form-actions">
            <button type="button" className="pos-cust-cancel" onClick={closeAuthorPrompt}>Plus tard</button>
            <button type="submit" className="pos-cust-submit">Appliquer</button>
          </div>
        </div>
      </form>
    </div>
  );
}
