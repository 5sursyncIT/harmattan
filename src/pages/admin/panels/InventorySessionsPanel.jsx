import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getInventorySessions, getInventoryScopeOptions, createInventorySession,
  deleteInventorySession,
} from '../../../api/admin';
import useAdminRole from '../../../hooks/useAdminRole';
import {
  FiClipboard, FiPlus, FiX, FiPackage, FiGrid, FiBookOpen, FiList,
  FiChevronRight, FiTrash2,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import './Stock.css';
import './Inventory.css';

const MANAGE_ROLES = ['super_admin', 'admin', 'gestionnaire_stock'];

const STATUS_LABEL = { draft: 'Brouillon', counting: 'En comptage', closed: 'Clôturé', canceled: 'Annulé' };
const STATUS_TABS = [
  { key: '', label: 'Tous' },
  { key: 'draft', label: 'Brouillons' },
  { key: 'counting', label: 'En comptage' },
  { key: 'closed', label: 'Clôturés' },
];

const SCOPE_OPTIONS = [
  { key: 'category', t: 'Par catégorie', d: 'Inventaire tournant, rayon par rayon', icon: <FiGrid size={18} /> },
  { key: 'publisher', t: 'Par éditeur', d: 'Tous les titres d\'un éditeur', icon: <FiBookOpen size={18} /> },
  { key: 'warehouse', t: 'Entrepôt complet', d: 'Tout le stock tracé d\'un entrepôt', icon: <FiPackage size={18} /> },
  { key: 'manual', t: 'Sélection / scan', d: 'On scanne les titres au fil de l\'eau', icon: <FiList size={18} /> },
];

export default function InventorySessionsPanel() {
  const role = useAdminRole();
  const canManage = MANAGE_ROLES.includes(role);
  const navigate = useNavigate();

  const [sessions, setSessions] = useState([]);
  const [counts, setCounts] = useState({});
  const [tab, setTab] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getInventorySessions(tab ? { status: tab } : {})
      .then(r => { setSessions(r.data.sessions || []); setCounts(r.data.counts || {}); })
      .catch(() => toast.error('Erreur chargement des inventaires'))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (e, s) => {
    e.preventDefault(); e.stopPropagation();
    if (!window.confirm(`Supprimer l'inventaire ${s.ref} ? (${STATUS_LABEL[s.status]})`)) return;
    try {
      await deleteInventorySession(s.id);
      toast.success('Inventaire supprimé');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Suppression impossible');
    }
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiClipboard size={18} style={{ color: '#1e40af' }} /> Inventaire physique
        </h3>
        {canManage && (
          <button className="inv-btn inv-btn-primary" onClick={() => setShowCreate(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <FiPlus size={16} /> Nouvel inventaire
          </button>
        )}
      </div>

      <p style={{ color: '#64748b', fontSize: '0.88rem', marginTop: 0 }}>
        Comptez le stock physique (scan ISBN, saisie ou import), puis clôturez : les écarts
        sont appliqués automatiquement au stock.
      </p>

      {/* Onglets statut */}
      <div className="sk-filters" style={{ marginBottom: 14 }}>
        {STATUS_TABS.map(t => (
          <button key={t.key} className={`sk-filter-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key && counts[t.key] > 0 && <span className="sk-filter-count">{counts[t.key]}</span>}
          </button>
        ))}
      </div>

      {loading ? <Loader /> : sessions.length === 0 ? (
        <div className="sk-empty">
          <FiClipboard size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucun inventaire {tab ? `« ${STATUS_LABEL[tab]} »` : ''}</p>
          {canManage && <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Cliquez sur « Nouvel inventaire » pour démarrer.</p>}
        </div>
      ) : (
        <div className="inv-session-list">
          {sessions.map(s => {
            const st = s.stats || {};
            const pct = st.total > 0 ? Math.round((st.counted / st.total) * 100) : 0;
            return (
              <div key={s.id} className="inv-session-card" role="button" tabIndex={0}
                onClick={() => navigate(`/admin/inventory/${s.id}`)}
                onKeyDown={e => { if (e.key === 'Enter') navigate(`/admin/inventory/${s.id}`); }}>
                <div className="inv-session-main">
                  <div className="inv-session-ref">
                    <span className="mono">{s.ref}</span>{s.title ? ` — ${s.title}` : ''}
                  </div>
                  <div className="inv-session-meta">
                    {s.scope_label} · créé par {s.created_by} le {new Date(s.created_at).toLocaleDateString('fr-FR')}
                  </div>
                </div>

                {s.status === 'counting' && st.total > 0 && (
                  <div className="inv-session-prog">
                    <div style={{ fontSize: '0.8rem', color: '#475569', marginBottom: 4 }}>{st.counted}/{st.total} comptés</div>
                    <div className="inv-progress-track"><div className="inv-progress-fill" style={{ width: `${pct}%` }} /></div>
                  </div>
                )}

                <span className={`inv-status ${s.status}`}>{STATUS_LABEL[s.status]}</span>

                {canManage && s.status !== 'closed' && (
                  <button title="Supprimer" onClick={e => handleDelete(e, s)}
                    className="sk-btn-ghost" style={{ color: '#dc2626', padding: 6 }}>
                    <FiTrash2 size={15} />
                  </button>
                )}
                <FiChevronRight size={18} style={{ color: '#cbd5e1' }} />
              </div>
            );
          })}
        </div>
      )}

      {showCreate && (
        <InventoryCreateModal
          onClose={() => setShowCreate(false)}
          onCreated={(s) => { setShowCreate(false); navigate(`/admin/inventory/${s.id}`); }}
        />
      )}
    </div>
  );
}

// ─── Modale de création (choix du périmètre) ──────────────────
function InventoryCreateModal({ onClose, onCreated }) {
  const [opts, setOpts] = useState(null);
  const [scope, setScope] = useState('category');
  const [warehouseId, setWarehouseId] = useState(null);
  const [scopeValue, setScopeValue] = useState('');
  const [title, setTitle] = useState('');
  const [uncountedZero, setUncountedZero] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getInventoryScopeOptions()
      .then(r => {
        setOpts(r.data);
        setWarehouseId(r.data.default_warehouse || r.data.warehouses?.[0]?.id);
        if (r.data.categories?.length) setScopeValue(String(r.data.categories[0].id));
      })
      .catch(() => toast.error('Erreur chargement des périmètres'));
  }, []);

  // Réinitialise la valeur de périmètre quand on change de type.
  useEffect(() => {
    if (!opts) return;
    if (scope === 'category') setScopeValue(opts.categories?.[0] ? String(opts.categories[0].id) : '');
    else if (scope === 'publisher') setScopeValue(opts.publishers?.[0]?.label || '');
    else setScopeValue('');
  }, [scope, opts]);

  const submit = async () => {
    if (scope === 'category' && !scopeValue) { toast.error('Choisissez une catégorie'); return; }
    if (scope === 'publisher' && !scopeValue) { toast.error('Choisissez un éditeur'); return; }
    setSaving(true);
    try {
      const r = await createInventorySession({
        title: title.trim() || null,
        warehouse_id: warehouseId,
        scope_type: scope,
        scope_value: scope === 'category' || scope === 'publisher' ? scopeValue : null,
        treat_uncounted_as_zero: scope === 'warehouse' ? uncountedZero : false,
      });
      toast.success(`Inventaire ${r.data.ref} créé`);
      onCreated(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="inv-modal-overlay" onClick={() => !saving && onClose()}>
      <div className="inv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiClipboard size={18} style={{ color: '#1e40af' }} /> Nouvel inventaire
          </h3>
          <button className="sk-btn-ghost" onClick={onClose} disabled={saving}><FiX size={18} /></button>
        </div>

        {!opts ? <Loader /> : (
          <>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', margin: '12px 0 4px' }}>Périmètre</label>
            <div className="inv-scope-grid">
              {SCOPE_OPTIONS.map(o => (
                <div key={o.key} className={`inv-scope-opt ${scope === o.key ? 'active' : ''}`} onClick={() => setScope(o.key)}>
                  <span style={{ color: scope === o.key ? '#1e40af' : '#94a3b8' }}>{o.icon}</span>
                  <div><div className="t">{o.t}</div><div className="d">{o.d}</div></div>
                </div>
              ))}
            </div>

            {/* Entrepôt */}
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Entrepôt</label>
            <select value={warehouseId || ''} onChange={e => setWarehouseId(parseInt(e.target.value, 10))}
              style={selStyle}>
              {opts.warehouses.map(w => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>

            {/* Valeur de périmètre conditionnelle */}
            {scope === 'category' && (
              <>
                <label style={lblStyle}>Catégorie</label>
                <select value={scopeValue} onChange={e => setScopeValue(e.target.value)} style={selStyle}>
                  {opts.categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </>
            )}
            {scope === 'publisher' && (
              <>
                <label style={lblStyle}>Éditeur</label>
                <select value={scopeValue} onChange={e => setScopeValue(e.target.value)} style={selStyle}>
                  {opts.publishers.map(p => <option key={p.label} value={p.label}>{p.label} ({p.products})</option>)}
                </select>
              </>
            )}
            {scope === 'manual' && (
              <div className="inv-warn">
                <FiList size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>Aucune liste pré-chargée : vous scannerez (ou chercherez) les titres directement sur l'écran de comptage.</span>
              </div>
            )}

            {scope === 'warehouse' && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '12px 0', fontSize: '0.82rem', color: '#475569' }}>
                <input type="checkbox" checked={uncountedZero} onChange={e => setUncountedZero(e.target.checked)} style={{ marginTop: 2 }} />
                <span>Considérer les titres <strong>non comptés comme épuisés (0)</strong> à la clôture. À n'activer que pour un inventaire réellement exhaustif.</span>
              </label>
            )}

            <label style={lblStyle}>Libellé (facultatif)</label>
            <input type="text" value={title} maxLength={120} onChange={e => setTitle(e.target.value)}
              placeholder="Ex : Inventaire rayon jeunesse — juin" style={{ ...selStyle, fontWeight: 400 }} />

            <div className="inv-modal-actions">
              <button className="inv-btn inv-btn-outline" onClick={onClose} disabled={saving}>Annuler</button>
              <button className="inv-btn inv-btn-primary" onClick={submit} disabled={saving}>
                {saving ? 'Création…' : 'Créer l\'inventaire'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const selStyle = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: '0.9rem', marginBottom: 10, background: '#fff' };
const lblStyle = { display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 };
