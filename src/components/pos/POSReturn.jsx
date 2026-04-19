import { useState } from 'react';
import { posLookupInvoice, posCreateReturn } from '../../api/pos';
import { FiX, FiSearch, FiRotateCcw } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './POSReturn.css';

export default function POSReturn({ onClose }) {
  const [ref, setRef] = useState('');
  const [invoice, setInvoice] = useState(null);
  const [selectedItems, setSelectedItems] = useState([]);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleLookup = async () => {
    if (!ref.trim()) return;
    setLoading(true);
    try {
      const res = await posLookupInvoice(ref.trim());
      setInvoice(res.data);
      setSelectedItems(res.data.lines.map(l => ({ ...l, returnQty: l.qty })));
    } catch {
      toast.error('Facture non trouvée');
      setInvoice(null);
    } finally {
      setLoading(false);
    }
  };

  const toggleItem = (idx) => {
    setSelectedItems(prev => prev.map((item, i) =>
      i === idx ? { ...item, selected: !item.selected } : item
    ));
  };

  const updateReturnQty = (idx, qty) => {
    setSelectedItems(prev => prev.map((item, i) =>
      i === idx ? { ...item, returnQty: Math.max(1, Math.min(qty, item.qty)) } : item
    ));
  };

  const handleReturn = async () => {
    const items = selectedItems.filter(i => i.selected).map(i => ({
      product_id: i.product_id,
      label: i.label,
      qty: i.returnQty,
      price_ttc: i.price_ttc,
    }));
    if (!items.length) return toast.error('Sélectionnez au moins un article');

    setLoading(true);
    try {
      const res = await posCreateReturn({
        invoice_id: invoice.id,
        invoice_ref: invoice.ref,
        items,
        reason,
      });
      setResult(res.data);
      toast.success(`Avoir ${res.data.credit_ref} créé`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création avoir');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pos-return-overlay">
      <div className="pos-return-panel">
        <div className="pos-return-header">
          <h3><FiRotateCcw /> {result ? 'Avoir créé' : 'Retour / Avoir'}</h3>
          <button onClick={onClose}><FiX size={20} /></button>
        </div>

        {result ? (
          <div className="pos-return-result">
            <p className="pos-return-success">Avoir <strong>{result.credit_ref}</strong> créé</p>
            <p>Facture originale : {result.original_ref}</p>
            <p>Montant : <strong>{Math.abs(result.total_ttc).toLocaleString('fr-FR')} FCFA</strong></p>
            <button className="pos-return-btn primary" onClick={onClose}>Fermer</button>
          </div>
        ) : !invoice ? (
          <div className="pos-return-search">
            <p>Saisissez la référence de la facture à retourner :</p>
            <div className="pos-return-search-row">
              <input
                type="text"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="Ex: FA2603-00001"
                onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                autoFocus
              />
              <button onClick={handleLookup} disabled={loading}>
                <FiSearch /> {loading ? '...' : 'Rechercher'}
              </button>
            </div>
          </div>
        ) : (
          <div className="pos-return-details">
            <div className="pos-return-invoice-info">
              <span><strong>{invoice.ref}</strong> — {invoice.customer_name}</span>
              <span>{parseFloat(invoice.total_ttc).toLocaleString('fr-FR')} FCFA</span>
            </div>

            <div className="pos-return-items">
              {selectedItems.map((item, i) => (
                <label key={i} className={`pos-return-item ${item.selected ? 'selected' : ''}`}>
                  <input type="checkbox" checked={item.selected || false} onChange={() => toggleItem(i)} />
                  <span className="pos-return-item-label">{item.label}</span>
                  <div className="pos-return-item-qty">
                    <span>Qté:</span>
                    <input
                      type="number"
                      min={1}
                      max={item.qty}
                      value={item.returnQty}
                      onChange={(e) => updateReturnQty(i, parseInt(e.target.value) || 1)}
                      disabled={!item.selected}
                    />
                    <span>/ {item.qty}</span>
                  </div>
                  <span className="pos-return-item-price">{Math.round(item.price_ttc * (item.selected ? item.returnQty : item.qty)).toLocaleString('fr-FR')} F</span>
                </label>
              ))}
            </div>

            <input
              className="pos-return-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Motif du retour (optionnel)"
            />

            <div className="pos-return-actions">
              <button className="pos-return-btn" onClick={() => setInvoice(null)}>Retour</button>
              <button className="pos-return-btn primary" onClick={handleReturn} disabled={loading}>
                {loading ? 'Création...' : 'Créer l\'avoir'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
