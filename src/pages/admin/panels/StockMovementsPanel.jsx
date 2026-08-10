import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getStockMovements, getStockMovementFilters, stockMovementsExportUrl } from '../../../api/admin';
import {
  FiArrowLeft, FiClock, FiSearch, FiDownload, FiAlertCircle, FiChevronLeft, FiChevronRight,
  FiUser, FiFilter, FiX, FiArrowUp, FiArrowDown, FiSettings,
} from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import StockNav from './StockNav';
import './Stock.css';

const fmtDateTime = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' })
    + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Provenance de l'information « acteur ». Distinction volontairement visible :
 * un mouvement attribué à une personne et un mouvement passé par un compte de
 * service n'ont pas la même valeur probante, et l'écran ne doit pas les confondre.
 */
const ACTOR_SOURCE = {
  app:      { label: 'saisi dans l\'application', tone: '#166534', bg: '#f0fdf4' },
  inferred: { label: 'rapproché du journal',      tone: '#92400e', bg: '#fffbeb' },
  document: { label: 'auteur du document',        tone: '#1e40af', bg: '#eff6ff' },
  dolibarr: { label: 'utilisateur Dolibarr',      tone: '#3730a3', bg: '#eef2ff' },
  service:  { label: 'écriture automatique',      tone: '#64748b', bg: '#f8fafc' },
  unknown:  { label: 'non attribué',              tone: '#64748b', bg: '#f8fafc' },
};

const EMPTY_FILTERS = {
  q: '', kind: '', warehouse_id: '', actor: '', direction: '', date_from: '', date_to: '',
};

export default function StockMovementsPanel() {
  const [searchParams] = useSearchParams();
  // Arrivée depuis une fiche produit : /admin/stock/movements?product_id=123
  const productId = searchParams.get('product_id') || '';

  const [filters, setFilters] = useState(() => ({ ...EMPTY_FILTERS, q: searchParams.get('q') || '' }));
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ movements: [], total: 0, pages: 1 });
  const [options, setOptions] = useState({ warehouses: [], actors: [], kinds: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    getStockMovementFilters().then(r => setOptions(r.data)).catch(() => {});
  }, []);

  const query = useMemo(() => {
    const q = { ...filters, page, limit: 30 };
    if (productId) q.product_id = productId;
    return q;
  }, [filters, page, productId]);

  const load = useCallback((signal) => {
    setLoading(true); setError(false);
    getStockMovements(query)
      .then(r => { if (!signal?.cancelled) setData(r.data); })
      .catch(() => { if (!signal?.cancelled) setError(true); })
      .finally(() => { if (!signal?.cancelled) setLoading(false); });
  }, [query]);

  useEffect(() => {
    const signal = { cancelled: false };
    const t = setTimeout(() => load(signal), 250); // debounce saisie
    return () => { signal.cancelled = true; clearTimeout(t); };
  }, [load]);

  // Tout changement de filtre ramène en page 1 : rester en page 40 après avoir
  // restreint à 12 résultats afficherait une page vide.
  const set = (k, v) => { setFilters(f => ({ ...f, [k]: v })); setPage(1); };
  const resetFilters = () => { setFilters({ ...EMPTY_FILTERS, q: filters.q }); setPage(1); };
  const activeCount = Object.entries(filters).filter(([k, v]) => k !== 'q' && v).length;
  const exportHref = stockMovementsExportUrl({ ...filters, ...(productId ? { product_id: productId } : {}) });

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiClock size={18} style={{ color: '#1e40af' }} /> Historique des mouvements
          </h3>
        </div>
        <a href={exportHref} className="sk-alert-btn" download
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none', fontSize: '0.82rem' }}>
          <FiDownload size={13} /> Exporter (CSV)
        </a>
      </div>

      <StockNav />

      <p style={{ color: '#64748b', fontSize: '0.88rem', marginTop: 0 }}>
        Toutes les manipulations de stock, quelle qu'en soit l'origine : ventes, avoirs, entrées,
        ajustements, transferts, réceptions et site web.
      </p>

      {/* Recherche + bascule filtres */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px' }}>
          <FiSearch size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input type="text" placeholder="Titre, référence, libellé ou code…" value={filters.q}
            onChange={e => set('q', e.target.value)}
            style={{ width: '100%', padding: '12px 14px 12px 42px', borderRadius: 10, border: '2px solid #e2e8f0', fontSize: '0.95rem' }} />
        </div>
        <button onClick={() => setShowFilters(s => !s)} className="sk-alert-btn"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem',
            background: activeCount ? '#eff6ff' : undefined, borderColor: activeCount ? '#bfdbfe' : undefined,
            color: activeCount ? '#1e40af' : undefined }}>
          <FiFilter size={13} /> Filtres{activeCount ? ` (${activeCount})` : ''}
        </button>
        {activeCount > 0 && (
          <button onClick={resetFilters} className="sk-btn-ghost"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.82rem' }}>
            <FiX size={13} /> Réinitialiser
          </button>
        )}
      </div>

      {showFilters && (
        <div className="sk-filters-panel">
          <label>
            <span>Nature</span>
            <select value={filters.kind} onChange={e => set('kind', e.target.value)}>
              <option value="">Toutes</option>
              {options.kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </label>
          <label>
            <span>Dépôt</span>
            <select value={filters.warehouse_id} onChange={e => set('warehouse_id', e.target.value)}>
              <option value="">Tous</option>
              {options.warehouses.map(w => <option key={w.id} value={w.id}>{w.ref}{w.lieu ? ` — ${w.lieu}` : ''}</option>)}
            </select>
          </label>
          <label>
            <span>Sens</span>
            <select value={filters.direction} onChange={e => set('direction', e.target.value)}>
              <option value="">Entrées et sorties</option>
              <option value="in">Entrées seulement</option>
              <option value="out">Sorties seulement</option>
            </select>
          </label>
          <label>
            <span>Acteur</span>
            <select value={filters.actor} onChange={e => set('actor', e.target.value)}>
              <option value="">Tous</option>
              {options.actors.map(a => <option key={a.username} value={a.username}>{a.username} ({a.n})</option>)}
            </select>
          </label>
          <label>
            <span>Du</span>
            <input type="date" value={filters.date_from} onChange={e => set('date_from', e.target.value)} />
          </label>
          <label>
            <span>Au</span>
            <input type="date" value={filters.date_to} onChange={e => set('date_to', e.target.value)} />
          </label>
        </div>
      )}

      {loading ? <Loader /> : error ? (
        <div className="sk-empty">
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
        </div>
      ) : data.movements.length === 0 ? (
        <div className="sk-empty">
          <FiClock size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucun mouvement pour ces critères</p>
        </div>
      ) : (
        <>
          <div className="sk-table-wrap">
            <table className="sk-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Titre</th>
                  <th style={{ textAlign: 'center' }}>Qté</th>
                  <th>Nature</th>
                  <th>Dépôt</th>
                  <th>Acteur</th>
                  <th>Détail</th>
                </tr>
              </thead>
              <tbody>
                {data.movements.map(m => {
                  const src = ACTOR_SOURCE[m.actor_source] || ACTOR_SOURCE.service;
                  const incoming = m.direction === 'in';
                  return (
                    <tr key={m.id}>
                      <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: '0.8rem' }}>{fmtDateTime(m.date)}</td>
                      <td style={{ maxWidth: 240 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.product_label || '—'}
                        </div>
                        <div className="mono" style={{ fontSize: '0.72rem' }}>{m.product_ref}</div>
                      </td>
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        <span className={`sk-move-qty ${incoming ? 'in' : 'out'}`}>
                          {incoming ? <FiArrowUp size={11} /> : <FiArrowDown size={11} />}
                          {incoming ? '+' : ''}{m.qty}
                        </span>
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{m.kind_label}</td>
                      <td style={{ whiteSpace: 'nowrap', fontSize: '0.82rem', color: '#475569' }}>{m.warehouse_ref || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {m.actor ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <span style={{
                              fontSize: '0.82rem', fontWeight: 600,
                              // Une écriture automatique ne se lit pas comme un geste
                              // humain : même colonne, mais présentation atténuée.
                              color: m.actor_source === 'service' ? '#64748b' : '#334155',
                              fontStyle: m.actor_source === 'service' ? 'italic' : 'normal',
                            }}
                              title={m.actor_account ? `Compte technique Dolibarr : ${m.actor_account}` : undefined}>
                              {m.actor_source === 'service'
                                ? <FiSettings size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
                                : <FiUser size={11} style={{ verticalAlign: -1, marginRight: 4 }} />}
                              {m.actor}
                            </span>
                            <span className="sk-actor-src" style={{ color: src.tone, background: src.bg }}>{src.label}</span>
                          </div>
                        ) : (
                          <span className="sk-actor-src" style={{ color: src.tone, background: src.bg }}>
                            {src.label}
                          </span>
                        )}
                      </td>
                      <td style={{ maxWidth: 260, fontSize: '0.8rem', color: '#64748b' }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.label}>
                          {m.reason || m.label || '—'}
                        </div>
                        {m.origin?.ref && <div className="mono" style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{m.origin.ref}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
              {data.total.toLocaleString('fr-FR')} mouvement{data.total > 1 ? 's' : ''}
            </span>
            {data.pages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="sk-btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><FiChevronLeft size={16} /></button>
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
                  Page {page} / {data.pages.toLocaleString('fr-FR')}
                </span>
                <button className="sk-btn-ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}><FiChevronRight size={16} /></button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
