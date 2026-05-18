import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FiArrowLeft, FiCalendar, FiFileText } from 'react-icons/fi';
import { getNewsArticleBySlug } from '../api/dolibarr';
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

const URL_REGEX = /(https?:\/\/[^\s<>"]+)/g;

function renderContent(text = '') {
  const paragraphs = String(text).split(/\n{2,}/);
  return paragraphs.map((para, pIdx) => {
    const lines = para.split('\n');
    return (
      <p key={pIdx}>
        {lines.map((line, lIdx) => {
          const parts = [];
          let last = 0;
          let match;
          URL_REGEX.lastIndex = 0;
          while ((match = URL_REGEX.exec(line)) !== null) {
            if (match.index > last) parts.push(line.slice(last, match.index));
            parts.push(
              <a key={`${pIdx}-${lIdx}-${match.index}`} href={match[0]} target="_blank" rel="noopener noreferrer">
                {match[0]}
              </a>
            );
            last = match.index + match[0].length;
          }
          if (last < line.length) parts.push(line.slice(last));
          return (
            <span key={lIdx}>
              {parts}
              {lIdx < lines.length - 1 && <br />}
            </span>
          );
        })}
      </p>
    );
  });
}

export default function ActualiteDetailPage() {
  const { slug } = useParams();
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    getNewsArticleBySlug(slug)
      .then((res) => setArticle(res.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [slug]);

  const content = useMemo(() => (article ? renderContent(article.content) : null), [article]);

  if (loading) {
    return (
      <div className="act-detail">
        <div className="container">
          <p>Chargement…</p>
        </div>
      </div>
    );
  }

  if (error || !article) {
    return (
      <div className="act-detail">
        <div className="container">
          <Link to="/actualites" className="act-detail-back">
            <FiArrowLeft size={16} /> Retour aux actualités
          </Link>
          <div className="act-empty">
            <h2 style={{ margin: '0 0 8px' }}>Actualité introuvable</h2>
            <p style={{ margin: 0 }}>
              Cette actualité n'existe plus ou n'a pas encore été publiée.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <article className="act-detail">
      <div className="container" style={{ maxWidth: 880 }}>
        <Link to="/actualites" className="act-detail-back">
          <FiArrowLeft size={16} /> Retour aux actualités
        </Link>

        {article.cover_image ? (
          <img className="act-detail-cover" src={article.cover_image} alt="" />
        ) : (
          <div
            className="act-detail-cover"
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 220 }}
          >
            <FiFileText size={48} color="#94a3b8" />
          </div>
        )}

        <div className="act-detail-meta">
          {article.category && <span className="act-card-category">{article.category}</span>}
          {article.published_at && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FiCalendar size={13} /> {formatDate(article.published_at)}
            </span>
          )}
        </div>

        <h1>{article.title}</h1>

        {article.excerpt && (
          <p style={{ fontSize: '1.15rem', color: '#475569', lineHeight: 1.6, marginBottom: 28 }}>
            {article.excerpt}
          </p>
        )}

        <div className="act-detail-content">
          {content}
        </div>
      </div>
    </article>
  );
}
