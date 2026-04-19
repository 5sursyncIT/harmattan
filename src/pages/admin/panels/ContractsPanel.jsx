import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getContractStats, getExpiringContracts } from '../../../api/contracts';
import { FiFileText, FiPlus, FiAlertTriangle, FiCheckCircle, FiClock, FiBookOpen } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import './Contracts.css';

const STATUS_COLORS = { 0: '#f59e0b', 1: '#10b981', 2: '#6b7280' };
const TYPE_COLORS = { harmattan_2024: '#10531a', harmattan_dll: '#0284c7', tamarinier: '#7c3aed' };

function StatCard({ icon, label, value, color = '#10531a' }) {
  return (
    <div className="admin-stat-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', color, flexShrink: 0 }}>{icon}</div>
        <div>
          <div className="stat-number">{value}</div>
          <p style={{ margin: 0, fontSize: '0.8rem', color: '#888' }}>{label}</p>
        </div>
      </div>
    </div>
  );
}

export default function ContractsPanel() {
  const [stats, setStats] = useState(null);
  const [expiring, setExpiring] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getContractStats().then(r => setStats(r.data)),
      getExpiringContracts(30).then(r => setExpiring(r.data)),
    ]).catch(() => {}).finally(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ height: 300, position: 'relative' }}><Loader /></div>;
  if (!stats) return <p>Erreur chargement</p>;

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiBookOpen /> Gestion des contrats</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/admin/contracts/list" className="btn btn-outline">Voir tous les contrats</Link>
          <Link to="/admin/contracts/new" className="ct-new-btn"><FiPlus /> Nouveau contrat</Link>
        </div>
      </div>

      <div className="admin-stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <StatCard icon={<FiFileText size={20} />} label="Total contrats" value={stats.total} />
        <StatCard icon={<FiClock size={20} />} label="Brouillons" value={stats.draft} color="#f59e0b" />
        <StatCard icon={<FiCheckCircle size={20} />} label="Actifs" value={stats.active} color="#10b981" />
        <StatCard icon={<FiAlertTriangle size={20} />} label="Expirent sous 90j" value={stats.expiringSoon} color="#ef4444" />
      </div>

      {stats.byType.length > 0 && (
        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Par type de contrat</h4>
          <div className="ct-type-row">
            {stats.byType.map(t => (
              <div key={t.type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="ct-type-dot" style={{ background: TYPE_COLORS[t.type] || '#888' }} />
                <strong>{t.label}</strong>
                <span style={{ color: '#888' }}>({t.count})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="ct-dashboard-cols">
        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: 6, color: '#ef4444' }}>
            <FiAlertTriangle size={16} /> Expirent sous 30 jours
          </h4>
          {expiring.length === 0 ? (
            <p style={{ color: '#888', fontSize: '0.85rem' }}>Aucun contrat n'expire prochainement</p>
          ) : (
            expiring.map(c => (
              <Link key={c.id} to={`/admin/contracts/${c.id}`} className="ct-expiring-item">
                <div>
                  <strong>{c.title || c.ref}</strong>
                  <div style={{ color: '#888', fontSize: '0.78rem' }}>{c.author}</div>
                </div>
                <span className="ct-expiry-date">{formatDate(c.expiryDate)}</span>
              </Link>
            ))
          )}
        </div>

        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Derniers contrats</h4>
          {stats.recent.map(c => (
            <Link key={c.id} to={`/admin/contracts/${c.id}`} className="ct-recent-item">
              <div>
                <strong>{c.ref}</strong> — {c.title || 'Sans titre'}
                <div style={{ color: '#888', fontSize: '0.78rem' }}>{c.author}</div>
              </div>
              <span className={`ct-badge ${c.status === 0 ? 'ct-badge-draft' : c.status === 1 ? 'ct-badge-active' : 'ct-badge-closed'}`}>
                {c.statusLabel}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
