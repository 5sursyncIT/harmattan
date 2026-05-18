import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowRight, FiShoppingCart } from 'react-icons/fi';
import { getProductImageUrl } from '../../api/dolibarr';
import { getHomeTagProducts } from '../../api/tags';
import { formatPrice, truncateText } from '../../utils/formatters';
import useCartStore from '../../store/cartStore';
import ProductCarousel from './ProductCarousel';
import HoverPreview from '../product/HoverPreview';
import toast from 'react-hot-toast';
import './TagSection.css';

function TagCard({ product, tagColor }) {
  const addItem = useCartStore((s) => s.addItem);
  const [showHover, setShowHover] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const hoverTimeout = useRef(null);
  const cardRef = useRef(null);

  const hasDiscount = product.discount_pct && product.discount_pct > 0;
  const currentPrice = parseFloat(product.price_ttc || product.price || 0);
  const originalPrice = hasDiscount ? parseFloat(product.price_ttc_original || currentPrice) : null;
  const imageUrl = getProductImageUrl(product.id, product.label);
  const author = product.array_options?.options_auteur || product.author;

  const handleAdd = (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({ id: product.id, ref: product.ref, label: product.label, price_ttc: currentPrice });
    toast.success(`${truncateText(product.label, 25)} ajouté`);
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
        className="tag-card"
        ref={cardRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="tag-card-img">
          <img src={imageUrl} alt={product.label} loading="lazy" />
          {hasDiscount && (
            <span className="tag-card-discount" style={{ background: tagColor }}>
              -{Math.round(product.discount_pct)}%
            </span>
          )}
          <button className="tag-card-cart" onClick={handleAdd} title="Ajouter au panier" aria-label="Ajouter au panier">
            <FiShoppingCart size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="tag-card-info">
          <h4 className="tag-card-title">{truncateText(product.label, 50)}</h4>
          {author && <p className="tag-card-author">{author}</p>}
          <p className="tag-card-price">
            {hasDiscount && originalPrice > currentPrice && (
              <span className="tag-card-price-original">{formatPrice(originalPrice)}</span>
            )}
            <span className={hasDiscount ? 'tag-card-price-current promo' : 'tag-card-price-current'}>
              {formatPrice(currentPrice)}
            </span>
          </p>
        </div>
      </Link>

      {showHover && anchorRect && (
        <HoverPreview product={product} anchorRect={anchorRect} />
      )}
    </>
  );
}

/**
 * Affiche une section de livres d'un tag donné.
 * @param {string} slug      — slug du tag (ex: 'notre_selection')
 * @param {string} title     — titre affiché (ex: 'Notre sélection')
 * @param {string} color     — couleur d'accent
 * @param {number} [max]     — nombre max d'items
 * @param {string} [kicker]  — petite étiquette au-dessus du titre
 */
export default function TagSection({ slug, title, color = '#10531a', max, kicker }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getHomeTagProducts(slug, max)
      .then((res) => setProducts(res.data?.products || []))
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  }, [slug, max]);

  const sectionStyle = { '--tag-accent': color };

  if (loading) {
    return (
      <section className="home-section tag-section" style={sectionStyle}>
        <div className="container">
          <div className="section-header">
            <div className="section-header-left">
              {kicker && <span className="section-kicker">{kicker}</span>}
              <h2 className="section-title">{title}</h2>
            </div>
          </div>
          <div className="tag-skeleton-row">
            {[...Array(5)].map((_, i) => <div key={i} className="tag-skeleton" />)}
          </div>
        </div>
      </section>
    );
  }

  if (products.length === 0) return null;

  return (
    <section className="home-section tag-section" data-slug={slug} style={sectionStyle}>
      <div className="container">
        <div className="section-header">
          <div className="section-header-left">
            {kicker && <span className="section-kicker">{kicker}</span>}
            <h2 className="section-title">{title}</h2>
          </div>
          <Link to={`/catalogue?tag=${slug}`} className="see-all">
            Voir tout <FiArrowRight aria-hidden="true" />
          </Link>
        </div>
        <ProductCarousel itemWidth={200} gap={20}>
          {products.map((p) => (
            <TagCard key={p.id} product={p} tagColor={color} />
          ))}
        </ProductCarousel>
      </div>
    </section>
  );
}
