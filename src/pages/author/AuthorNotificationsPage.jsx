import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FiArrowLeft, FiBell, FiCheck, FiCheckSquare, FiAlertCircle, FiFilter, FiRefreshCw,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import './AuthorPages.css';
import './AuthorNotificationsPage.css';

const FILTERS = [
  { value: 'all', label: 'Toutes' },
  { value: 'unread', label: 'Non lues' },
  { value: 'action', label: 'Action requise' },
];

function formatFullDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function AuthorNotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [marking, setMarking] = useState(false);

  const load = () => {
    setLoading(true);
    authorApi.listNotifications(100)
      .then((res) => setItems(res.data || []))
      .catch((err) => {
        if (err.response?.status === 401) navigate('/auteur/connexion');
        else toast.error('Erreur de chargement');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load();   }, []);

  const filtered = useMemo(() => {
    if (filter === 'unread') return items.filter((n) => !n.is_read);
    if (filter === 'action') return items.filter((n) => n.action_required);
    return items;
  }, [items, filter]);

  const stats = useMemo(() => ({
    total: items.length,
    unread: items.filter((n) => !n.is_read).length,
    action: items.filter((n) => n.action_required && !n.is_read).length,
  }), [items]);

  const handleClick = async (notif) => {
    if (!notif.is_read) {
      try { await authorApi.markNotificationRead(notif.id); } catch { /* ignore */ }
      setItems((arr) => arr.map((n) => n.id === notif.id ? { ...n, is_read: true } : n));
    }
    if (notif.manuscript_id) navigate(`/auteur/manuscrits/${notif.manuscript_id}`);
  };

  const handleMarkAllRead = async () => {
    setMarking(true);
    try {
      await authorApi.markAllNotificationsRead();
      setItems((arr) => arr.map((n) => ({ ...n, is_read: true })));
      toast.success('Toutes les notifications marquées comme lues');
    } catch {
      toast.error('Erreur');
    } finally { setMarking(false); }
  };

  return (
    <div className="author-page">
      <div className="container">
        <Link to="/auteur/dashboard" className="back-link"><FiArrowLeft /> Retour au tableau de bord</Link>

        <div className="author-detail-header">
          <div>
            <h1><FiBell style={{ verticalAlign: '-3px', marginRight: 8 }} /> Mes notifications</h1>
            <p className="author-subtitle">
              {stats.total} au total · {stats.unread} non lue{stats.unread > 1 ? 's' : ''}
              {stats.action > 0 && <span className="anp-action-pill"><FiAlertCircle size={12} /> {stats.action} action{stats.action > 1 ? 's' : ''} requise{stats.action > 1 ? 's' : ''}</span>}
            </p>
          </div>
          <div className="author-actions">
            <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
              <FiRefreshCw className={loading ? 'anp-spin' : ''} /> Actualiser
            </button>
            {stats.unread > 0 && (
              <button type="button" className="btn btn-primary" onClick={handleMarkAllRead} disabled={marking}>
                <FiCheckSquare /> Tout marquer comme lu
              </button>
            )}
          </div>
        </div>

        <div className="anp-filters" role="group" aria-label="Filtrer">
          <FiFilter size={14} style={{ color: '#6b7280', marginRight: 4 }} />
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`anp-filter-btn ${filter === f.value ? 'active' : ''}`}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
            >
              {f.label}
              {f.value === 'unread' && stats.unread > 0 && <span className="anp-filter-count">{stats.unread}</span>}
              {f.value === 'action' && stats.action > 0 && <span className="anp-filter-count urgent">{stats.action}</span>}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="anp-empty">Chargement…</div>
        ) : filtered.length === 0 ? (
          <div className="anp-empty">
            <FiBell size={36} />
            <h2>{items.length === 0 ? 'Aucune notification pour le moment' : 'Aucune notification dans ce filtre'}</h2>
            <p>
              {items.length === 0
                ? "Vous serez informé ici à chaque étape de votre manuscrit (évaluation, contrat, corrections, BAT, impression…)."
                : 'Essayez un autre filtre ou actualisez la liste.'}
            </p>
          </div>
        ) : (
          <ul className="anp-list">
            {filtered.map((n) => (
              <li
                key={n.id}
                className={`anp-item ${n.is_read ? 'read' : 'unread'} ${n.action_required ? 'action-required' : ''}`}
              >
                <button type="button" className="anp-item-btn" onClick={() => handleClick(n)}>
                  <div className="anp-item-head">
                    <strong className="anp-item-title">{n.title}</strong>
                    {n.action_required && (
                      <span className="anp-tag">
                        <FiAlertCircle size={12} /> Action requise
                      </span>
                    )}
                    {n.is_read && <FiCheck size={14} className="anp-read-icon" aria-label="Lu" />}
                  </div>
                  {n.message && <p className="anp-item-msg">{n.message}</p>}
                  <div className="anp-item-meta">
                    {n.manuscript_ref && <span><strong>{n.manuscript_ref}</strong>{n.manuscript_title ? ` — ${n.manuscript_title}` : ''}</span>}
                    <time dateTime={n.created_at}>{formatFullDate(n.created_at)}</time>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
