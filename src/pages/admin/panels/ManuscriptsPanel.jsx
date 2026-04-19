import { useState, useEffect } from 'react';
import { getManuscripts, updateManuscriptStatus, downloadManuscript } from '../../../api/admin';
import { FiFileText, FiSearch, FiDownload, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import toast from 'react-hot-toast';

const STATUS_COLORS = {
  'reçu': '#f59e0b',
  'en lecture': '#3b82f6',
  'accepté': '#10b981',
  'refusé': '#ef4444',
};

const PAGE_SIZE = 15;

export default function ManuscriptsPanel() {
  const [manuscripts, setManuscripts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    getManuscripts().then((res) => setManuscripts(res.data)).catch(() => {});
  }, []);

  const handleStatus = async (id, status) => {
    try {
      await updateManuscriptStatus(id, status);
      setManuscripts((m) => m.map((x) => (x.id === id ? { ...x, status } : x)));
      if (selected?.id === id) setSelected({ ...selected, status });
      toast.success(`Statut mis à jour : ${status} (email envoyé à l'auteur)`);
    } catch {
      toast.error('Erreur');
    }
  };

  const handleDownload = async (ms) => {
    try {
      const res = await downloadManuscript(ms.id);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = ms.file_name || 'manuscrit';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Fichier introuvable');
    }
  };

  const filtered = manuscripts.filter(ms => {
    if (filter !== 'all' && ms.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return ms.title?.toLowerCase().includes(q) || ms.firstname?.toLowerCase().includes(q) || ms.lastname?.toLowerCase().includes(q) || ms.email?.toLowerCase().includes(q);
    }
    return true;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="admin-panel admin-split">
      <div className="admin-list-container">
        <div style={{ padding: '12px', background: '#fff', borderBottom: '1px solid #f3f4f6', borderRadius: '12px 12px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#999' }} />
              <input
                type="text" placeholder="Rechercher titre, auteur, email..." value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                style={{ width: '100%', padding: '8px 8px 8px 32px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: '0.85rem' }}
              />
            </div>
          </div>
          <select value={filter} onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}>
            <option value="all">Toutes ({manuscripts.length})</option>
            {Object.keys(STATUS_COLORS).map(s => (
              <option key={s} value={s}>{s} ({manuscripts.filter(m => m.status === s).length})</option>
            ))}
          </select>
        </div>
        <div className="admin-list" style={{ borderRadius: '0 0 12px 12px' }}>
          {paginated.length === 0 && (
            <div className="admin-empty"><FiFileText size={48} /><p>Aucun manuscrit trouvé</p></div>
          )}
          {paginated.map((ms) => (
            <div key={ms.id} className={`admin-list-item ${selected?.id === ms.id ? 'active' : ''}`} onClick={() => setSelected(ms)}>
              <div className="admin-list-item-header">
                <strong>{ms.title}</strong>
                <span className="admin-status-badge" style={{ background: STATUS_COLORS[ms.status] || '#888' }}>{ms.status}</span>
              </div>
              <div className="admin-list-item-sub">{ms.firstname} {ms.lastname} — {ms.genre}</div>
              <div className="admin-list-date">{new Date(ms.created_at).toLocaleDateString('fr-FR')}</div>
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
            <h3>{selected.title}</h3>
            <div className="admin-ms-info">
              <p><strong>Auteur :</strong> {selected.firstname} {selected.lastname}</p>
              <p><strong>Email :</strong> <a href={`mailto:${selected.email}`}>{selected.email}</a></p>
              <p><strong>Téléphone :</strong> {selected.phone || '—'}</p>
              <p><strong>Genre :</strong> {selected.genre || '—'}</p>
              <p><strong>Fichier :</strong> {selected.file_name ? (
                <button onClick={() => handleDownload(selected)} style={{ background: 'none', border: 'none', color: '#3b82f6', cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <FiDownload size={14} /> {selected.file_name}
                </button>
              ) : 'Non joint'}</p>
              <p><strong>Date :</strong> {new Date(selected.created_at).toLocaleString('fr-FR')}</p>
            </div>
            {selected.synopsis && <><h4>Synopsis</h4><p>{selected.synopsis}</p></>}
            {selected.message && <><h4>Message</h4><p>{selected.message}</p></>}

            <div className="admin-ms-actions">
              <label>Statut :</label>
              {['reçu', 'en lecture', 'accepté', 'refusé'].map((s) => (
                <button key={s} className={`btn btn-sm ${selected.status === s ? 'active' : ''}`}
                  style={{ borderColor: STATUS_COLORS[s], color: selected.status === s ? '#fff' : STATUS_COLORS[s], background: selected.status === s ? STATUS_COLORS[s] : 'transparent' }}
                  onClick={() => { if (confirm(`Changer le statut en "${s}" ? L'auteur sera notifié par email.`)) handleStatus(selected.id, s); }}>
                  {s}
                </button>
              ))}
            </div>

            {selected.status === 'accepté' && (
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #f3f4f6' }}>
                <a href={`/admin/contracts/new?author=${encodeURIComponent(selected.firstname + ' ' + selected.lastname)}&title=${encodeURIComponent(selected.title)}`}
                  className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiFileText size={14} /> Créer un contrat d'édition
                </a>
              </div>
            )}
          </>
        ) : (
          <div className="admin-empty" style={{ height: '100%', justifyContent: 'center' }}>
            <FiFileText size={64} /><p>Sélectionnez un manuscrit</p>
          </div>
        )}
      </div>
    </div>
  );
}
