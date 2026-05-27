import { useState, useEffect } from 'react';
import { FiDelete } from 'react-icons/fi';
import usePosCartStore from '../../store/posCartStore';
import toast from 'react-hot-toast';
import './POSNumpad.css';

const MODES = [
  { key: 'qty', label: 'Qté' },
  { key: 'price', label: 'Prix' },
  { key: 'discount', label: 'Remise ligne' },
];

export default function POSNumpad() {
  const selectedItemId = usePosCartStore((s) => s.selectedItemId);
  const items = usePosCartStore((s) => s.items);
  const removeItem = usePosCartStore((s) => s.removeItem);

  const selectedItem = items.find((i) => i.product_id === selectedItemId) || null;

  const [mode, setMode] = useState('qty');
  const [buffer, setBuffer] = useState('');
  // Modal combinée prix + motif (raison obligatoire pour produit référencé).
  // Pour un produit libre, le motif est optionnel.
  const [priceModal, setPriceModal] = useState(null); // { item }
  const [priceInput, setPriceInput] = useState('');
  const [reason, setReason] = useState('');

  // Reset buffer if selected item changes
  useEffect(() => { setBuffer(''); }, [selectedItemId, mode]);

  const display = (() => {
    if (!selectedItem) return '0';
    if (buffer) return buffer;
    if (mode === 'qty') return String(selectedItem.qty);
    if (mode === 'price') return String(Math.round(selectedItem.price_ttc));
    if (mode === 'discount') return String(selectedItem.discount || 0);
    return '0';
  })();

  const handleDigit = (d) => {
    if (!selectedItem) {
      toast('Sélectionnez d’abord une ligne du ticket', { icon: 'ℹ️' });
      return;
    }
    setBuffer((b) => {
      const next = (b === '0' ? '' : b) + d;
      return next.slice(0, mode === 'price' ? 8 : 4);
    });
  };

  const apply = () => {
    // Relit le store au moment du click pour éviter toute closure stale.
    const store = usePosCartStore.getState();
    const sel = store.items.find((i) => i.product_id === store.selectedItemId) || null;
    if (!sel) {
      toast.error('Sélectionnez d’abord une ligne du ticket');
      return;
    }
    if (!buffer) return;
    const value = parseInt(buffer, 10);

    if (mode === 'qty') {
      if (!Number.isFinite(value) || value < 1) {
        toast.error('La quantité doit être ≥ 1');
        return;
      }
      store.updateQty(sel.product_id, value);
      toast.success(`Qté ${sel.label.slice(0, 24)} → ${value}`);
    } else if (mode === 'price') {
      if (value <= 0) {
        toast.error('Prix invalide');
        return;
      }
      // Produit libre : prix immédiatement appliqué (pas de justification).
      // Produit référencé : passe par la modale (jamais atteint ici car le
      // bouton Prix ouvre la modale directement, mais on garde la garde).
      if (!sel.is_free) {
        setPriceInput(String(value));
        setPriceModal({ item: sel });
        return;
      }
      store.setPrice(sel.product_id, value);
      toast.success(`Prix → ${value.toLocaleString('fr-FR')} F`);
    } else if (mode === 'discount') {
      if (value < 0 || value > 100) {
        toast.error('Remise entre 0 et 100 %');
        return;
      }
      store.setDiscount(sel.product_id, value);
      toast.success(`Remise → ${value} %`);
    }
    setBuffer('');
  };

  const handleModeChange = (m) => {
    // Prix sur produit référencé = action directe (modale prix+motif).
    // Pas de bascule de mode, sinon l'utilisateur clique Prix et ne voit
    // visuellement rien d'autre qu'une teinte plus foncée sur le bouton.
    if (m === 'price') {
      const store = usePosCartStore.getState();
      const sel = store.items.find((i) => i.product_id === store.selectedItemId);
      if (!sel) {
        toast('Sélectionnez d’abord une ligne du ticket', { icon: 'ℹ️' });
        return;
      }
      if (!sel.is_free) {
        setPriceInput(String(Math.round(sel.price_ttc)));
        setReason(sel.price_override_reason || '');
        setPriceModal({ item: sel });
        return;
      }
      // Produit libre : on bascule en mode numpad pour saisie rapide.
      setMode('price');
      setBuffer('');
      return;
    }
    setMode(m);
    setBuffer('');
  };

  const confirmPriceOverride = () => {
    const newPrice = parseInt(priceInput, 10);
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      toast.error('Prix invalide');
      return;
    }
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      toast.error('Motif obligatoire (3 caractères minimum)');
      return;
    }
    const store = usePosCartStore.getState();
    store.setPrice(priceModal.item.product_id, newPrice, trimmed);
    toast.success(`Prix → ${newPrice.toLocaleString('fr-FR')} F (${trimmed})`);
    setPriceModal(null); setReason(''); setPriceInput(''); setBuffer('');
  };

  const cancelPriceOverride = () => {
    setPriceModal(null); setReason(''); setPriceInput('');
  };

  const handleClear = () => setBuffer('');

  const handleDelete = () => {
    if (!selectedItem) return;
    if (confirm(`Retirer « ${selectedItem.label} » du ticket ?`)) {
      removeItem(selectedItem.product_id);
    }
  };

  return (
    <section className="pos-numpad" aria-label="Pavé numérique">
      <div className="pos-numpad-board">
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('7')}>7</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('8')}>8</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('9')}>9</button>
        <button
          type="button"
          className={`pos-numpad-btn op ${mode === 'qty' ? 'active' : ''}`}
          onClick={() => handleModeChange('qty')}
        >Qté</button>

        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('4')}>4</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('5')}>5</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('6')}>6</button>
        <button
          type="button"
          className={`pos-numpad-btn op ${mode === 'price' ? 'active' : ''}`}
          onClick={() => handleModeChange('price')}
        >Prix</button>

        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('1')}>1</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('2')}>2</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('3')}>3</button>
        <button
          type="button"
          className={`pos-numpad-btn op ${mode === 'discount' ? 'active' : ''}`}
          onClick={() => handleModeChange('discount')}
        >Remise</button>

        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('0')}>0</button>
        <button type="button" className="pos-numpad-btn digit" onClick={() => handleDigit('00')}>00</button>
        <button type="button" className="pos-numpad-btn clear" onClick={handleClear} title="Effacer la saisie">C</button>
        <button type="button" className="pos-numpad-btn delete" onClick={handleDelete} title="Retirer la ligne">
          <FiDelete size={18} />
        </button>
      </div>

      <button
        type="button"
        className="pos-numpad-apply"
        onClick={apply}
        disabled={!buffer}
      >
        <span>Appliquer {MODES.find((m) => m.key === mode)?.label}</span>
        {buffer && <span className="pos-numpad-apply-value">{display}</span>}
      </button>

      {priceModal && (
        <div
          onClick={cancelPriceOverride}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 2200 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 20, width: '100%', maxWidth: 440, boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: '1.05rem', color: '#0f172a' }}>Modification de prix</h3>
            <p style={{ margin: '0 0 14px', fontSize: '0.85rem', color: '#475569' }}>
              <strong>{priceModal.item.label}</strong><br />
              <span style={{ color: '#64748b' }}>
                Prix catalogue : {Math.round(priceModal.item.price_original ?? priceModal.item.price_ttc).toLocaleString('fr-FR')} F
              </span>
            </p>

            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: 6 }}>
              Nouveau prix (FCFA) <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="number"
              inputMode="numeric"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              min={1}
              max={10000000}
              autoFocus
              style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '1.2rem', fontWeight: 700, textAlign: 'right', outline: 'none', marginBottom: 14 }}
            />

            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: 6 }}>
              Motif de la modification <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex : remise client fidèle, livre abîmé, négociation manager…"
              rows={3}
              maxLength={200}
              style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.9rem', resize: 'vertical', outline: 'none' }}
            />
            <div style={{ fontSize: '0.72rem', color: '#94a3b8', textAlign: 'right', marginTop: 2 }}>
              {reason.length}/200
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                onClick={cancelPriceOverride}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', cursor: 'pointer', fontWeight: 600 }}
              >Annuler</button>
              <button
                onClick={confirmPriceOverride}
                disabled={reason.trim().length < 3 || !priceInput}
                style={{ flex: 1, padding: 10, borderRadius: 8, border: 'none', background: (reason.trim().length < 3 || !priceInput) ? '#94a3b8' : '#10531a', color: '#fff', cursor: (reason.trim().length < 3 || !priceInput) ? 'not-allowed' : 'pointer', fontWeight: 700 }}
              >Confirmer</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
