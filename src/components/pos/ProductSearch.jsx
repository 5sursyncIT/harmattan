import { useState, useRef, useEffect, useCallback } from 'react';
import { posSearchProducts, posLookupBarcode } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import { FiSearch } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './ProductSearch.css';

// Quand le scanner code-barre est configuré en QWERTY mais l'OS en FR AZERTY,
// les touches numériques (sans Shift) sortent en symboles : 1→&, 2→é, 3→", 4→', 5→(,
// 6→-, 7→è, 8→_, 9→ç, 0→à. Cette fonction reconvertit en chiffres si la chaîne
// ressemble à un faux barcode AZERTY (pas de chiffres ni lettres déjà présents).
const AZERTY_TO_DIGIT = {
  '&': '1', 'é': '2', '"': '3', "'": '4', '(': '5',
  '-': '6', 'è': '7', '_': '8', 'ç': '9', 'à': '0',
};
function azertyToDigits(s) {
  if (!s || s.length < 6) return s;
  if (/[0-9a-zA-Z]/.test(s)) return s; // contient chiffres ou lettres → saisie normale
  const chars = [...s];
  const mapped = chars.map((c) => AZERTY_TO_DIGIT[c]);
  if (mapped.some((m) => m === undefined)) return s; // au moins 1 char non-mappé → abandon
  return mapped.join('');
}

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
      const product = res.data;
      addItem(product);
      // Info discrète : stock restant après ajout au panier
      const inCart = usePosCartStore.getState().items.find((i) => i.product_id === product.id)?.qty || 0;
      const remaining = Math.max(0, (Number(product.stock_reel) || 0) - inCart);
      toast(`${product.label} · ${remaining} en stock`, {
        icon: '📚',
        duration: 2000,
        style: {
          background: remaining > 0 ? '#f1f5f9' : '#fef2f2',
          color: remaining > 0 ? '#334155' : '#b91c1c',
          fontSize: 13,
          fontWeight: 500,
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        },
      });
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
        // Translate scanner-AZERTY garbage → digits si applicable
        handleBarcodeScan(azertyToDigits(barcodeBuffer.current));
        barcodeBuffer.current = '';
        return;
      }

      // Accepte chiffres/lettres normaux + symboles AZERTY-sans-Shift des chiffres
      if (/^[0-9a-zA-Z\-&é"'(_èçà]$/.test(e.key)) {
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
    // Si l'input ressemble à une lecture scanner AZERTY (ex: "çè_é&'"àà..."), on retraduit
    const val = azertyToDigits(e.target.value);
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
