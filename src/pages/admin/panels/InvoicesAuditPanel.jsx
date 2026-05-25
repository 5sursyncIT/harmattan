import { useState, useEffect, useCallback, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiList, FiSearch } from 'react-icons/fi';
import { getInvoicesAuditLog } from '../../../api/invoices';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function firstDayOfMonth() { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0]; }
function today() { return new Date().toISOString().split('T')[0]; }

const ACTION_OPTIONS = [
  { value: '', label: 'Toutes actions' },
  { value: 'pay', label: 'Paiement manuel' },
  { value: 'credit_note', label: 'Avoir' },
  { value: 'settodraft', label: 'Repasser brouillon' },
  { value: 'edit_lines', label: 'Édition lignes' },
  { value: 'reassign_customer', label: 'Réassignation client' },
  { value: 'delete', label: 'Suppression brouillon' },
];

const ACTION_LABELS = Object.fromEntries(ACTION_OPTIONS.filter(o => o.value).map(o => [o.value, o.label]));

const ACTION_COLOR = {
  pay: '#10531a',
  credit_note: '#9333ea',
  settodraft: '#0891b2',
  edit_lines: '#0284c7',
  reassign_customer: '#f59e0b',
  delete: '#dc2626',
};

export default function InvoicesAuditPanel() {
  const [data, setData] = useState({ entries: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    action: '',
    user_role: '',
    ref_facture: '',
    date_from: firstDayOfMonth(),
    date_to: today(),
    page: 1,
  });
  const [expanded, setExpanded] = useState(null);

  const reload = useCallback(() => {
    setLoading(true);
    getInvoicesAuditLog(filters)
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => { toast.error('Erreur chargement audit'); setLoading(false); });
  }, [filters]);

  useEffect(() => { reload(); }, [reload]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/invoices" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiList /> Journal d'audit des factures ({data.total})
          </h3>
        </div>
      </div>

      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Action</label>
          <select className="ac-filter-select" value={filters.action} onChange={e => update('action', e.target.value)}>
            {ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Rôle</label>
          <select className="ac-filter-select" value={filters.user_role} onChange={e => update('user_role', e.target.value)}>
            <option value="">Tous</option>
            <option value="super_admin">Super Admin</option>
            <option value="admin">Admin</option>
            <option value="librarian">Libraire</option>
            <option value="comptable">Comptable</option>
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Référence facture</label>
          <input className="ac-filter-input" type="text" placeholder="LIBFAC…"
            value={filters.ref_facture} onChange={e => update('ref_facture', e.target.value)} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Du</label>
          <input type="date" className="ac-filter-input" value={filters.date_from} onChange={e => update('date_from', e.target.value)} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Au</label>
          <input type="date" className="ac-filter-input" value={filters.date_to} onChange={e => update('date_to', e.target.value)} />
        </div>
      </div>

      {loading ? <Loader /> : (
        <>
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>Facture</th>
                  <th>Utilisateur</th>
                  <th>Motif</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map(e => (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="ac-date">{new Date(e.created_at).toLocaleString('fr-FR')}</td>
                      <td>
                        <span style={{
                          background: '#f1f5f9', color: ACTION_COLOR[e.action] || '#475569',
                          padding: '2px 8px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 700,
                        }}>{ACTION_LABELS[e.action] || e.action}</span>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{e.ref_facture || `#${e.fk_facture}`}</td>
                      <td>{e.user_name} <span style={{ color: '#94a3b8', fontSize: '0.72rem' }}>({e.user_role})</span></td>
                      <td style={{ fontStyle: 'italic', color: '#475569', fontSize: '0.85rem' }}>« {e.reason} »</td>
                      <td>
                        <button className="ac-mini-btn" title="Voir les détails"
                          onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                          <FiSearch />
                        </button>
                      </td>
                    </tr>
                    {expanded === e.id && (
                      <tr>
                        <td colSpan={6} style={{ background: '#f8fafc', padding: 12 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                            <div>
                              <strong>Avant :</strong>
                              <pre className="ac-json-block">{JSON.stringify(e.before_snapshot, null, 2)}</pre>
                            </div>
                            <div>
                              <strong>Après :</strong>
                              <pre className="ac-json-block">{JSON.stringify(e.after_snapshot, null, 2)}</pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {data.entries.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucune régularisation</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="ac-pagination">
              <button className="ac-page-btn" disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}>‹</button>
              <span className="ac-page-info">Page {filters.page} / {data.pages}</span>
              <button className="ac-page-btn" disabled={filters.page >= data.pages} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}>›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
