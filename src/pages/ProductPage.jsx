import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { FiShoppingCart, FiMinus, FiPlus, FiArrowLeft, FiMaximize2, FiMinimize2 } from 'react-icons/fi';
import { createPreorder, getProduct, getProductImageUrl } from '../api/dolibarr';
import { formatPrice, stripHtml } from '../utils/formatters';
import useCartStore from '../store/cartStore';
import useAuthStore from '../store/authStore';
import useSiteConfig from '../hooks/useSiteConfig.jsx';
import Loader from '../components/common/Loader';
import Breadcrumb from '../components/common/Breadcrumb';
import toast from 'react-hot-toast';
import './ProductPage.css';

function getSubtitle(product) {
  return product.array_options?.options_soustitre || null;
}

function getAuthor(product) {
  return product.array_options?.options_auteur || null;
}

function getPublicationDate(product) {
  const raw = product.description || '';
  const match = raw.match(/Date de publication\s*:\s*(.+?)(?:<br|\\n|\n|$)/i);
  if (match) {
    return match[1].replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim();
  }
  return null;
}

function parseReleaseDate(value) {
  if (!value) return null;

  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split('-').map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const slashMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch.map(Number);
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  const months = {
    janvier: 0,
    fevrier: 1,
    mars: 2,
    avril: 3,
    mai: 4,
    juin: 5,
    juillet: 6,
    aout: 7,
    septembre: 8,
    octobre: 9,
    novembre: 10,
    decembre: 11,
  };

  const normalized = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const frenchMatch = normalized.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);

  if (frenchMatch) {
    const day = Number(frenchMatch[1]);
    const monthIndex = months[frenchMatch[2]];
    const year = Number(frenchMatch[3]);
    if (monthIndex !== undefined) {
      return new Date(year, monthIndex, day, 12, 0, 0, 0);
    }
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatReleaseDate(value) {
  const parsed = parseReleaseDate(value);
  if (!parsed) return value || 'Date à confirmer';

  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
}

function isUpcomingRelease(value) {
  const parsed = parseReleaseDate(value);
  if (!parsed) return false;

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return parsed.getTime() > today.getTime();
}

function getMatchingUpcomingBook(config, productId) {
  return (config?.upcoming_books || []).find((book) => {
    const directMatch = String(book?.product_id || '') === String(productId);
    const linkMatch = String(book?.link || '').trim() === `/produit/${productId}`;
    return directMatch || linkMatch;
  }) || null;
}

function getInitialPreorderForm(customer, defaultPaymentMethod) {
  return {
    firstname: customer?.firstname || '',
    lastname: customer?.lastname || customer?.name?.split(' ').slice(1).join(' ') || '',
    email: customer?.email || '',
    phone: customer?.phone || '',
    address: customer?.address || '',
    city: customer?.town || 'Dakar',
    country: 'Sénégal',
    quantity: 1,
    payment_method: defaultPaymentMethod || '',
  };
}

function validatePreorderForm(form) {
  const errors = {};

  if (!form.firstname.trim()) errors.firstname = 'Le prénom est requis';
  if (!form.lastname.trim()) errors.lastname = 'Le nom est requis';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = 'Veuillez saisir une adresse email valide';
  if (form.phone.trim() && form.phone.trim().length < 6) errors.phone = 'Le numéro de téléphone est trop court';
  if (!form.address.trim()) errors.address = 'L’adresse de livraison est requise';
  if (!form.city.trim()) errors.city = 'La ville est requise';
  if (!form.country.trim()) errors.country = 'Le pays est requis';
  if (!Number.isInteger(Number(form.quantity)) || Number(form.quantity) < 1 || Number(form.quantity) > 10) {
    errors.quantity = 'La quantité doit être comprise entre 1 et 10';
  }
  if (!form.payment_method) errors.payment_method = 'Choisissez un moyen de paiement';

  return errors;
}

export default function ProductPage() {
  const { id } = useParams();
  const config = useSiteConfig();
  const { customer } = useAuthStore();
  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [selectedImage, setSelectedImage] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPreorderForm, setShowPreorderForm] = useState(false);
  const [preorderSubmitting, setPreorderSubmitting] = useState(false);
  const [preorderErrors, setPreorderErrors] = useState({});
  const [preorderSuccess, setPreorderSuccess] = useState(null);
  const addItem = useCartStore((s) => s.addItem);
  const paymentMethods = useMemo(
    () => (config?.payment_methods || []).filter((method) => method.enabled),
    [config]
  );
  const defaultPaymentMethod = paymentMethods[0]?.id || '';
  const [preorderForm, setPreorderForm] = useState(() => getInitialPreorderForm(customer, defaultPaymentMethod));

  useEffect(() => {
    let cancelled = false;

    window.scrollTo(0, 0);
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setSelectedImage(0);
        setShowPreorderForm(false);
        setPreorderSuccess(null);
        setPreorderErrors({});
      }
    });

    getProduct(id)
      .then((res) => {
        if (!cancelled) setProduct(res.data);
      })
      .catch((err) => console.error('Error loading product:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    setPreorderForm((current) => ({
      ...getInitialPreorderForm(customer, defaultPaymentMethod),
      quantity: current.quantity || 1,
      payment_method: current.payment_method || defaultPaymentMethod,
    }));
  }, [customer, defaultPaymentMethod]);

  if (loading) return <Loader />;
  if (!product) return <div className="container" style={{ padding: '60px 0', textAlign: 'center' }}>Produit non trouvé.</div>;

  const ref = product.ref || '';
  const label = product.label || 'Sans titre';
  const title = label;
  const subtitle = getSubtitle(product);
  const author = getAuthor(product);
  const price = product.price_ttc || product.price || 0;
  const description = stripHtml(product.description);
  const stock = parseFloat(product.stock_reel || 0);
  const upcomingBook = getMatchingUpcomingBook(config, product.id);
  const publicationDate = upcomingBook?.release_date || getPublicationDate(product);
  const ribbon = product.array_options?.options_livre_du_mois_ribbon;
  const releaseDateLabel = formatReleaseDate(publicationDate);
  const isUpcoming = isUpcomingRelease(publicationDate);
  const preorderDiscountRate = Number(upcomingBook?.preorder_discount_pct || 0);
  const preorderUnitPrice = Math.max(0, Number(price) * (1 - preorderDiscountRate / 100));
  const preorderTotal = preorderUnitPrice * Number(preorderForm.quantity || 1);

  const images = product.images?.length > 0
    ? product.images.map((img) => img.url || getProductImageUrl(product.id, label))
    : [getProductImageUrl(product.id, label)];

  const handleAddToCart = () => {
    addItem({ id: product.id, ref, label, price_ttc: price }, quantity);
    toast.success(`${title} ajouté au panier`);
  };

  const handlePreorderFieldChange = (event) => {
    const { name, value } = event.target;
    setPreorderForm((current) => ({
      ...current,
      [name]: name === 'quantity' ? Math.max(1, Math.min(10, Number(value) || 1)) : value,
    }));
    setPreorderErrors((current) => ({ ...current, [name]: '' }));
  };

  const handlePreorderSubmit = async (event) => {
    event.preventDefault();
    const validationErrors = validatePreorderForm(preorderForm);

    if (Object.keys(validationErrors).length > 0) {
      setPreorderErrors(validationErrors);
      toast.error('Veuillez corriger les champs signalés');
      return;
    }

    setPreorderSubmitting(true);
    setPreorderErrors({});

    try {
      const response = await createPreorder({
        product_id: String(product.id),
        quantity: Number(preorderForm.quantity),
        payment_method: preorderForm.payment_method,
        customer: {
          firstname: preorderForm.firstname.trim(),
          lastname: preorderForm.lastname.trim(),
          email: preorderForm.email.trim(),
          phone: preorderForm.phone.trim(),
          address: preorderForm.address.trim(),
          city: preorderForm.city.trim(),
          country: preorderForm.country.trim(),
        },
      });

      setPreorderSuccess(response.data);
      setShowPreorderForm(false);
      toast.success(`Précommande ${response.data.preorder_ref} enregistrée`);
    } catch (error) {
      const message = error.response?.data?.error || 'Impossible d’enregistrer la précommande';
      const details = error.response?.data?.details || {};
      setPreorderErrors(details);
      toast.error(message);
    } finally {
      setPreorderSubmitting(false);
    }
  };

  return (
    <div className="product-page">
      <div className="container">
        <Breadcrumb items={[
          { label: 'Catalogue', to: '/catalogue' },
          { label: product.label },
        ]} />
        <Link to="/catalogue" className="back-link">
          <FiArrowLeft /> Retour au catalogue
        </Link>

        <div className="product-detail">
          <div className="product-image-section">
            {ribbon && <span className="product-badge">{ribbon}</span>}

            <div className="product-main-image" onClick={() => setFullscreen(true)}>
              <img src={images[selectedImage]} alt={title} />
              <button className="product-zoom-btn" aria-label="Agrandir">
                <FiMaximize2 size={18} />
              </button>
            </div>

            {images.length > 1 && (
              <div className="product-thumbnails">
                {images.map((img, i) => (
                  <button
                    key={i}
                    className={`product-thumb ${selectedImage === i ? 'active' : ''}`}
                    onClick={() => setSelectedImage(i)}
                  >
                    <img src={img} alt={`${title} - vue ${i + 1}`} />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="product-info-section">
            <h1 className="product-title">{title}</h1>

            {subtitle && <p className="product-subtitle">{subtitle}</p>}

            {author && (
              <p className="product-author">
                Par <Link to={`/catalogue?author=${encodeURIComponent(author)}`} className="product-author-link">{author}</Link>
              </p>
            )}

            <p className="product-price">{formatPrice(price)}</p>

            <div className="product-share">
              <span>Partager :</span>
              <a href={`https://wa.me/?text=${encodeURIComponent(`${product.label} — ${formatPrice(price)} sur L'Harmattan Sénégal ${window.location.href}`)}`} target="_blank" rel="noopener noreferrer" className="share-btn whatsapp" title="Partager sur WhatsApp">WhatsApp</a>
              <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(window.location.href)}`} target="_blank" rel="noopener noreferrer" className="share-btn facebook" title="Partager sur Facebook">Facebook</a>
            </div>

            {isUpcoming ? (
              <div className="preorder-panel">
                <div className="preorder-badge">Précommandes ouvertes</div>
                <p className="preorder-copy">
                  Cet ouvrage est annoncé pour le {releaseDateLabel}. Réservez votre exemplaire dès maintenant.
                </p>
                <div className="preorder-price-row">
                  {preorderDiscountRate > 0 ? (
                    <>
                      <span className="preorder-old-price">{formatPrice(price)}</span>
                      <span className="preorder-price">{formatPrice(preorderUnitPrice)}</span>
                      <span className="preorder-discount">-{preorderDiscountRate}%</span>
                    </>
                  ) : (
                    <span className="preorder-price">{formatPrice(preorderUnitPrice)}</span>
                  )}
                </div>

                {!preorderSuccess && (
                  <button
                    className="btn btn-primary btn-lg preorder-toggle"
                    onClick={() => setShowPreorderForm((current) => !current)}
                  >
                    <FiShoppingCart /> {showPreorderForm ? 'Masquer le formulaire' : 'Précommander'}
                  </button>
                )}

                {preorderSuccess && (
                  <div className="preorder-success-box">
                    <strong>Précommande confirmée</strong>
                    <p>Référence : {preorderSuccess.preorder_ref}</p>
                    <p>Montant : {formatPrice(preorderSuccess.total_price_ttc)}</p>
                    <p>Disponibilité estimée : {formatReleaseDate(preorderSuccess.estimated_release_date)}</p>
                  </div>
                )}

                {showPreorderForm && (
                  <form className="preorder-form" onSubmit={handlePreorderSubmit} noValidate>
                    <div className="preorder-grid">
                      <label className="preorder-field">
                        <span>Prénom *</span>
                        <input name="firstname" value={preorderForm.firstname} onChange={handlePreorderFieldChange} />
                        {preorderErrors.firstname && <small>{preorderErrors.firstname}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Nom *</span>
                        <input name="lastname" value={preorderForm.lastname} onChange={handlePreorderFieldChange} />
                        {preorderErrors.lastname && <small>{preorderErrors.lastname}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Email *</span>
                        <input name="email" type="email" value={preorderForm.email} onChange={handlePreorderFieldChange} />
                        {preorderErrors.email && <small>{preorderErrors.email}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Téléphone</span>
                        <input name="phone" value={preorderForm.phone} onChange={handlePreorderFieldChange} />
                        {preorderErrors.phone && <small>{preorderErrors.phone}</small>}
                      </label>
                      <label className="preorder-field preorder-field-full">
                        <span>Adresse de livraison *</span>
                        <input name="address" value={preorderForm.address} onChange={handlePreorderFieldChange} />
                        {preorderErrors.address && <small>{preorderErrors.address}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Ville *</span>
                        <input name="city" value={preorderForm.city} onChange={handlePreorderFieldChange} />
                        {preorderErrors.city && <small>{preorderErrors.city}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Pays *</span>
                        <input name="country" value={preorderForm.country} onChange={handlePreorderFieldChange} />
                        {preorderErrors.country && <small>{preorderErrors.country}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Quantité *</span>
                        <input
                          name="quantity"
                          type="number"
                          min="1"
                          max="10"
                          value={preorderForm.quantity}
                          onChange={handlePreorderFieldChange}
                        />
                        {preorderErrors.quantity && <small>{preorderErrors.quantity}</small>}
                      </label>
                      <label className="preorder-field">
                        <span>Paiement *</span>
                        <select name="payment_method" value={preorderForm.payment_method} onChange={handlePreorderFieldChange}>
                          <option value="">Choisir</option>
                          {paymentMethods.map((method) => (
                            <option key={method.id} value={method.id}>{method.label}</option>
                          ))}
                        </select>
                        {preorderErrors.payment_method && <small>{preorderErrors.payment_method}</small>}
                      </label>
                    </div>

                    <div className="preorder-summary">
                      <span>Total estimé</span>
                      <strong>{formatPrice(preorderTotal)}</strong>
                    </div>

                    <button type="submit" className="btn btn-primary btn-lg preorder-submit" disabled={preorderSubmitting}>
                      {preorderSubmitting ? 'Enregistrement...' : 'Valider la précommande'}
                    </button>
                  </form>
                )}
              </div>
            ) : stock > 0 ? (
              <div className="product-actions">
                <div className="product-stock-info in-stock">
                  {stock <= 5 ? `Plus que ${stock} exemplaire${stock > 1 ? 's' : ''} !` : 'En stock'}
                </div>
                <div className="quantity-selector">
                  <button onClick={() => setQuantity(Math.max(1, quantity - 1))}>
                    <FiMinus />
                  </button>
                  <span>{quantity}</span>
                  <button onClick={() => setQuantity(Math.min(stock, quantity + 1))}>
                    <FiPlus />
                  </button>
                </div>
                <button className="btn btn-primary btn-lg" onClick={handleAddToCart}>
                  <FiShoppingCart /> Ajouter au panier
                </button>
              </div>
            ) : (
              <div className="product-out-of-stock">
                <div className="product-stock-badge">Rupture de stock</div>
                <p>Cet ouvrage est temporairement indisponible. Contactez-nous pour plus d'informations.</p>
                <Link to="/contact" className="btn btn-outline">Nous contacter</Link>
              </div>
            )}

            <div className="product-meta">
              {ref && (
                <div className="meta-item">
                  <span className="meta-label">ISBN</span>
                  <span>{ref}</span>
                </div>
              )}
              {publicationDate && (
                <div className="meta-item">
                  <span className="meta-label">Date de publication</span>
                  <span>{publicationDate}</span>
                </div>
              )}
            </div>

            {description && (
              <div className="product-description">
                <h3>Description</h3>
                <p>{description}</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {fullscreen && (
        <div className="product-fullscreen" onClick={() => setFullscreen(false)}>
          <button className="product-fullscreen-close" aria-label="Fermer">
            <FiMinimize2 size={24} />
          </button>
          <img src={images[selectedImage]} alt={title} onClick={(e) => e.stopPropagation()} />
          {images.length > 1 && (
            <div className="product-fullscreen-thumbs" onClick={(e) => e.stopPropagation()}>
              {images.map((img, i) => (
                <button
                  key={i}
                  className={`product-thumb ${selectedImage === i ? 'active' : ''}`}
                  onClick={() => setSelectedImage(i)}
                >
                  <img src={img} alt={`Vue ${i + 1}`} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
