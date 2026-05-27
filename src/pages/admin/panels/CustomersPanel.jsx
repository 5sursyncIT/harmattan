import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiSearch, FiRefreshCw, FiMail, FiEye } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { getAdminCustomers } from '../../../api/admin';

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function CustomersPanel() {
  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

  const load = useCallback(() => {
    setLoading(true);
    getAdminCustomers({ q, page, limit: 20 })
      .then((r) => {
        setCustomers(r.data.customers);
        setTotal(r.data.total);
        setPages(r.data.pages);
      })
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [q, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3 style={{ margin: 0 }}>Comptes web ({total})</h3>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Comptes créés via la boutique en ligne. Pour la base complète des clients/prospects/fournisseurs Dolibarr, voir <strong>Tiers</strong>.
          </p>
        </div>
        <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div className="admin-search-row">
          <div className="admin-search-input">
            <FiSearch />
            <input
              type="text"
              placeholder="Rechercher par email, nom, prénom ou téléphone…"
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value); }}
            />
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th>Ville</th>
              <th style={{ textAlign: 'center' }}>Précom.</th>
              <th>Inscrit le</th>
              <th style={{ width: 130 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Chargement…</td></tr>
            ) : customers.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Aucun client</td></tr>
            ) : (
              customers.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/admin/customers/${c.id}`} style={{ color: '#10531a', fontWeight: 600, textDecoration: 'none' }}>
                      {c.firstname} {c.lastname}
                    </Link>
                  </td>
                  <td><a href={`mailto:${c.email}`} style={{ color: '#10531a' }}>{c.email}</a></td>
                  <td>{c.phone || '—'}</td>
                  <td>{c.city || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{c.preorder_count || 0}</td>
                  <td>{formatDate(c.created_at)}</td>
                  <td>
                    <Link to={`/admin/customers/${c.id}`} className="btn-ghost" title="Voir le profil"><FiEye /></Link>
                    <a href={`mailto:${c.email}`} className="btn-ghost" title="Envoyer un email"><FiMail /></a>
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
    </div>
  );
}
