import { useState, useEffect } from 'react';
import { FiPlay, FiExternalLink, FiX, FiClock } from 'react-icons/fi';
import api from '../../api/dolibarr';
import './YouTubeVideos.css';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return 'Hier';
  if (days < 7) return `Il y a ${days} jours`;
  if (days < 30) return `Il y a ${Math.floor(days / 7)} sem.`;
  return `Il y a ${Math.floor(days / 30)} mois`;
}

export default function YouTubeVideos() {
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeVideo, setActiveVideo] = useState(null);
  const [hoveredVideo, setHoveredVideo] = useState(null);

  useEffect(() => {
    // Mesure de performance initiale
    const startTime = performance.now();
    
    api.get('/youtube/videos?limit=5')
      .then((res) => {
        setVideos(res.data);
        // Log de performance (simulé pour l'analytics)
        const loadTime = performance.now() - startTime;
        console.log(`[Analytics] Vidéos chargées en ${Math.round(loadTime)}ms`);
      })
      .catch(() => setVideos([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <section className="yt-section">
        <div className="container">
          <div className="yt-header">
            <div>
              <h2 className="section-title">Nos vidéos</h2>
            </div>
          </div>
          <div className="yt-grid-skeleton">
            <div className="yt-skeleton-main" />
            <div className="yt-skeleton-list">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="yt-skeleton-item" />
              ))}
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (videos.length === 0) return null;

  const featured = videos[0];
  const others = videos.slice(1);

  return (
    <section className="yt-section">
      <div className="container">
        <div className="yt-header">
          <div className="yt-title-wrap">
            <h2 className="section-title">Nos vidéos</h2>
            <p className="yt-subtitle">Découvrez nos dernières interviews, lancements et rencontres littéraires.</p>
          </div>
          <a
            href="https://www.youtube.com/@EditionsLHarmattanS%C3%A9n%C3%A9gal"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-outline yt-channel-btn"
            aria-label="Ouvrir la chaîne YouTube de L'Harmattan Sénégal dans un nouvel onglet"
          >
            Voir la chaîne <FiExternalLink aria-hidden="true" />
          </a>
        </div>

        <div className="yt-immersive-layout">
          {/* Lecteur principal immersif */}
          <article 
            className="yt-main-player" 
            onClick={() => setActiveVideo(featured.id)}
            onMouseEnter={() => setHoveredVideo(featured.id)}
            onMouseLeave={() => setHoveredVideo(null)}
            tabIndex={0}
            role="button"
            aria-label={`Lire la vidéo : ${featured.title}`}
            onKeyDown={(e) => e.key === 'Enter' && setActiveVideo(featured.id)}
          >
            <div className="yt-main-thumb">
              <img 
                src={featured.thumbnail.replace('hqdefault', 'maxresdefault')} 
                alt={featured.title}
                loading="lazy" 
              />
              <div className={`yt-overlay ${hoveredVideo === featured.id ? 'active' : ''}`}>
                <button className="yt-play-huge" aria-label="Lecture" tabIndex={-1}>
                  <FiPlay />
                </button>
              </div>
              <div className="yt-main-meta">
                <span className="yt-badge">À la une</span>
                <span className="yt-time-ago"><FiClock /> {timeAgo(featured.published)}</span>
              </div>
            </div>
            <div className="yt-main-info">
              <h3 className="yt-main-title">{featured.title}</h3>
              {featured.description && (
                <p className="yt-main-desc">{featured.description}</p>
              )}
            </div>
          </article>

          {/* Liste des autres vidéos */}
          <aside className="yt-playlist">
            <h4 className="yt-playlist-title">Dernières publications</h4>
            <div className="yt-playlist-items">
              {others.map((v) => (
                <article 
                  key={v.id} 
                  className="yt-list-item" 
                  onClick={() => setActiveVideo(v.id)}
                  tabIndex={0}
                  role="button"
                  aria-label={`Lire la vidéo : ${v.title}`}
                  onKeyDown={(e) => e.key === 'Enter' && setActiveVideo(v.id)}
                >
                  <div className="yt-list-thumb">
                    <img src={v.thumbnail} alt="" loading="lazy" />
                    <div className="yt-list-play">
                      <FiPlay />
                    </div>
                  </div>
                  <div className="yt-list-info">
                    <h5 className="yt-list-title" title={v.title}>{v.title}</h5>
                    <span className="yt-list-date">{timeAgo(v.published)}</span>
                  </div>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </div>

      {/* Modal Vidéo Responsive */}
      {activeVideo && (
        <div 
          className="yt-modal" 
          onClick={() => setActiveVideo(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Lecteur vidéo"
        >
          <button 
            className="yt-modal-close" 
            aria-label="Fermer la vidéo"
            autoFocus
          >
            <FiX />
          </button>
          <div className="yt-modal-wrapper" onClick={(e) => e.stopPropagation()}>
            <iframe
              src={`https://www.youtube.com/embed/${activeVideo}?autoplay=1&rel=0&modestbranding=1&color=white`}
              title="Lecteur vidéo YouTube"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              loading="lazy"
            />
          </div>
        </div>
      )}
    </section>
  );
}
