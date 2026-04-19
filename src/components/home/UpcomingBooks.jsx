import { FiArrowRight, FiBookOpen, FiCalendar, FiUser } from 'react-icons/fi';
import { Link } from 'react-router-dom';
import useSiteConfig from '../../hooks/useSiteConfig.jsx';
import './UpcomingBooks.css';

function formatReleaseDate(date) {
  if (!date) return 'Date à confirmer';

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;

  return new Intl.DateTimeFormat('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(parsed);
}

function UpcomingBookCard({ book }) {
  const title = book.title?.trim() || 'Titre à venir';
  const author = book.author?.trim() || 'Auteur à confirmer';
  const summary = book.summary?.trim() || 'Résumé à venir.';
  const releaseDate = formatReleaseDate(book.release_date);
  const detailsLink = book.link?.trim() || '/catalogue';
  const hasCover = Boolean(book.cover?.trim());

  return (
    <article className="upcoming-book-card">
      <div className="upcoming-book-media">
        {hasCover ? (
          <img
            src={book.cover}
            alt={`Couverture de ${title}`}
            className="upcoming-book-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="upcoming-book-cover upcoming-book-cover-placeholder" aria-hidden="true">
            <span>{title.slice(0, 1).toUpperCase()}</span>
          </div>
        )}
      </div>

      <div className="upcoming-book-content">
        <div className="upcoming-book-meta">
          <span className="upcoming-book-badge">À paraître</span>
          <span className="upcoming-book-date">
            <FiCalendar size={15} />
            <time dateTime={book.release_date || undefined}>{releaseDate}</time>
          </span>
        </div>

        <h3 className="upcoming-book-title">{title}</h3>

        <p className="upcoming-book-author">
          <FiUser size={15} />
          <span>{author}</span>
        </p>

        <p className="upcoming-book-summary">{summary}</p>

        <div className="upcoming-book-actions">
          <Link to={detailsLink} className="upcoming-book-link">
            En savoir plus <FiArrowRight size={15} />
          </Link>
        </div>
      </div>
    </article>
  );
}

export default function UpcomingBooks() {
  const config = useSiteConfig();
  const books = Array.isArray(config?.upcoming_books)
    ? config.upcoming_books.filter((book) => book?.title || book?.summary || book?.author)
    : [];

  if (books.length === 0) return null;

  return (
    <section className="upcoming-books-section" aria-labelledby="upcoming-books-title">
      <div className="container">
        <div className="upcoming-books-header">
          <div>
            <p className="upcoming-books-kicker">Agenda éditorial</p>
            <h2 className="section-title" id="upcoming-books-title">Ouvrages à paraître</h2>
            <p className="upcoming-books-subtitle">
              Découvrez les prochaines parutions annoncées par L&apos;Harmattan Sénégal, avec leurs informations clés et leurs dates prévisionnelles de publication.
            </p>
          </div>

          <Link to="/catalogue" className="upcoming-books-all-link">
            Explorer le catalogue <FiBookOpen size={16} />
          </Link>
        </div>

        <div className="upcoming-books-grid" role="list" aria-label="Liste des ouvrages à paraître">
          {books.map((book, index) => (
            <div key={`${book.title || 'ouvrage'}-${index}`} role="listitem">
              <UpcomingBookCard book={book} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
