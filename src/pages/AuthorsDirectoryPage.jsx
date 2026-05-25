import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { FiSearch, FiBook, FiUser } from 'react-icons/fi';
import { authorPublicApi } from '../api/author';
import Breadcrumb from '../components/common/Breadcrumb';
import './AuthorsDirectoryPage.css';

function getInitials(name) {
  return String(name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
}

export default function AuthorsDirectoryPage() {
  const [authors, setAuthors] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    authorPublicApi.list({ q: debouncedQ, limit: 120 })
      .then((res) => {
        if (cancelled) return;
        setAuthors(res.data.authors || []);
        setTotal(res.data.total || 0);
      })
      .catch(() => { if (!cancelled) setAuthors([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQ]);

  // Regroupement alphabétique (par première lettre du nom de famille pour faciliter le scan)
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const a of authors) {
      const key = (a.name || '').trim().split(' ').slice(-1)[0]?.[0]?.toUpperCase() || '#';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, 'fr'));
  }, [authors]);

  return (
    <div className="authors-dir">
      <div className="container">
        <Breadcrumb items={[{ label: 'Accueil', to: '/' }, { label: 'Nos auteurs' }]} />

        <header className="authors-dir-header">
          <h1>Nos auteurs</h1>
          <p className="authors-dir-subtitle">
            Découvrez les voix qui font L'Harmattan Sénégal.
            {total > 0 && <span className="authors-dir-count"> {total} auteur{total > 1 ? 's' : ''} publié{total > 1 ? 's' : ''}</span>}
          </p>
        </header>

        <div className="authors-dir-search">
          <FiSearch />
          <input
            type="search"
            placeholder="Rechercher un auteur par nom…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Rechercher un auteur"
          />
        </div>

        {loading ? (
          <div className="authors-dir-loading">Chargement…</div>
        ) : authors.length === 0 ? (
          <div className="authors-dir-empty">
            <FiUser size={48} />
            <p>{debouncedQ ? `Aucun auteur ne correspond à « ${debouncedQ} ».` : 'Aucun auteur publié pour le moment.'}</p>
          </div>
        ) : (
          <div className="authors-dir-groups">
            {grouped.map(([letter, list]) => (
              <section key={letter} className="authors-dir-group">
                <h2 className="authors-dir-letter">{letter}</h2>
                <div className="authors-dir-grid">
                  {list.map((a) => (
                    <Link
                      key={a.id}
                      to={`/auteur/${a.slug}`}
                      className="author-card"
                    >
                      <div className="author-card-photo">
                        {a.photo_url ? (
                          <img src={a.photo_url} alt={a.name} loading="lazy" />
                        ) : (
                          <span className="author-card-initials">{getInitials(a.name)}</span>
                        )}
                      </div>
                      <div className="author-card-info">
                        <h3>{a.name}</h3>
                        {a.bio_excerpt && <p className="author-card-bio">{a.bio_excerpt}…</p>}
                        <p className="author-card-meta">
                          <FiBook size={12} /> {a.book_count} livre{a.book_count > 1 ? 's' : ''}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
