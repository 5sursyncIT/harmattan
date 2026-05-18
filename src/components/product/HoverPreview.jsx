import { useState, useEffect, useRef } from 'react';
import { formatPrice, truncateText } from '../../utils/formatters';
import { getProduct } from '../../api/dolibarr';
import './HoverPreview.css';

export default function HoverPreview({ product, anchorRect }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0, arrowSide: 'left' });
  const [images, setImages] = useState(null); // null = loading, [] = aucune trouvée

  useEffect(() => {
    if (!anchorRect) return;

    let isMounted = true;
    const timeoutId = setTimeout(() => {
      if (!isMounted) return;
      const tooltip = { width: 340, height: 420 };
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let top = anchorRect.top;
      let left = anchorRect.right + 12;
      let arrowSide = 'left';

      if (left + tooltip.width > vw - 12) {
        left = anchorRect.left - tooltip.width - 12;
        arrowSide = 'right';
      }

      if (top + tooltip.height > vh - 8) top = vh - tooltip.height - 8;
      if (top < 8) top = 8;

      setPosition({ top, left, arrowSide });
    }, 10);

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [anchorRect]);

  // Lazy-load la liste des images du produit (recto + verso si dispo)
  useEffect(() => {
    if (!product?.id) return;
    let cancelled = false;
    getProduct(product.id)
      .then((res) => {
        if (cancelled) return;
        setImages(res.data?.images || []);
      })
      .catch(() => {
        if (!cancelled) setImages([]);
      });
    return () => { cancelled = true; };
  }, [product?.id]);

  if (!product) return null;

  const author = product.array_options?.options_auteur;
  const stock = parseInt(product.stock_reel || '0');
  const meta = product.parsed_meta || {};
  const barcode = product.barcode;

  const recto = images && images.length > 0
    ? images[0].url
    : `/api/image/${product.id}?title=${encodeURIComponent(product.label || '')}`;
  const verso = images && images.length > 1 ? images[1].url : null;

  return (
    <div
      className={`hover-preview hover-preview-${position.arrowSide}`}
      ref={ref}
      style={{ top: position.top, left: position.left }}
    >
      <div className={`hp-covers ${verso ? 'hp-covers-two' : 'hp-covers-one'}`}>
        <div className="hp-cover">
          <img src={recto} alt="Recto" loading="lazy" />
          <span className="hp-cover-label">Recto</span>
        </div>
        {verso && (
          <div className="hp-cover">
            <img src={verso} alt="Verso" loading="lazy" />
            <span className="hp-cover-label">Verso</span>
          </div>
        )}
      </div>

      <h4 className="hp-title">{truncateText(product.label || '', 60)}</h4>
      {author && <p className="hp-author">Par {author}</p>}
      <p className="hp-price">{formatPrice(product.price_ttc || product.price || 0)}</p>

      <div className="hp-meta">
        <span className="hp-meta-label">EAN</span>
        <span className="hp-meta-value">{barcode || '—'}</span>

        <span className="hp-meta-label">Pages</span>
        <span className="hp-meta-value">{meta.pages || '—'}</span>

        <span className="hp-meta-label">Année</span>
        <span className="hp-meta-value">{meta.publication_year || '—'}</span>

        <span className="hp-meta-label">Collection</span>
        <span className="hp-meta-value">{product.genre_category || '—'}</span>

        <span className="hp-meta-label">Langue</span>
        <span className="hp-meta-value">{meta.language || 'Français'}</span>
      </div>

      <div className="hp-footer">
        {product.ref && <span className="hp-ref">Réf : {product.ref}</span>}
        <span className={`hp-stock ${stock > 0 ? 'in' : 'out'}`}>
          {stock > 0 ? `En stock (${stock})` : 'Rupture'}
        </span>
      </div>
    </div>
  );
}
