import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  FiSearch, FiFilter, FiX, FiDownload, FiChevronLeft, FiChevronRight,
  FiArrowUp, FiArrowDown, FiClock, FiRefreshCw, FiCopy, FiArrowLeft,
} from 'react-icons/fi';
import { manuscriptsApi } from '../../../api/manuscripts';
import ManuscriptDuplicates from './ManuscriptDuplicates';
import './ManuscriptsWorkflow.css';

// Colonnes triables : `key` part telle quelle au serveur (whitelist côté API),
// `dir` est le sens du premier clic — alphabétique croissant pour le texte,
// plus récent / plus immobilisé en tête pour les dates (mêmes valeurs que
// MANUSCRIPT_SORT_DIR côté serveur, pour que la flèche dise la vérité).
const SORTABLE = [
  { key: 'ref', label: 'Réf.', dir: 'ASC' },
  { key: 'title', label: 'Titre', dir: 'ASC' },
  { key: 'author', label: 'Auteur', dir: 'ASC' },
  { key: 'genre', label: 'Genre', dir: 'ASC' },
  { key: 'stage', label: 'Étape', dir: 'ASC' },
  { key: 'updated', label: 'Dernière MAJ', dir: 'DESC' },
  { key: 'stale', label: 'Immobilisé', dir: 'DESC' },
];
const defaultDir = (key) => SORTABLE.find((c) => c.key === key)?.dir || 'DESC';

const UNASSIGNED_OPTIONS = [
  { value: '', label: 'Toutes affectations' },
  { value: 'evaluateur', label: 'Sans évaluateur' },
  { value: 'correcteur', label: 'Sans correcteur' },
  { value: 'imprimeur', label: 'Sans imprimeur' },
  { value: 'any', label: 'Aucun intervenant' },
];

// Même grandeur que la colonne « Immobilisé » : temps passé dans l'étape courante.
const STALE_OPTIONS = [
  { value: '', label: 'Toute ancienneté' },
  { value: '7', label: 'Bloqué depuis > 7 j' },
  { value: '15', label: 'Bloqué depuis > 15 j' },
  { value: '30', label: 'Bloqué depuis > 30 j' },
  { value: '60', label: 'Bloqué depuis > 60 j' },
  { value: '90', label: 'Bloqué depuis > 90 j' },
];

const PAGE_SIZES = [25, 50, 100];
const DEFAULT_LIMIT = 25;

// Étapes terminales : un manuscrit paru ou rejeté n'est pas « en retard »,
// l'alerte d'immobilisation ne doit pas s'y afficher.
const TERMINAL_STAGES = ['published', 'evaluation_negative'];

const fmtDate = (d) => (d ? new Date(String(d).replace(' ', 'T') + 'Z').toLocaleDateString('fr-FR') : '—');

export default function ManuscriptsPanelV2() {
  const navigate = useNavigate();
  const [data, setData] = useState({ rows: [], total: 0, page: 1, pages: 1, limit: DEFAULT_LIMIT, stage_counts: {}, group_counts: {} });
  const [meta, setMeta] = useState({ stages: [], labels: {}, groups: [], genres: [], intervenants: [] });
  const [loading, setLoading] = useState(true);    // première charge
  const [fetching, setFetching] = useState(false); // rafraîchissements (pas de flash)
  const [exporting, setExporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  // Nombre de groupes de doublons en attente d'arbitrage — pastille du bouton.
  const [dupCount, setDupCount] = useState(0);
  const hasLoadedRef = useRef(false);

  // Filtres, tri et page dans l'URL : ils survivent à l'aller-retour
  // liste ↔ fiche manuscrit (auparavant, consulter un manuscrit ramenait la
  // liste complète non filtrée) et l'écran filtré se partage par simple lien.
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => ({
    q: searchParams.get('q') ?? '',
    stage: searchParams.get('stage') ?? '',
    group: searchParams.get('group') ?? '',
    genre: searchParams.get('genre') ?? '',
    intervenant: searchParams.get('intervenant') ?? '',
    unassigned: searchParams.get('unassigned') ?? '',
    contract: searchParams.get('contract') ?? '',
    series: searchParams.get('series') ?? '',
    stale: searchParams.get('stale') ?? '',
    date_field: searchParams.get('date_field') === 'updated' ? 'updated' : 'created',
    date_from: searchParams.get('from') ?? '',
    date_to: searchParams.get('to') ?? '',
    duplicates: ['include', 'only'].includes(searchParams.get('duplicates')) ? searchParams.get('duplicates') : '',
    view: searchParams.get('view') === 'duplicates' ? 'duplicates' : '',
    sort: searchParams.get('sort') ?? '',
    order: searchParams.get('order') === 'ASC' ? 'ASC' : searchParams.get('order') === 'DESC' ? 'DESC' : '',
    page: Math.max(1, parseInt(searchParams.get('page'), 10) || 1),
    limit: PAGE_SIZES.includes(parseInt(searchParams.get('limit'), 10)) ? parseInt(searchParams.get('limit'), 10) : DEFAULT_LIMIT,
  }), [searchParams]);

  // Seules les valeurs non par défaut sont écrites dans l'URL (URLs lisibles).
  // replace:true — la frappe et la pagination ne polluent pas l'historique.
  const updateParams = (patch) => {
    const next = { ...filters, ...patch };
    const p = {};
    for (const [key, param] of [['q', 'q'], ['stage', 'stage'], ['group', 'group'], ['genre', 'genre'],
      ['intervenant', 'intervenant'], ['unassigned', 'unassigned'], ['contract', 'contract'],
      ['series', 'series'], ['stale', 'stale'], ['duplicates', 'duplicates'],
      ['view', 'view'], ['date_from', 'from'], ['date_to', 'to']]) {
      if (next[key]) p[param] = next[key];
    }
    if (next.date_field === 'updated' && (next.date_from || next.date_to)) p.date_field = 'updated';
    if (next.sort) { p.sort = next.sort; if (next.order) p.order = next.order; }
    if (next.page > 1) p.page = String(next.page);
    if (next.limit !== DEFAULT_LIMIT) p.limit = String(next.limit);
    setSearchParams(p, { replace: true });
  };

  // Recherche debouncée (300 ms) : l'input répond à la frappe, la requête ne
  // part qu'à la pause — plus besoin de cliquer « Filtrer ».
  const [searchInput, setSearchInput] = useState(filters.q);
  useEffect(() => {
    if (searchInput === filters.q) return undefined;
    const t = setTimeout(() => updateParams({ q: searchInput, page: 1 }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);
  // Retour arrière navigateur / réinitialisation : resynchronise le champ.
  useEffect(() => { setSearchInput((v) => (v === filters.q ? v : filters.q)); }, [filters.q]);

  useEffect(() => {
    manuscriptsApi.filters().then((res) => setMeta(res.data)).catch(() => {});
  }, []);

  const loadDuplicateCount = useCallback(() => {
    manuscriptsApi.duplicateGroups().then((res) => setDupCount(res.data.unresolved || 0)).catch(() => {});
  }, []);
  useEffect(() => { loadDuplicateCount(); }, [loadDuplicateCount]);

  useEffect(() => {
    if (filters.view === 'duplicates') return undefined;
    let cancelled = false;
    if (hasLoadedRef.current) setFetching(true); else setLoading(true);
    manuscriptsApi.list({
      q: filters.q || undefined,
      stage: filters.stage || undefined,
      group: filters.group || undefined,
      genre: filters.genre || undefined,
      intervenant: filters.intervenant || undefined,
      unassigned: filters.unassigned || undefined,
      contract: filters.contract || undefined,
      series: filters.series || undefined,
      stale: filters.stale || undefined,
      duplicates: filters.duplicates || undefined,
      date_field: filters.date_field,
      date_from: filters.date_from || undefined,
      date_to: filters.date_to || undefined,
      sort: filters.sort || undefined,
      order: filters.order || undefined,
      page: filters.page,
      limit: filters.limit,
    })
      .then((res) => { if (!cancelled) { setData(res.data); hasLoadedRef.current = true; } })
      .catch((err) => { if (!cancelled) toast.error(err.response?.data?.error || 'Erreur de chargement'); })
      .finally(() => { if (!cancelled) { setLoading(false); setFetching(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (key, value) => updateParams({ [key]: value, page: 1 });

  // 1er clic : sens naturel de la colonne. 2ᵉ : inverse. 3ᵉ : retour au tri par
  // défaut (les plus récemment reçus).
  const toggleSort = (key) => {
    if (filters.sort !== key) return updateParams({ sort: key, order: defaultDir(key), page: 1 });
    if (filters.order === defaultDir(key)) {
      return updateParams({ sort: key, order: defaultDir(key) === 'ASC' ? 'DESC' : 'ASC', page: 1 });
    }
    return updateParams({ sort: '', order: '', page: 1 });
  };

  const activeFilters = [filters.stage, filters.group, filters.genre, filters.intervenant,
    filters.unassigned, filters.contract, filters.series, filters.stale, filters.duplicates,
    filters.date_from, filters.date_to].filter(Boolean).length;

  const resetFilters = () => {
    setSearchInput('');
    setSearchParams({}, { replace: true });
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const res = await manuscriptsApi.exportCsv({
        q: filters.q || undefined, stage: filters.stage || undefined, group: filters.group || undefined,
        genre: filters.genre || undefined, intervenant: filters.intervenant || undefined,
        unassigned: filters.unassigned || undefined, contract: filters.contract || undefined,
        series: filters.series || undefined, stale: filters.stale || undefined,
        duplicates: filters.duplicates || undefined,
        date_field: filters.date_field, date_from: filters.date_from || undefined, date_to: filters.date_to || undefined,
        sort: filters.sort || undefined, order: filters.order || undefined,
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `manuscrits-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Export CSV téléchargé');
    } catch {
      toast.error("Erreur lors de l'export");
    } finally {
      setExporting(false);
    }
  };

  const buildPages = () => {
    const { page } = filters;
    const total = data.pages;
    const out = [];
    const left = Math.max(1, page - 2);
    const right = Math.min(total, page + 2);
    if (left > 1) { out.push(1); if (left > 2) out.push('…'); }
    for (let i = left; i <= right; i++) out.push(i);
    if (right < total) { if (right < total - 1) out.push('…'); out.push(total); }
    return out;
  };

  const sortIcon = (key) => {
    if (filters.sort !== key) return null;
    return (filters.order || defaultDir(key)) === 'ASC' ? <FiArrowUp size={11} /> : <FiArrowDown size={11} />;
  };

  // Ancienneté dans l'étape : au-delà d'un mois le dossier dort, au-delà de
  // deux il faut relancer. Muet sur les étapes terminales.
  const staleClass = (row) => {
    if (TERMINAL_STAGES.includes(row.current_stage) || row.days_in_stage == null) return '';
    if (row.days_in_stage >= 60) return 'ms-stale-high';
    if (row.days_in_stage >= 30) return 'ms-stale-mid';
    return '';
  };

  const totalAll = Object.values(data.group_counts || {}).reduce((s, n) => s + n, 0);
  const isDuplicatesView = filters.view === 'duplicates';

  return (
    <div className="ms-panel">
      <div className="ms-list-header">
        <div>
          <h2>{isDuplicatesView ? 'Manuscrits — doublons' : 'Manuscrits — vue globale'}</h2>
          <p className="ms-subtitle" style={{ marginBottom: 0 }}>
            {isDuplicatesView ? (
              "Mêmes ouvrages reçus plusieurs fois. Les renvois évidents sont refusés dès la soumission ; ceux-ci demandent un arbitrage."
            ) : (
              <>
                {data.total} manuscrit{data.total > 1 ? 's' : ''}
                {activeFilters || filters.q ? ' correspondant aux critères' : ' au total'}
                {data.stage_counts?.submitted ? ` · ${data.stage_counts.submitted} en attente de traitement` : ''}
              </>
            )}
          </p>
        </div>
        <div className="ms-list-actions">
          {isDuplicatesView ? (
            <button type="button" className="ms-btn" onClick={() => updateParams({ view: '', page: 1 })}>
              <FiArrowLeft size={14} /> Retour à la liste
            </button>
          ) : (
            <>
              <button type="button" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}
                className={`ms-btn ${showFilters || activeFilters ? 'ms-btn-toggle-active' : ''}`}>
                <FiFilter size={14} /> Filtres
                {activeFilters > 0 && <span className="ms-count-badge">{activeFilters}</span>}
              </button>
              {/* Pastille rouge : des doublons attendent un arbitrage. */}
              <button type="button" onClick={() => updateParams({ view: 'duplicates' })}
                className={`ms-btn ${dupCount ? 'ms-btn-warn' : ''}`}>
                <FiCopy size={14} /> Doublons
                {dupCount > 0 && <span className="ms-count-badge ms-count-badge-warn">{dupCount}</span>}
              </button>
              <button type="button" onClick={handleExport} disabled={exporting || !data.total} className="ms-btn">
                <FiDownload size={14} /> {exporting ? 'Export…' : 'Export CSV'}
              </button>
            </>
          )}
        </div>
      </div>

      {isDuplicatesView && (
        <ManuscriptDuplicates onResolved={() => { loadDuplicateCount(); hasLoadedRef.current = false; }} />
      )}

      {/* La vue « doublons » remplace la liste : recherche, puces et filtres
          n'ont pas de sens pendant l'arbitrage. */}
      {!isDuplicatesView && (
      <>
      <form className="ms-search-wrap" onSubmit={(e) => { e.preventDefault(); updateParams({ q: searchInput, page: 1 }); }}>
        <FiSearch size={16} className="ms-search-icon" />
        <input
          type="search"
          className="ms-search-input"
          placeholder="Rechercher : titre, sous-titre, réf., série, genre, ISBN, auteur, email, téléphone…"
          aria-label="Rechercher un manuscrit"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        {searchInput && (
          <button type="button" className="ms-search-clear" aria-label="Effacer la recherche" onClick={() => setSearchInput('')}>
            <FiX size={14} />
          </button>
        )}
      </form>

      {/* Familles d'étapes : le pipeline d'un coup d'œil, un clic pour filtrer. */}
      <div className="ms-chips" role="group" aria-label="Filtrer par famille d'étapes">
        <button type="button" className={`ms-chip ${!filters.group && !filters.stage ? 'active' : ''}`}
          onClick={() => updateParams({ group: '', stage: '', page: 1 })}>
          Tous <span className="ms-chip-count">{totalAll}</span>
        </button>
        {meta.groups?.map((g) => (
          <button key={g.value} type="button"
            className={`ms-chip ms-chip-${g.value} ${filters.group === g.value ? 'active' : ''}`}
            onClick={() => updateParams({ group: filters.group === g.value ? '' : g.value, stage: '', page: 1 })}>
            {g.label} <span className="ms-chip-count">{data.group_counts?.[g.value] ?? 0}</span>
          </button>
        ))}
      </div>

      {showFilters && (
        <div className="ms-filter-bar">
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-stage">Étape précise</label>
            <select id="ms-f-stage" value={filters.stage} onChange={(e) => update('stage', e.target.value)}>
              <option value="">Toutes les étapes</option>
              {meta.stages?.map((s) => (
                <option key={s} value={s}>
                  {meta.labels?.[s] || s}{data.stage_counts?.[s] ? ` (${data.stage_counts[s]})` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-genre">Genre</label>
            <select id="ms-f-genre" value={filters.genre} onChange={(e) => update('genre', e.target.value)}>
              <option value="">Tous les genres</option>
              {meta.genres?.map((g) => <option key={g.genre} value={g.genre}>{g.genre} ({g.n})</option>)}
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-interv">Intervenant</label>
            <select id="ms-f-interv" value={filters.intervenant} onChange={(e) => update('intervenant', e.target.value)}>
              <option value="">Tous les intervenants</option>
              {meta.intervenants?.map((i) => <option key={i.id} value={i.id}>{i.nom}</option>)}
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-unassigned">Affectation</label>
            <select id="ms-f-unassigned" value={filters.unassigned} onChange={(e) => update('unassigned', e.target.value)}>
              {UNASSIGNED_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-contract">Contrat</label>
            <select id="ms-f-contract" value={filters.contract} onChange={(e) => update('contract', e.target.value)}>
              <option value="">Avec ou sans contrat</option>
              <option value="with">Contrat rattaché</option>
              <option value="without">Sans contrat</option>
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-series">Type d'ouvrage</label>
            <select id="ms-f-series" value={filters.series} onChange={(e) => update('series', e.target.value)}>
              <option value="">Tous les ouvrages</option>
              <option value="only">Séries (multi-tomes)</option>
              <option value="single">Ouvrages simples</option>
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-stale">Blocage dans l'étape</label>
            <select id="ms-f-stale" value={filters.stale} onChange={(e) => update('stale', e.target.value)}>
              {STALE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-dup">Doublons marqués</label>
            <select id="ms-f-dup" value={filters.duplicates} onChange={(e) => update('duplicates', e.target.value)}>
              <option value="">Masqués (défaut)</option>
              <option value="include">Inclus dans la liste</option>
              <option value="only">Uniquement les doublons</option>
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-datefield">Période sur</label>
            <select id="ms-f-datefield" value={filters.date_field} onChange={(e) => update('date_field', e.target.value)}>
              <option value="created">Date de réception</option>
              <option value="updated">Dernière mise à jour</option>
            </select>
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-from">Du</label>
            <input id="ms-f-from" type="date" value={filters.date_from} onChange={(e) => update('date_from', e.target.value)} />
          </div>
          <div className="ms-filter-group">
            <label className="ms-filter-label" htmlFor="ms-f-to">Au</label>
            <input id="ms-f-to" type="date" value={filters.date_to} onChange={(e) => update('date_to', e.target.value)} />
          </div>
          {(activeFilters > 0 || filters.q) && (
            <button type="button" onClick={resetFilters} className="ms-btn ms-filter-reset">
              <FiRefreshCw size={13} /> Réinitialiser
            </button>
          )}
        </div>
      )}
      </>
      )}

      {isDuplicatesView ? null : loading ? (
        <p>Chargement...</p>
      ) : !data.rows.length ? (
        <div className="ms-empty">
          Aucun manuscrit pour ces critères.
          {(activeFilters > 0 || filters.q) && (
            <div style={{ marginTop: 12 }}>
              <button type="button" className="ms-btn" onClick={resetFilters}><FiRefreshCw size={13} /> Réinitialiser les filtres</button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="ms-table-wrap" aria-busy={fetching}>
            <table className="ms-table ms-table-sortable">
              <thead>
                <tr>
                  {SORTABLE.slice(0, 5).map((c) => (
                    <th key={c.key}>
                      <button type="button" className={`ms-th-sort ${filters.sort === c.key ? 'active' : ''}`} onClick={() => toggleSort(c.key)}>
                        {c.label} {sortIcon(c.key)}
                      </button>
                    </th>
                  ))}
                  <th>Acteur</th>
                  {SORTABLE.slice(5).map((c) => (
                    <th key={c.key}>
                      <button type="button" className={`ms-th-sort ${filters.sort === c.key ? 'active' : ''}`} onClick={() => toggleSort(c.key)}>
                        {c.label} {sortIcon(c.key)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((m) => (
                  // `fromList` : la fiche renvoie vers la liste TELLE QU'ELLE ÉTAIT
                  // (filtres, tri, page) au lieu de la remettre à zéro.
                  <tr key={m.id} onClick={() => navigate(`/admin/manuscripts/${m.id}`, { state: { fromList: searchParams.toString() } })}>
                    <td className="ms-cell-ref">{m.ref}</td>
                    <td>
                      {m.title}
                      {m.tome_number ? (
                        <span className="ms-series-badge" title={m.series_title ? `Série : ${m.series_title}` : 'Ouvrage en plusieurs tomes'}>
                          Série • Tome {m.tome_number}{m.tome_total ? `/${m.tome_total}` : ''}
                        </span>
                      ) : null}
                      {m.has_contract ? <span className="ms-flag-badge" title="Contrat d'édition rattaché">Contrat</span> : null}
                      {m.duplicate_of_ref ? (
                        <span className="ms-flag-badge ms-flag-dup" title={`Doublon de ${m.duplicate_of_ref} — ${m.duplicate_of_title || ''}`}>
                          Doublon de {m.duplicate_of_ref}
                        </span>
                      ) : null}
                      {m.subtitle ? <span className="ms-cell-subtitle">{m.subtitle}</span> : null}
                    </td>
                    <td>{m.author_name}</td>
                    <td className="ms-cell-muted">{m.genre || '—'}</td>
                    <td>
                      <span className={`ms-stage-badge ms-stage-${m.current_stage}`}>
                        {m.stage_label || m.current_stage}
                      </span>
                    </td>
                    <td className="ms-cell-muted">
                      {m.assignee_name
                        ? <span title={m.owner_metier_label || ''}>{m.assignee_name}</span>
                        : <span className="ms-cell-empty">—</span>}
                    </td>
                    <td className="ms-cell-muted">{fmtDate(m.updated_at || m.created_at)}</td>
                    <td>
                      <span className={`ms-stale ${staleClass(m)}`}>
                        {staleClass(m) ? <FiClock size={11} /> : null}
                        {m.days_in_stage == null ? '—' : m.days_in_stage === 0 ? "aujourd'hui" : `${m.days_in_stage} j`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="ms-pagination">
            {data.pages > 1 && (
              <>
                <button type="button" disabled={filters.page <= 1} onClick={() => updateParams({ page: filters.page - 1 })}
                  className="ms-page-btn" aria-label="Page précédente"><FiChevronLeft size={16} /></button>
                {buildPages().map((p, i) => (p === '…'
                  ? <span key={`e${i}`} className="ms-page-ellipsis">…</span>
                  : <button type="button" key={p} onClick={() => updateParams({ page: p })}
                      className={`ms-page-btn ${data.page === p ? 'active' : ''}`}>{p}</button>))}
                <button type="button" disabled={filters.page >= data.pages} onClick={() => updateParams({ page: filters.page + 1 })}
                  className="ms-page-btn" aria-label="Page suivante"><FiChevronRight size={16} /></button>
              </>
            )}
            <span className="ms-page-info">
              {data.total} résultat{data.total > 1 ? 's' : ''} · page {data.page} sur {data.pages}
            </span>
            <select className="ms-page-size" value={filters.limit} aria-label="Manuscrits par page"
              onChange={(e) => updateParams({ limit: parseInt(e.target.value, 10), page: 1 })}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
            </select>
          </div>
        </>
      )}
    </div>
  );
}
