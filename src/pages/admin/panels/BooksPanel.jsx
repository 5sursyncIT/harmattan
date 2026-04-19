import { useState, useEffect, useCallback } from 'react';
import { FiPlus, FiSearch, FiBook, FiAlertCircle } from 'react-icons/fi';
import { listBooks, getBook } from '../../../api/admin';
import BookForm from './BookForm';
import './BooksPanel.css';

export default function BooksPanel() {
  const [books, setBooks] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [limit] = useState(20);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedBook, setSelectedBook] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState('list'); // 'list' | 'edit' | 'create'

  const loadBooks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listBooks({ page, limit, q });
      setBooks(res.data.books || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      console.error('Load books failed', err);
    } finally {
      setLoading(false);
    }
  }, [page, limit, q]);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

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

  const handleSaved = () => {
    loadBooks();
    if (mode === 'create') {
      setMode('list');
    } else if (selectedId) {
      // Refresh detail
      getBook(selectedId).then((res) => setSelectedBook(res.data));
    }
  };

  const handleDeleted = () => {
    loadBooks();
    setMode('list');
    setSelectedBook(null);
    setSelectedId(null);
  };

  const totalPages = Math.ceil(total / limit);

  // Quality metric: books with all key fields filled
  const validCount = books.filter((b) =>
    b.label && b.ref && b.publication_year && b.nombre_pages && b.editeur && b.genre_label
  ).length;
  const qualityPct = books.length > 0 ? Math.round((validCount / books.length) * 100) : 100;

  return (
    <div className="books-panel">
      {/* Header */}
      <div className="books-header">
        <div className="books-title">
          <h2><FiBook /> Gestion des livres</h2>
          <p>Saisie structurée des ouvrages avec validation rigoureuse</p>
        </div>
        <div className="books-stats">
          <div className="books-stat">
            <span className="books-stat-value">{total.toLocaleString('fr-FR')}</span>
            <span className="books-stat-label">Livres dans le catalogue</span>
          </div>
          <div className="books-stat">
            <span className={`books-stat-value ${qualityPct >= 99 ? 'good' : qualityPct >= 90 ? 'warn' : 'bad'}`}>
              {qualityPct}%
            </span>
            <span className="books-stat-label">Conformité (page visible)</span>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="books-toolbar">
        <div className="books-search">
          <FiSearch />
          <input
            type="text"
            placeholder="Rechercher par titre, auteur ou ISBN..."
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
          />
        </div>
        <button className="btn btn-primary" onClick={handleCreate}>
          <FiPlus /> Nouveau livre
        </button>
      </div>

      {/* Split layout */}
      <div className="books-split">
        {/* LEFT: List */}
        <div className="books-list-pane">
          {loading ? (
            <div className="books-loading">Chargement...</div>
          ) : books.length === 0 ? (
            <div className="books-empty">
              <FiAlertCircle />
              <p>Aucun livre trouvé</p>
            </div>
          ) : (
            <>
              <ul className="books-list">
                {books.map((b) => {
                  const hasAllFields = b.publication_year && b.nombre_pages && b.editeur && b.genre_label;
                  return (
                    <li
                      key={b.id}
                      className={`books-list-item ${selectedId === b.id ? 'active' : ''} ${!hasAllFields ? 'incomplete' : ''}`}
                      onClick={() => handleSelect(b.id)}
                    >
                      <div className="books-list-main">
                        <strong>{b.label}</strong>
                        <span className="books-list-author">{b.auteur || 'Auteur inconnu'}</span>
                        <span className="books-list-meta">
                          {b.genre_label && <span className="pill">{b.genre_label}</span>}
                          {b.publication_year && <span className="pill pill-muted">{b.publication_year}</span>}
                          {b.nombre_pages && <span className="pill pill-muted">{b.nombre_pages} p.</span>}
                        </span>
                      </div>
                      <div className="books-list-side">
                        <span className="books-list-ref">{b.barcode || b.ref}</span>
                        <span className="books-list-price">{parseInt(b.price_ttc || 0).toLocaleString('fr-FR')} F</span>
                        {!hasAllFields && (
                          <span className="books-list-warn" title="Métadonnées incomplètes">
                            <FiAlertCircle size={12} />
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>

              {totalPages > 1 && (
                <div className="books-pagination">
                  <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹ Précédent</button>
                  <span>Page {page + 1} / {totalPages}</span>
                  <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Suivant ›</button>
                </div>
              )}
            </>
          )}
        </div>

        {/* RIGHT: Detail / Form */}
        <div className="books-detail-pane">
          {mode === 'list' && !selectedBook && (
            <div className="books-placeholder">
              <FiBook size={48} />
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
            />
          )}
        </div>
      </div>
    </div>
  );
}
