import { useState, useEffect, useMemo } from 'react';
import { getStockWarehouses, transferStock } from '../../../api/admin';
import { FiRepeat, FiAlertCircle, FiPlus, FiMinus, FiArrowRight } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './Stock.css';

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
  const totalStock = useMemo(() => warehouses.reduce((s, w) => s + Number(w.reel || 0), 0), [warehouses]);
  const available = Number(srcWh?.reel ?? 0);
  const qtyNum = qty === '' ? null : Math.max(0, parseInt(qty, 10) || 0);

  const tooFew = warehouses.length < 2;
  const sameWh = src != null && dst != null && src === dst;
  const overStock = qtyNum != null && qtyNum > available;
  const invalidQty = qtyNum === null || qtyNum < 1;
  const canSubmit = !saving && !tooFew && !sameWh && !overStock && !invalidQty && src != null && dst != null;
  const showDelta = !invalidQty && !overStock && !sameWh;

  const setQtyClamped = (n) => setQty(String(Math.max(1, Math.min(available || 1, n))));
  const swap = () => { setSrc(dst); setDst(src); };

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

  const whName = (w) => `${w.ref}${w.label && w.label !== w.ref ? ' — ' + w.label : ''}`;
  const whLabel = (w) => `${whName(w)} (${Number(w.reel ?? 0)})`;

  return (
    <div className="ct-modal-overlay" onClick={() => !saving && onClose?.()}>
      <div className="ct-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiRepeat size={18} style={{ color: '#1e40af' }} /> Transférer entre entrepôts
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 0 }}>
          Déplace des exemplaires d'un dépôt à un autre. Le stock total est inchangé : seule sa répartition par entrepôt évolue.
        </p>

        {/* Produit + stock total */}
        <div className="sk-trf-prod">
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{product.label}</div>
            <div style={{ fontSize: '0.82rem', color: '#64748b' }}>Réf. {product.ref}</div>
          </div>
          {!loadingWh && !whError && (
            <div className="sk-trf-prod-total"><b>{totalStock}</b><span>en stock</span></div>
          )}
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
            {/* Répartition par entrepôt + aperçu en direct */}
            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: '#334155', marginBottom: 6 }}>Répartition par entrepôt</div>
            <div className="sk-trf-dist">
              {warehouses.map(w => {
                const isSrc = w.id === src;
                const isDst = w.id === dst;
                const base = Number(w.reel || 0);
                const live = showDelta && (isSrc || isDst);
                const after = isSrc ? base - qtyNum : isDst ? base + qtyNum : base;
                return (
                  <div key={w.id} className={`sk-trf-chip${isSrc ? ' is-src' : ''}${isDst ? ' is-dst' : ''}`}>
                    <div className="sk-trf-chip-ref" title={whName(w)}>
                      {w.ref}{isSrc ? ' · source' : isDst ? ' · destination' : ''}
                    </div>
                    <div className="sk-trf-chip-qty">
                      {live ? after : base}
                      {live && <span className={`delta ${isSrc ? 'down' : 'up'}`}>{isSrc ? '−' : '+'}{qtyNum}</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Source → (inverser) → Destination */}
            <div className="sk-trf-route">
              <div>
                <label>Depuis (source)</label>
                <select className="sk-trf-select" value={src ?? ''} onChange={e => setSrc(parseInt(e.target.value, 10))}>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{whLabel(w)}</option>)}
                </select>
              </div>
              <button type="button" className="sk-trf-swap" title="Inverser source et destination" onClick={swap}>
                <FiRepeat size={15} />
              </button>
              <div>
                <label>Vers (destination)</label>
                <select className="sk-trf-select" style={{ borderColor: sameWh ? '#dc2626' : undefined }} value={dst ?? ''} onChange={e => setDst(parseInt(e.target.value, 10))}>
                  {warehouses.map(w => <option key={w.id} value={w.id}>{whLabel(w)}</option>)}
                </select>
              </div>
            </div>

            {sameWh && (
              <div style={{ color: '#b91c1c', fontSize: '0.8rem', marginBottom: 10 }}>
                Source et destination doivent être différentes.
              </div>
            )}

            {/* Quantité : stepper + « Tout » */}
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', margin: '12px 0 4px' }}>
              Quantité à transférer
              <span style={{ fontWeight: 400, color: '#64748b' }}> · {available} disponible(s) en source</span>
            </label>
            <div className="sk-trf-qty-row">
              <div className={`sk-trf-stepper${overStock ? ' over' : ''}`}>
                <button type="button" className="sk-trf-step-btn" title="Diminuer" disabled={!qtyNum || qtyNum <= 1} onClick={() => setQtyClamped((qtyNum || 1) - 1)}>
                  <FiMinus size={16} />
                </button>
                <input
                  className="sk-trf-qty-input"
                  type="number" min={1} max={available || undefined} value={qty} autoFocus
                  onChange={e => setQty(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && canSubmit) submit(); }}
                />
                <button type="button" className="sk-trf-step-btn" title="Augmenter" disabled={available > 0 && (qtyNum || 0) >= available} onClick={() => setQtyClamped((qtyNum || 0) + 1)}>
                  <FiPlus size={16} />
                </button>
              </div>
              <button type="button" className="sk-trf-max" disabled={available <= 0} onClick={() => setQty(String(available))}>
                Tout ({available})
              </button>
            </div>
            {overStock && (
              <div style={{ color: '#b91c1c', fontSize: '0.8rem', marginTop: 6 }}>
                Quantité supérieure au stock disponible ({available}).
              </div>
            )}

            {/* Récapitulatif compact source → destination */}
            {showDelta && srcWh && dstWh && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, margin: '12px 0 0', fontSize: '0.85rem', color: '#334155', flexWrap: 'wrap' }}>
                <strong>{qtyNum}</strong> ex.&nbsp;: {srcWh.ref}
                <FiArrowRight size={13} style={{ color: '#94a3b8' }} />
                {dstWh.ref}
              </div>
            )}

            {/* Motif */}
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', margin: '14px 0 4px' }}>Motif (facultatif)</label>
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
            {saving ? 'Transfert…' : showDelta ? `Transférer ${qtyNum} ex.` : 'Transférer'}
          </button>
        </div>
      </div>
    </div>
  );
}
