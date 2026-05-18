import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiSearch, FiArrowRight, FiStar, FiCalendar, FiFileText } from 'react-icons/fi';
import { getNews } from '../api/dolibarr';
import './ActualitesPage.css';

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch {
    return '';
  }
}

function CardSkeleton() {
  return (
    <div className="act-card" aria-hidden="true">
      <div className="act-card-cover" style={{ background: '#e5e7eb' }} />
      <div className="act-card-body">
        <div style={{ height: 10, width: '40%', background: '#e5e7eb', borderRadius: 6, marginBottom: 10 }} />
        <div style={{ height: 16, width: '80%', background: '#e5e7eb', borderRadius: 6, marginBottom: 10 }} />
        <div style={{ height: 12, width: '95%', background: '#e5e7eb', borderRadius: 6, marginBottom: 6 }} />
        <div style={{ height: 12, width: '70%', background: '#e5e7eb', borderRadius: 6 }} />
      </div>
    </div>
  );
}

export default function ActualitesPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Tous');

  useEffect(() => {
    getNews()
      .then((res) => setItems(res.data || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category).filter(Boolean));
    return ['Tous', ...Array.from(set).sort((a, b) => a.localeCompare(b, 'fr'))];
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (category !== 'Tous' && i.category !== category) return false;
      if (!q) return true;
      const hay = [i.title, i.excerpt, i.category, i.content].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, query, category]);

  return (
    <div className="act-page">
      <section className="act-hero">
        <div className="container">
          <span className="act-kicker">Actualités</span>
          <h1>Toute l'actualité de L'Harmattan Sénégal</h1>
          <p className="act-hero-subtitle">
            Communiqués, lancements, partenariats, prix littéraires et coulisses : suivez toutes les nouvelles de la maison d'édition au fil de l'eau.
          </p>
        </div>
      </section>

      <section className="act-content">
        <div className="container">
          <div className="act-toolbar">
            <div className="act-search">
              <FiSearch size={16} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher une actualité…"
                aria-label="Rechercher"
              />
            </div>
            <div className="act-filters" role="group" aria-label="Filtrer par rubrique">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`act-chip ${category === cat ? 'active' : ''}`}
                  onClick={() => setCategory(cat)}
                  aria-pressed={category === cat}
                >
                  {cat}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="act-grid">
              <CardSkeleton /><CardSkeleton /><CardSkeleton />
            </div>
          ) : filtered.length === 0 ? (
            <div className="act-empty">
              <h2 style={{ margin: '0 0 8px', fontSize: '1.2rem' }}>
                {items.length === 0 ? 'Aucune actualité pour le moment' : 'Aucun résultat'}
              </h2>
              <p style={{ margin: 0 }}>
                {items.length === 0
                  ? 'Revenez bientôt pour découvrir nos prochaines nouvelles.'
                  : 'Essayez un autre mot-clé ou réinitialisez le filtre.'}
              </p>
            </div>
          ) : (
            <div className="act-grid">
              {filtered.map((item) => (
                <Link key={item.id} to={`/actualites/${item.slug}`} className="act-card">
                  <div className="act-card-cover">
                    {item.cover_image ? (
                      <img src={item.cover_image} alt="" loading="lazy" />
                    ) : (
                      <div className="act-card-cover-placeholder">
                        <FiFileText size={36} />
                      </div>
                    )}
                    {item.pinned && (
                      <span className="act-card-pin"><FiStar size={11} /> Épinglé</span>
                    )}
                  </div>
                  <div className="act-card-body">
                    <div className="act-card-meta">
                      {item.category && <span className="act-card-category">{item.category}</span>}
                      {item.published_at && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <FiCalendar size={12} /> {formatDate(item.published_at)}
                        </span>
                      )}
                    </div>
                    <h3>{item.title}</h3>
                    {item.excerpt && <p>{item.excerpt}</p>}
                    <span className="act-card-link">
                      Lire la suite <FiArrowRight size={14} />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
