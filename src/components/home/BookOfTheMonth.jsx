import { useEffect, useState } from 'react';
import { FiArrowRight, FiChevronLeft, FiChevronRight, FiShoppingCart, FiStar, FiUser } from 'react-icons/fi';
import { Link } from 'react-router-dom';
import { getBooksOfTheMonth, getProductImageUrl } from '../../api/dolibarr';
import useCartStore from '../../store/cartStore';
import { formatPrice, stripHtml, truncateText } from '../../utils/formatters';
import toast from 'react-hot-toast';
import './BookOfTheMonth.css';

const getAuthorName = (book) =>
  book.author || book.array_options?.options_auteur || 'Auteur à découvrir';

const getBookSummary = (book) => {
  const summary = stripHtml(book.description || '');
  return summary || 'Un ouvrage mis à l’honneur par L’Harmattan Sénégal ce mois-ci.';
};

export default function BookOfTheMonthSection() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const addItem = useCartStore((s) => s.addItem);

  useEffect(() => {
    let cancelled = false;

    getBooksOfTheMonth()
      .then((res) => {
        if (cancelled) return;
        const items = Array.isArray(res.data) ? res.data : [];
        setBooks(items);
        setActiveIndex(0);
      })
      .catch(() => {
        if (!cancelled) setBooks([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const activeBook = books[activeIndex] || books[0] || null;

  const goToBook = (direction) => {
    if (books.length <= 1) return;
    setActiveIndex((current) => (current + direction + books.length) % books.length);
  };

  const handleAddToCart = (book) => {
    const price = parseFloat(book.price_ttc || book.price || 0);
    addItem({
      id: book.id,
      label: book.label,
      price_ttc: price,
      ref: book.ref,
    });
    toast.success('Ajouté au panier');
  };

  if (loading) {
    return (
      <section className="home-section botm-section">
        <div className="container">
          <div className="botm-header">
            <h2 className="section-title">Livres du mois</h2>
          </div>
          <div className="botm-skeleton-hero" />
        </div>
      </section>
    );
  }

  if (books.length === 0) return null;

  const author = getAuthorName(activeBook);
  const summary = getBookSummary(activeBook);
  const price = formatPrice(activeBook.price_ttc || activeBook.price || 0);
  const imageUrl = getProductImageUrl(activeBook.id, activeBook.label);

  return (
    <section className="home-section botm-section" aria-labelledby="book-of-the-month-title">
      <div className="container">
        <div className="botm-header">
          <div>
            <p className="botm-kicker">Sélection éditoriale</p>
            <h2 className="section-title" id="book-of-the-month-title">Livres du mois</h2>
          </div>
          <Link to="/catalogue" className="see-all">
            Voir tout <FiArrowRight />
          </Link>
        </div>

        <article className="botm-hero" aria-live="polite">
          <div className="botm-hero-media">
            <div className="botm-book-cover">
              <img
                src={imageUrl}
                alt={`Couverture de ${activeBook.label}`}
                loading="eager"
                fetchPriority="high"
                decoding="async"
              />
            </div>
          </div>

          <div className="botm-hero-copy">
            <div className="botm-hero-topline">
              {activeBook.category && <span className="botm-category-pill">{activeBook.category}</span>}
              <span className="botm-rating-mini">
                {[...Array(5)].map((_, i) => <FiStar key={i} size={12} fill="currentColor" />)}
                <span>Coup de cœur éditorial</span>
              </span>
            </div>

            <h3 className="botm-book-title">{activeBook.label}</h3>

            <div className="botm-book-meta">
              <span><FiUser size={14} /> {author}</span>
              <span className="botm-price">{price}</span>
            </div>

            <p className="botm-summary">{truncateText(summary, 180)}</p>

            <div className="botm-book-actions">
              <Link to={`/produit/${activeBook.id}`} className="botm-btn-details">
                Voir la fiche
              </Link>
              <button
                type="button"
                className="botm-btn-buy"
                onClick={() => handleAddToCart(activeBook)}
                aria-label={`Acheter ${activeBook.label}`}
              >
                <FiShoppingCart size={14} /> Acheter
              </button>
            </div>
          </div>
        </article>

        {books.length > 1 && (
          <div className="botm-nav-strip" role="tablist" aria-label="Autres livres du mois">
            <button
              type="button"
              className="botm-nav-arrow"
              onClick={() => goToBook(-1)}
              aria-label="Livre précédent"
            >
              <FiChevronLeft size={18} />
            </button>

            <div className="botm-thumbs">
              {books.map((book, index) => {
                const isActive = index === activeIndex;
                return (
                  <button
                    key={book.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`botm-thumb${isActive ? ' is-active' : ''}`}
                    onClick={() => setActiveIndex(index)}
                    title={book.label}
                  >
                    <img
                      src={getProductImageUrl(book.id, book.label)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      aria-hidden="true"
                    />
                    <span className="botm-thumb-info">
                      <strong>{truncateText(book.label, 36)}</strong>
                      <small>{getAuthorName(book)}</small>
                    </span>
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="botm-nav-arrow"
              onClick={() => goToBook(1)}
              aria-label="Livre suivant"
            >
              <FiChevronRight size={18} />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
