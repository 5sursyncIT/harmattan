import { useState, useEffect, useCallback } from 'react';
import { FiPlus, FiSearch, FiBook, FiAlertCircle, FiImage } from 'react-icons/fi';
import { listBooks, getBook, getBookQualityStats } from '../../../api/admin';
import { getProductImageUrl } from '../../../api/dolibarr';
import { getPageItems } from '../../../utils/pagination';
import BookForm from './BookForm';
import './BooksPanel.css';

const SEARCH_DEBOUNCE_MS = 300;

export default function BooksPanel() {
  const [books, setBooks] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [limit] = useState(20);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [gotoInput, setGotoInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedBook, setSelectedBook] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState('list');
  const [coverVersion, setCoverVersion] = useState({});
  const [justUpdatedAt, setJustUpdatedAt] = useState(null);

  // Conformité globale catalogue
  const [qualityGlobal, setQualityGlobal] = useState(null);

  // Debounce input → q
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [qInput]);

  const loadBooks = useCallback(async (signal) => {
    setLoading(true);
    try {
      const res = await listBooks({ page, limit, q }, { signal });
      setBooks(res.data.books || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError') return;
      console.error('Load books failed', err);
    } finally {
      setLoading(false);
    }
  }, [page, limit, q]);

  useEffect(() => {
    const ctrl = new AbortController();
    loadBooks(ctrl.signal);
    return () => ctrl.abort();
  }, [loadBooks]);

  // Charge la conformité globale (mise à jour après chaque save)
  const loadQualityStats = useCallback(() => {
    getBookQualityStats()
      .then((res) => setQualityGlobal(res.data))
      .catch(() => setQualityGlobal(null));
  }, []);

  useEffect(() => {
    loadQualityStats();
  }, [loadQualityStats]);

  const handleSelect = async (id) => {
    setSelectedId(id);
    setMode('edit');
    try {
      const res = await getBook(id);
      setSelectedBook(res.data);
    } catch (err) {
      console.error('Load book detail failed', err);
      setSelectedBook(null);
    }
  };

  const handleCreate = () => {
    setSelectedBook(null);
    setSelectedId(null);
    setMode('create');
  };

  const flashUpdated = () => {
    setJustUpdatedAt(Date.now());
    setTimeout(() => setJustUpdatedAt(null), 2500);
  };

  const handleSaved = () => {
    loadBooks();
    loadQualityStats();
    flashUpdated();
    if (mode === 'create') {
      setMode('list');
    } else if (selectedId) {
      getBook(selectedId).then((res) => setSelectedBook(res.data));
    }
  };

  const handleDeleted = () => {
    loadBooks();
    loadQualityStats();
    flashUpdated();
    setMode('list');
    setSelectedBook(null);
    setSelectedId(null);
  };

  const handleCoverUpdated = useCallback((bookId) => {
    setCoverVersion((v) => ({ ...v, [bookId]: (v[bookId] || 0) + 1 }));
  }, []);

  const totalPages = Math.ceil(total / limit);

  const handleGoto = (e) => {
    e.preventDefault();
    const n = parseInt(gotoInput, 10);
    if (!Number.isFinite(n)) return;
    const target = Math.min(Math.max(1, n), totalPages) - 1;
    setPage(target);
    setGotoInput('');
  };

  return (
    <div className="books-panel">
      <div className="books-header">
        <div className="books-title">
          <h2><FiBook aria-hidden="true" /> Gestion des livres</h2>
          <p>Saisie structurée des ouvrages avec validation rigoureuse</p>
        </div>
        <div className="books-stats">
          <div className="books-stat">
            <span className="books-stat-value">{total.toLocaleString('fr-FR')}</span>
            <span className="books-stat-label">Livres dans le catalogue</span>
          </div>
          {qualityGlobal && (
            <div className="books-stat">
              <span className={`books-stat-value ${qualityGlobal.pct >= 95 ? 'good' : qualityGlobal.pct >= 80 ? 'warn' : 'bad'}`}>
                {qualityGlobal.pct}%
              </span>
              <span className="books-stat-label">
                Conformité globale<br/>
                <small>({qualityGlobal.compliant.toLocaleString('fr-FR')}/{qualityGlobal.total.toLocaleString('fr-FR')})</small>
              </span>
            </div>
          )}
        </div>
      </div>

      {justUpdatedAt && (
        <div className="books-flash" role="status" aria-live="polite">
          ✓ Liste mise à jour
        </div>
      )}

      <div className="books-toolbar">
        <label className="books-search" htmlFor="books-search-input">
          <FiSearch aria-hidden="true" />
          <span className="visually-hidden">Rechercher un livre</span>
          <input
            id="books-search-input"
            type="text"
            placeholder="Rechercher par titre, auteur ou ISBN..."
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            aria-label="Rechercher un livre"
          />
        </label>
        <button className="btn btn-primary" onClick={handleCreate} type="button">
          <FiPlus aria-hidden="true" /> Nouveau livre
        </button>
      </div>

      <div className="books-split">
        <div className="books-list-pane">
          {loading ? (
            <ul className="books-list" aria-busy="true" aria-label="Chargement de la liste">
              {Array.from({ length: 8 }).map((_, i) => (
                <li key={i} className="books-list-item books-list-skeleton">
                  <div className="skeleton-cover" />
                  <div className="skeleton-main">
                    <div className="skeleton-line skeleton-line-title" />
                    <div className="skeleton-line skeleton-line-author" />
                    <div className="skeleton-pills">
                      <span className="skeleton-pill" />
                      <span className="skeleton-pill" />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : books.length === 0 ? (
            <div className="books-empty">
              <FiAlertCircle aria-hidden="true" />
              <p>Aucun livre trouvé</p>
            </div>
          ) : (
            <>
              <ul className="books-list">
                {books.map((b) => {
                  const hasAllFields = b.publication_year && b.nombre_pages && b.editeur && b.genre_label;
                  const v = coverVersion[b.id] || 0;
                  return (
                    <li
                      key={b.id}
                      className={`books-list-item ${selectedId === b.id ? 'active' : ''} ${!hasAllFields ? 'incomplete' : ''}`}
                      onClick={() => handleSelect(b.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleSelect(b.id);
                        }
                      }}
                    >
                      <div className="books-list-cover">
                        <CoverImage productId={b.id} title={b.label} version={v} />
                      </div>
                      <div className="books-list-main">
                        <strong>{b.label}</strong>
                        <span className="books-list-author">{b.auteur || 'Auteur inconnu'}</span>
                        <span className="books-list-meta">
                          {b.genre_label && <span className="books-pill">{b.genre_label}</span>}
                          {b.publication_year && <span className="books-pill books-pill-muted">{b.publication_year}</span>}
                          {b.nombre_pages && <span className="books-pill books-pill-muted">{b.nombre_pages} p.</span>}
                        </span>
                      </div>
                      <div className="books-list-side">
                        <span className="books-list-ref">{b.barcode || b.ref}</span>
                        <span className="books-list-price">{parseInt(b.price_ttc || 0).toLocaleString('fr-FR')} F</span>
                        {!hasAllFields && (
                          <span className="books-list-warn" title="Métadonnées incomplètes">
                            <FiAlertCircle size={12} aria-hidden="true" />
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {totalPages > 1 && (
                <div className="books-pagination">
                  <div className="books-pagination-pages">
                    <button disabled={page === 0} onClick={() => setPage(0)} type="button" title="Première page" aria-label="Première page">«</button>
                    <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} type="button">‹ Préc.</button>
                    {getPageItems(page, totalPages).map((it, i) =>
                      it === '…' ? (
                        <span key={`gap-${i}`} className="books-pagination-gap" aria-hidden="true">…</span>
                      ) : (
                        <button
                          key={it}
                          type="button"
                          className={`books-pagination-num${it - 1 === page ? ' is-current' : ''}`}
                          aria-current={it - 1 === page ? 'page' : undefined}
                          onClick={() => setPage(it - 1)}
                        >{it}</button>
                      )
                    )}
                    <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} type="button">Suiv. ›</button>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)} type="button" title="Dernière page" aria-label="Dernière page">»</button>
                  </div>
                  <form className="books-pagination-goto" onSubmit={handleGoto}>
                    <span>Aller à</span>
                    <input
                      type="number"
                      min={1}
                      max={totalPages}
                      value={gotoInput}
                      onChange={(e) => setGotoInput(e.target.value)}
                      placeholder={String(page + 1)}
                      aria-label="Numéro de page"
                    />
                    <span>/ {totalPages}</span>
                    <button type="submit">OK</button>
                  </form>
                </div>
              )}
            </>
          )}
        </div>

        <div className="books-detail-pane">
          {mode === 'list' && !selectedBook && (
            <div className="books-placeholder">
              <FiBook size={48} aria-hidden="true" />
              <h3>Sélectionnez un livre</h3>
              <p>Cliquez sur un livre de la liste pour l'éditer, ou créez un nouvel ouvrage.</p>
            </div>
          )}
          {mode === 'create' && (
            <BookForm
              book={null}
              onSaved={handleSaved}
              onCancel={() => setMode('list')}
            />
          )}
          {mode === 'edit' && selectedBook && (
            <BookForm
              book={selectedBook}
              onSaved={handleSaved}
              onDeleted={handleDeleted}
              onCancel={() => { setMode('list'); setSelectedBook(null); setSelectedId(null); }}
              onCoverUpdated={handleCoverUpdated}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function CoverImage({ productId, title, version, size = 'list' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [productId, version]);

  if (failed) {
    return (
      <div className={`cover-fallback cover-fallback-${size}`} aria-label="Aucune couverture">
        <FiImage aria-hidden="true" />
      </div>
    );
  }
  const base = getProductImageUrl(productId, title);
  const sep = base.includes('?') ? '&' : '?';
  return (
    <img
      src={`${base}${sep}v=${version || 0}`}
      alt={title || 'Couverture du livre'}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export { CoverImage };
