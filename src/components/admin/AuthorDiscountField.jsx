import { useState } from 'react';
import { FiBookOpen, FiX } from 'react-icons/fi';
import { parseAuthorDiscount } from '../../utils/authorDiscount';

// Champ « Remise auteur (%) » OBLIGATOIRE quand le client est un auteur.
// Plusieurs niveaux de remise coexistent : rien n'est pré-rempli, l'agent
// saisit la valeur (0 accepté s'il est tapé).
export function AuthorDiscountField({ value, onChange, authorName, style }) {
  const invalid = value !== '' && parseAuthorDiscount(value) === null;
  return (
    <div style={{ background: 'color-mix(in srgb, var(--color-orange) 8%, var(--color-white))', border: '1px solid var(--color-orange)', borderRadius: 10, padding: '10px 12px', ...style }}>
      <label htmlFor="author-discount-input" style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: '0.85rem', color: 'var(--color-text)' }}>
        <FiBookOpen size={14} /> Client auteur{authorName ? ` (${authorName})` : ''} — remise auteur (%) *
      </label>
      <input
        id="author-discount-input"
        type="number" inputMode="decimal" min={0} max={100} step="0.5"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Saisir le taux, ex. 30"
        aria-invalid={invalid || value === ''}
        style={{ width: 160, marginTop: 6, padding: '7px 10px', border: `1px solid ${invalid ? 'var(--color-danger)' : 'var(--color-border)'}`, borderRadius: 8, fontSize: '0.9rem' }}
      />
      <div style={{ fontSize: '0.76rem', color: 'var(--color-text-muted)', marginTop: 4 }}>
        {invalid ? 'Taux entre 0 et 100 %.' : 'Plusieurs niveaux de remise existent : saisissez celui accordé à cet auteur. Appliqué à toutes les lignes.'}
      </div>
    </div>
  );
}

// Modale de saisie ouverte après un refus serveur 409 AUTHOR_DISCOUNT_REQUIRED.
export function AuthorDiscountPromptModal({ message, busy, onSubmit, onCancel }) {
  const [value, setValue] = useState('');
  const pct = parseAuthorDiscount(value);
  return (
    <div className="ct-modal-overlay" onClick={() => !busy && onCancel()}>
      <div className="ct-modal" style={{ maxWidth: 460, width: '100%' }} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiBookOpen size={18} /> Remise auteur</h3>
          <button className="ct-btn-ghost" onClick={onCancel} disabled={busy} aria-label="Fermer"><FiX size={20} /></button>
        </div>
        {message && <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', marginTop: 0 }}>{message}</p>}
        <form onSubmit={(e) => { e.preventDefault(); if (pct !== null) onSubmit(pct); }}>
          <AuthorDiscountField value={value} onChange={setValue} />
          <div className="ct-modal-actions" style={{ marginTop: 14 }}>
            <button type="button" className="ct-btn ct-btn-outline" onClick={onCancel} disabled={busy}>Annuler</button>
            <button type="submit" className="ct-btn ct-btn-primary" disabled={busy || pct === null}>
              {busy ? 'En cours...' : 'Appliquer et continuer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
