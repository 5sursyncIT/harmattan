import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FiArrowLeft, FiTruck, FiPrinter, FiShoppingCart, FiCheck, FiX,
  FiAlertCircle, FiPackage, FiInbox,
} from 'react-icons/fi';
import {
  getPurchaseOrders, receivePurchaseOrder, cancelPurchaseOrder,
} from '../../../api/admin';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import StockNav from './StockNav';
import './Stock.css';

const STATUS_TABS = [
  { value: 'open', label: 'En cours' },
  { value: 'received', label: 'Reçues' },
  { value: 'cancelled', label: 'Annulées' },
  { value: '', label: 'Toutes' },
];
const STATUS_BADGE = {
  ordered: { label: 'En cours', bg: '#eff6ff', color: '#1e40af' },
  partial: { label: 'Reçue partiellement', bg: '#fffbeb', color: '#92400e' },
  received: { label: 'Reçue', bg: '#f0fdf4', color: '#166534' },
  cancelled: { label: 'Annulée', bg: '#fef2f2', color: '#991b1b' },
};
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Modale de réception (par ligne, pré-remplie au reste à recevoir).
function ReceiveModal({ order, onClose, onDone }) {
  const [qtys, setQtys] = useState(() =>
    Object.fromEntries(order.lines.map(l => [l.id, Math.max(0, l.ordered_qty - l.received_qty)])));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const lines = order.lines
      .map(l => ({ line_id: l.id, qty: Math.max(0, Math.min(parseInt(qtys[l.id], 10) || 0, l.ordered_qty - l.received_qty)) }))
      .filter(l => l.qty > 0);
    if (lines.length === 0) return toast.error('Indiquez au moins une quantité à recevoir');
    setBusy(true);
    try {
      const { data } = await receivePurchaseOrder(order.id, { lines });
      if (data.failed?.length) toast(`Réception partielle : ${data.moved} OK, ${data.failed.length} échec(s)`, { icon: '⚠️' });
      else toast.success(`Réception enregistrée — stock crédité (${data.moved} ligne(s))`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur réception');
    } finally { setBusy(false); }
  };

  return (
    <div className="ct-modal-overlay" onClick={() => !busy && onClose()}>
      <div className="ct-modal" style={{ maxWidth: 560 }} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}><FiInbox size={18} /> Réception — {order.reference}</h3>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: 0 }}>Le stock du dépôt {order.warehouse_id} est crédité dans Dolibarr pour les quantités reçues.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}>
          {order.lines.map(l => {
            const remaining = l.ordered_qty - l.received_qty;
            return (
              <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8, alignItems: 'center', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.product_label || `Produit #${l.product_id}`}</div>
                  <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>Commandé {l.ordered_qty} · reçu {l.received_qty} · reste <strong>{remaining}</strong></div>
                </div>
                <input type="number" min={0} max={remaining} disabled={remaining <= 0}
                  value={qtys[l.id]} onChange={e => setQtys(q => ({ ...q, [l.id]: e.target.value }))}
                  style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', textAlign: 'center', fontWeight: 700 }} />
              </div>
            );
          })}
        </div>
        <div className="ct-modal-actions">
          <button className="ct-btn ct-btn-outline" onClick={onClose} disabled={busy}>Annuler</button>
          <button className="ct-btn ct-btn-primary" onClick={submit} disabled={busy}>{busy ? 'Réception…' : 'Confirmer la réception'}</button>
        </div>
      </div>
    </div>
  );
}

export default function StockPurchaseOrdersPanel() {
  const [orders, setOrders] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState('open');
  const [receiving, setReceiving] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(false);
    getPurchaseOrders({ status })
      .then(r => { setOrders(r.data.orders || []); setCounts(r.data.counts || {}); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const openCount = (counts.ordered || 0) + (counts.partial || 0);

  const handleCancel = async (o) => {
    if (!window.confirm(`Annuler la commande ${o.reference} ?`)) return;
    setBusyId(o.id);
    try { await cancelPurchaseOrder(o.id); toast.success('Commande annulée'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setBusyId(null); }
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiTruck size={18} /> Commandes d'approvisionnement</h3>
        </div>
      </div>

      <StockNav badges={{ appro: openCount }} />

      <div className="sk-filters">
        {STATUS_TABS.map(t => (
          <button key={t.value} className={`sk-filter-btn ${status === t.value ? 'active' : ''}`} onClick={() => setStatus(t.value)}>
            {t.label}
            {t.value === 'open' && openCount > 0 && <span className="sk-filter-count">{openCount}</span>}
            {t.value === 'received' && counts.received > 0 && <span className="sk-filter-count">{counts.received}</span>}
          </button>
        ))}
      </div>

      {loading ? <Loader /> : error ? (
        <div className="sk-empty">
          <FiAlertCircle size={42} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
          <button className="btn btn-primary" onClick={load} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : orders.length === 0 ? (
        <div className="sk-empty">
          <FiPackage size={42} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucune commande {status === 'open' ? 'en cours' : ''}</p>
          <p style={{ fontSize: '0.85rem' }}>Les commandes fournisseurs et réimpressions lancées depuis les recommandations apparaissent ici.</p>
        </div>
      ) : (
        <div className="sk-po-list">
          {orders.map(o => {
            const b = STATUS_BADGE[o.status] || { label: o.status, bg: '#f1f5f9', color: '#475569' };
            const canReceive = o.status === 'ordered' || o.status === 'partial';
            return (
              <div key={o.id} className="sk-po-card">
                <div className="sk-po-main">
                  <div className="sk-po-head">
                    <span className={`sk-reco-supply ${o.order_type === 'reprint' ? 'reimpression' : 'commande'}`}>
                      {o.order_type === 'reprint' ? <><FiPrinter size={11} /> Réimpression</> : <><FiShoppingCart size={11} /> Fournisseur</>}
                    </span>
                    <span className="mono" style={{ fontWeight: 700, color: '#0f172a' }}>{o.reference}</span>
                    <span style={{ padding: '2px 9px', borderRadius: 999, fontSize: '0.72rem', fontWeight: 700, background: b.bg, color: b.color }}>{b.label}</span>
                  </div>
                  <div className="sk-po-meta">
                    <span>{o.supplier_label}</span>
                    <span>{o.lines.length} ligne(s) · {o.total_ordered} ex.</span>
                    {o.amount_estimated > 0 && <span>{Math.round(o.amount_estimated).toLocaleString('fr-FR')} FCFA</span>}
                    <span style={{ color: '#94a3b8' }}>Commandé le {fmtDate(o.ordered_at)}</span>
                    {o.expected_at && <span style={{ color: '#94a3b8' }}>Prévu {fmtDate(o.expected_at)}</span>}
                  </div>
                  {(o.status === 'partial' || o.status === 'received') && (
                    <div className="sk-po-progress">
                      <div className="sk-po-progress-track"><span className="sk-po-progress-fill" style={{ width: `${o.progress}%` }} /></div>
                      <span>{o.total_received}/{o.total_ordered} reçus</span>
                    </div>
                  )}
                </div>
                <div className="sk-po-actions">
                  {canReceive && (
                    <>
                      <button className="sk-btn-order" onClick={() => setReceiving(o)}><FiInbox size={13} /> Réceptionner</button>
                      <button className="sk-btn-ghost danger" disabled={busyId === o.id} title="Annuler" onClick={() => handleCancel(o)}><FiX size={15} /></button>
                    </>
                  )}
                  {o.status === 'received' && <span style={{ color: '#166534', display: 'inline-flex', alignItems: 'center', gap: 4, fontWeight: 600, fontSize: '0.85rem' }}><FiCheck size={15} /> Reçue</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {receiving && (
        <ReceiveModal order={receiving} onClose={() => setReceiving(null)} onDone={() => { setReceiving(null); load(); }} />
      )}
    </div>
  );
}
