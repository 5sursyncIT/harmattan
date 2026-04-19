import { useState, lazy, Suspense } from 'react';
import ProductCard from './ProductCard';
import './ProductGrid.css';

const QuickPreview = lazy(() => import('./QuickPreview'));

export default function ProductGrid({ products, loading }) {
  const [previewId, setPreviewId] = useState(null);

  if (loading) {
    return (
      <div className="product-grid">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="product-skeleton">
            <div className="skeleton-image" />
            <div className="skeleton-info">
              <div className="skeleton-line w80" />
              <div className="skeleton-line w60" />
              <div className="skeleton-line w40" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!products || products.length === 0) {
    return (
      <div className="no-products">
        <p>Aucun produit trouvé.</p>
      </div>
    );
  }

  return (
    <>
      <div className="product-grid">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            onQuickPreview={setPreviewId}
          />
        ))}
      </div>

      {previewId && (
        <Suspense fallback={null}>
          <QuickPreview productId={previewId} onClose={() => setPreviewId(null)} />
        </Suspense>
      )}
    </>
  );
}
