import { useState, useRef, useEffect, useCallback } from 'react';
import { posSearchProducts, posLookupBarcode } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import { FiSearch } from 'react-icons/fi';
import './ProductSearch.css';

export default function ProductSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const addItem = usePosCartStore((s) => s.addItem);
  const inputRef = useRef(null);
  const barcodeBuffer = useRef('');
  const barcodeTimer = useRef(null);
  const searchTimer = useRef(null);

  const doSearch = useCallback(async (term) => {
    if (term.length < 2) { setResults([]); setShowResults(false); return; }
    setLoading(true);
    try {
      const res = await posSearchProducts(term);
      setResults(res.data);
      setShowResults(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleBarcodeScan = useCallback(async (code) => {
    try {
      const res = await posLookupBarcode(code);
      addItem(res.data);
      setQuery('');
      setShowResults(false);
      inputRef.current?.focus();
    } catch {
      setQuery(code);
      doSearch(code);
    }
  }, [addItem, doSearch]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Raccourci Ctrl+K ou Cmd+K pour focus la recherche
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }

      if (e.target.tagName === 'INPUT' && e.target !== inputRef.current) return;

      if (e.key === 'Enter' && barcodeBuffer.current.length >= 6) {
        e.preventDefault();
        handleBarcodeScan(barcodeBuffer.current);
        barcodeBuffer.current = '';
        return;
      }

      if (/^[0-9a-zA-Z-]$/.test(e.key)) {
        barcodeBuffer.current += e.key;
        clearTimeout(barcodeTimer.current);
        barcodeTimer.current = setTimeout(() => {
          barcodeBuffer.current = '';
        }, 150);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBarcodeScan]);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(val), 300);
  };

  const handleSelect = (product) => {
    addItem(product);
    setQuery('');
    setShowResults(false);
    inputRef.current?.focus();
  };

  return (
    <div className="pos-search">
      <div className="pos-search-input-wrap">
        <FiSearch className="pos-search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="pos-search-input"
          placeholder="Rechercher un produit ou scanner un code-barres..."
          value={query}
          onChange={handleChange}
          onFocus={() => results.length > 0 && setShowResults(true)}
          autoFocus
        />
        {!query && !loading && (
          <div className="pos-search-shortcut">
            <span>Ctrl</span>+<span>K</span>
          </div>
        )}
        {loading && <div className="pos-search-spinner" />}
      </div>

      <div className="pos-search-hints">
        <span className="pos-search-hint">Recherche titre / ISBN</span>
        <span className="pos-search-hint">Scan code-barres</span>
        <span className="pos-search-hint">Ajout instantané</span>
      </div>

      {showResults && results.length > 0 && (
        <div className="pos-search-results">
          {results.map((p) => (
            <button key={p.id} className="pos-search-result" onClick={() => handleSelect(p)}>
              <div className="pos-search-result-info">
                <span className="pos-search-result-label">{p.label}</span>
                <span className="pos-search-result-ref">{p.ref}</span>
              </div>
              <div className="pos-search-result-right">
                <span className="pos-search-result-price">
                  {parseInt(p.price_ttc).toLocaleString('fr-FR')} F
                </span>
                <span className={`pos-search-result-stock ${p.stock_reel > 0 ? 'in' : 'out'}`}>
                  {p.stock_reel > 0 ? `${p.stock_reel} en stock` : 'Rupture'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {showResults && results.length === 0 && query.length >= 2 && !loading && (
        <div className="pos-search-results">
          <div className="pos-search-empty">Aucun produit trouvé</div>
        </div>
      )}

      {showResults && <div className="pos-search-overlay" onClick={() => setShowResults(false)} />}
    </div>
  );
}
