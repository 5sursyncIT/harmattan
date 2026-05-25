import { useState, useRef, useEffect } from 'react';
import { FiX, FiPlusCircle, FiPackage } from 'react-icons/fi';
import usePosCartStore from '../../store/posCartStore';
import toast from 'react-hot-toast';
import './POSFreeProduct.css';

export default function POSFreeProduct({ onClose }) {
  const [label, setLabel] = useState('');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState(1);
  const addItem = usePosCartStore((s) => s.addItem);
  const labelRef = useRef(null);

  useEffect(() => { labelRef.current?.focus(); }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmedLabel = label.trim();
    const numericPrice = parseInt(price, 10);
    const numericQty = parseInt(qty, 10);

    if (!trimmedLabel) return toast.error('Libellé obligatoire');
    if (!numericPrice || numericPrice <= 0) return toast.error('Prix invalide');
    if (!numericQty || numericQty <= 0) return toast.error('Quantité invalide');

    const freeId = `free-${Date.now()}`;
    addItem({
      id: freeId,
      ref: 'LIBRE',
      label: trimmedLabel,
      price_ttc: numericPrice,
      stock_reel: 999,
      is_free: true,
    });

    if (numericQty > 1) {
      const updateQty = usePosCartStore.getState().updateQty;
      updateQty(freeId, numericQty);
    }

    toast.success(`${trimmedLabel} ajouté au ticket`);
    onClose();
  };

  return (
    <div className="pos-free-overlay" onClick={onClose}>
      <form className="pos-free-modal" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <header className="pos-free-header">
          <div className="pos-free-title">
            <FiPackage size={18} />
            <div>
              <h2>Produit libre</h2>
              <p>Ajouter une ligne ad-hoc au ticket (article non référencé)</p>
            </div>
          </div>
          <button type="button" className="pos-free-close" onClick={onClose} aria-label="Fermer">
            <FiX size={20} />
          </button>
        </header>

        <div className="pos-free-body">
          <label className="pos-free-field">
            <span>Libellé</span>
            <input
              ref={labelRef}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex. Livre d'occasion, dédicace, papeterie…"
              maxLength={200}
              required
            />
          </label>

          <div className="pos-free-row">
            <label className="pos-free-field">
              <span>Prix unitaire (FCFA)</span>
              <input
                type="number"
                inputMode="numeric"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
                min="1"
                step="1"
                required
              />
            </label>

            <label className="pos-free-field">
              <span>Quantité</span>
              <input
                type="number"
                inputMode="numeric"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                min="1"
                step="1"
                required
              />
            </label>
          </div>

          <div className="pos-free-warning">
            ⚠️ Cette ligne sera enregistrée sans référence produit dans Dolibarr (TVA 0%, sans impact stock).
          </div>
        </div>

        <footer className="pos-free-footer">
          <button type="button" className="pos-free-cancel" onClick={onClose}>
            Annuler
          </button>
          <button type="submit" className="pos-free-submit">
            <FiPlusCircle size={16} />
            Ajouter au ticket
          </button>
        </footer>
      </form>
    </div>
  );
}
