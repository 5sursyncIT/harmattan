import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiPackage, FiAlertTriangle, FiTrendingUp, FiClock, FiDollarSign, FiArchive, FiRefreshCw, FiList } from 'react-icons/fi';
import { getStockDashboard, runStockBatch } from '../../../api/admin';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Stock.css';

const ALERT_LABELS = { rupture: 'Ruptures', stock_bas: 'Stock bas', sous_point_de_commande: 'Sous ROP', couverture_critique: 'Couverture critique', surstock: 'Surstock', stock_dormant: 'Dormants' };

function KPI({ icon, value, label, color = '#10531a' }) {
  return (
    <div className="sk-kpi">
      <div className="sk-kpi-icon" style={{ background: `${color}15`, color }}>{icon}</div>
      <div className="sk-kpi-value">{value}</div>
      <div className="sk-kpi-label">{label}</div>
    </div>
  );
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    setLoading(true);
    getStockDashboard()
      .then(r => setData(r.data))
      .catch(() => toast.error('Erreur chargement dashboard stock'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await runStockBatch();
      toast.success('Recalcul terminé');
      load();
    } catch { toast.error('Erreur recalcul'); }
    finally { setRefreshing(false); }
  };

  if (loading) return <Loader />;
  if (!data) return <p>Erreur chargement</p>;

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiPackage /> Pilotage Stock
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/admin/stock/products" className="btn btn-outline"><FiPackage size={14} /> Gérer le stock</Link>
          <Link to="/admin/stock/alerts" className="btn btn-outline"><FiList size={14} /> Alertes</Link>
          <button onClick={handleRefresh} disabled={refreshing} className="btn btn-primary">
            <FiRefreshCw size={14} className={refreshing ? 'spin' : ''} />
            {refreshing ? 'Recalcul...' : 'Recalculer'}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="sk-kpi-grid">
        <KPI icon={<FiPackage size={20} />} value={data.total_products?.toLocaleString('fr-FR')} label="Références actives" />
        <KPI icon={<FiDollarSign size={20} />} value={formatPrice(data.value_public)} label="Valeur stock (prix public)" color="#0284c7" />
        <KPI icon={<FiAlertTriangle size={20} />} value={data.ruptures} label={`Ruptures (${data.taux_rupture}%)`} color="#dc2626" />
        <KPI icon={<FiArchive size={20} />} value={data.stock_bas} label="Stock bas" color="#f59e0b" />
        <KPI icon={<FiClock size={20} />} value={`${data.avg_coverage_days}j`} label="Couverture moyenne" color="#7c3aed" />
        <KPI icon={<FiTrendingUp size={20} />} value={data.dormant_count} label="Réf. dormantes (180j)" color="#94a3b8" />
      </div>

      {/* Alertes actives */}
      {data.alert_summary?.length > 0 && (
        <div className="sk-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h4 className="sk-section-title" style={{ margin: 0 }}><FiAlertTriangle size={16} /> Alertes actives</h4>
            <Link to="/admin/stock/alerts" style={{ fontSize: '0.85rem', color: '#10531a', fontWeight: 600 }}>Voir toutes les alertes</Link>
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

      {/* Stock par éditeur */}
      {data.by_publisher?.length > 0 && (
        <div className="sk-section">
          <h4 className="sk-section-title">Stock par éditeur</h4>
          <div className="sk-wh-row">
            {data.by_publisher.map(p => (
              <div key={p.editeur} className="sk-wh-pill">
                <strong>{p.editeur}</strong> — {p.products} réf. / {p.units} unités
                {p.ruptures > 0 && <span style={{ color: '#dc2626', fontWeight: 700, marginLeft: 8 }}>({p.ruptures} ruptures)</span>}
              </div>
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
              <div key={w.id} className="sk-wh-pill">
                <strong>{w.name}</strong> — {w.products} réf. / {w.units} unités
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top produits avec couverture */}
      {data.top_products?.length > 0 && (
        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Top 20 — Ventes & couverture</h4>
          <div className="sk-table-wrap">
            <table className="sk-table">
              <thead>
                <tr>
                  <th>Réf.</th>
                  <th>Titre</th>
                  <th>Éditeur</th>
                  <th>Réappro</th>
                  <th>Stock</th>
                  <th>Ventes 30j</th>
                  <th>Couverture</th>
                  <th>Rotation</th>
                </tr>
              </thead>
              <tbody>
                {data.top_products.map(p => (
                  <tr key={p.product_id}>
                    <td className="mono">{p.ref}</td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</td>
                    <td style={{ fontSize: '0.78rem', color: '#64748b' }}>{p.editeur || '—'}</td>
                    <td><span style={{ padding: '2px 6px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700, background: p.supply_type === 'reimpression' ? '#dbeafe' : '#fef3c7', color: p.supply_type === 'reimpression' ? '#1e40af' : '#92400e' }}>{p.supply_type === 'reimpression' ? 'Réimpression' : 'Commande'}</span></td>
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
