import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiBell, FiCheck, FiCheckSquare, FiAlertCircle, FiArrowRight } from 'react-icons/fi';
import { authorApi } from '../../api/author';
import './NotificationBell.css';

const POLL_INTERVAL_MS = 60_000;

function formatRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `il y a ${days} j`;
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ unread: 0, action_required: 0 });
  const [loading, setLoading] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  // Polling du compteur (non lu)
  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      authorApi.getUnreadCount()
        .then((res) => { if (!cancelled) setCounts(res.data || { unread: 0, action_required: 0 }); })
        .catch(() => { /* silent */ });
    };
    fetchCount();
    const id = setInterval(fetchCount, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Chargement de la liste quand le panneau s'ouvre
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    authorApi.listNotifications()
      .then((res) => setItems(res.data || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [open]);

  // Fermer au clic extérieur ou Escape
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (buttonRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleOpenNotification = async (notif) => {
    if (!notif.is_read) {
      try { await authorApi.markNotificationRead(notif.id); } catch { /* ignore */ }
      setItems((arr) => arr.map((n) => n.id === notif.id ? { ...n, is_read: true } : n));
      setCounts((c) => ({
        unread: Math.max(0, c.unread - 1),
        action_required: Math.max(0, c.action_required - (notif.action_required ? 1 : 0)),
      }));
    }
    setOpen(false);
    if (notif.manuscript_id) navigate(`/auteur/manuscrits/${notif.manuscript_id}`);
  };

  const handleMarkAllRead = async () => {
    try { await authorApi.markAllNotificationsRead(); } catch { /* ignore */ }
    setItems((arr) => arr.map((n) => ({ ...n, is_read: true })));
    setCounts({ unread: 0, action_required: 0 });
  };

  const badgeLabel = counts.unread > 99 ? '99+' : String(counts.unread);

  return (
    <div className="notif-bell-wrapper">
      <button
        ref={buttonRef}
        type="button"
        className={`notif-bell-trigger ${counts.action_required > 0 ? 'has-action' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={counts.unread > 0 ? `Notifications (${counts.unread} non lue${counts.unread > 1 ? 's' : ''})` : 'Notifications'}
        aria-expanded={open}
      >
        <FiBell size={20} />
        {counts.unread > 0 && (
          <span className={`notif-bell-badge ${counts.action_required > 0 ? 'urgent' : ''}`}>
            {badgeLabel}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="notif-bell-panel" role="dialog" aria-label="Notifications">
          <div className="notif-bell-header">
            <strong>Notifications</strong>
            {counts.unread > 0 && (
              <button
                type="button"
                className="notif-bell-mark-all"
                onClick={handleMarkAllRead}
              >
                <FiCheckSquare size={14} /> Tout marquer comme lu
              </button>
            )}
          </div>

          {loading ? (
            <div className="notif-bell-empty">Chargement…</div>
          ) : items.length === 0 ? (
            <div className="notif-bell-empty">
              <FiBell size={28} />
              <p>Aucune notification pour le moment.</p>
            </div>
          ) : (
            <>
              <ul className="notif-bell-list">
                {items.slice(0, 10).map((n) => (
                  <li
                    key={n.id}
                    className={`notif-bell-item ${n.is_read ? '' : 'unread'} ${n.action_required ? 'action-required' : ''}`}
                  >
                    <button
                      type="button"
                      className="notif-bell-item-btn"
                      onClick={() => handleOpenNotification(n)}
                    >
                      {!n.is_read && <span className="notif-bell-dot" aria-hidden="true" />}
                      {n.action_required && (
                        <span className="notif-bell-tag" title="Action requise">
                          <FiAlertCircle size={11} /> Action requise
                        </span>
                      )}
                      <strong className="notif-bell-title">{n.title}</strong>
                      {n.message && <span className="notif-bell-message">{n.message}</span>}
                      <span className="notif-bell-meta">
                        {n.manuscript_ref && <span>{n.manuscript_ref}</span>}
                        <span>·</span>
                        <time dateTime={n.created_at}>{formatRelative(n.created_at)}</time>
                      </span>
                    </button>
                    {n.is_read && (
                      <FiCheck size={12} className="notif-bell-read-icon" aria-label="Lu" />
                    )}
                  </li>
                ))}
              </ul>
              <Link
                to="/auteur/notifications"
                className="notif-bell-see-all"
                onClick={() => setOpen(false)}
              >
                Voir toutes les notifications <FiArrowRight size={13} />
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
