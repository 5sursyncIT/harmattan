import { useState } from 'react';
import { adjustStock } from '../../../api/admin';
import { FiClipboard, FiArrowRight } from 'react-icons/fi';
import toast from 'react-hot-toast';

/**
 * Modale d'ajustement d'inventaire (déphasage stock physique ↔ système).
 * L'utilisateur saisit la quantité PHYSIQUE réelle ; le serveur calcule l'écart.
 *
 * Props :
 *   product : { product_id, ref, label, stock }   (stock = stock système actuel)
 *   onClose()                                       fermeture
 *   onDone(result)                                  après succès (rafraîchir la liste)
 */
export default function StockAdjustModal({ product, onClose, onDone }) {
  const current = Number(product?.stock ?? 0);
  const [counted, setCounted] = useState(String(current));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const countedNum = counted === '' ? null : Math.max(0, parseInt(counted, 10) || 0);
  const delta = countedNum === null ? null : countedNum - current;
  const noChange = delta === 0;

  const submit = async () => {
    if (countedNum === null) { toast.error('Saisissez la quantité comptée'); return; }
    setSaving(true);
    try {
      const r = await adjustStock(product.product_id, countedNum, reason || 'Ajustement inventaire');
      const d = r.data?.delta ?? 0;
      if (d === 0) toast.success('Stock déjà à jour');
      else toast.success(`Stock ajusté : ${product.ref} ${current}→${countedNum} (${d > 0 ? '+' : ''}${d})`);
      onDone?.(r.data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || "Erreur d'ajustement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ct-modal-overlay" onClick={() => !saving && onClose?.()}>
      <div className="ct-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiClipboard size={18} style={{ color: '#1e40af' }} /> Ajuster le stock
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 0 }}>
          Saisissez la quantité <strong>physiquement présente</strong> en rayon. Le système calcule l'écart et corrige automatiquement.
        </p>

        <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 14, border: '1px solid #e2e8f0' }}>
          <div style={{ fontWeight: 700 }}>{product.label}</div>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>
            Réf. {product.ref} · stock système <strong style={{ color: current <= 0 ? '#dc2626' : '#0f172a' }}>{current}</strong>
          </div>
        </div>

        <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Quantité comptée (réelle)</label>
        <input
          type="number" min={0} value={counted} autoFocus
          onChange={e => setCounted(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !saving) submit(); }}
          style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '2px solid #1e40af', fontSize: '1.4rem', fontWeight: 700, textAlign: 'center', marginBottom: 10 }}
        />

        {/* Aperçu de l'écart */}
        {delta !== null && !noChange && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 12, fontSize: '0.95rem' }}>
            <span style={{ color: '#64748b' }}>{current}</span>
            <FiArrowRight size={16} style={{ color: '#94a3b8' }} />
            <span style={{ fontWeight: 700 }}>{countedNum}</span>
            <span style={{
              fontWeight: 800, padding: '2px 10px', borderRadius: 20,
              background: delta > 0 ? '#dcfce7' : '#fee2e2', color: delta > 0 ? '#15803d' : '#b91c1c',
            }}>
              {delta > 0 ? '+' : ''}{delta}
            </span>
          </div>
        )}
        {noChange && (
          <div style={{ textAlign: 'center', marginBottom: 12, fontSize: '0.85rem', color: '#94a3b8' }}>
            Aucun écart — rien à corriger.
          </div>
        )}

        <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Motif (facultatif)</label>
        <input
          type="text" value={reason} maxLength={60}
          onChange={e => setReason(e.target.value)}
          placeholder="Ex : comptage rayon, exemplaire retrouvé, casse…"
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: '0.88rem' }}
        />

        <div className="ct-modal-actions">
          <button className="ct-btn ct-btn-outline" onClick={() => onClose?.()} disabled={saving}>Annuler</button>
          <button className="ct-btn ct-btn-primary" onClick={submit} disabled={saving || noChange || countedNum === null}>
            {saving ? 'Enregistrement…' : noChange ? 'Aucun écart' : 'Appliquer l\'ajustement'}
          </button>
        </div>
      </div>
    </div>
  );
}
