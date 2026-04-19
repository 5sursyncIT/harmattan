import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getStockAlerts, acknowledgeStockAlert, resolveStockAlert, ignoreStockAlert } from '../../../api/admin';
import { FiAlertTriangle, FiArrowLeft, FiCheck, FiEye, FiXCircle } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Stock.css';

const TYPE_LABELS = {
  rupture: 'Rupture de stock', stock_bas: 'Stock bas', sous_point_de_commande: 'Sous point de commande',
  couverture_critique: 'Couverture critique', surstock: 'Surstock', stock_dormant: 'Stock dormant',
  retard_fournisseur: 'Retard fournisseur',
};
const STATUS_TABS = [
  { value: 'open', label: 'Ouvertes' },
  { value: 'acknowledged', label: 'Prises en compte' },
  { value: 'resolved', label: 'Résolues' },
  { value: 'ignored', label: 'Ignorées' },
];

export default function StockAlertsPanel() {
  const [alerts, setAlerts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('open');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);

  const [fetchKey, setFetchKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    getStockAlerts({ status, type: typeFilter, page })
      .then(r => { if (!cancelled) { setAlerts(r.data.alerts); setTotal(r.data.total); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement alertes'); setLoading(false); } });
    return () => { cancelled = true; controller.abort(); };
  }, [status, typeFilter, page, fetchKey]);

  const reload = () => { setLoading(true); setFetchKey(k => k + 1); };

  const handleAction = async (id, action) => {
    try {
      if (action === 'acknowledge') await acknowledgeStockAlert(id);
      else if (action === 'resolve') await resolveStockAlert(id);
      else if (action === 'ignore') await ignoreStockAlert(id);
      toast.success('Alerte mise à jour');
      reload();
    } catch { toast.error('Erreur'); }
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0 }}><FiAlertTriangle size={18} /> Alertes stock ({total})</h3>
        </div>
      </div>

      {/* Status tabs */}
      <div className="sk-filters">
        {STATUS_TABS.map(t => (
          <button key={t.value} className={`sk-filter-btn ${status === t.value ? 'active' : ''}`}
            onClick={() => { setStatus(t.value); setPage(1); }}>{t.label}</button>
        ))}
      </div>

      {/* Type filter */}
      <div className="sk-filters">
        <button className={`sk-filter-btn ${!typeFilter ? 'active' : ''}`} onClick={() => { setTypeFilter(''); setPage(1); }}>Toutes</button>
        {Object.entries(TYPE_LABELS).map(([k, v]) => (
          <button key={k} className={`sk-filter-btn ${typeFilter === k ? 'active' : ''}`}
            onClick={() => { setTypeFilter(k); setPage(1); }}>{v}</button>
        ))}
      </div>

      {loading ? <Loader /> : alerts.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiCheck size={40} style={{ marginBottom: 8, opacity: 0.4 }} />
          <p>Aucune alerte {status === 'open' ? 'ouverte' : status}</p>
        </div>
      ) : (
        <>
          {alerts.map(a => (
            <div key={a.id} className="sk-alert-item">
              <div className="sk-alert-left">
                <div className={`sk-alert-severity ${a.severity}`} />
                <div className="sk-alert-info">
                  <div className="sk-alert-type">{TYPE_LABELS[a.alert_type] || a.alert_type}</div>
                  <div className="sk-alert-product">
                    {a.product_ref && <span className="mono" style={{ marginRight: 6 }}>{a.product_ref}</span>}
                    {a.product_label || `Produit #${a.product_id}`}
                  </div>
                </div>
                <div className="sk-alert-meta">
                  <span>Stock: <strong>{a.current_stock_live ?? a.current_stock}</strong></span>
                  <span>Couv: <strong>{a.coverage_days}j</strong></span>
                  {a.recommended_qty > 0 && <span>Reco: <strong>+{a.recommended_qty}</strong></span>}
                  <span>{formatDate(a.created_at)}</span>
                </div>
              </div>
              {status === 'open' && (
                <div className="sk-alert-actions">
                  <button className="sk-alert-btn" onClick={() => handleAction(a.id, 'acknowledge')} title="Prendre en compte"><FiEye size={12} /></button>
                  <button className="sk-alert-btn resolve" onClick={() => handleAction(a.id, 'resolve')} title="Résoudre"><FiCheck size={12} /></button>
                  <button className="sk-alert-btn" onClick={() => handleAction(a.id, 'ignore')} title="Ignorer"><FiXCircle size={12} /></button>
                </div>
              )}
              {status === 'acknowledged' && (
                <div className="sk-alert-actions">
                  <button className="sk-alert-btn resolve" onClick={() => handleAction(a.id, 'resolve')}>Résoudre</button>
                </div>
              )}
            </div>
          ))}

          {total > 50 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 16 }}>
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="sk-filter-btn">Précédent</button>
              <span style={{ padding: '6px 12px', fontSize: '0.85rem', color: '#64748b' }}>Page {page}</span>
              <button disabled={alerts.length < 50} onClick={() => setPage(p => p + 1)} className="sk-filter-btn">Suivant</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
