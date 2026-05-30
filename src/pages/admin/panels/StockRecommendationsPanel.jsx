import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FiArrowLeft, FiShoppingCart, FiPrinter, FiCheck, FiX, FiAlertCircle,
  FiTrendingDown, FiPackage,
} from 'react-icons/fi';
import {
  getStockRecommendations, approveRecommendation, cancelRecommendation,
  requestReprint, requestSupplierOrder,
} from '../../../api/admin';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import StockNav from './StockNav';
import './Stock.css';

const REASON = {
  rupture: { label: 'Rupture', color: '#dc2626', bg: '#fef2f2' },
  stock_bas: { label: 'Stock bas', color: '#d97706', bg: '#fffbeb' },
  sous_point_de_commande: { label: 'Sous seuil', color: '#2563eb', bg: '#eff6ff' },
};
const STATUS_TABS = [
  { value: 'draft', label: 'À traiter' },
  { value: 'approved', label: 'Approuvées' },
  { value: 'cancelled', label: 'Annulées' },
];

export default function StockRecommendationsPanel() {
  const [recs, setRecs] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState('draft');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setError(false);
    getStockRecommendations({ status })
      .then(r => { setRecs(r.data.recommendations || []); setCounts(r.data.counts || {}); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [status]);
  useEffect(() => { load(); }, [load]);

  const act = async (id, fn, okMsg) => {
    setBusyId(id);
    try { await fn(); toast.success(okMsg); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setBusyId(null); }
  };

  const handleOrder = async (rec) => {
    setBusyId(rec.id);
    try {
      if (rec.supply_type === 'reimpression') {
        const r = await requestReprint(rec.product_id, rec.recommended_qty);
        toast.success(`Réimpression lancée (${r.data.mo_ref})`);
      } else {
        const r = await requestSupplierOrder(rec.product_id, rec.recommended_qty);
        toast.success(`Commande créée (${r.data.order_ref})`);
      }
      await approveRecommendation(rec.id);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de la commande');
    } finally { setBusyId(null); }
  };

  const totalQty = recs.reduce((s, r) => s + (r.recommended_qty || 0), 0);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiShoppingCart size={18} /> Recommandations d'achat</h3>
        </div>
      </div>

      <StockNav badges={{ reco: counts.draft }} />

      {/* Résumé */}
      <div className="sk-reco-summary">
        <div><span className="sk-reco-sum-val">{counts.draft || 0}</span><span className="sk-reco-sum-lbl">À traiter</span></div>
        <div><span className="sk-reco-sum-val">{status === 'draft' ? totalQty.toLocaleString('fr-FR') : '—'}</span><span className="sk-reco-sum-lbl">Exemplaires à commander</span></div>
        <div><span className="sk-reco-sum-val">{counts.approved || 0}</span><span className="sk-reco-sum-lbl">Approuvées</span></div>
      </div>

      {/* Onglets statut */}
      <div className="sk-filters">
        {STATUS_TABS.map(t => (
          <button key={t.value} className={`sk-filter-btn ${status === t.value ? 'active' : ''}`}
            onClick={() => setStatus(t.value)}>
            {t.label}{counts[t.value] > 0 && <span className="sk-filter-count">{counts[t.value]}</span>}
          </button>
        ))}
      </div>

      {loading ? <Loader /> : error ? (
        <div className="sk-empty">
          <FiAlertCircle size={42} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
          <button className="btn btn-primary" onClick={load} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : recs.length === 0 ? (
        <div className="sk-empty">
          <FiCheck size={42} style={{ color: '#10b981', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucune recommandation {status === 'draft' ? 'à traiter' : status}</p>
          <p style={{ fontSize: '0.85rem' }}>Le calcul quotidien propose ici les réapprovisionnements nécessaires.</p>
        </div>
      ) : (
        <div className="sk-reco-list">
          {recs.map(r => {
            const reason = REASON[r.reason_code] || { label: r.reason_code, color: '#64748b', bg: '#f1f5f9' };
            const isBusy = busyId === r.id;
            return (
              <div key={r.id} className="sk-reco-card">
                <div className="sk-reco-main">
                  <div className="sk-reco-head">
                    {r.abc_class && <span className={`sk-abc sk-abc-${r.abc_class}`}>{r.abc_class}</span>}
                    <span className="sk-reco-reason" style={{ color: reason.color, background: reason.bg }}>{reason.label}</span>
                    <span className={`sk-reco-supply ${r.supply_type}`}>
                      {r.supply_type === 'reimpression' ? <><FiPrinter size={11} /> Réimpression</> : <><FiShoppingCart size={11} /> Commande</>}
                    </span>
                  </div>
                  <div className="sk-reco-title">{r.product_label}</div>
                  <div className="sk-reco-meta">
                    <span className="mono">{r.product_ref}</span>
                    <span><FiPackage size={11} /> Stock {r.current_stock_live ?? r.stock_on_hand}</span>
                    <span><FiTrendingDown size={11} /> Couv. {r.coverage_days}j</span>
                    <span>{Number(r.demand_avg_daily).toFixed(1)}/j</span>
                    {r.editeur && <span style={{ color: '#94a3b8' }}>{r.editeur}</span>}
                  </div>
                </div>
                <div className="sk-reco-qty">
                  <div className="sk-reco-qty-val">+{r.recommended_qty}</div>
                  <div className="sk-reco-qty-lbl">à commander</div>
                </div>
                {status === 'draft' && (
                  <div className="sk-reco-actions">
                    <button className="sk-btn-order" disabled={isBusy} onClick={() => handleOrder(r)}>
                      {r.supply_type === 'reimpression' ? <FiPrinter size={13} /> : <FiShoppingCart size={13} />}
                      {isBusy ? '…' : 'Commander'}
                    </button>
                    <button className="sk-btn-ghost" disabled={isBusy} title="Marquer approuvée (sans créer la commande)"
                      onClick={() => act(r.id, () => approveRecommendation(r.id), 'Approuvée')}><FiCheck size={15} /></button>
                    <button className="sk-btn-ghost danger" disabled={isBusy} title="Ignorer"
                      onClick={() => act(r.id, () => cancelRecommendation(r.id), 'Ignorée')}><FiX size={15} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
