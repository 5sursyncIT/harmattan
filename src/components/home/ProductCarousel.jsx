import { useRef, useState, useEffect, useCallback } from 'react';
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import './ProductCarousel.css';

export default function ProductCarousel({ children, itemWidth = 220, gap = 20, scrollItems = 2 }) {
  const trackRef = useRef(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll, { passive: true });
    window.addEventListener('resize', checkScroll);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [checkScroll, children]);

  const scroll = (dir) => {
    const el = trackRef.current;
    if (!el) return;
    const amount = (itemWidth + gap) * scrollItems;
    el.scrollBy({ left: dir * amount, behavior: 'smooth' });
  };

  return (
    <div className="product-carousel">
      {canScrollLeft && (
        <button className="carousel-arrow carousel-arrow-left" onClick={() => scroll(-1)} aria-label="Précédent">
          <FiChevronLeft size={22} />
        </button>
      )}
      <div className="carousel-track" ref={trackRef} style={{ gap: `${gap}px` }}>
        {children}
      </div>
      {canScrollRight && (
        <button className="carousel-arrow carousel-arrow-right" onClick={() => scroll(1)} aria-label="Suivant">
          <FiChevronRight size={22} />
        </button>
      )}
    </div>
  );
}
