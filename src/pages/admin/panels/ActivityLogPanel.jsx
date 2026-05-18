import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  FiActivity, FiRefreshCw, FiDownload, FiSearch, FiFilter, FiX,
  FiLogIn, FiLogOut, FiUserPlus, FiUserMinus, FiSettings, FiMail, FiEdit3,
  FiTrash2, FiUpload, FiCheck, FiAlertCircle, FiClock, FiUsers, FiCalendar,
} from 'react-icons/fi';
import { getActivityLog, getActivityStats, getActivityExportUrl } from '../../../api/admin';
import './ActivityLogPanel.css';

const REFRESH_INTERVAL_MS = 15000;
const PAGE_SIZE = 50;

// Libellés humanisés pour chaque action connue
const ACTION_LABELS = {
  login: 'Connexion',
  logout: 'Déconnexion',
  create_admin: 'Création utilisateur',
  delete_admin: 'Suppression utilisateur',
  update_admin: 'Modification utilisateur',
  reply_message: 'Réponse message',
  update_config: 'Modification config',
  create_book: 'Création livre',
  update_book: 'Modification livre',
  delete_book: 'Suppression livre',
  upload_cover: 'Upload couverture',
  create_contract: 'Création contrat',
  update_contract: 'Modification contrat',
  confirm_payment: 'Paiement confirmé',
  reject_payment: 'Paiement rejeté',
  create_tag: 'Création tag',
  delete_tag: 'Suppression tag',
  update_tag: 'Modification tag',
};

// Classification visuelle (icône + couleur) par famille d'action
function classifyAction(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'login') return { icon: FiLogIn, color: '#0ea5e9', tone: 'info' };
  if (a === 'logout') return { icon: FiLogOut, color: '#64748b', tone: 'muted' };
  if (a.includes('delete')) return { icon: FiTrash2, color: '#b91c1c', tone: 'danger' };
  if (a.includes('create') || a.includes('add')) return { icon: FiUserPlus, color: '#059669', tone: 'success' };
  if (a.includes('update') || a.includes('edit') || a.includes('modif')) return { icon: FiEdit3, color: '#d97706', tone: 'warn' };
  if (a.includes('reply') || a.includes('message')) return { icon: FiMail, color: '#7c3aed', tone: 'purple' };
  if (a.includes('config')) return { icon: FiSettings, color: '#0891b2', tone: 'teal' };
  if (a.includes('upload')) return { icon: FiUpload, color: '#10531a', tone: 'green' };
  if (a.includes('payment')) return { icon: FiCheck, color: '#059669', tone: 'success' };
  if (a.includes('reject')) return { icon: FiAlertCircle, color: '#dc2626', tone: 'danger' };
  return { icon: FiActivity, color: '#6b7280', tone: 'default' };
}

// Formatte une date en libellé de groupe ("Aujourd'hui", "Hier", "lundi 22 avril 2026", ...)
function dayLabel(dateStr) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : ' '));
  // Normalise à minuit local
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return 'Hier';
  return day.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

function dayKey(dateStr) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : ' '));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeShort(dateStr) {
  const d = new Date(dateStr + (dateStr.includes('T') ? '' : ' '));
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export default function ActivityLogPanel() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);

  // Filtres
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [availableActions, setAvailableActions] = useState([]);
  const [availableUsers, setAvailableUsers] = useState([]);

  // Stats
  const [stats, setStats] = useState(null);

  const intervalRef = useRef(null);

  const filters = useMemo(() => ({
    page,
    limit: PAGE_SIZE,
    ...(q ? { search: q } : {}),
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(userFilter ? { username: userFilter } : {}),
    ...(fromDate ? { from: fromDate } : {}),
    ...(toDate ? { to: toDate } : {}),
  }), [page, q, actionFilter, userFilter, fromDate, toDate]);

  const filtersWithoutPage = useMemo(() => {
    const { page: _p, limit: _l, ...rest } = filters;
    return rest;
  }, [filters]);

  // Debounce search input → q
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  // Reset page quand un autre filtre change
  useEffect(() => { setPage(0); }, [actionFilter, userFilter, fromDate, toDate]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const res = await getActivityLog(filters);
      const data = res.data || {};
      setLogs(data.logs || []);
      setTotal(data.total || 0);
      if (Array.isArray(data.available_actions)) setAvailableActions(data.available_actions);
      if (Array.isArray(data.available_users)) setAvailableUsers(data.available_users);
      setLastUpdate(new Date());
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [filters]);

  const loadStats = useCallback(() => {
    getActivityStats()
      .then((res) => setStats(res.data))
      .catch(() => setStats(null));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);

  useEffect(() => {
    if (!autoRefresh) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      load(true);
      loadStats();
    }, REFRESH_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, load, loadStats]);

  const resetFilters = () => {
    setQInput(''); setQ('');
    setActionFilter(''); setUserFilter('');
    setFromDate(''); setToDate('');
  };

  const hasActiveFilters = q || actionFilter || userFilter || fromDate || toDate;

  // Groupement par jour pour affichage timeline
  const groupedLogs = useMemo(() => {
    const groups = [];
    let currentKey = null;
    for (const log of logs) {
      const key = dayKey(log.created_at);
      if (key !== currentKey) {
        groups.push({ key, label: dayLabel(log.created_at), items: [] });
        currentKey = key;
      }
      groups[groups.length - 1].items.push(log);
    }
    return groups;
  }, [logs]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const exportUrl = getActivityExportUrl(filtersWithoutPage);

  return (
    <div className="activity-panel">
      {/* Header */}
      <div className="activity-header">
        <div>
          <h2><FiActivity aria-hidden="true" /> Journal d'activité</h2>
          <p>Historique des actions effectuées dans l'administration</p>
        </div>
        <div className="activity-header-actions">
          <label className="activity-auto">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto (15s)
          </label>
          <a
            href={exportUrl}
            className="btn btn-outline"
            download
            title="Exporter les résultats filtrés en CSV"
          >
            <FiDownload aria-hidden="true" /> Export CSV
          </a>
          <button
            type="button"
            onClick={() => { load(false); loadStats(); }}
            disabled={refreshing}
            className="btn btn-primary"
            title="Actualiser maintenant"
          >
            <FiRefreshCw size={14} className={refreshing ? 'spin' : ''} aria-hidden="true" />
            Actualiser
          </button>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="activity-stats-grid">
          <StatCard icon={FiClock} label="Aujourd'hui" value={stats.today} color="#10531a" />
          <StatCard icon={FiCalendar} label="7 derniers jours" value={stats.week} color="#0284c7" />
          <StatCard icon={FiActivity} label="Total historique" value={stats.total} color="#7c3aed" />
          <StatCard icon={FiUsers} label="Utilisateurs actifs" value={stats.byUser?.length || 0} color="#ea580c" />
        </div>
      )}

      {/* Top actions */}
      {stats?.byAction?.length > 0 && (
        <div className="activity-top">
          <span className="activity-top-label">Actions les plus fréquentes :</span>
          <div className="activity-top-chips">
            {stats.byAction.slice(0, 6).map((a) => {
              const { color, icon: Icon } = classifyAction(a.action);
              return (
                <button
                  key={a.action}
                  type="button"
                  className={`activity-top-chip ${actionFilter === a.action ? 'active' : ''}`}
                  onClick={() => setActionFilter(actionFilter === a.action ? '' : a.action)}
                  style={{ borderColor: color, color }}
                  title={`Filtrer sur ${ACTION_LABELS[a.action] || a.action}`}
                >
                  <Icon size={12} aria-hidden="true" />
                  {ACTION_LABELS[a.action] || a.action}
                  <span className="activity-top-chip-count">{a.c}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Toolbar : search + filters toggle */}
      <div className="activity-toolbar">
        <label className="activity-search" htmlFor="activity-search-input">
          <FiSearch aria-hidden="true" />
          <input
            id="activity-search-input"
            type="text"
            placeholder="Rechercher dans le journal..."
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
          />
          {qInput && (
            <button
              type="button"
              className="activity-search-clear"
              onClick={() => setQInput('')}
              aria-label="Effacer la recherche"
            >
              <FiX size={14} aria-hidden="true" />
            </button>
          )}
        </label>
        <button
          type="button"
          className={`btn btn-outline ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters((s) => !s)}
        >
          <FiFilter aria-hidden="true" /> Filtres
          {hasActiveFilters && <span className="activity-dot" aria-label="Filtres actifs" />}
        </button>
        {hasActiveFilters && (
          <button type="button" className="btn btn-link" onClick={resetFilters}>
            Réinitialiser
          </button>
        )}
      </div>

      {showFilters && (
        <div className="activity-filters">
          <div className="activity-filter">
            <label htmlFor="filter-action">Action</label>
            <select id="filter-action" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
              <option value="">Toutes</option>
              {availableActions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>
              ))}
            </select>
          </div>
          <div className="activity-filter">
            <label htmlFor="filter-user">Utilisateur</label>
            <select id="filter-user" value={userFilter} onChange={(e) => setUserFilter(e.target.value)}>
              <option value="">Tous</option>
              {availableUsers.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <div className="activity-filter">
            <label htmlFor="filter-from">Du</label>
            <input
              id="filter-from"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="activity-filter">
            <label htmlFor="filter-to">Au</label>
            <input
              id="filter-to"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Result count + last update */}
      <div className="activity-meta">
        <span>
          <strong>{total.toLocaleString('fr-FR')}</strong> entrée{total > 1 ? 's' : ''}
          {hasActiveFilters && ' (filtrées)'}
        </span>
        {lastUpdate && (
          <span className="activity-meta-updated">
            Mis à jour à {lastUpdate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        )}
      </div>

      {/* Timeline */}
      {loading ? (
        <div className="activity-loading">Chargement…</div>
      ) : logs.length === 0 ? (
        <div className="activity-empty">
          <FiClock size={40} aria-hidden="true" />
          <p>Aucune activité{hasActiveFilters ? ' ne correspond à vos filtres' : ' enregistrée'}</p>
        </div>
      ) : (
        <div className="activity-timeline">
          {groupedLogs.map((group) => (
            <div key={group.key} className="activity-day">
              <div className="activity-day-header">
                <span className="activity-day-label">{group.label}</span>
                <span className="activity-day-count">{group.items.length} action{group.items.length > 1 ? 's' : ''}</span>
              </div>
              <ul className="activity-day-items">
                {group.items.map((log) => {
                  const { icon: Icon, color, tone } = classifyAction(log.action);
                  return (
                    <li key={log.id} className={`activity-item tone-${tone}`}>
                      <div className="activity-item-icon" style={{ background: `${color}18`, color }}>
                        <Icon size={14} aria-hidden="true" />
                      </div>
                      <div className="activity-item-body">
                        <div className="activity-item-head">
                          <strong>{log.admin_username}</strong>
                          <span className="activity-item-action" style={{ background: `${color}18`, color }}>
                            {ACTION_LABELS[log.action] || log.action}
                          </span>
                        </div>
                        {log.details && <p className="activity-item-details">{log.details}</p>}
                      </div>
                      <time className="activity-item-time" dateTime={log.created_at}>
                        {timeShort(log.created_at)}
                      </time>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="activity-pagination">
          <button
            type="button"
            disabled={page === 0 || refreshing}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ‹ Précédent
          </button>
          <span>Page <strong>{page + 1}</strong> / {totalPages}</span>
          <button
            type="button"
            disabled={page >= totalPages - 1 || refreshing}
            onClick={() => setPage((p) => p + 1)}
          >
            Suivant ›
          </button>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }) {
  return (
    <div className="activity-stat-card">
      <div className="activity-stat-icon" style={{ background: `${color}18`, color }}>
        <Icon size={18} aria-hidden="true" />
      </div>
      <div>
        <div className="activity-stat-value">{(value || 0).toLocaleString('fr-FR')}</div>
        <div className="activity-stat-label">{label}</div>
      </div>
    </div>
  );
}
