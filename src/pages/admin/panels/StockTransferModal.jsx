import { useState, useEffect, useMemo } from 'react';
import { getStockWarehouses, transferStock } from '../../../api/admin';
import { FiRepeat, FiArrowRight, FiAlertCircle } from 'react-icons/fi';
import toast from 'react-hot-toast';

/**
 * Modale de transfert de stock entre entrepôts (circulation de livres dépôt → dépôt).
 * Réplique le transfert natif Dolibarr : SORTIE source + ENTRÉE destination appariées.
 *
 * Props :
 *   product : { product_id, ref, label }
 *   onClose()                fermeture
 *   onDone(result)           après succès (rafraîchir la liste / le stock affiché)
 */
export default function StockTransferModal({ product, onClose, onDone }) {
  const [warehouses, setWarehouses] = useState([]);
  const [loadingWh, setLoadingWh] = useState(true);
  const [whError, setWhError] = useState(false);
  const [src, setSrc] = useState(null);
  const [dst, setDst] = useState(null);
  const [qty, setQty] = useState('1');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Charger les entrepôts + le stock du produit dans chacun.
  useEffect(() => {
    let cancelled = false;
    setLoadingWh(true); setWhError(false);
    getStockWarehouses(product.product_id)
      .then(r => {
        if (cancelled) return;
        const list = r.data?.warehouses || [];
        setWarehouses(list);
        // Source par défaut = dépôt avec le plus de stock ; destination = 1er autre dépôt.
        const sorted = [...list].sort((a, b) => Number(b.reel || 0) - Number(a.reel || 0));
        const defSrc = sorted.find(w => Number(w.reel || 0) > 0) || sorted[0];
        if (defSrc) setSrc(defSrc.id);
        const defDst = list.find(w => w.id !== defSrc?.id);
        if (defDst) setDst(defDst.id);
      })
      .catch(() => { if (!cancelled) setWhError(true); })
      .finally(() => { if (!cancelled) setLoadingWh(false); });
    return () => { cancelled = true; };
  }, [product.product_id]);

  const srcWh = useMemo(() => warehouses.find(w => w.id === src), [warehouses, src]);
  const dstWh = useMemo(() => warehouses.find(w => w.id === dst), [warehouses, dst]);
  const available = Number(srcWh?.reel ?? 0);
  const qtyNum = qty === '' ? null : Math.max(0, parseInt(qty, 10) || 0);

  const tooFew = warehouses.length < 2;
  const sameWh = src != null && dst != null && src === dst;
  const overStock = qtyNum != null && qtyNum > available;
  const invalidQty = qtyNum === null || qtyNum < 1;
  const canSubmit = !saving && !tooFew && !sameWh && !overStock && !invalidQty && src != null && dst != null;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      const r = await transferStock({
        product_id: product.product_id,
        qty: qtyNum,
        warehouse_source_id: src,
        warehouse_dest_id: dst,
        reason: reason || undefined,
      });
      toast.success(`Transfert : ${product.ref} × ${qtyNum} ${srcWh?.ref} → ${dstWh?.ref}`);
      onDone?.(r.data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de transfert');
    } finally {
      setSaving(false);
    }
  };

  const whLabel = (w) => `${w.ref}${w.label && w.label !== w.ref ? ' — ' + w.label : ''} (${Number(w.reel ?? 0)})`;

  return (
    <div className="ct-modal-overlay" onClick={() => !saving && onClose?.()}>
      <div className="ct-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiRepeat size={18} style={{ color: '#1e40af' }} /> Transférer entre entrepôts
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 0 }}>
          Déplace des exemplaires d'un dépôt à un autre. Le stock total est inchangé : seule sa répartition par entrepôt évolue.
        </p>

        <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 14, border: '1px solid #e2e8f0' }}>
          <div style={{ fontWeight: 700 }}>{product.label}</div>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>Réf. {product.ref}</div>
        </div>

        {loadingWh ? (
          <p style={{ color: '#94a3b8', fontSize: '0.88rem' }}>Chargement des entrepôts…</p>
        ) : whError ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b91c1c', fontSize: '0.88rem', marginBottom: 12 }}>
            <FiAlertCircle size={16} /> Impossible de charger les entrepôts.
          </div>
        ) : tooFew ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', marginBottom: 12 }}>
            <FiAlertCircle size={16} /> Un seul entrepôt actif : aucun transfert possible.
          </div>
        ) : (
          <>
            {/* Source → Destination */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'end', gap: 8, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.8rem', marginBottom: 4 }}>Depuis (source)</label>
                <select value={src ?? ''} onChange={e => setSrc(parseInt(e.target.value, 10))}
                  style={{ width: '100%', padding: '10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: '0.85rem', background: '#fff' }}>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{whLabel(w)}</option>)}
                </select>
              </div>
              <FiArrowRight size={18} style={{ color: '#94a3b8', marginBottom: 10 }} />
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.8rem', marginBottom: 4 }}>Vers (destination)</label>
                <select value={dst ?? ''} onChange={e => setDst(parseInt(e.target.value, 10))}
                  style={{ width: '100%', padding: '10px', borderRadius: 8, border: `1px solid ${sameWh ? '#dc2626' : '#d1d5db'}`, fontSize: '0.85rem', background: '#fff' }}>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{whLabel(w)}</option>)}
                </select>
              </div>
            </div>

            {sameWh && (
              <div style={{ color: '#b91c1c', fontSize: '0.8rem', marginBottom: 10 }}>
                Source et destination doivent être différentes.
              </div>
            )}

            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>
              Quantité à transférer
              <span style={{ fontWeight: 400, color: '#64748b' }}> · {available} disponible(s) en source</span>
            </label>
            <input
              type="number" min={1} max={available || undefined} value={qty} autoFocus
              onChange={e => setQty(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit(); }}
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: `2px solid ${overStock ? '#dc2626' : '#1e40af'}`, fontSize: '1.3rem', fontWeight: 700, textAlign: 'center', marginBottom: overStock ? 4 : 10 }}
            />
            {overStock && (
              <div style={{ color: '#b91c1c', fontSize: '0.8rem', marginBottom: 10 }}>
                Quantité supérieure au stock disponible ({available}).
              </div>
            )}

            {/* Aperçu du résultat */}
            {!invalidQty && !overStock && !sameWh && srcWh && dstWh && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 12, fontSize: '0.85rem', color: '#334155' }}>
                <span>{srcWh.ref}: <strong>{available}</strong> → <strong>{available - qtyNum}</strong></span>
                <FiArrowRight size={14} style={{ color: '#94a3b8' }} />
                <span>{dstWh.ref}: <strong>{Number(dstWh.reel ?? 0)}</strong> → <strong>{Number(dstWh.reel ?? 0) + qtyNum}</strong></span>
              </div>
            )}

            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Motif (facultatif)</label>
            <input
              type="text" value={reason} maxLength={60}
              onChange={e => setReason(e.target.value)}
              placeholder="Ex : réassort rayon, retour réserve, salon…"
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: '0.88rem' }}
            />
          </>
        )}

        <div className="ct-modal-actions">
          <button className="ct-btn ct-btn-outline" onClick={() => onClose?.()} disabled={saving}>Annuler</button>
          <button className="ct-btn ct-btn-primary" onClick={submit} disabled={!canSubmit}>
            {saving ? 'Transfert…' : 'Transférer'}
          </button>
        </div>
      </div>
    </div>
  );
}
