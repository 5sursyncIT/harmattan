import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiSearch, FiRefreshCw, FiEye, FiMail, FiPhone, FiUsers, FiBriefcase, FiUserCheck, FiPlus, FiEdit3, FiTrash2 } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { getAdminSocietes, deleteAdminSociete } from '../../../api/admin';
import TiersFormModal from '../../../components/admin/TiersFormModal';

function TypeBadge({ client, fournisseur }) {
  const tags = [];
  if (client === 1 || client === 3) tags.push({ label: 'Client', color: '#10531a' });
  if (client === 2 || client === 3) tags.push({ label: 'Prospect', color: '#0284c7' });
  if (fournisseur === 1) tags.push({ label: 'Fournisseur', color: '#7c3aed' });
  if (!tags.length) tags.push({ label: '—', color: '#9ca3af' });
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {tags.map((t, i) => (
        <span key={i} style={{
          background: t.color + '22', color: t.color, padding: '1px 8px',
          borderRadius: 10, fontSize: 11, fontWeight: 600,
        }}>{t.label}</span>
      ))}
    </span>
  );
}

export default function TiersPanel() {
  const [societes, setSocietes] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [statut, setStatut] = useState('active'); // active | archived | all
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [editing, setEditing] = useState(null); // null = caché, {} = nouveau, {id, ...} = édition

  const load = useCallback(() => {
    setLoading(true);
    getAdminSocietes({ q, type, statut, page, limit: 30 })
      .then(r => {
        setSocietes(r.data.societes);
        setTotal(r.data.total);
        setPages(r.data.pages);
      })
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [q, type, statut, page]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (s) => {
    if (!window.confirm(`Supprimer définitivement « ${s.nom} » ?`)) return;
    try {
      await deleteAdminSociete(s.id);
      toast.success('Tiers supprimé');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression');
    }
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3 style={{ margin: 0 }}>Tiers ({total})</h3>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Source : Dolibarr (clients, prospects, fournisseurs, auteurs).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
          <button className="btn btn-primary" onClick={() => setEditing({})}><FiPlus /> Nouveau tiers</button>
        </div>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div className="admin-search-row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <div className="admin-search-input" style={{ flex: '1 1 320px', minWidth: 240 }}>
            <FiSearch />
            <input
              type="text"
              placeholder="Rechercher par nom, code, email, téléphone, ville…"
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value); }}
            />
          </div>
          <div className="tiers-segment" role="tablist" aria-label="Filtrer par type">
            {[
              { v: '',            l: 'Tous',        icon: <FiUsers /> },
              { v: 'client',      l: 'Clients',     icon: <FiUserCheck /> },
              { v: 'prospect',    l: 'Prospects',   icon: <FiUsers /> },
              { v: 'fournisseur', l: 'Fournisseurs', icon: <FiBriefcase /> },
            ].map(f => (
              <button
                key={f.v}
                role="tab"
                aria-selected={type === f.v}
                className={'tiers-segment-btn ' + (type === f.v ? 'is-active' : '')}
                onClick={() => { setPage(1); setType(f.v); }}
              >
                {f.icon} <span>{f.l}</span>
              </button>
            ))}
          </div>
          <div className="tiers-segment" role="tablist" aria-label="Filtrer par statut">
            {[
              { v: 'active',   l: 'Actifs' },
              { v: 'archived', l: 'Archivés' },
              { v: 'all',      l: 'Tous' },
            ].map(f => (
              <button
                key={f.v}
                role="tab"
                aria-selected={statut === f.v}
                className={'tiers-segment-btn ' + (statut === f.v ? 'is-active' : '')}
                onClick={() => { setPage(1); setStatut(f.v); }}
              >
                <span>{f.l}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Nom du tiers</th>
              <th>Nom alt.</th>
              <th>Code client</th>
              <th>Code fournisseur</th>
              <th>Type</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th>Ville</th>
              <th style={{ width: 120, textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Chargement…</td></tr>
            ) : societes.length === 0 ? (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Aucun tiers</td></tr>
            ) : (
              societes.map(s => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/admin/tiers/${s.id}`} style={{ color: s.status === 0 ? '#9ca3af' : '#10531a', fontWeight: 600, textDecoration: 'none' }}>
                      {s.nom}
                    </Link>
                    {s.status === 0 && (
                      <span style={{ marginLeft: 8, background: '#f1f5f9', color: '#64748b', padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>Archivé</span>
                    )}
                  </td>
                  <td>{s.name_alias || '—'}</td>
                  <td>{s.code_client || '—'}</td>
                  <td>{s.code_fournisseur || '—'}</td>
                  <td><TypeBadge client={s.client} fournisseur={s.fournisseur} /></td>
                  <td>{s.email ? <a href={`mailto:${s.email}`} style={{ color: '#10531a', display: 'inline-flex', alignItems: 'center', gap: 4 }}><FiMail size={12} /> {s.email}</a> : '—'}</td>
                  <td>{s.phone ? <a href={`tel:${s.phone}`} style={{ color: '#374151', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}><FiPhone size={12} /> {s.phone}</a> : '—'}</td>
                  <td>{[s.zip, s.town].filter(Boolean).join(' ') || '—'}</td>
                  <td>
                    <div className="tiers-actions">
                      <Link to={`/admin/tiers/${s.id}`} className="btn-ghost" title="Voir le profil" aria-label="Voir"><FiEye /></Link>
                      <button className="btn-ghost" title="Modifier" aria-label="Modifier" onClick={() => setEditing(s)}><FiEdit3 /></button>
                      <button className="btn-ghost btn-ghost-danger" title="Supprimer" aria-label="Supprimer" onClick={() => handleDelete(s)}><FiTrash2 /></button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="admin-pagination">
            <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button>
            <span>Page {page} / {pages}</span>
            <button className="btn btn-outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Suivant</button>
          </div>
        )}
      </div>

      {editing !== null && (
        <TiersFormModal
          tier={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
