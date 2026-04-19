import { useState, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiShoppingCart, FiEye } from 'react-icons/fi';
import { formatPrice, stripHtml, truncateText } from '../../utils/formatters';
import { getProductImageUrl } from '../../api/dolibarr';
import useCartStore from '../../store/cartStore';
import toast from 'react-hot-toast';
import HoverPreview from './HoverPreview';
import './ProductCard.css';

const getInitials = (text) =>
  text
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');

const getPlaceholderColor = (text) => {
  const colors = [
    ['#10531a', '#e8f5ea'],
    ['#0b2b5e', '#e8edf8'],
    ['#7c2d12', '#fef3ee'],
    ['#1e3a5f', '#eaf1fb'],
    ['#4a1d96', '#f3eeff'],
    ['#134e4a', '#e6faf9'],
  ];
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = text.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
};

export default function ProductCard({ product, onQuickPreview }) {
  const addItem = useCartStore((s) => s.addItem);
  const [imgError, setImgError] = useState(false);
  const [showHover, setShowHover] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const hoverTimeout = useRef(null);
  const cardRef = useRef(null);

  const ref = product.ref || '';
  const label = product.label || 'Sans titre';
  const price = product.price_ttc || product.price || 0;
  const description = stripHtml(product.description);
  const imageUrl = getProductImageUrl(product.id, label);
  const [bgColor, textColor] = getPlaceholderColor(label);

  const handleAddToCart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({
      id: product.id,
      ref,
      label,
      price_ttc: price,
    });
    toast.success(`${truncateText(label, 30)} ajouté au panier`);
  };

  const handleQuickPreview = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onQuickPreview) onQuickPreview(product.id);
  };

  const handleMouseEnter = useCallback(() => {
    hoverTimeout.current = setTimeout(() => {
      if (cardRef.current) {
        setAnchorRect(cardRef.current.getBoundingClientRect());
        setShowHover(true);
      }
    }, 400);
  }, []);

  const handleMouseLeave = useCallback(() => {
    clearTimeout(hoverTimeout.current);
    setShowHover(false);
  }, []);

  return (
    <>
      <Link
        to={`/produit/${product.id}`}
        className="product-card"
        ref={cardRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="product-card-image">
          {imgError ? (
            <div
              className="product-card-img-fallback"
              style={{ background: bgColor }}
              aria-label={label}
            >
              <span className="product-card-img-initials" style={{ color: textColor }}>
                {getInitials(label)}
              </span>
              <span className="product-card-img-label" style={{ color: textColor }}>
                {truncateText(label, 40)}
              </span>
            </div>
          ) : (
            <img
              src={imageUrl}
              alt={label}
              onError={() => setImgError(true)}
              loading="lazy"
            />
          )}
          <div className="product-card-overlay-btns">
            {onQuickPreview && (
              <button
                className="product-card-quick-btn"
                onClick={handleQuickPreview}
                title="Aperçu rapide"
                aria-label={`Aperçu rapide de ${label}`}
              >
                <FiEye size={16} />
              </button>
            )}
            <button
              className="product-card-cart-btn product-card-cart-btn-desktop"
              onClick={handleAddToCart}
              title="Ajouter au panier"
              aria-label={`Ajouter ${label} au panier`}
            >
              <FiShoppingCart size={16} />
            </button>
          </div>
        </div>
        <div className="product-card-info">
          <h3 className="product-card-title">{label}</h3>
          {product.array_options?.options_auteur && (
            <p className="product-card-author">{product.array_options.options_auteur}</p>
          )}
          {description && (
            <p className="product-card-desc">{truncateText(description, 80)}</p>
          )}
          <div className="product-card-footer">
            <p className="product-card-ref">{ref}</p>
            <p className="product-card-price">{formatPrice(price)}</p>
          </div>
          <button
            className="product-card-cart-btn-mobile"
            onClick={handleAddToCart}
            aria-label={`Ajouter ${label} au panier`}
          >
            <FiShoppingCart size={14} /> Ajouter au panier
          </button>
        </div>
      </Link>

      {showHover && anchorRect && (
        <HoverPreview
          product={product}
          anchorRect={anchorRect}
        />
      )}
    </>
  );
}
