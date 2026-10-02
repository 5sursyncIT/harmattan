import { useState } from 'react';
import { FiX, FiBookOpen } from 'react-icons/fi';
import usePosCartStore from '../../store/posCartStore';
import './CustomerSelect.css';

const fmt = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} F`;

// Saisie OBLIGATOIRE de la remise auteur quand le client du ticket est un
// auteur. Deux façons de faire, au choix du caissier :
//  - « Remise en % » : un taux appliqué à toutes les lignes (0 accepté s'il est saisi) ;
//  - « Prix négocié » : un prix unitaire par livre (override de prix tracé).
// Le serveur refuse la vente (409) tant que l'un ou l'autre n'est pas renseigné.
export default function AuthorDiscountModal() {
  const customer = usePosCartStore((s) => s.customer);
  const items = usePosCartStore((s) => s.items);
  const current = usePosCartStore((s) => s.authorDiscount);
  const negotiated = usePosCartStore((s) => s.authorNegotiated);
  const setAuthorDiscount = usePosCartStore((s) => s.setAuthorDiscount);
  const setAuthorNegotiatedPrices = usePosCartStore((s) => s.setAuthorNegotiatedPrices);
  const closeAuthorPrompt = usePosCartStore((s) => s.closeAuthorPrompt);

  const [mode, setMode] = useState(negotiated ? 'negotiated' : 'percent');
  const [value, setValue] = useState(current != null ? String(current) : '');
  // Prix négociés pré-remplis avec le prix actuel de chaque ligne.
  const [prices, setPrices] = useState(() => Object.fromEntries(items.map((i) => [i.product_id, String(Math.round(i.price_ttc))])));
  const [error, setError] = useState('');

  const negotiatedTotal = items.reduce((s, i) => s + (parseInt(prices[i.product_id], 10) || 0) * i.qty, 0);
  const catalogTotal = items.reduce((s, i) => s + Math.round(i.price_original ?? i.price_ttc) * i.qty, 0);

  const submit = (e) => {
    e.preventDefault();
    if (mode === 'percent') {
      const raw = value.trim().replace(',', '.');
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100) {
        setError('Saisissez un taux entre 0 et 100 %.');
        return;
      }
      setAuthorDiscount(Math.round(n * 100) / 100);
      return;
    }
    if (items.length === 0) {
      setError('Ajoutez d’abord les livres au ticket, puis saisissez leurs prix négociés.');
      return;
    }
    const bad = items.find((i) => {
      const p = Number(prices[i.product_id]);
      return !Number.isInteger(p) || p <= 0 || p > 10_000_000;
    });
    if (bad) {
      setError(`Prix négocié invalide pour « ${bad.label} » (montant entier supérieur à 0).`);
      return;
    }
    setAuthorNegotiatedPrices(prices);
  };

  const tabStyle = (active) => ({
    flex: 1, padding: '8px 10px', borderRadius: 8, fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer',
    border: `1px solid ${active ? 'var(--color-green)' : 'var(--color-border)'}`,
    background: active ? 'var(--color-green)' : 'var(--color-white)',
    color: active ? 'var(--color-white)' : 'var(--color-text)',
  });

  return (
    <div className="pos-cust-overlay">
      <form className="pos-cust-panel" style={{ maxWidth: 520 }} onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="pos-author-discount-title">
        <div className="pos-cust-header">
          <h3 id="pos-author-discount-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <FiBookOpen /> Remise auteur
          </h3>
          <button type="button" onClick={closeAuthorPrompt} aria-label="Fermer"><FiX size={20} /></button>
        </div>
        <div className="pos-cust-form" style={{ overflowY: 'auto' }}>
          <p className="pos-cust-hint" style={{ marginTop: 0 }}>
            <strong>{customer?.name || 'Ce client'}</strong> est un auteur. Choisissez comment lui accorder sa remise.
          </p>
          <div role="tablist" aria-label="Type de remise" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <button type="button" role="tab" aria-selected={mode === 'percent'} style={tabStyle(mode === 'percent')}
              onClick={() => { setMode('percent'); setError(''); }}>Remise en %</button>
            <button type="button" role="tab" aria-selected={mode === 'negotiated'} style={tabStyle(mode === 'negotiated')}
              onClick={() => { setMode('negotiated'); setError(''); }}>Prix négocié</button>
          </div>

          {mode === 'percent' ? (
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
              <small className="pos-cust-hint">Appliqué à toutes les lignes du ticket, y compris celles ajoutées ensuite.</small>
            </div>
          ) : items.length === 0 ? (
            <p className="pos-cust-hint">Ajoutez d’abord les livres au ticket, puis touchez « Remise auteur » pour saisir leurs prix négociés.</p>
          ) : (
            <>
              {items.map((i, idx) => (
                <div key={i.product_id} className="pos-cust-field">
                  <label htmlFor={`neg-${i.product_id}`}>
                    {i.label} {i.qty > 1 ? `× ${i.qty}` : ''}
                    <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}> — catalogue {fmt(i.price_original ?? i.price_ttc)}</span>
                  </label>
                  <input
                    id={`neg-${i.product_id}`}
                    type="number" inputMode="numeric" min={1} step={1}
                    value={prices[i.product_id] ?? ''}
                    onChange={(e) => { setPrices((p) => ({ ...p, [i.product_id]: e.target.value })); setError(''); }}
                    placeholder="Prix unitaire négocié"
                    autoFocus={idx === 0}
                  />
                </div>
              ))}
              <p className="pos-cust-hint" style={{ margin: 0 }}>
                Total négocié : <strong>{fmt(negotiatedTotal)}</strong> (catalogue {fmt(catalogTotal)}).
                Un livre ajouté ensuite sera au prix catalogue : rouvrez « Remise auteur » pour le négocier.
              </p>
            </>
          )}

          {error && <p className="pos-cust-hint" role="alert" style={{ color: 'var(--color-danger)' }}>{error}</p>}
          <div className="pos-cust-form-actions">
            <button type="button" className="pos-cust-cancel" onClick={closeAuthorPrompt}>Plus tard</button>
            <button type="submit" className="pos-cust-submit" disabled={mode === 'negotiated' && items.length === 0}>Appliquer</button>
          </div>
        </div>
      </form>
    </div>
  );
}
