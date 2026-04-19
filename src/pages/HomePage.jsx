import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowRight, FiBook, FiTruck, FiShield, FiHeadphones } from 'react-icons/fi';
import { getFeaturedProducts } from '../api/dolibarr';
import ProductGrid from '../components/product/ProductGrid';
import HeroCarousel from '../components/home/HeroCarousel';
import OurSelection from '../components/home/OurSelection';
import BookOfTheMonthSection from '../components/home/BookOfTheMonth';
import UpcomingBooks from '../components/home/UpcomingBooks';
import YouTubeVideos from '../components/home/YouTubeVideos';
import './HomePage.css';

export default function HomePage() {
  const [newProducts, setNewProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const prodRes = await getFeaturedProducts(10);
        setNewProducts(prodRes.data.products || prodRes.data);
      } catch (err) {
        console.error('Error loading home data:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  return (
    <div className="home-page">
      {/* Hero Carousel */}
      <HeroCarousel />

      {/* Features */}
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

      {/* Notre Sélection (carousel) */}
      <OurSelection />

      {/* Livres du mois (carousel) */}
      <BookOfTheMonthSection />

      {/* Nouveautés (grille) */}
      <section className="home-section">
        <div className="container">
          <div className="section-header">
            <h2 className="section-title">Nouveautés</h2>
            <Link to="/catalogue" className="see-all">
              Voir tout <FiArrowRight />
            </Link>
          </div>
          <ProductGrid products={newProducts} loading={loading} />
        </div>
      </section>

      {/* Ouvrages à paraître */}
      <UpcomingBooks />

      {/* YouTube Videos */}
      <YouTubeVideos />
    </div>
  );
}
