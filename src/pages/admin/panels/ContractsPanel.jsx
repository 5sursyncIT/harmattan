import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getContractStats, getExpiringContracts, getPendingIsbnContracts, setContractIsbn } from '../../../api/contracts';
import { FiFileText, FiPlus, FiAlertTriangle, FiCheckCircle, FiClock, FiBookOpen, FiHash, FiSave } from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import './Contracts.css';
import { contractTypeColor } from '../../../utils/contractTypes';
import useAdminRole, { CONTRACT_WRITE_ROLES } from '../../../hooks/useAdminRole';

// File d'attente « contrats en attente d'ISBN » : un livre n'a son ISBN qu'après
// impression / dépôt légal, mais le calcul des droits d'auteur exige l'ISBN pour
// rattacher les ventes. Cette carte liste les contrats validés sans ISBN et
// permet de le compléter (avec vérification qu'un produit catalogue correspond).
function IsbnQueueCard({ canEdit }) {
  const [items, setItems] = useState(null);
  const [drafts, setDrafts] = useState({}); // { [contractId]: isbn saisi }
  const [saving, setSaving] = useState(null);

  const load = () => getPendingIsbnContracts().then(r => setItems(r.data.items || [])).catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  const save = async (id) => {
    const isbn = (drafts[id] || '').trim();
    if (!isbn) return;
    setSaving(id);
    try {
      const { data } = await setContractIsbn(id, isbn);
      if (data.catalog_match) {
        toast.success(`ISBN enregistré — produit catalogue trouvé : ${data.catalog_match.label || data.catalog_match.ref}. Les droits se calculeront désormais.`);
      } else {
        toast(`ISBN enregistré, mais AUCUN produit catalogue ne correspond encore. Les droits resteront à 0 tant que le livre n'est pas au catalogue avec ce code-barres.`, { icon: '⚠️', duration: 7000 });
      }
      setItems(prev => prev.filter(it => it.id !== id));
      setDrafts(prev => { const n = { ...prev }; delete n[id]; return n; });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de l\'enregistrement de l\'ISBN');
    } finally { setSaving(null); }
  };

  if (items === null) return null;            // pas encore chargé : pas de scintillement
  if (items.length === 0) return null;        // file vide : on n'affiche rien

  return (
    <div className="admin-card" style={{ borderLeft: '4px solid #f59e0b', background: '#fffbeb' }}>
      <h4 style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 6, color: '#b45309' }}>
        <FiHash size={16} /> {items.length} contrat{items.length > 1 ? 's' : ''} en attente d'ISBN
      </h4>
      <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: '#92400e' }}>
        Droits d'auteur incalculables tant que l'ISBN n'est pas renseigné. À compléter une fois le livre imprimé / déposé.
      </p>
      {items.map(c => (
        <div key={c.id} className="ct-isbn-queue-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #fde68a' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Link to={`/admin/contracts/${c.id}`} style={{ fontWeight: 600, color: '#1f2937', textDecoration: 'none' }}>
              {c.book_title || c.ref}
            </Link>
            <div style={{ color: '#92400e', fontSize: '0.78rem' }}>{c.ref} · {c.author_name}</div>
          </div>
          {canEdit ? (
            <>
              <input
                type="text"
                inputMode="numeric"
                placeholder="ISBN (10 ou 13 chiffres)"
                value={drafts[c.id] || ''}
                onChange={e => setDrafts(prev => ({ ...prev, [c.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') save(c.id); }}
                style={{ width: 200, padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.85rem' }}
              />
              <button
                onClick={() => save(c.id)}
                disabled={saving === c.id || !(drafts[c.id] || '').trim()}
                className="ct-btn ct-btn-blue"
                style={{ whiteSpace: 'nowrap' }}
              >
                <FiSave size={13} /> {saving === c.id ? '…' : 'Enregistrer'}
              </button>
            </>
          ) : (
            <span style={{ color: '#92400e', fontSize: '0.8rem' }}>ISBN manquant</span>
          )}
        </div>
      ))}
    </div>
  );
}

const STATUS_COLORS = { 0: '#f59e0b', 1: '#10b981', 2: '#6b7280' };

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
  const [reloadKey, setReloadKey] = useState(0);
  const role = useAdminRole();
  const canCreate = CONTRACT_WRITE_ROLES.includes(role);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getContractStats().then(r => r.data),
      getExpiringContracts(30).then(r => r.data).catch(() => []),
    ])
      .then(([statsData, expiringData]) => {
        if (cancelled) return;
        setStats(statsData);
        setExpiring(expiringData || []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (loading) return <div style={{ height: 300, position: 'relative' }}><Loader /></div>;
  if (!stats) return (
    <div className="ct-empty">
      <FiAlertTriangle size={48} className="ct-empty-icon" style={{ color: '#ef4444' }} />
      <h3>Erreur de chargement</h3>
      <p>Impossible de récupérer le tableau de bord des contrats.</p>
      <button onClick={() => setReloadKey(k => k + 1)} className="ct-new-btn" style={{ marginTop: 8 }}>Réessayer</button>
    </div>
  );

  const byType = stats.byType || [];
  const recent = stats.recent || [];

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiBookOpen /> Gestion des contrats</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/admin/contracts/list" className="btn btn-outline">Voir tous les contrats</Link>
          {canCreate && <Link to="/admin/contracts/new" className="ct-new-btn"><FiPlus /> Nouveau contrat</Link>}
        </div>
      </div>

      <div className="admin-stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <StatCard icon={<FiFileText size={20} />} label="Total contrats" value={stats.total} />
        <StatCard icon={<FiClock size={20} />} label="Brouillons" value={stats.draft} color="#f59e0b" />
        <StatCard icon={<FiCheckCircle size={20} />} label="Actifs" value={stats.active} color="#10b981" />
        <StatCard icon={<FiAlertTriangle size={20} />} label="Expirent sous 90j" value={stats.expiringSoon} color="#ef4444" />
      </div>

      <IsbnQueueCard canEdit={canCreate} />

      {byType.length > 0 && (
        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Par type de contrat</h4>
          <div className="ct-type-row">
            {byType.map(t => (
              <div key={t.type} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="ct-type-dot" style={{ background: contractTypeColor(t.type) }} />
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
          {recent.map(c => (
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
