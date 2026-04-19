import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiX, FiShoppingCart, FiPlus, FiMinus, FiExternalLink } from 'react-icons/fi';
import { getProduct, getProductImageUrl } from '../../api/dolibarr';
import { formatPrice, stripHtml, truncateText } from '../../utils/formatters';
import useCartStore from '../../store/cartStore';
import toast from 'react-hot-toast';
import './QuickPreview.css';

export default function QuickPreview({ productId, onClose }) {
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [imgError, setImgError] = useState(false);
  const addItem = useCartStore((s) => s.addItem);

  useEffect(() => {
    if (!productId) return;
    let cancelled = false;

    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setQuantity(1);
        setImgError(false);
      }
    });

    getProduct(productId)
      .then((res) => {
        if (!cancelled) setProduct(res.data);
      })
      .catch(() => {
        if (!cancelled) setProduct(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [productId]);

  useEffect(() => {
    const handleEsc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handleEsc);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const handleAddToCart = () => {
    if (!product) return;
    addItem({
      id: product.id,
      ref: product.ref || '',
      label: product.label || 'Sans titre',
      price_ttc: product.price_ttc || product.price || 0,
    }, quantity);
    toast.success(`${truncateText(product.label, 30)} ajouté au panier`);
    onClose();
  };

  const label = product?.label || 'Sans titre';
  const price = product?.price_ttc || product?.price || 0;
  const description = stripHtml(product?.description);
  const author = product?.array_options?.options_auteur;
  const stock = parseInt(product?.stock_reel || '0');
  const inStock = stock > 0;

  return (
    <div className="qp-overlay" onClick={onClose}>
      <div className="qp-modal" onClick={(e) => e.stopPropagation()}>
        <button className="qp-close" onClick={onClose} aria-label="Fermer">
          <FiX size={20} />
        </button>

        {loading ? (
          <div className="qp-loading">
            <div className="qp-loading-image" />
            <div className="qp-loading-info">
              <div className="skeleton-line w80" />
              <div className="skeleton-line w60" />
              <div className="skeleton-line w40" />
              <div className="skeleton-line w80" />
              <div className="skeleton-line w60" />
            </div>
          </div>
        ) : !product ? (
          <div className="qp-error">Produit introuvable</div>
        ) : (
          <div className="qp-content">
            <div className="qp-image">
              {imgError ? (
                <div className="qp-image-placeholder">
                  <span>{label.charAt(0)}</span>
                </div>
              ) : (
                <img
                  src={getProductImageUrl(product.id, label)}
                  alt={label}
                  onError={() => setImgError(true)}
                />
              )}
            </div>
            <div className="qp-info">
              <h2 className="qp-title">{label}</h2>
              {author && <p className="qp-author">Par {author}</p>}
              <p className="qp-price">{formatPrice(price)}</p>

              <div className={`qp-stock ${inStock ? 'in-stock' : 'out-of-stock'}`}>
                {inStock ? `En stock (${stock})` : 'Rupture de stock'}
              </div>

              {product.ref && (
                <div className="qp-meta">
                  <span>Réf : {product.ref}</span>
                  {product.barcode && <span>ISBN : {product.barcode}</span>}
                </div>
              )}

              {description && (
                <div className="qp-description">
                  <p>{truncateText(description, 300)}</p>
                </div>
              )}

              {inStock && (
                <div className="qp-actions">
                  <div className="qp-quantity">
                    <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} aria-label="Moins">
                      <FiMinus size={14} />
                    </button>
                    <span>{quantity}</span>
                    <button onClick={() => setQuantity((q) => Math.min(stock, q + 1))} aria-label="Plus">
                      <FiPlus size={14} />
                    </button>
                  </div>
                  <button className="qp-add-cart" onClick={handleAddToCart}>
                    <FiShoppingCart size={16} /> Ajouter au panier
                  </button>
                </div>
              )}

              <Link to={`/produit/${product.id}`} className="qp-view-full" onClick={onClose}>
                Voir la fiche complète <FiExternalLink size={14} />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
