import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FiFilter, FiX, FiSearch, FiChevronDown, FiChevronUp } from 'react-icons/fi';
import { getProducts, getCategories, getPriceRange } from '../api/dolibarr';
import ProductGrid from '../components/product/ProductGrid';
import Pagination from '../components/common/Pagination';
import './CatalogPage.css';

const ITEMS_PER_PAGE = 20;

const SORT_OPTIONS = [
  { value: 't.rowid-DESC', label: 'Plus récents' },
  { value: 't.rowid-ASC', label: 'Plus anciens' },
  { value: 't.label-ASC', label: 'Titre A-Z' },
  { value: 't.label-DESC', label: 'Titre Z-A' },
  { value: 't.price-ASC', label: 'Prix croissant' },
  { value: 't.price-DESC', label: 'Prix décroissant' },
];

export default function CatalogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [totalProducts, setTotalProducts] = useState(0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [localSearch, setLocalSearch] = useState(searchParams.get('q') || '');
  const [priceRange, setPriceRange] = useState({ min: 0, max: 50000 });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const debounceRef = useRef(null);

  // Read all params from URL
  const page = parseInt(searchParams.get('page') || '1');
  const query = searchParams.get('q') || '';
  const categoryId = searchParams.get('category') || '';
  const sortParam = searchParams.get('sort') || 't.rowid-DESC';
  const author = searchParams.get('author') || '';
  const priceMin = searchParams.get('price_min') || '';
  const priceMax = searchParams.get('price_max') || '';
  const inStock = searchParams.get('in_stock') || '';
  const withCover = searchParams.get('with_cover') || '';

  // Local state for advanced inputs (avoid fetching on every keystroke)
  const [localAuthor, setLocalAuthor] = useState(author);
  const [localPriceMin, setLocalPriceMin] = useState(priceMin);
  const [localPriceMax, setLocalPriceMax] = useState(priceMax);

  useEffect(() => {
    getCategories()
      .then((res) => {
        const cats = Array.isArray(res.data) ? res.data : [];
        // Excluded categories (not real book genres)
        const excluded = new Set([
          'accueil', 'racine', 'services', 'librairie', 'livres',
          'livres du mois', 'http://senharmattan.com/',
        ]);

        // Decode HTML entities
        const decode = (s) =>
          s?.replace(/&eacute;/g, 'é')
            .replace(/&acirc;/g, 'â')
            .replace(/&egrave;/g, 'è')
            .replace(/&ocirc;/g, 'ô')
            .replace(/&ucirc;/g, 'û')
            .replace(/&icirc;/g, 'î')
            .replace(/&agrave;/g, 'à')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'") || s;

        // Deduplicate (case-insensitive), filter, decode, sort
        const seen = new Set();
        const cleaned = cats
          .map((c) => ({ ...c, label: decode(c.label) }))
          .filter((c) => {
            const key = c.label.toLowerCase().trim();
            if (excluded.has(key) || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => a.label.localeCompare(b.label, 'fr'));

        setCategories(cleaned);
      })
      .catch(console.error);

    getPriceRange()
      .then((res) => setPriceRange(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fetchProducts = async () => {
      setLoading(true);
      try {
        const pageIndex = page - 1;
        const [sortField, sortOrder] = sortParam.split('-');
        const params = {
          limit: ITEMS_PER_PAGE,
          page: pageIndex,
          sort: sortField,
          order: sortOrder,
        };

        if (categoryId) params.category = categoryId;
        if (query) params.q = query;
        if (author) params.author = author;
        if (priceMin) params.price_min = priceMin;
        if (priceMax) params.price_max = priceMax;
        if (inStock) params.in_stock = inStock;
        if (withCover) params.with_cover = withCover;

        const res = await getProducts(params);
        const data = res.data.products || res.data;
        const items = Array.isArray(data) ? data : [];

        setProducts(items);
        const total = res.data.total;
        if (total !== undefined) {
          setTotalProducts(total);
        } else {
          setTotalProducts(
            items.length >= ITEMS_PER_PAGE
              ? (page + 1) * ITEMS_PER_PAGE
              : (page - 1) * ITEMS_PER_PAGE + items.length
          );
        }
      } catch (err) {
        console.error('Error fetching products:', err);
        setProducts([]);
      } finally {
        setLoading(false);
      }
    };
    fetchProducts();
  }, [page, query, categoryId, sortParam, author, priceMin, priceMax, inStock, withCover]);

  // Sync local search with URL
  useEffect(() => { setLocalSearch(query); }, [query]);
  useEffect(() => { setLocalAuthor(author); }, [author]);
  useEffect(() => { setLocalPriceMin(priceMin); }, [priceMin]);
  useEffect(() => { setLocalPriceMax(priceMax); }, [priceMax]);

  useEffect(() => {
    // Adding advanced filters to dependency array isn't needed here 
    // because we trigger updates explicitly, but to satisfy linter:
    if (author || priceMin || priceMax || inStock || withCover) {
      setAdvancedOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateParams = useCallback((updates) => {
    const params = new URLSearchParams(searchParams);
    params.delete('page');
    Object.entries(updates).forEach(([key, value]) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });
    setSearchParams(params);
  }, [searchParams, setSearchParams]);

  const handlePageChange = (newPage) => {
    const params = new URLSearchParams(searchParams);
    params.set('page', newPage.toString());
    setSearchParams(params);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCategoryClick = (catId) => {
    const params = new URLSearchParams(searchParams);
    params.delete('page');
    if (catId) params.set('category', catId);
    else params.delete('category');
    setSearchParams(params);
    setFilterOpen(false);
  };

  const handleSortChange = (e) => {
    updateParams({ sort: e.target.value });
  };

  const handleSearchInput = useCallback((e) => {
    const value = e.target.value;
    setLocalSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      updateParams({ q: value.trim() || null });
    }, 500);
  }, [updateParams]);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    clearTimeout(debounceRef.current);
    updateParams({ q: localSearch.trim() || null });
  };

  const applyAdvancedFilters = () => {
    updateParams({
      author: localAuthor.trim() || null,
      price_min: localPriceMin || null,
      price_max: localPriceMax || null,
    });
  };

  const handleAdvancedKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyAdvancedFilters();
    }
  };

  const clearFilters = () => {
    setSearchParams({});
    setLocalSearch('');
    setLocalAuthor('');
    setLocalPriceMin('');
    setLocalPriceMax('');
    setFilterOpen(false);
  };

  const selectedCategory = categories.find((c) => c.id == categoryId);
  const totalPages = Math.ceil(totalProducts / ITEMS_PER_PAGE);
  const hasFilters = query || categoryId || sortParam !== 't.rowid-DESC' || author || priceMin || priceMax || inStock || withCover;

  const activeFilterCount = [query, categoryId, author, priceMin || priceMax, inStock, withCover].filter(Boolean).length;

  return (
    <div className="catalog-page">
      <div className="container">
        <div className="catalog-header">
          <h1>
            {query
              ? `Résultats pour "${query}"`
              : selectedCategory
                ? selectedCategory.label
                : 'Catalogue'}
          </h1>
          <div className="catalog-header-actions">
            {hasFilters && (
              <button className="clear-filters-btn" onClick={clearFilters}>
                <FiX size={14} /> Effacer tout
              </button>
            )}
            <button className="filter-toggle" onClick={() => setFilterOpen(!filterOpen)}>
              {filterOpen ? <FiX /> : <FiFilter />} Filtres
              {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
            </button>
          </div>
        </div>

        <div className="catalog-toolbar">
          <form className="catalog-search" onSubmit={handleSearchSubmit}>
            <FiSearch size={16} className="catalog-search-icon" />
            <input
              type="text"
              placeholder="Rechercher un titre, ISBN, mot-clé..."
              value={localSearch}
              onChange={handleSearchInput}
            />
          </form>
          <select className="catalog-sort" value={sortParam} onChange={handleSortChange}>
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Advanced filters panel */}
        <div className="catalog-advanced-toggle">
          <button onClick={() => setAdvancedOpen(!advancedOpen)}>
            <FiFilter size={14} />
            Filtres avancés
            {activeFilterCount > 0 && <span className="adv-badge">{activeFilterCount}</span>}
            {advancedOpen ? <FiChevronUp /> : <FiChevronDown />}
          </button>
        </div>

        {advancedOpen && (
          <div className="catalog-advanced">
            <div className="advanced-grid">
              {/* Author */}
              <div className="advanced-field">
                <label><FiSearch size={12} /> Auteur</label>
                <input
                  type="text"
                  placeholder="Ex: Cheikh Anta Diop"
                  value={localAuthor}
                  onChange={(e) => setLocalAuthor(e.target.value)}
                  onKeyDown={handleAdvancedKeyDown}
                />
              </div>

              {/* Price range */}
              <div className="advanced-field advanced-price-group">
                <label>Fourchette de prix (FCFA)</label>
                <div className="price-inputs">
                  <input
                    type="number"
                    placeholder={`Min (${priceRange.min})`}
                    value={localPriceMin}
                    onChange={(e) => setLocalPriceMin(e.target.value)}
                    onKeyDown={handleAdvancedKeyDown}
                    min={0}
                  />
                  <span className="price-separator">—</span>
                  <input
                    type="number"
                    placeholder={`Max (${priceRange.max})`}
                    value={localPriceMax}
                    onChange={(e) => setLocalPriceMax(e.target.value)}
                    onKeyDown={handleAdvancedKeyDown}
                    min={0}
                  />
                </div>
                {/* Quick price buttons */}
                <div className="price-presets">
                  {[5000, 10000, 15000, 20000, 30000].map((p) => (
                    <button key={p} className={`price-preset ${localPriceMax == p ? 'active' : ''}`} onClick={() => { setLocalPriceMin(''); setLocalPriceMax(String(p)); }}>
                      &lt; {(p / 1000)}k
                    </button>
                  ))}
                  <button className={`price-preset ${!localPriceMax ? 'active' : ''}`} onClick={() => { setLocalPriceMin(''); setLocalPriceMax(''); }}>
                    Tous
                  </button>
                </div>
              </div>

              {/* Toggles */}
              <div className="advanced-field">
                <label>Options</label>
                <div className="advanced-toggles">
                  <button
                    className={`toggle-chip ${inStock === '1' ? 'active' : ''}`}
                    onClick={() => updateParams({ in_stock: inStock === '1' ? null : '1' })}
                  >
                    En stock uniquement
                  </button>
                  <button
                    className={`toggle-chip ${withCover === '1' ? 'active' : ''}`}
                    onClick={() => updateParams({ with_cover: withCover === '1' ? null : '1' })}
                  >
                    Avec couverture
                  </button>
                </div>
              </div>
            </div>

            <div className="advanced-actions">
              <button className="advanced-apply" onClick={applyAdvancedFilters}>
                <FiSearch size={14} /> Appliquer les filtres
              </button>
              {hasFilters && (
                <button className="advanced-clear" onClick={clearFilters}>
                  <FiX size={14} /> Tout effacer
                </button>
              )}
            </div>

            {/* Active filter tags */}
            {hasFilters && (
              <div className="active-filters">
                {query && (
                  <span className="filter-tag">
                    "{query}" <button onClick={() => { setLocalSearch(''); updateParams({ q: null }); }}><FiX size={12} /></button>
                  </span>
                )}
                {author && (
                  <span className="filter-tag">
                    Auteur: {author} <button onClick={() => { setLocalAuthor(''); updateParams({ author: null }); }}><FiX size={12} /></button>
                  </span>
                )}
                {(priceMin || priceMax) && (
                  <span className="filter-tag">
                    {priceMin || '0'} — {priceMax || '∞'} F
                    <button onClick={() => { setLocalPriceMin(''); setLocalPriceMax(''); updateParams({ price_min: null, price_max: null }); }}><FiX size={12} /></button>
                  </span>
                )}
                {categoryId && selectedCategory && (
                  <span className="filter-tag">
                    {selectedCategory.label} <button onClick={() => handleCategoryClick('')}><FiX size={12} /></button>
                  </span>
                )}
                {inStock && (
                  <span className="filter-tag">
                    En stock <button onClick={() => updateParams({ in_stock: null })}><FiX size={12} /></button>
                  </span>
                )}
                {withCover && (
                  <span className="filter-tag">
                    Avec couverture <button onClick={() => updateParams({ with_cover: null })}><FiX size={12} /></button>
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="catalog-results-info">
          {!loading && (
            <span>{totalProducts > 0 ? `${totalProducts} résultat${totalProducts > 1 ? 's' : ''}` : 'Aucun résultat'}</span>
          )}
        </div>

        <div className="catalog-layout">
          <aside className={`catalog-sidebar ${filterOpen ? 'open' : ''}`}>
            <div className="sidebar-header">
              <h3>Catégories</h3>
              <button className="sidebar-close" onClick={() => setFilterOpen(false)}>
                <FiX size={20} />
              </button>
            </div>
            <ul className="category-list">
              <li>
                <button
                  className={!categoryId ? 'active' : ''}
                  onClick={() => handleCategoryClick('')}
                >
                  Tous les livres
                </button>
              </li>
              {categories.map((cat) => (
                <li key={cat.id}>
                  <button
                    className={categoryId == cat.id ? 'active' : ''}
                    onClick={() => handleCategoryClick(cat.id)}
                  >
                    {cat.label}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <div className="catalog-content">
            <ProductGrid products={products} loading={loading} />
            {totalPages > 1 && (
              <Pagination page={page} totalPages={totalPages} onPageChange={handlePageChange} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
