import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getContracts, exportContractsCsv } from '../../../api/contracts';
import { FiSearch, FiPlus, FiChevronLeft, FiChevronRight, FiArrowLeft, FiFilter, FiX, FiCalendar, FiBookOpen, FiDownload, FiArrowUp, FiArrowDown } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Contracts.css';
import { contractTypeLabel, contractTypeColor, CONTRACT_TYPE_FILTER_GROUPS } from '../../../utils/contractTypes';
import useAdminRole, { CONTRACT_EDIT_ROLES, CONTRACT_WRITE_ROLES } from '../../../hooks/useAdminRole';

const SORT_OPTIONS = [
  { key: 'date', label: 'Date' },
  { key: 'ref', label: 'Ref' },
  { key: 'author', label: 'Auteur' },
  { key: 'title', label: 'Titre' },
  { key: 'status', label: 'Statut' },
];

export default function ContractsList() {
  const [data, setData] = useState({ contracts: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);   // première charge uniquement (Loader plein écran)
  const [fetching, setFetching] = useState(false); // rafraîchissements (liste estompée, pas de flash)
  const [loadError, setLoadError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0); // bouton « Réessayer »
  const role = useAdminRole();
  const canEdit = CONTRACT_EDIT_ROLES.includes(role);   // export CSV (éditeurs/admin)
  const canCreate = CONTRACT_WRITE_ROLES.includes(role); // création (inclut le comptable)

  // Filtres/tri/page dans l'URL : ils survivent à l'aller-retour liste ↔ détail
  // (auparavant en useState, consulter un contrat ramenait page 1 sans filtres).
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => ({
    status: searchParams.get('status') ?? '',
    type: searchParams.get('type') ?? '',
    author: searchParams.get('author') ?? '',
    date_from: searchParams.get('from') ?? '',
    date_to: searchParams.get('to') ?? '',
    sort: searchParams.get('sort') ?? '',
    order: searchParams.get('order') === 'ASC' ? 'ASC' : 'DESC',
    page: Math.max(1, parseInt(searchParams.get('page'), 10) || 1),
    limit: [10, 20, 50].includes(parseInt(searchParams.get('limit'), 10)) ? parseInt(searchParams.get('limit'), 10) : 20,
  }), [searchParams]);

  // Seules les valeurs non par défaut sont écrites dans l'URL (URLs propres).
  // replace:true — la frappe et les changements de page ne polluent pas
  // l'historique ; « retour » ramène à l'écran précédent, pas à chaque filtre.
  const updateParams = (patch) => {
    const next = { ...filters, ...patch };
    const p = {};
    if (next.status !== '') p.status = next.status;
    if (next.type) p.type = next.type;
    if (next.author) p.author = next.author;
    if (next.date_from) p.from = next.date_from;
    if (next.date_to) p.to = next.date_to;
    if (next.sort) { p.sort = next.sort; p.order = next.order; }
    if (next.page > 1) p.page = String(next.page);
    if (next.limit !== 20) p.limit = String(next.limit);
    setSearchParams(p, { replace: true });
  };

  // Recherche debouncée (300 ms) : l'input répond localement à la frappe, le
  // fetch ne part qu'à la pause — fini les 10 requêtes + clignotements pour
  // taper « Sow Fall » sur une connexion mobile.
  const [searchInput, setSearchInput] = useState(filters.author);
  useEffect(() => {
    if (searchInput === filters.author) return undefined;
    const t = setTimeout(() => updateParams({ author: searchInput, page: 1 }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const [showFilters, setShowFilters] = useState(false);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (hasLoadedRef.current) setFetching(true); else setLoading(true);
    setLoadError(false);
    getContracts(filters)
      .then((r) => { if (!cancelled) { setData(r.data); hasLoadedRef.current = true; } })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) { setLoading(false); setFetching(false); } });
    return () => { cancelled = true; };
  }, [filters, reloadKey]);

  const update = (key, value) => updateParams({ [key]: value, page: 1 });
  const changePage = (page) => updateParams({ page });
  const changeLimit = (limit) => updateParams({ limit: parseInt(limit, 10) || 20, page: 1 });
  const toggleSort = (key) => {
    if (filters.sort === key) updateParams({ order: filters.order === 'DESC' ? 'ASC' : 'DESC', page: 1 });
    else updateParams({ sort: key, order: 'DESC', page: 1 });
  };
  const resetFilters = () => { setSearchInput(''); updateParams({ status: '', type: '', author: '', date_from: '', date_to: '', sort: '', order: 'DESC', page: 1 }); };
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
      toast.success('Export CSV téléchargé');
    } catch {
      toast.error('Erreur lors de l’export');
    } finally {
      setExporting(false);
    }
  };

  const formatDate = (ts) => {
    if (!ts) return '—';
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
          <Link to="/admin/contracts" aria-label="Retour au tableau de bord contrats" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <div>
            <h2 className="ct-list-title">Contrats d'&eacute;dition</h2>
            <span className="ct-list-subtitle">{data.total} contrat{data.total > 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="ct-list-actions">
          <button onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters} className={`ct-toggle-btn ${showFilters ? 'active' : ''}`}>
            <FiFilter size={14} /> Filtres
            {activeFilterCount > 0 && <span className="ct-toggle-badge">{activeFilterCount}</span>}
          </button>
          {canEdit && (
            <button onClick={handleExport} disabled={exporting} className="ct-btn ct-btn-outline">
              <FiDownload size={14} /> {exporting ? 'Export...' : 'Export CSV'}
            </button>
          )}
          {canCreate && <Link to="/admin/contracts/new" className="ct-new-btn"><FiPlus size={14} /> Nouveau contrat</Link>}
        </div>
      </div>

      {/* Search */}
      <div className="ct-search-wrap">
        <FiSearch size={16} className="ct-search-icon" />
        <input type="text" className="ct-search-input" placeholder="Rechercher par nom d'auteur..."
          aria-label="Rechercher par nom d'auteur"
          value={searchInput} onChange={e => setSearchInput(e.target.value)} />
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
              {CONTRACT_TYPE_FILTER_GROUPS.map(g => (
                <optgroup key={g.model} label={g.label}>
                  {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </optgroup>
              ))}
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
      {loading ? <Loader /> : loadError ? (
        <div className="ct-empty">
          <FiX size={48} className="ct-empty-icon" style={{ color: '#ef4444' }} />
          <h3>Erreur de chargement</h3>
          <p>Impossible de récupérer les contrats.</p>
          <button onClick={() => setReloadKey(k => k + 1)} className="ct-btn ct-btn-primary" style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : data.contracts.length === 0 ? (
        <div className="ct-empty">
          <FiBookOpen size={48} className="ct-empty-icon" />
          <h3>Aucun contrat trouv&eacute;</h3>
          <p>Ajustez vos filtres ou cr&eacute;ez un nouveau contrat.</p>
        </div>
      ) : (
        <>
          <div className="ct-card-list" aria-busy={fetching}>
            {data.contracts.map(c => (
              <Link key={c.id} className="ct-card" to={`/admin/contracts/${c.id}`}>
                <div style={{ minWidth: 0 }}>
                  <div className="ct-card-badges">
                    <span className="ct-card-ref">{c.ref}</span>
                    <span className={`ct-badge ${statusClass(c.status)}`}>{c.statusLabel}</span>
                    {c.type && (
                      <span className="ct-badge" style={{ background: `${contractTypeColor(c.type)}10`, color: contractTypeColor(c.type) }}>
                        {c.typeLabel || contractTypeLabel(c.type)}
                      </span>
                    )}
                  </div>
                  <div className="ct-card-title">{c.title || 'Sans titre'}</div>
                  <div className="ct-card-meta">
                    <span>{c.author?.name || '—'}</span>
                    {c.isbn && <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{c.isbn}</span>}
                  </div>
                </div>
                <div className="ct-card-right">
                  <div className="ct-card-date"><FiCalendar size={12} />{formatDate(c.date)}</div>
                  {c.royaltyPrint != null && <span style={{ fontSize: '0.78rem', color: '#64748b' }}>{c.royaltyPrint}% print</span>}
                </div>
              </Link>
            ))}
          </div>

          <div className="ct-pagination">
            {data.pages > 1 && (
              <>
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
              </>
            )}
            <span className="ct-page-info">
              {data.total} résultat{data.total > 1 ? 's' : ''} · Page {filters.page} sur {data.pages}
            </span>
            <select
              className="ct-filter-select"
              style={{ marginLeft: 'auto', width: 'auto' }}
              value={filters.limit}
              onChange={e => changeLimit(e.target.value)}
              aria-label="Contrats par page"
            >
              <option value={10}>10 / page</option>
              <option value={20}>20 / page</option>
              <option value={50}>50 / page</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}
