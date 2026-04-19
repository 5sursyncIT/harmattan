import { useState, useEffect, useRef } from 'react';
import { formatPrice, truncateText } from '../../utils/formatters';
import './HoverPreview.css';

export default function HoverPreview({ product, anchorRect }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0, arrowSide: 'left' });

  useEffect(() => {
    if (!anchorRect) return;

    let isMounted = true;
    const timeoutId = setTimeout(() => {
      if (!isMounted) return;
      const tooltip = { width: 320, height: 340 };
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

  if (!product) return null;

  const author = product.array_options?.options_auteur;
  const stock = parseInt(product.stock_reel || '0');
  const meta = product.parsed_meta || {};
  const barcode = product.barcode;

  return (
    <div
      className={`hover-preview hover-preview-${position.arrowSide}`}
      ref={ref}
      style={{ top: position.top, left: position.left }}
    >
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
