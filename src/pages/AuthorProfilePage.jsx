import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { FiBook, FiGlobe, FiTwitter, FiInstagram, FiLinkedin, FiFacebook, FiUser } from 'react-icons/fi';
import { authorPublicApi } from '../api/author';
import { formatPrice } from '../utils/formatters';
import { getProductImageUrl } from '../api/dolibarr';
import Breadcrumb from '../components/common/Breadcrumb';
import Loader from '../components/common/Loader';
import './AuthorProfilePage.css';

function getInitials(name) {
  return String(name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

export default function AuthorProfilePage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setNotFound(false);
    authorPublicApi.profile(slug)
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err) => {
        if (cancelled) return;
        if (err.response?.status === 404) setNotFound(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  if (loading) return <Loader />;
  if (notFound) {
    return (
      <div className="author-profile-empty">
        <div className="container">
          <FiUser size={56} />
          <h2>Auteur introuvable</h2>
          <p>Ce profil n'existe pas ou n'est plus public.</p>
          <button className="btn btn-primary" onClick={() => navigate('/auteurs')}>Voir l'annuaire</button>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const { author, books } = data;

  return (
    <div className="author-profile">
      <div className="container">
        <Breadcrumb items={[
          { label: 'Accueil', to: '/' },
          { label: 'Nos auteurs', to: '/auteurs' },
          { label: author.name },
        ]} />

        <header className="author-profile-header">
          <div className="author-profile-photo">
            {author.photo_url ? (
              <img src={author.photo_url} alt={author.name} />
            ) : (
              <span className="author-profile-initials">{getInitials(author.name)}</span>
            )}
          </div>
          <div className="author-profile-meta">
            <h1>{author.name}</h1>
            <p className="author-profile-tagline">
              <FiBook /> {books.length} livre{books.length > 1 ? 's' : ''} publié{books.length > 1 ? 's' : ''}
            </p>
            <div className="author-profile-socials">
              {author.website && (
                <a href={author.website} target="_blank" rel="noopener noreferrer" title="Site web">
                  <FiGlobe />
                </a>
              )}
              {author.socials?.twitter && (
                <a href={author.socials.twitter} target="_blank" rel="noopener noreferrer" title="Twitter">
                  <FiTwitter />
                </a>
              )}
              {author.socials?.instagram && (
                <a href={author.socials.instagram} target="_blank" rel="noopener noreferrer" title="Instagram">
                  <FiInstagram />
                </a>
              )}
              {author.socials?.linkedin && (
                <a href={author.socials.linkedin} target="_blank" rel="noopener noreferrer" title="LinkedIn">
                  <FiLinkedin />
                </a>
              )}
              {author.socials?.facebook && (
                <a href={author.socials.facebook} target="_blank" rel="noopener noreferrer" title="Facebook">
                  <FiFacebook />
                </a>
              )}
            </div>
          </div>
        </header>

        {author.bio && (
          <section className="author-profile-bio">
            <h2>Biographie</h2>
            <div className="author-profile-bio-text">
              {author.bio.split('\n').map((paragraph, i) => (
                paragraph.trim() ? <p key={i}>{paragraph}</p> : null
              ))}
            </div>
          </section>
        )}

        <section className="author-profile-books">
          <h2>Bibliographie</h2>
          {books.length === 0 ? (
            <p className="author-profile-no-books">Aucun ouvrage référencé pour cet auteur.</p>
          ) : (
            <div className="author-profile-books-grid">
              {books.map((b) => (
                <Link key={b.id} to={`/produit/${b.id}`} className="author-book-card">
                  <div className="author-book-cover">
                    <img
                      src={getProductImageUrl(b.id, b.label)}
                      alt={b.label}
                      loading="lazy"
                      onError={(e) => { e.target.style.display = 'none'; }}
                    />
                  </div>
                  <div className="author-book-info">
                    <h3>{b.label}</h3>
                    {b.subtitle && <p className="author-book-subtitle">{b.subtitle}</p>}
                    <p className="author-book-meta">
                      {b.year ? `${b.year}` : ''}
                      {b.year && b.editor ? ' · ' : ''}
                      {b.editor || ''}
                    </p>
                    <p className="author-book-price">{formatPrice(b.price)}</p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
