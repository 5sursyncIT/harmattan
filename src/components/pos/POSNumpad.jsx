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
  const updateQty = usePosCartStore((s) => s.updateQty);
  const setDiscount = usePosCartStore((s) => s.setDiscount);
  const setPrice = usePosCartStore((s) => s.setPrice);
  const removeItem = usePosCartStore((s) => s.removeItem);

  const selectedItem = items.find((i) => i.product_id === selectedItemId) || null;

  const [mode, setMode] = useState('qty');
  const [buffer, setBuffer] = useState('');

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
      if (!sel.is_free) {
        toast.error('Prix non modifiable — produit référencé');
        return;
      }
      if (value <= 0) {
        toast.error('Prix invalide');
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
    if (m === 'price' && selectedItem && !selectedItem.is_free) {
      toast('Prix verrouillé pour les produits référencés', { icon: '🔒' });
      return;
    }
    setMode(m);
    setBuffer('');
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
    </section>
  );
}
