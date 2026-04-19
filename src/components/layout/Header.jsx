import { useState, useRef } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { FiSearch, FiShoppingCart, FiUser, FiMenu, FiX, FiFacebook, FiYoutube, FiLinkedin } from 'react-icons/fi';
import { FaXTwitter } from 'react-icons/fa6';
import useCartStore from '../../store/cartStore';
import useAuthStore from '../../store/authStore';
import useSiteConfig from '../../hooks/useSiteConfig.jsx';
import { getProductImageUrl } from '../../api/dolibarr';
import api from '../../api/dolibarr';
import './Header.css';

const getNavClass = ({ isActive }) => isActive ? 'active' : undefined;

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchTimer = useRef(null);
  const navigate = useNavigate();
  const itemCount = useCartStore((s) => s.getItemCount());
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const config = useSiteConfig();
  const social = config?.social || {};

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/catalogue?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery('');
      setSuggestions([]);
      setShowSuggestions(false);
      setSearchOpen(false);
      setMenuOpen(false);
    }
  };

  const handleSearchInput = (e) => {
    const val = e.target.value;
    setSearchQuery(val);
    clearTimeout(searchTimer.current);
    if (val.trim().length < 2) { setSuggestions([]); setShowSuggestions(false); return; }
    searchTimer.current = setTimeout(() => {
      api.get('/search/suggest', { params: { q: val.trim() } })
        .then((res) => {
          setSuggestions(res.data || []);
          setShowSuggestions(true);
        })
        .catch(() => setSuggestions([]));
    }, 300);
  };

  const handleSelectSuggestion = (product) => {
    navigate(`/produit/${product.id}`);
    setSearchQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    setSearchOpen(false);
  };

  const closeMenu = () => setMenuOpen(false);

  return (
    <header className="header">
      <div className="header-main">
        <div className="container header-main-inner">
          <button className="menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
            {menuOpen ? <FiX size={24} /> : <FiMenu size={24} />}
          </button>

          <Link to="/" className="logo">
            <img src="/images/logo.png" alt="L'Harmattan Sénégal" className="logo-img" />
          </Link>

          <nav className={`header-nav ${menuOpen ? 'open' : ''}`} aria-label="Navigation principale">
            <ul className="nav-links">
              <li><NavLink to="/" end className={getNavClass} onClick={closeMenu}>Accueil</NavLink></li>
              <li><NavLink to="/catalogue" className={getNavClass} onClick={closeMenu}>Catalogue</NavLink></li>
              <li><NavLink to="/se-faire-editer" className={getNavClass} onClick={closeMenu}>Se faire éditer</NavLink></li>
              <li><NavLink to="/evenements" className={getNavClass} onClick={closeMenu}>Actualités</NavLink></li>
              <li><NavLink to="/contact" className={getNavClass} onClick={closeMenu}>Contacts</NavLink></li>
            </ul>
          </nav>

          <div className="header-actions">
            <div className="header-socials">
              {social.facebook && <a href={social.facebook} target="_blank" rel="noopener noreferrer" aria-label="Facebook"><FiFacebook size={16} /></a>}
              {social.youtube && <a href={social.youtube} target="_blank" rel="noopener noreferrer" aria-label="YouTube"><FiYoutube size={16} /></a>}
              {social.twitter && <a href={social.twitter} target="_blank" rel="noopener noreferrer" aria-label="X"><FaXTwitter size={16} /></a>}
              {social.linkedin && <a href={social.linkedin} target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><FiLinkedin size={16} /></a>}
            </div>

            <button
              className="header-action-btn search-toggle"
              onClick={() => setSearchOpen(!searchOpen)}
              aria-label="Rechercher"
            >
              <FiSearch size={18} />
            </button>

            <Link
              to={isAuthenticated ? '/compte' : '/connexion'}
              className="header-action-btn"
              aria-label="Mon compte"
            >
              <FiUser size={18} />
              <span className="header-action-label">Mon compte</span>
            </Link>

            <Link
              to="/panier"
              className="header-action-btn cart-btn"
              aria-label={`Panier (${itemCount} article${itemCount !== 1 ? 's' : ''})`}
            >
              <FiShoppingCart size={18} />
              {itemCount > 0 && <span className="cart-badge">{itemCount}</span>}
              <span className="header-action-label">Mon panier</span>
            </Link>
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="header-search-bar">
          <div className="container">
            <form className="header-search" onSubmit={handleSearch}>
              <input
                type="text"
                placeholder="Rechercher un livre, un auteur..."
                value={searchQuery}
                onChange={handleSearchInput}
                aria-label="Rechercher"
                autoFocus
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              />
              <button type="submit" aria-label="Lancer la recherche"><FiSearch size={18} /></button>
              <button type="button" className="search-close" onClick={() => { setSearchOpen(false); setSuggestions([]); }} aria-label="Fermer">
                <FiX size={18} />
              </button>
            </form>
            {showSuggestions && suggestions.length > 0 && (
              <div className="search-suggestions">
                {suggestions.map((p) => (
                  <button key={p.id} className="search-suggestion" onClick={() => handleSelectSuggestion(p)}>
                    <img src={getProductImageUrl(p.id, p.label)} alt="" className="search-suggestion-img" />
                    <div className="search-suggestion-info">
                      <span className="search-suggestion-title">{p.label}</span>
                      <span className="search-suggestion-price">{parseInt(p.price_ttc).toLocaleString('fr-FR')} FCFA</span>
                    </div>
                  </button>
                ))}
                <button className="search-suggestion-all" onClick={handleSearch}>
                  Voir tous les résultats pour "{searchQuery}"
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
