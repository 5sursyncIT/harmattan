import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FiArchive, FiSearch, FiX, FiPlus, FiEdit3, FiTrash2, FiSave,
  FiAlertCircle, FiChevronLeft, FiChevronRight, FiCheckCircle, FiClock, FiBook,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import {
  listLegalDeposits, createLegalDeposit, updateLegalDeposit, deleteLegalDeposit,
  getLegalDepositInstitutions, searchLegalDepositBooks,
} from '../../../api/legalDeposits';
import './Contracts.css';

const STATUS_BADGE = {
  todo: { label: 'À faire', bg: '#fef3c7', color: '#92400e' },
  deposited: { label: 'Déposé', bg: '#dcfce7', color: '#166534' },
};
const QUARTERS = ['T1', 'T2', 'T3', 'T4'];
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

function DepositModal({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    product_id: initial?.product_id || null,
    isbn: initial?.isbn || '',
    title: initial?.title || '',
    author: initial?.author || '',
    dl_number: initial?.dl_number || '',
    deposit_date: initial?.deposit_date || '',
    dl_quarter: initial?.dl_quarter || '',
    dl_year: initial?.dl_year || '',
    status: initial?.status || 'todo',
    note: initial?.note || '',
  });
  // institutions sélectionnées : { name -> copies }
  const [selected, setSelected] = useState(() => {
    const m = {};
    (initial?.institutions || []).forEach((i) => { m[i.name] = i.copies || 0; });
    return m;
  });
  const [institutionsList, setInstitutionsList] = useState([]);
  const [bookQuery, setBookQuery] = useState('');
  const [bookResults, setBookResults] = useState([]);
  const [newInstitution, setNewInstitution] = useState('');
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    getLegalDepositInstitutions().then(r => setInstitutionsList(r.data.institutions || [])).catch(() => {});
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Fusionne institutions préset + celles déjà saisies hors liste
  const allInstitutions = [...new Set([...institutionsList, ...Object.keys(selected)])];

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const onBookSearch = (q) => {
    setBookQuery(q);
    if (q.trim().length < 2) { setBookResults([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      searchLegalDepositBooks(q).then(r => setBookResults(r.data.books || [])).catch(() => {});
    }, 280);
  };
  const pickBook = (b) => {
    setForm(f => ({ ...f, product_id: b.id, title: b.label, isbn: b.isbn || f.isbn }));
    setBookQuery(''); setBookResults([]);
  };

  const toggleInstitution = (name) => {
    setSelected(prev => {
      const next = { ...prev };
      if (name in next) delete next[name];
      else next[name] = 0;
      return next;
    });
  };
  const setCopies = (name, copies) => setSelected(prev => ({ ...prev, [name]: Math.max(0, parseInt(copies, 10) || 0) }));

  const addInstitution = () => {
    const name = newInstitution.trim();
    if (!name) return;
    if (allInstitutions.some(n => n.toLowerCase() === name.toLowerCase())) {
      toast.error('Cette institution est déjà dans la liste');
      return;
    }
    setSelected(prev => ({ ...prev, [name]: 0 })); // ajoutée et cochée d'office
    setNewInstitution('');
  };

  const submit = async () => {
    if (!form.title.trim()) return toast.error('Titre requis');
    setSaving(true);
    const payload = {
      ...form,
      dl_year: form.dl_year ? parseInt(form.dl_year, 10) : null,
      institutions: Object.entries(selected).map(([name, copies]) => ({ name, copies })),
    };
    try {
      if (isEdit) await updateLegalDeposit(initial.id, payload);
      else await createLegalDeposit(payload);
      toast.success(isEdit ? 'Dépôt légal mis à jour' : 'Entrée enregistrée');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de l\'enregistrement');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '0.9rem' };
  const labelStyle = { fontWeight: 600, fontSize: '0.82rem', color: '#334155', display: 'block', marginBottom: 4 };

  return (
    <div className="ct-modal-overlay" onClick={onClose}>
      <div className="ct-modal" style={{ maxWidth: 680, width: '100%' }} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiArchive size={18} /> {isEdit ? 'Modifier le dépôt légal' : 'Nouveau dépôt légal'}
          </h3>
          <button onClick={onClose} className="ct-btn-ghost" aria-label="Fermer"><FiX size={20} /></button>
        </div>

        {/* Recherche d'un titre du catalogue */}
        <label style={labelStyle}>Relier à un titre du catalogue (optionnel)</label>
        <div style={{ position: 'relative', marginBottom: 14 }}>
          <FiSearch size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input value={bookQuery} onChange={e => onBookSearch(e.target.value)} placeholder="Rechercher (réf, titre, ISBN)..." style={{ ...inputStyle, paddingLeft: 36 }} />
          {bookResults.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
              {bookResults.map(b => (
                <div key={b.id} onClick={() => pickBook(b)} style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>{b.label}</div>
                  {b.isbn && <div style={{ fontSize: '0.78rem', color: '#94a3b8' }}>ISBN {b.isbn}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={labelStyle}>Titre de l'ouvrage *</label>
            <input value={form.title} onChange={e => set('title', e.target.value)} maxLength={300} style={inputStyle} />
          </div>
          <div><label style={labelStyle}>Auteur</label><input value={form.author} onChange={e => set('author', e.target.value)} maxLength={200} style={inputStyle} /></div>
          <div><label style={labelStyle}>ISBN</label><input value={form.isbn} onChange={e => set('isbn', e.target.value)} maxLength={30} style={inputStyle} /></div>
          <div><label style={labelStyle}>N° de dépôt légal</label><input value={form.dl_number} onChange={e => set('dl_number', e.target.value)} maxLength={60} style={inputStyle} /></div>
          <div><label style={labelStyle}>Date de dépôt</label><input type="date" value={form.deposit_date || ''} onChange={e => set('deposit_date', e.target.value)} style={inputStyle} /></div>
          <div>
            <label style={labelStyle}>Trimestre</label>
            <select value={form.dl_quarter} onChange={e => set('dl_quarter', e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
              <option value="">—</option>
              {QUARTERS.map(q => <option key={q} value={q}>{q}</option>)}
            </select>
          </div>
          <div><label style={labelStyle}>Année</label><input type="number" value={form.dl_year || ''} onChange={e => set('dl_year', e.target.value)} min={1900} max={2100} style={inputStyle} /></div>
        </div>

        {/* Institutions */}
        <label style={labelStyle}>Institutions destinataires</label>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {allInstitutions.map(name => {
            const checked = name in selected;
            return (
              <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer', fontSize: '0.88rem' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggleInstitution(name)} />
                  {name}
                </label>
                {checked && (
                  <input type="number" min={0} value={selected[name]} onChange={e => setCopies(name, e.target.value)} title="Exemplaires déposés"
                    style={{ width: 70, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, textAlign: 'center' }} placeholder="ex." />
                )}
              </div>
            );
          })}
          {/* Ajout d'une institution non listée */}
          <div style={{ display: 'flex', gap: 6, marginTop: 4, paddingTop: 8, borderTop: '1px dashed #e2e8f0' }}>
            <input
              value={newInstitution}
              onChange={e => setNewInstitution(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addInstitution(); } }}
              placeholder="Ajouter une autre institution..."
              maxLength={200}
              style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.85rem' }}
            />
            <button type="button" onClick={addInstitution} className="ct-btn ct-btn-outline" style={{ padding: '6px 12px', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
              <FiPlus size={13} /> Ajouter
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 180px' }}>
            <label style={labelStyle}>Statut</label>
            <select value={form.status} onChange={e => set('status', e.target.value)} style={{ ...inputStyle, background: '#fff' }}>
              <option value="todo">À faire</option>
              <option value="deposited">Déposé</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label style={labelStyle}>Note</label>
            <input value={form.note} onChange={e => set('note', e.target.value)} maxLength={2000} placeholder="Optionnel" style={inputStyle} />
          </div>
        </div>

        <div className="ct-modal-actions">
          <button className="ct-btn ct-btn-outline" onClick={onClose} disabled={saving}>Annuler</button>
          <button className="ct-btn ct-btn-primary" onClick={submit} disabled={saving}>
            <FiSave size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function LegalDepositPanel() {
  const [data, setData] = useState({ deposits: [], total: 0, pages: 1, kpis: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({ status: '', search: '', year: '', page: 1 });
  const [editing, setEditing] = useState(null); // null | {} (new) | deposit (edit)

  const reload = useCallback(() => {
    setLoading(true); setError(false);
    const params = { ...filters };
    if (!params.status) delete params.status;
    if (!params.year) delete params.year;
    listLegalDeposits(params)
      .then(r => setData(r.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));

  const handleDelete = async (d) => {
    if (!window.confirm(`Supprimer l'entrée « ${d.title} » du registre ?`)) return;
    try {
      await deleteLegalDeposit(d.id);
      toast.success('Entrée supprimée');
      reload();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de la suppression');
    }
  };

  const institutionsSummary = (list) => {
    if (!list || list.length === 0) return '—';
    const names = list.map(i => i.name.replace(/\s*\(.*\)/, '').split(' ')[0]);
    const shown = names.slice(0, 2).join(', ');
    return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiArchive /> Dépôt légal</h3>
        <button className="btn btn-primary" onClick={() => setEditing({})} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiPlus size={16} /> Nouvelle entrée
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { v: data.kpis?.total ?? 0, l: 'Total', c: '#0f172a', icon: <FiBook /> },
          { v: data.kpis?.todo ?? 0, l: 'À faire', c: '#92400e', icon: <FiClock /> },
          { v: data.kpis?.deposited ?? 0, l: 'Déposés', c: '#166534', icon: <FiCheckCircle /> },
        ].map((k, i) => (
          <div key={i} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: k.c, display: 'flex', alignItems: 'center', gap: 8 }}>{k.icon}{k.v}</div>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>{k.l}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <FiSearch size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input value={filters.search} onChange={e => update('search', e.target.value)} placeholder="Titre, ISBN, n° DL, auteur..."
            style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '0.9rem' }} />
        </div>
        <input value={filters.year} onChange={e => update('year', e.target.value)} placeholder="Année" type="number"
          style={{ width: 110, padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '0.9rem' }} />
        <select value={filters.status} onChange={e => update('status', e.target.value)}
          style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', fontSize: '0.9rem' }}>
          <option value="">Tous statuts</option>
          <option value="todo">À faire</option>
          <option value="deposited">Déposé</option>
        </select>
      </div>

      {loading ? <Loader /> : error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : data.deposits.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiArchive size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucune entrée au registre</p>
          <p style={{ fontSize: '0.85rem' }}>Cliquez sur « Nouvelle entrée » pour enregistrer un dépôt légal.</p>
        </div>
      ) : (
        <>
          <div className="admin-table-container">
            <table className="admin-table">
              <thead><tr>
                <th>Titre</th><th>ISBN</th><th>N° DL</th><th>Période</th><th>Institutions</th><th>Statut</th><th>Date</th><th></th>
              </tr></thead>
              <tbody>
                {data.deposits.map(d => {
                  const b = STATUS_BADGE[d.status] || { label: d.status_label, bg: '#f1f5f9', color: '#475569' };
                  return (
                    <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setEditing(d)}>
                      <td>
                        <strong>{d.title}</strong>
                        {d.author && <span style={{ color: '#94a3b8', fontSize: '0.78rem', display: 'block' }}>{d.author}</span>}
                      </td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{d.isbn || '—'}</td>
                      <td style={{ fontWeight: 600 }}>{d.dl_number || '—'}</td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{[d.dl_quarter, d.dl_year].filter(Boolean).join(' ') || '—'}</td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }} title={(d.institutions || []).map(i => `${i.name}${i.copies ? ` (${i.copies})` : ''}`).join('\n')}>
                        {institutionsSummary(d.institutions)}
                      </td>
                      <td><span style={{ padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, background: b.bg, color: b.color }}>{b.label}</span></td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{fmtDate(d.deposit_date)}</td>
                      <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                        <button className="ct-btn-ghost" onClick={() => setEditing(d)} title="Modifier"><FiEdit3 size={15} /></button>
                        <button className="ct-btn-ghost" onClick={() => handleDelete(d)} title="Supprimer"><FiTrash2 size={15} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <button className="btn btn-outline btn-sm" disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}><FiChevronLeft size={16} /></button>
              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Page {filters.page} / {data.pages}</span>
              <button className="btn btn-outline btn-sm" disabled={filters.page >= data.pages} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}><FiChevronRight size={16} /></button>
            </div>
          )}
        </>
      )}

      {editing !== null && (
        <DepositModal
          initial={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </div>
  );
}
