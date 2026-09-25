import { useState, useEffect, useMemo } from 'react';
import { adjustStock, getStockWarehouses } from '../../../api/admin';
import { FiClipboard, FiArrowRight, FiAlertCircle } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './Stock.css';

// Dépôt de vente au comptoir : c'est CE stock que la caisse vend et décrémente.
const SHOP_WAREHOUSE = 4;

/**
 * Modale d'ajustement d'inventaire (déphasage stock physique ↔ système).
 * L'utilisateur saisit la quantité PHYSIQUE réelle ; le serveur calcule l'écart.
 *
 * Un ajustement porte TOUJOURS sur un dépôt précis (le serveur applique le
 * mouvement sur cet entrepôt-là). On charge donc le stock réel par dépôt et on
 * compare la saisie au dépôt choisi — jamais au total tous dépôts, sinon
 * compter le rayon (4 ex.) en regardant le total (28) gonflait le stock.
 *
 * Props :
 *   product : { product_id, ref, label }
 *   onClose()                                       fermeture
 *   onDone(result)                                  après succès (rafraîchir la liste)
 */
export default function StockAdjustModal({ product, onClose, onDone }) {
  const [warehouses, setWarehouses] = useState([]);
  const [loadingWh, setLoadingWh] = useState(true);
  const [whError, setWhError] = useState(false);
  const [wh, setWh] = useState(null);
  const [counted, setCounted] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Stock réel du produit dans chaque dépôt actif.
  useEffect(() => {
    let cancelled = false;
    setLoadingWh(true); setWhError(false);
    getStockWarehouses(product.product_id)
      .then(r => {
        if (cancelled) return;
        const list = r.data?.warehouses || [];
        setWarehouses(list);
        // Par défaut : le rayon (dépôt de la caisse), sinon le dépôt le mieux fourni.
        const def = list.find(w => w.id === (r.data?.default_warehouse ?? SHOP_WAREHOUSE))
          || [...list].sort((a, b) => Number(b.reel || 0) - Number(a.reel || 0))[0];
        if (def) {
          setWh(def.id);
          setCounted(String(Number(def.reel || 0)));
        }
      })
      .catch(() => { if (!cancelled) setWhError(true); })
      .finally(() => { if (!cancelled) setLoadingWh(false); });
    return () => { cancelled = true; };
  }, [product.product_id]);

  const selected = useMemo(() => warehouses.find(w => w.id === wh), [warehouses, wh]);
  const current = Number(selected?.reel ?? 0);
  const total = useMemo(() => warehouses.reduce((s, w) => s + Number(w.reel || 0), 0), [warehouses]);

  const countedNum = counted === '' ? null : Math.max(0, parseInt(counted, 10) || 0);
  const delta = countedNum === null ? null : countedNum - current;
  const noChange = delta === 0;
  const ready = !loadingWh && !whError && wh != null;

  // Changer de dépôt réinitialise la saisie sur le stock de ce dépôt.
  const pickWarehouse = (id) => {
    setWh(id);
    const w = warehouses.find(x => x.id === id);
    setCounted(String(Number(w?.reel || 0)));
  };

  const submit = async () => {
    if (!ready) return;
    if (countedNum === null) { toast.error('Saisissez la quantité comptée'); return; }
    setSaving(true);
    try {
      const r = await adjustStock(product.product_id, countedNum, reason || 'Ajustement inventaire', wh);
      const d = r.data?.delta ?? 0;
      if (d === 0) toast.success('Stock déjà à jour');
      else toast.success(`Stock ajusté : ${product.ref} ${r.data?.current ?? current}→${countedNum} (${d > 0 ? '+' : ''}${d}) · ${selected?.ref || `dépôt ${wh}`}`);
      onDone?.({ ...r.data, warehouse_id: wh });
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || "Erreur d'ajustement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ct-modal-overlay" onClick={() => !saving && onClose?.()}>
      <div className="ct-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiClipboard size={18} style={{ color: '#1e40af' }} /> Ajuster le stock
        </h3>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 0 }}>
          Saisissez la quantité <strong>physiquement présente dans le dépôt choisi</strong>. Le système calcule l'écart et corrige automatiquement ce dépôt.
        </p>

        <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 14, border: '1px solid #e2e8f0' }}>
          <div style={{ fontWeight: 700 }}>{product.label}</div>
          <div style={{ fontSize: '0.82rem', color: '#64748b' }}>
            Réf. {product.ref}
            {ready && <> · stock total <strong style={{ color: total <= 0 ? '#dc2626' : '#0f172a' }}>{total}</strong> tous dépôts</>}
          </div>
        </div>

        {loadingWh ? (
          <p style={{ color: '#94a3b8', fontSize: '0.88rem' }}>Chargement des dépôts…</p>
        ) : whError ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b91c1c', fontSize: '0.88rem', marginBottom: 12 }}>
            <FiAlertCircle size={16} /> Impossible de charger les dépôts — ajustement indisponible.
          </div>
        ) : (
          <>
            {/* Dépôt à corriger : le stock affiché est celui de CE dépôt */}
            <div style={{ fontWeight: 600, fontSize: '0.8rem', color: '#334155', marginBottom: 6 }}>Dépôt à corriger</div>
            <div className="sk-trf-dist">
              {warehouses.map(w => {
                const isSel = w.id === wh;
                const base = Number(w.reel || 0);
                const live = isSel && delta !== null && !noChange;
                return (
                  <button
                    type="button" key={w.id} onClick={() => pickWarehouse(w.id)} disabled={saving}
                    className={`sk-trf-chip${isSel ? ' is-dst' : ''}`}
                    style={{ textAlign: 'left', cursor: saving ? 'default' : 'pointer', font: 'inherit' }}
                  >
                    <div className="sk-trf-chip-ref" title={w.label || w.ref}>
                      {w.ref}{isSel ? ' · à corriger' : ''}
                    </div>
                    <div className="sk-trf-chip-qty">
                      {live ? countedNum : base}
                      {live && <span className={`delta ${delta > 0 ? 'up' : 'down'}`}>{delta > 0 ? '+' : ''}{delta}</span>}
                    </div>
                  </button>
                );
              })}
            </div>

            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>
              Quantité comptée (réelle)
              <span style={{ fontWeight: 400, color: '#64748b' }}> · {selected?.ref || 'dépôt'} : {current} au système</span>
            </label>
            <input
              type="number" min={0} value={counted} autoFocus
              onChange={e => setCounted(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !saving) submit(); }}
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '2px solid #1e40af', fontSize: '1.4rem', fontWeight: 700, textAlign: 'center', marginBottom: 10 }}
            />

            {/* Aperçu de l'écart */}
            {delta !== null && !noChange && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6, fontSize: '0.95rem' }}>
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
            {delta !== null && !noChange && (
              <div style={{ textAlign: 'center', marginBottom: 12, fontSize: '0.8rem', color: '#64748b' }}>
                Stock total {total} → <strong>{total + delta}</strong> tous dépôts
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
          </>
        )}

        <div className="ct-modal-actions">
          <button className="ct-btn ct-btn-outline" onClick={() => onClose?.()} disabled={saving}>Annuler</button>
          <button className="ct-btn ct-btn-primary" onClick={submit} disabled={saving || !ready || noChange || countedNum === null}>
            {saving ? 'Enregistrement…' : noChange ? 'Aucun écart' : 'Appliquer l\'ajustement'}
          </button>
        </div>
      </div>
    </div>
  );
}
