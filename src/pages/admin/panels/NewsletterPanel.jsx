import { useState, useEffect } from 'react';
import { getSubscribers, deleteSubscriber, exportSubscribers } from '../../../api/admin';
import { FiTrash2, FiDownload, FiCheck, FiClock, FiSearch, FiUsers, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import toast from 'react-hot-toast';

const PAGE_SIZE = 20;

export default function NewsletterPanel() {
  const [subscribers, setSubscribers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    getSubscribers().then((res) => setSubscribers(res.data)).catch(() => {});
  }, []);

  const handleDelete = async (id) => {
    if (!confirm('Supprimer cet abonné ?')) return;
    try {
      await deleteSubscriber(id);
      setSubscribers((s) => s.filter((x) => x.id !== id));
      toast.success('Supprimé');
    } catch { toast.error('Erreur'); }
  };

  const filtered = subscribers.filter(s =>
    s.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const confirmed = subscribers.filter((s) => s.confirmed);
  const pending = subscribers.filter((s) => !s.confirmed);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ flexWrap: 'wrap', gap: 16 }}>
        <div><strong>{confirmed.length}</strong> confirmés, <strong>{pending.length}</strong> en attente</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ position: 'relative' }}>
            <FiSearch style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
            <input type="text" placeholder="Rechercher un email..." value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              style={{ padding: '8px 12px 8px 32px', borderRadius: 6, border: '1px solid #d1d5db' }} />
          </div>
          <a href={exportSubscribers()} className="btn btn-outline" download><FiDownload /> Exporter CSV</a>
        </div>
      </div>

      <div className="admin-table-container">
        {paginated.length === 0 ? (
          <div className="admin-empty"><FiUsers size={48} /><p>Aucun abonné trouvé</p></div>
        ) : (
          <>
            <table className="admin-table">
              <thead>
                <tr><th>Email</th><th>Statut</th><th>Date</th><th></th></tr>
              </thead>
              <tbody>
                {paginated.map((s) => (
                  <tr key={s.id}>
                    <td>{s.email}</td>
                    <td>{s.confirmed ? <span className="admin-badge success"><FiCheck /> Confirmé</span> : <span className="admin-badge warning"><FiClock /> En attente</span>}</td>
                    <td>{new Date(s.created_at).toLocaleDateString('fr-FR')}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn-icon danger" onClick={() => handleDelete(s.id)}><FiTrash2 /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, padding: 12, fontSize: '0.85rem' }}>
                <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><FiChevronLeft /></button>
                <span>{page} / {totalPages} ({filtered.length} résultats)</span>
                <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}><FiChevronRight /></button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
