import { useState, useEffect, useMemo } from 'react';
import { posLookupInvoice, posCreateReturn } from '../../api/pos';
import usePosAuthStore from '../../store/posAuthStore';
import { FiX, FiSearch, FiRotateCcw, FiAlertTriangle } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './POSReturn.css';

// UUID v4 simple, fonctionne aussi en contexte non-sécurisé (HTTP).
function genReturnId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    try { return crypto.randomUUID(); } catch { /* fallback */ }
  }
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const REFUND_METHODS = [
  { code: 'LIQ', label: 'Espèces' },
  { code: 'CB', label: 'Carte' },
  { code: 'WAVE', label: 'Wave' },
  { code: 'OM', label: 'Orange Money' },
  { code: 'CHQ', label: 'Chèque' },
];

export default function POSReturn({ onClose, initialRef }) {
  const [ref, setRef] = useState(initialRef || '');
  const [invoice, setInvoice] = useState(null);
  const [selectedItems, setSelectedItems] = useState([]);
  const [reason, setReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('LIQ');
  const [managerPin, setManagerPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  // Identifiant unique de ce remboursement — clé d'idempotence côté serveur.
  // Régénéré uniquement quand on ouvre la modale (nouvelle vraie tentative).
  const [returnId] = useState(() => genReturnId());
  const staffRole = usePosAuthStore((s) => s.staff?.role);

  // FIX #2+#3 — Détecte un remboursement « cross-method » qui nécessitera un
  // PIN manager si le caissier connecté n'est pas lui-même manager.
  const originalMethods = invoice?.original_payment_methods || [];
  const crossMethod = originalMethods.length > 0 && !originalMethods.includes(refundMethod);
  const needsManagerPin = crossMethod && staffRole !== 'manager';
  const METHOD_LABELS = useMemo(() => ({ LIQ: 'Espèces', CB: 'Carte', WAVE: 'Wave', OM: 'Orange Money', CHQ: 'Chèque' }), []);

  const lookup = async (refValue) => {
    const lookupRef = (refValue || '').trim();
    if (!lookupRef) return;
    setLoading(true);
    try {
      const res = await posLookupInvoice(lookupRef);
      setInvoice(res.data);
      setSelectedItems(res.data.lines.map(l => {
        const returnable = l.qty_returnable ?? l.qty;
        return { ...l, returnQty: returnable > 0 ? returnable : 0 };
      }));
    } catch {
      toast.error('Facture non trouvée');
      setInvoice(null);
    } finally {
      setLoading(false);
    }
  };

  const handleLookup = () => lookup(ref);

  useEffect(() => {
    if (initialRef) lookup(initialRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRef]);

  const toggleItem = (idx) => {
    setSelectedItems(prev => prev.map((item, i) =>
      i === idx ? { ...item, selected: !item.selected } : item
    ));
  };

  const updateReturnQty = (idx, qty) => {
    setSelectedItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const max = item.qty_returnable ?? item.qty;
      return { ...item, returnQty: Math.max(1, Math.min(qty, max)) };
    }));
  };

  const handleReturn = async () => {
    const items = selectedItems.filter(i => i.selected && i.returnQty > 0).map(i => ({
      product_id: i.product_id,
      label: i.label,
      qty: i.returnQty,
      price_ttc: i.price_ttc,
    }));
    if (!items.length) return toast.error('Sélectionnez au moins un article');
    if (needsManagerPin && !managerPin.trim()) {
      return toast.error('Saisie du PIN manager requise');
    }

    setLoading(true);
    try {
      const res = await posCreateReturn({
        invoice_id: invoice.id,
        invoice_ref: invoice.ref,
        items,
        reason,
        refund_method: refundMethod,
        client_return_id: returnId,
        manager_pin: needsManagerPin ? managerPin.trim() : undefined,
      });
      setResult(res.data);
      toast.success(`Avoir ${res.data.credit_ref} créé`);
    } catch (err) {
      const errCode = err.response?.data?.code;
      if (errCode === 'MANAGER_PIN_REQUIRED' || errCode === 'MANAGER_PIN_INVALID') {
        toast.error(err.response.data.error);
        setManagerPin('');
      } else {
        toast.error(err.response?.data?.error || 'Erreur création avoir');
      }
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
            <p>Remboursé en : <strong>{REFUND_METHODS.find(m => m.code === result.refund_method)?.label || result.refund_method || 'Espèces'}</strong></p>
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
              {selectedItems.map((item, i) => {
                const returnable = item.qty_returnable ?? item.qty;
                const exhausted = returnable <= 0;
                return (
                  <label key={i} className={`pos-return-item ${item.selected ? 'selected' : ''} ${exhausted ? 'exhausted' : ''}`}>
                    <input type="checkbox" checked={item.selected || false} onChange={() => toggleItem(i)} disabled={exhausted} />
                    <span className="pos-return-item-label">
                      {item.label}
                      {item.qty_returned > 0 && (
                        <small> — déjà retourné : {item.qty_returned}/{item.qty}</small>
                      )}
                    </span>
                    <div className="pos-return-item-qty">
                      <span>Qté:</span>
                      <input
                        type="number"
                        min={1}
                        max={returnable}
                        value={item.returnQty}
                        onChange={(e) => updateReturnQty(i, parseInt(e.target.value) || 1)}
                        disabled={!item.selected || exhausted}
                      />
                      <span>/ {returnable}</span>
                    </div>
                    <span className="pos-return-item-price">{Math.round(item.price_ttc * (item.selected ? item.returnQty : returnable)).toLocaleString('fr-FR')} F</span>
                  </label>
                );
              })}
            </div>

            <div className="pos-return-refund">
              <div className="pos-return-refund-label">
                Remboursé en :
                {originalMethods.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: '#64748b', fontWeight: 400 }}>
                    (vente initiale : {originalMethods.map((m) => METHOD_LABELS[m] || m).join(', ')})
                  </span>
                )}
              </div>
              <div className="pos-return-method-btns">
                {REFUND_METHODS.map(m => (
                  <button
                    key={m.code}
                    type="button"
                    className={`pos-return-method-btn ${refundMethod === m.code ? 'active' : ''}`}
                    onClick={() => setRefundMethod(m.code)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {needsManagerPin && (
              <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: 12, marginTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
                  <FiAlertTriangle size={16} style={{ color: '#b45309', flexShrink: 0, marginTop: 2 }} />
                  <div style={{ fontSize: 13, color: '#92400e', lineHeight: 1.4 }}>
                    Vente initiale en <strong>{originalMethods.map((m) => METHOD_LABELS[m] || m).join('/')}</strong>,
                    remboursement demandé en <strong>{METHOD_LABELS[refundMethod] || refundMethod}</strong>.
                    Cette opération nécessite la validation d'un manager.
                  </div>
                </div>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="PIN manager"
                  value={managerPin}
                  onChange={(e) => setManagerPin(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', fontSize: 16, fontWeight: 700, letterSpacing: 4, textAlign: 'center', borderRadius: 8, border: '1px solid #fbbf24', outline: 'none' }}
                />
              </div>
            )}

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
