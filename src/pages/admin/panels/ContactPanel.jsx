import { useState, useEffect } from 'react';
import { getContactMessages, markMessageRead, deleteMessage, replyToMessage } from '../../../api/admin';
import { FiTrash2, FiMail, FiMessageSquare, FiSearch, FiSend, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import toast from 'react-hot-toast';

const PAGE_SIZE = 15;

export default function ContactPanel() {
  const [messages, setMessages] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [showReply, setShowReply] = useState(false);

  useEffect(() => {
    getContactMessages().then((res) => setMessages(res.data)).catch(() => {});
  }, []);

  const handleRead = async (msg) => {
    setSelected(msg);
    setShowReply(false);
    setReplyText('');
    if (!msg.read) {
      await markMessageRead(msg.id).catch(() => {});
      setMessages((m) => m.map((x) => (x.id === msg.id ? { ...x, read: 1 } : x)));
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Supprimer ce message ?')) return;
    try {
      await deleteMessage(id);
      setMessages((m) => m.filter((x) => x.id !== id));
      if (selected?.id === id) setSelected(null);
      toast.success('Supprimé');
    } catch { toast.error('Erreur'); }
  };

  const handleReply = async () => {
    if (!replyText.trim()) return;
    setReplying(true);
    try {
      await replyToMessage(selected.id, { message: replyText });
      toast.success('Réponse envoyée par email');
      setShowReply(false);
      setReplyText('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    } finally { setReplying(false); }
  };

  const filtered = messages.filter(msg => {
    if (filter === 'unread' && msg.read) return false;
    if (search) {
      const q = search.toLowerCase();
      return msg.name?.toLowerCase().includes(q) || msg.email?.toLowerCase().includes(q) || msg.subject?.toLowerCase().includes(q);
    }
    return true;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const unreadCount = messages.filter(m => !m.read).length;

  useEffect(() => { setPage(1); }, [filter, search]);

  return (
    <div className="admin-panel admin-split">
      <div className="admin-list-container">
        <div style={{ padding: '12px', background: '#fff', borderBottom: '1px solid #f3f4f6', borderRadius: '12px 12px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ position: 'relative' }}>
            <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#999' }} />
            <input type="text" placeholder="Rechercher nom, email, sujet..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: '100%', padding: '8px 8px 8px 32px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '0.85rem' }} />
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}>
            <option value="all">Tous ({messages.length})</option>
            <option value="unread">Non lus ({unreadCount})</option>
          </select>
        </div>
        <div className="admin-list" style={{ borderRadius: '0 0 12px 12px' }}>
          {paginated.length === 0 && (
            <div className="admin-empty"><FiMessageSquare size={48} /><p>Aucun message</p></div>
          )}
          {paginated.map((msg) => (
            <div key={msg.id} className={`admin-list-item ${!msg.read ? 'unread' : ''} ${selected?.id === msg.id ? 'active' : ''}`} onClick={() => handleRead(msg)}>
              <div className="admin-list-item-header">
                <strong>{msg.name}</strong>
                <span className="admin-list-date">{new Date(msg.created_at).toLocaleDateString('fr-FR')}</span>
              </div>
              <div className="admin-list-item-sub">{msg.subject || 'Sans sujet'}</div>
              <div className="admin-list-item-badge">{msg.department || 'Général'}</div>
            </div>
          ))}
        </div>
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: 10, fontSize: '0.85rem' }}>
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><FiChevronLeft /></button>
            <span>{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><FiChevronRight /></button>
          </div>
        )}
      </div>

      <div className="admin-detail">
        {selected ? (
          <>
            <div className="admin-detail-header">
              <div>
                <h3>{selected.subject || 'Sans sujet'}</h3>
                <p>De: <strong>{selected.name}</strong> ({selected.email}) — {selected.department || 'Général'}</p>
                <p className="admin-list-date">{new Date(selected.created_at).toLocaleString('fr-FR')}</p>
              </div>
              <div className="admin-detail-actions">
                <button className="btn btn-primary btn-sm" onClick={() => setShowReply(!showReply)}><FiSend size={14} /> Répondre</button>
                <button className="btn-icon danger" onClick={() => handleDelete(selected.id)} aria-label="Supprimer"><FiTrash2 /></button>
              </div>
            </div>
            <div className="admin-detail-body" style={{ whiteSpace: 'pre-wrap' }}>{selected.message}</div>

            {showReply && (
              <div style={{ marginTop: 16, padding: 16, background: '#f8fafc', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                <p style={{ fontWeight: 700, marginBottom: 8, fontSize: '0.9rem' }}>Répondre à {selected.name} :</p>
                <textarea
                  value={replyText} onChange={(e) => setReplyText(e.target.value)}
                  rows={5} placeholder="Votre réponse..."
                  style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #d1d5db', resize: 'vertical', fontSize: '0.9rem' }}
                  autoFocus
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                  <button className="btn btn-outline btn-sm" onClick={() => setShowReply(false)}>Annuler</button>
                  <button className="btn btn-primary btn-sm" onClick={handleReply} disabled={replying || !replyText.trim()}>
                    <FiSend size={14} /> {replying ? 'Envoi...' : 'Envoyer'}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="admin-empty" style={{ height: '100%', justifyContent: 'center' }}>
            <FiMail size={64} /><p>Sélectionnez un message</p>
          </div>
        )}
      </div>
    </div>
  );
}
