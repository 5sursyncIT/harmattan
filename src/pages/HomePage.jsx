import { useState, useEffect } from 'react';
import { FiBook, FiTruck, FiShield, FiHeadphones } from 'react-icons/fi';
import { getHomeTags } from '../api/tags';
import HeroCarousel from '../components/home/HeroCarousel';
import TagSection from '../components/home/TagSection';
import UpcomingBooks from '../components/home/UpcomingBooks';
import YouTubeVideos from '../components/home/YouTubeVideos';
import './HomePage.css';

export default function HomePage() {
  const [tags, setTags] = useState([]);

  useEffect(() => {
    getHomeTags()
      .then((res) => setTags(res.data || []))
      .catch(() => setTags([]));
  }, []);

  return (
    <div className="home-page">
      <HeroCarousel />

      <section className="features">
        <div className="container features-grid">
          <div className="feature">
            <FiBook size={28} />
            <div>
              <h4>+6 000 livres</h4>
              <p>Catalogue riche et varié</p>
            </div>
          </div>
          <div className="feature">
            <FiTruck size={28} />
            <div>
              <h4>Livraison rapide</h4>
              <p>Dakar et régions</p>
            </div>
          </div>
          <div className="feature">
            <FiShield size={28} />
            <div>
              <h4>Paiement sécurisé</h4>
              <p>Orange Money, Wave, CB</p>
            </div>
          </div>
          <div className="feature">
            <FiHeadphones size={28} />
            <div>
              <h4>Service client</h4>
              <p>Du lundi au samedi</p>
            </div>
          </div>
        </div>
      </section>

      {/* Sections dynamiques basées sur les tags de curation */}
      {tags.map((t) => (
        <TagSection
          key={t.id}
          slug={t.slug}
          title={t.label}
          color={t.color}
          max={t.max_items}
          kicker={t.description}
        />
      ))}

      <UpcomingBooks />
      <YouTubeVideos />
    </div>
  );
}
