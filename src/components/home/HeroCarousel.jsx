import { Swiper, SwiperSlide } from 'swiper/react';
import { Autoplay, Navigation, Pagination, EffectFade } from 'swiper/modules';
import { Link } from 'react-router-dom';
import { FiArrowRight } from 'react-icons/fi';
import useSiteConfig from '../../hooks/useSiteConfig.jsx';
import 'swiper/css';
import 'swiper/css/navigation';
import 'swiper/css/pagination';
import 'swiper/css/effect-fade';
import './HeroCarousel.css';

const defaultSlides = [
  { id: 1, image: '/images/slider/slide3.jpg', title: "Bienvenue chez L'Harmattan Sénégal", subtitle: 'Plus de 6 000 ouvrages africains et internationaux à Dakar', link: '/catalogue', btnPrimary: 'Découvrir le catalogue' },
];

export default function HeroCarousel() {
  const config = useSiteConfig();
  const slides = config?.hero_slides?.length > 0 ? config.hero_slides : defaultSlides;

  return (
    <div className="hero-carousel">
      <Swiper
        modules={[Autoplay, Navigation, Pagination, EffectFade]}
        effect="fade"
        fadeEffect={{ crossFade: true }}
        autoplay={{ delay: 5000, disableOnInteraction: false }}
        navigation
        pagination={{ clickable: true }}
        loop
        speed={800}
      >
        {slides.map((slide) => (
          <SwiperSlide key={slide.id}>
            {slide.isBanner ? (
              <Link to={slide.link} className="slide slide-banner">
                <img src={slide.image} alt={slide.title} className="slide-image" />
              </Link>
            ) : (
              <div className="slide">
                {slide.image ? (
                  <>
                    <img src={slide.image} alt={slide.title} className="slide-image" />
                    <div className="slide-image-overlay" />
                  </>
                ) : (
                  <div className="slide-gradient" style={{ background: slide.bgGradient }} />
                )}

                <div className="slide-content">
                  {!slide.image && (
                    <div className="slide-logo">
                      <span className="logo-mark">Sen</span>
                      <span className="logo-name">Harmattan</span>
                    </div>
                  )}
                  <h2>{slide.title}</h2>
                  {slide.subtitle && <p>{slide.subtitle}</p>}
                  {slide.btnPrimary && (
                    <div className="slide-actions">
                      <Link to={slide.link} className="slide-btn slide-btn-primary">
                        {slide.btnPrimary} <FiArrowRight size={16} />
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            )}
          </SwiperSlide>
        ))}
      </Swiper>
    </div>
  );
}
