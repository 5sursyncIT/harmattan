import { useState, useEffect } from 'react';
import { posSearchProducts } from '../../api/pos';
import usePosCartStore from '../../store/posCartStore';
import { getProductImageUrl } from '../../api/dolibarr';
import './ProductGrid.css';

export default function ProductGrid({ category }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const addItem = usePosCartStore((s) => s.addItem);

  useEffect(() => {
    const loadingTimer = window.setTimeout(() => {
      setLoading(true);
    }, 0);

    posSearchProducts('', category)
      .then((res) => setProducts(res.data))
      .catch(() => setProducts([]))
      .finally(() => {
        clearTimeout(loadingTimer);
        setLoading(false);
      });

    return () => clearTimeout(loadingTimer);
  }, [category]);

  if (loading) {
    return (
      <div className="pos-grid-loading">
        <div className="pos-grid-spinner" />
        <span>Chargement...</span>
      </div>
    );
  }

  if (products.length === 0) {
    return <div className="pos-grid-empty">Aucun produit dans cette catégorie</div>;
  }

  return (
    <div className="pos-product-grid">
      {products.map((p) => (
        <button
          key={p.id}
          className={`pos-product-card ${p.stock_reel <= 0 ? 'out-of-stock' : ''}`}
          onClick={() => addItem(p)}
        >
          <div className="pos-product-media">
            <img
              src={getProductImageUrl(p.id, p.label)}
              alt={p.label}
              className="pos-product-img"
              loading="lazy"
            />
          </div>
          <div className="pos-product-info">
            <span className="pos-product-ref">{p.ref}</span>
            <span className="pos-product-label">{p.label}</span>
            <div className="pos-product-meta">
              <span className="pos-product-price">
                {parseInt(p.price_ttc).toLocaleString('fr-FR')} F
              </span>
              <span className={`pos-product-stock ${p.stock_reel > 0 ? 'in' : 'out'}`}>
                {p.stock_reel > 0 ? `${p.stock_reel} en stock` : 'Indisponible'}
              </span>
            </div>
          </div>
          {p.stock_reel <= 0 && <span className="pos-product-badge-out">Rupture</span>}
          {p.stock_reel > 0 && p.stock_reel <= 3 && (
            <span className="pos-product-badge-low">{p.stock_reel} restant(s)</span>
          )}
        </button>
      ))}
    </div>
  );
}
