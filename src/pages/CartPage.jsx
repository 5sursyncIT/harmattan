import { Link } from 'react-router-dom';
import { FiTrash2, FiMinus, FiPlus, FiShoppingCart, FiArrowLeft } from 'react-icons/fi';
import useCartStore from '../store/cartStore';
import { formatPrice } from '../utils/formatters';
import { getProductImageUrl } from '../api/dolibarr';
import './CartPage.css';

export default function CartPage() {
  const { items, removeItem, updateQuantity, clearCart, getTotal } = useCartStore();

  if (items.length === 0) {
    return (
      <div className="cart-page">
        <div className="container cart-empty">
          <FiShoppingCart size={64} />
          <h2>Votre panier est vide</h2>
          <p>Découvrez notre catalogue de livres</p>
          <Link to="/catalogue" className="btn btn-primary">
            Parcourir le catalogue
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="cart-page">
      <div className="container">
        <h1>Mon panier</h1>

        <div className="cart-layout">
          <div className="cart-items">
            {items.map((item) => (
              <div key={item.id} className="cart-item">
                <div className="cart-item-image">
                  <img
                    src={getProductImageUrl(item.id, item.label)}
                    alt={item.label}
                    onError={(e) => { e.target.onerror = null; }}
                  />
                </div>
                <div className="cart-item-info">
                  <Link to={`/produit/${item.id}`} className="cart-item-title">{item.label}</Link>
                  <p className="cart-item-ref">{item.ref}</p>
                  <p className="cart-item-price">{formatPrice(item.price_ttc)}</p>
                </div>
                <div className="cart-item-quantity">
                  <button onClick={() => updateQuantity(item.id, item.quantity - 1)}>
                    <FiMinus />
                  </button>
                  <span>{item.quantity}</span>
                  <button onClick={() => updateQuantity(item.id, item.quantity + 1)}>
                    <FiPlus />
                  </button>
                </div>
                <div className="cart-item-subtotal">
                  {formatPrice(parseFloat(item.price_ttc) * item.quantity)}
                </div>
                <button className="cart-item-remove" onClick={() => removeItem(item.id)}>
                  <FiTrash2 />
                </button>
              </div>
            ))}
          </div>

          <div className="cart-summary">
            <h3>Récapitulatif</h3>
            <div className="summary-row">
              <span>Sous-total</span>
              <span>{formatPrice(getTotal())}</span>
            </div>
            <div className="summary-row">
              <span>Livraison</span>
              <span>Calculée à l'étape suivante</span>
            </div>
            <div className="summary-row total">
              <span>Total</span>
              <span>{formatPrice(getTotal())}</span>
            </div>
            <Link to="/commande" className="btn btn-primary btn-lg" style={{ width: '100%' }}>
              Passer la commande
            </Link>
            <button className="btn btn-outline btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={() => { if (confirm('Vider le panier ?')) clearCart(); }}>
              Vider le panier
            </button>
          </div>
        </div>

        <Link to="/catalogue" className="back-link" style={{ marginTop: 24 }}>
          <FiArrowLeft /> Continuer mes achats
        </Link>
      </div>
    </div>
  );
}
