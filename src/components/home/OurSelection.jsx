import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowRight, FiShoppingCart } from 'react-icons/fi';
import { getProducts, getProductImageUrl } from '../../api/dolibarr';
import { formatPrice, truncateText } from '../../utils/formatters';
import useCartStore from '../../store/cartStore';
import ProductCarousel from './ProductCarousel';
import toast from 'react-hot-toast';
import './OurSelection.css';

function SelectionCard({ product }) {
  const addItem = useCartStore((s) => s.addItem);
  const price = parseFloat(product.price_ttc || product.price || 0);
  const imageUrl = getProductImageUrl(product.id, product.label);
  const author = product.array_options?.options_auteur;

  const handleAdd = (e) => {
    e.preventDefault();
    e.stopPropagation();
    addItem({ id: product.id, ref: product.ref, label: product.label, price_ttc: price });
    toast.success(`${truncateText(product.label, 25)} ajouté`);
  };

  return (
    <Link to={`/produit/${product.id}`} className="selection-card">
      <div className="selection-card-img">
        <img src={imageUrl} alt={product.label} loading="lazy" />
        <button className="selection-card-cart" onClick={handleAdd} title="Ajouter au panier">
          <FiShoppingCart size={16} />
        </button>
      </div>
      <div className="selection-card-info">
        <h4 className="selection-card-title">{truncateText(product.label, 50)}</h4>
        {author && <p className="selection-card-author">{author}</p>}
        <p className="selection-card-price">{formatPrice(price)}</p>
      </div>
    </Link>
  );
}

export default function OurSelection() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProducts({ limit: 12, sort: 't.rowid', order: 'DESC', with_cover: '1' })
      .then((res) => setProducts(res.data?.products || []))
      .catch(() => setProducts([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <section className="home-section selection-section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Notre Sélection</h2>
          </div>
          <div className="selection-skeleton-row">
            {[...Array(5)].map((_, i) => <div key={i} className="selection-skeleton" />)}
          </div>
        </div>
      </section>
    );
  }

  if (products.length === 0) return null;

  return (
    <section className="home-section selection-section">
      <div className="container">
        <div className="section-header">
          <h2 className="section-title">Notre Sélection</h2>
          <Link to="/catalogue" className="see-all">
            Voir tout <FiArrowRight />
          </Link>
        </div>
        <ProductCarousel itemWidth={200} gap={20}>
          {products.map((p) => (
            <SelectionCard key={p.id} product={p} />
          ))}
        </ProductCarousel>
      </div>
    </section>
  );
}
