import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  FiPackage, FiAlertTriangle, FiTrendingUp, FiClock, FiArchive, FiRefreshCw,
  FiShoppingCart, FiChevronRight,
} from 'react-icons/fi';
import { getStockDashboard, runStockBatch, getStockRecommendations } from '../../../api/admin';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import StockNav from './StockNav';
import './Stock.css';

const ALERT_LABELS = { rupture: 'Ruptures', stock_bas: 'Stock bas', sous_point_de_commande: 'Sous ROP', couverture_critique: 'Couverture critique', surstock: 'Surstock', stock_dormant: 'Dormants' };

function KPI({ icon, value, label, color = '#10531a', to, sub }) {
  const inner = (
    <>
      <div className="sk-kpi-icon" style={{ background: `${color}15`, color }}>{icon}</div>
      <div className="sk-kpi-value">{value}</div>
      <div className="sk-kpi-label">{label}</div>
      {sub && <div className="sk-kpi-sub" style={{ color }}>{sub}</div>}
      {to && <FiChevronRight className="sk-kpi-arrow" size={16} />}
    </>
  );
  return to
    ? <Link to={to} className="sk-kpi sk-kpi-link">{inner}</Link>
    : <div className="sk-kpi">{inner}</div>;
}

function CoverageBar({ days }) {
  const pct = Math.min(100, (days / 90) * 100);
  const color = days <= 7 ? '#dc2626' : days <= 30 ? '#f59e0b' : '#10b981';
  return (
    <span>
      <span className="sk-cov-bar"><span className="sk-cov-fill" style={{ width: `${pct}%`, background: color }} /></span>
      <span style={{ fontSize: '0.8rem', color }}>{days > 365 ? '>365' : days}j</span>
    </span>
  );
}

export default function StockDashboardPanel() {
  const [data, setData] = useState(null);
  const [reco, setReco] = useState({ count: 0, qty: 0, top: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setLoading(true); setError(false);
    Promise.all([
      getStockDashboard().then(r => r.data),
      getStockRecommendations({ status: 'draft' }).then(r => r.data).catch(() => ({ recommendations: [], counts: {} })),
    ])
      .then(([dash, recoData]) => {
        setData(dash);
        const list = recoData.recommendations || [];
        setReco({
          count: recoData.counts?.draft || 0,
          qty: list.reduce((s, r) => s + (r.recommended_qty || 0), 0),
          top: list.slice(0, 5),
        });
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await runStockBatch(); toast.success('Recalcul terminé'); load(); }
    catch { toast.error('Erreur recalcul'); }
    finally { setRefreshing(false); }
  };

  if (loading) return <Loader />;
  if (error || !data) return (
    <div className="admin-panel">
      <div className="sk-empty">
        <FiAlertTriangle size={42} style={{ color: '#ef4444', marginBottom: 8 }} />
        <p style={{ fontWeight: 600 }}>Erreur de chargement du pilotage stock</p>
        <button className="btn btn-primary" onClick={load} style={{ marginTop: 8 }}>Réessayer</button>
      </div>
    </div>
  );

  const rateColor = data.taux_rupture >= 10 ? '#dc2626' : data.taux_rupture >= 5 ? '#f59e0b' : '#10b981';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiPackage /> Pilotage Stock</h3>
        <button onClick={handleRefresh} disabled={refreshing} className="btn btn-primary">
          <FiRefreshCw size={14} className={refreshing ? 'spin' : ''} />
          {refreshing ? 'Recalcul...' : 'Recalculer'}
        </button>
      </div>

      <StockNav badges={{ reco: reco.count }} />

      {/* KPIs */}
      <div className="sk-kpi-grid">
        <KPI icon={<FiPackage size={20} />} value={data.total_products?.toLocaleString('fr-FR')} label="Références actives" to="/admin/stock/products" />
        <KPI icon={<FiAlertTriangle size={20} />} value={data.ruptures} label="Ruptures" color="#dc2626" sub={`${data.taux_rupture}% du catalogue`} to="/admin/stock/alerts?type=rupture" />
        <KPI icon={<FiArchive size={20} />} value={data.stock_bas} label="Stock bas" color="#f59e0b" to="/admin/stock/alerts?type=stock_bas" />
        <KPI icon={<FiShoppingCart size={20} />} value={reco.count} label="À réapprovisionner" color="#2563eb" sub={reco.qty > 0 ? `${reco.qty.toLocaleString('fr-FR')} ex.` : null} to="/admin/stock/recommendations" />
        <KPI icon={<FiClock size={20} />} value={`${data.avg_coverage_days}j`} label="Couverture moyenne" color="#7c3aed" />
        <KPI icon={<FiTrendingUp size={20} />} value={data.dormant_count} label="Réf. dormantes (180j)" color="#94a3b8" />
      </div>

      {/* Taux de rupture — barre */}
      <div className="sk-section">
        <div className="sk-rate-card">
          <div className="sk-rate-head">
            <span>Taux de rupture</span>
            <strong style={{ color: rateColor }}>{data.taux_rupture}%</strong>
          </div>
          <div className="sk-rate-track"><span className="sk-rate-fill" style={{ width: `${Math.min(100, data.taux_rupture)}%`, background: rateColor }} /></div>
          <div className="sk-rate-foot">{data.ruptures} ruptures sur {data.total_products?.toLocaleString('fr-FR')} références — objectif &lt; 5%</div>
        </div>
      </div>

      {/* Recommandations — aperçu */}
      {reco.top.length > 0 && (
        <div className="sk-section">
          <div className="sk-section-head">
            <h4 className="sk-section-title" style={{ margin: 0 }}><FiShoppingCart size={16} /> Réapprovisionnements prioritaires</h4>
            <Link to="/admin/stock/recommendations" className="sk-section-link">Tout voir ({reco.count}) <FiChevronRight size={13} /></Link>
          </div>
          <div className="sk-reco-list">
            {reco.top.map(r => (
              <Link key={r.id} to="/admin/stock/recommendations" className="sk-reco-card sk-reco-card-mini">
                <div className="sk-reco-main">
                  <div className="sk-reco-title">{r.product_label}</div>
                  <div className="sk-reco-meta">
                    <span className="mono">{r.product_ref}</span>
                    <span>Stock {r.current_stock_live ?? r.stock_on_hand}</span>
                    <span>Couv. {r.coverage_days}j</span>
                    <span className={`sk-reco-supply ${r.supply_type}`}>{r.supply_type === 'reimpression' ? 'Réimpr.' : 'Cmd.'}</span>
                  </div>
                </div>
                <div className="sk-reco-qty"><div className="sk-reco-qty-val">+{r.recommended_qty}</div></div>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Alertes actives */}
      {data.alert_summary?.length > 0 && (
        <div className="sk-section">
          <div className="sk-section-head">
            <h4 className="sk-section-title" style={{ margin: 0 }}><FiAlertTriangle size={16} /> Alertes actives</h4>
            <Link to="/admin/stock/alerts" className="sk-section-link">Voir toutes <FiChevronRight size={13} /></Link>
          </div>
          <div className="sk-alert-summary">
            {data.alert_summary.map((a, i) => (
              <Link key={i} to={`/admin/stock/alerts?type=${a.alert_type}`} className={`sk-alert-chip ${a.severity}`} style={{ textDecoration: 'none' }}>
                {a.count} {ALERT_LABELS[a.alert_type] || a.alert_type}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Stock par dépôt */}
      {data.by_warehouse?.length > 0 && (
        <div className="sk-section">
          <h4 className="sk-section-title">Stock par dépôt</h4>
          <div className="sk-wh-row">
            {data.by_warehouse.map(w => (
              <div key={w.id} className="sk-wh-pill"><strong>{w.name}</strong> — {w.products} réf. / {w.units} unités</div>
            ))}
          </div>
        </div>
      )}

      {/* Top produits */}
      {data.top_products?.length > 0 && (
        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Top 20 — Ventes & couverture</h4>
          <div className="sk-table-wrap">
            <table className="sk-table">
              <thead>
                <tr><th>Réf.</th><th>Titre</th><th>Éditeur</th><th>Réappro</th><th>Stock</th><th>Ventes 30j</th><th>Couverture</th><th>Rotation</th></tr>
              </thead>
              <tbody>
                {data.top_products.map(p => (
                  <tr key={p.product_id}>
                    <td className="mono">{p.ref}</td>
                    <td className="sk-td-title">{p.label}</td>
                    <td style={{ fontSize: '0.78rem', color: '#64748b' }}>{p.editeur || '—'}</td>
                    <td><span className={`sk-supply-badge ${p.supply_type}`}>{p.supply_type === 'reimpression' ? 'Réimpression' : 'Commande'}</span></td>
                    <td style={{ fontWeight: 700, color: p.stock <= 0 ? '#dc2626' : p.stock < 5 ? '#f59e0b' : '#0f172a' }}>{p.stock}</td>
                    <td>{p.sold_30d}</td>
                    <td><CoverageBar days={p.coverage_days} /></td>
                    <td style={{ fontWeight: 600 }}>{p.rotation_annual}x</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
