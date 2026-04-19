import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getContracts, exportContractsCsv } from '../../../api/contracts';
import { FiSearch, FiPlus, FiChevronLeft, FiChevronRight, FiArrowLeft, FiFilter, FiX, FiCalendar, FiBookOpen, FiDownload, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Contracts.css';

const STATUS_LABELS = { 0: 'Brouillon', 1: 'Actif', 2: 'Clos' };
const TYPE_LABELS = { harmattan_2024: 'Harmattan 2024', harmattan_dll: 'Harmattan DLL', tamarinier: 'Le Tamarinier' };
const TYPE_COLORS = { harmattan_2024: '#10531a', harmattan_dll: '#0284c7', tamarinier: '#7c3aed' };
const SORT_OPTIONS = [
  { key: 'date', label: 'Date' },
  { key: 'ref', label: 'Ref' },
  { key: 'author', label: 'Auteur' },
  { key: 'title', label: 'Titre' },
  { key: 'status', label: 'Statut' },
];

export default function ContractsList() {
  const navigate = useNavigate();
  const [data, setData] = useState({ contracts: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    status: '', type: '', author: '', date_from: '', date_to: '',
    sort: '', order: 'DESC', page: 1,
  });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getContracts(filters)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (key, value) => setFilters(f => ({ ...f, [key]: value, page: 1 }));
  const changePage = (page) => setFilters(f => ({ ...f, page }));
  const toggleSort = (key) => {
    setFilters(f => {
      if (f.sort === key) return { ...f, order: f.order === 'DESC' ? 'ASC' : 'DESC', page: 1 };
      return { ...f, sort: key, order: 'DESC', page: 1 };
    });
  };
  const resetFilters = () => setFilters({ status: '', type: '', author: '', date_from: '', date_to: '', sort: '', order: 'DESC', page: 1 });
  const activeFilterCount = [filters.status, filters.type, filters.date_from, filters.date_to].filter(Boolean).length;

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await exportContractsCsv({ status: filters.status, type: filters.type, author: filters.author, date_from: filters.date_from, date_to: filters.date_to });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contrats-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Export CSV t\u00e9l\u00e9charg\u00e9');
    } catch {
      toast.error('Erreur lors de l\u2019export');
    } finally {
      setExporting(false);
    }
  };

  const formatDate = (ts) => {
    if (!ts) return '\u2014';
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const buildPages = () => {
    const { page } = filters;
    const total = data.pages;
    const pages = [];
    const delta = 2;
    const left = Math.max(1, page - delta);
    const right = Math.min(total, page + delta);
    if (left > 1) { pages.push(1); if (left > 2) pages.push('...'); }
    for (let i = left; i <= right; i++) pages.push(i);
    if (right < total) { if (right < total - 1) pages.push('...'); pages.push(total); }
    return pages;
  };

  const statusClass = (s) => s === 0 ? 'ct-badge-draft' : s === 1 ? 'ct-badge-active' : 'ct-badge-closed';

  return (
    <div className="admin-panel">
      {/* Header */}
      <div className="ct-list-header">
        <div className="ct-list-title-group">
          <Link to="/admin/contracts" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <div>
            <h2 className="ct-list-title">Contrats d'&eacute;dition</h2>
            <span className="ct-list-subtitle">{data.total} contrat{data.total > 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="ct-list-actions">
          <button onClick={() => setShowFilters(!showFilters)} className={`ct-toggle-btn ${showFilters ? 'active' : ''}`}>
            <FiFilter size={14} /> Filtres
            {activeFilterCount > 0 && <span className="ct-toggle-badge">{activeFilterCount}</span>}
          </button>
          <button onClick={handleExport} disabled={exporting} className="ct-btn ct-btn-outline">
            <FiDownload size={14} /> {exporting ? 'Export...' : 'Export CSV'}
          </button>
          <Link to="/admin/contracts/new" className="ct-new-btn"><FiPlus size={14} /> Nouveau contrat</Link>
        </div>
      </div>

      {/* Search */}
      <div className="ct-search-wrap">
        <FiSearch size={16} className="ct-search-icon" />
        <input type="text" className="ct-search-input" placeholder="Rechercher par auteur, titre, ISBN..."
          value={filters.author} onChange={e => update('author', e.target.value)} />
      </div>

      {/* Filters */}
      {showFilters && (
        <div className="ct-filter-bar">
          <div className="ct-filter-group">
            <label className="ct-filter-label">Statut</label>
            <select className="ct-filter-select" value={filters.status} onChange={e => update('status', e.target.value)}>
              <option value="">Tous</option>
              <option value="0">Brouillon</option>
              <option value="1">Actif</option>
              <option value="2">Clos</option>
            </select>
          </div>
          <div className="ct-filter-group">
            <label className="ct-filter-label">Type</label>
            <select className="ct-filter-select" value={filters.type} onChange={e => update('type', e.target.value)}>
              <option value="">Tous</option>
              <option value="harmattan_2024">Harmattan 2024</option>
              <option value="harmattan_dll">Harmattan DLL</option>
              <option value="tamarinier">Le Tamarinier</option>
            </select>
          </div>
          <div className="ct-filter-group">
            <label className="ct-filter-label">Date d&eacute;but</label>
            <input type="date" className="ct-filter-input" value={filters.date_from} onChange={e => update('date_from', e.target.value)} />
          </div>
          <div className="ct-filter-group">
            <label className="ct-filter-label">Date fin</label>
            <input type="date" className="ct-filter-input" value={filters.date_to} onChange={e => update('date_to', e.target.value)} />
          </div>
          {activeFilterCount > 0 && (
            <button onClick={resetFilters} className="ct-clear-btn" style={{ alignSelf: 'flex-end' }}>
              <FiX size={12} /> Effacer
            </button>
          )}
        </div>
      )}

      {/* Sort bar */}
      <div className="ct-sort-bar">
        <span>Trier par :</span>
        {SORT_OPTIONS.map(s => (
          <button key={s.key} onClick={() => toggleSort(s.key)}
            className={`ct-sort-btn ${filters.sort === s.key ? 'active' : ''}`}>
            {s.label}
            {filters.sort === s.key && (filters.order === 'ASC' ? <FiArrowUp size={10} /> : <FiArrowDown size={10} />)}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? <Loader /> : data.contracts.length === 0 ? (
        <div className="ct-empty">
          <FiBookOpen size={48} className="ct-empty-icon" />
          <h3>Aucun contrat trouv&eacute;</h3>
          <p>Ajustez vos filtres ou cr&eacute;ez un nouveau contrat.</p>
        </div>
      ) : (
        <>
          <div className="ct-card-list">
            {data.contracts.map(c => (
              <div key={c.id} className="ct-card" onClick={() => navigate(`/admin/contracts/${c.id}`)}>
                <div style={{ minWidth: 0 }}>
                  <div className="ct-card-badges">
                    <span className="ct-card-ref">{c.ref}</span>
                    <span className={`ct-badge ${statusClass(c.status)}`}>{c.statusLabel}</span>
                    {c.type && (
                      <span className="ct-badge" style={{ background: `${TYPE_COLORS[c.type] || '#888'}10`, color: TYPE_COLORS[c.type] || '#888' }}>
                        {TYPE_LABELS[c.type]}
                      </span>
                    )}
                  </div>
                  <div className="ct-card-title">{c.title || 'Sans titre'}</div>
                  <div className="ct-card-meta">
                    <span>{c.author?.name || '\u2014'}</span>
                    {c.isbn && <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{c.isbn}</span>}
                  </div>
                </div>
                <div className="ct-card-right">
                  <div className="ct-card-date"><FiCalendar size={12} />{formatDate(c.date)}</div>
                  {c.royaltyPrint != null && <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{c.royaltyPrint}% print</span>}
                </div>
              </div>
            ))}
          </div>

          {data.pages > 1 && (
            <div className="ct-pagination">
              <button disabled={filters.page <= 1} onClick={() => changePage(filters.page - 1)} className="ct-page-btn">
                <FiChevronLeft size={16} />
              </button>
              {buildPages().map((p, i) => (
                p === '...' ? <span key={`e${i}`} style={{ padding: '0 6px', color: '#94a3b8' }}>...</span> : (
                  <button key={p} onClick={() => changePage(p)} className={`ct-page-btn ${filters.page === p ? 'active' : ''}`}>{p}</button>
                )
              ))}
              <button disabled={filters.page >= data.pages} onClick={() => changePage(filters.page + 1)} className="ct-page-btn">
                <FiChevronRight size={16} />
              </button>
              <span className="ct-page-info">Page {filters.page} sur {data.pages}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
