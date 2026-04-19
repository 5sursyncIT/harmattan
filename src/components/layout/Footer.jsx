import { Link } from 'react-router-dom';
import { FiMapPin, FiPhone, FiMail, FiClock, FiFacebook, FiYoutube, FiLinkedin } from 'react-icons/fi';
import { FaXTwitter, FaCcVisa, FaCcMastercard } from 'react-icons/fa6';
import useSiteConfig from '../../hooks/useSiteConfig.jsx';
import './Footer.css';

export default function Footer() {
  const config = useSiteConfig();
  const contact = config?.contact || {};
  const social = config?.social || {};

  return (
    <footer className="footer">
      <div className="footer-main">
        <div className="container footer-grid">
          <div className="footer-col">
            <h3 className="footer-title">L'Harmattan Sénégal</h3>
            <p className="footer-desc">
              Maison d'édition et librairie basée à Dakar, L'Harmattan Sénégal propose
              un large catalogue de livres africains et internationaux.
            </p>
          </div>

          <div className="footer-col">
            <h4 className="footer-heading">Navigation</h4>
            <ul>
              <li><Link to="/">Accueil</Link></li>
              <li><Link to="/catalogue">Catalogue</Link></li>
              <li><Link to="/a-propos">À propos</Link></li>
              <li><Link to="/contact">Contact</Link></li>
              <li><Link to="/faq">FAQ</Link></li>
              <li><Link to="/suivi-commande">Suivi de commande</Link></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4 className="footer-heading">Catégories</h4>
            <ul>
              <li><Link to="/catalogue?cat=roman">Romans</Link></li>
              <li><Link to="/catalogue?cat=essai">Essais</Link></li>
              <li><Link to="/catalogue?cat=poesie">Poésie</Link></li>
              <li><Link to="/catalogue?cat=theatre">Théâtre</Link></li>
              <li><Link to="/catalogue?cat=jeunesse">Jeunesse</Link></li>
            </ul>
          </div>

          <div className="footer-col">
            <h4 className="footer-heading">Contact</h4>
            <ul className="footer-contact">
              <li><FiMapPin size={14} /> {contact.address_short || '10, VDN, Sicap Karak 45034, Dakar'}</li>
              <li><FiPhone size={14} /> {(contact.phones || []).join(' / ') || '+221 33 825 98 58'}</li>
              <li><FiMail size={14} /> {contact.emails?.[0] || 'commandes@senharmattan.com'}</li>
              <li><FiClock size={14} /> {contact.hours || 'Lun - Ven: 8h - 18h30 | Sam: 9h - 18h30'}</li>
            </ul>
            <div className="footer-socials">
              {social.facebook && <a href={social.facebook} target="_blank" rel="noopener noreferrer" aria-label="Facebook"><FiFacebook size={18} /></a>}
              {social.youtube && <a href={social.youtube} target="_blank" rel="noopener noreferrer" aria-label="YouTube"><FiYoutube size={18} /></a>}
              {social.twitter && <a href={social.twitter} target="_blank" rel="noopener noreferrer" aria-label="X"><FaXTwitter size={18} /></a>}
              {social.linkedin && <a href={social.linkedin} target="_blank" rel="noopener noreferrer" aria-label="LinkedIn"><FiLinkedin size={18} /></a>}
            </div>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="container footer-bottom-inner">
          <div className="footer-legal-links">
            <Link to="/cgv">CGV</Link>
            <Link to="/mentions-legales">Mentions légales</Link>
          </div>
          <p>&copy; {new Date().getFullYear()} L'Harmattan Sénégal. Tous droits réservés.</p>
          <div className="footer-payment">
            <span className="payment-icon" title="Orange Money">
              <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
                <rect width="32" height="20" rx="3" fill="#FF6600"/>
                <text x="16" y="14" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold" fontFamily="Arial,sans-serif">OM</text>
              </svg>
            </span>
            <span className="payment-icon" title="Wave">
              <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
                <rect width="32" height="20" rx="3" fill="#1DC3E2"/>
                <text x="16" y="14" textAnchor="middle" fill="white" fontSize="7" fontWeight="bold" fontFamily="Arial,sans-serif">Wave</text>
              </svg>
            </span>
            <span className="payment-icon" title="Visa"><FaCcVisa size={28} color="#1a1f71" /></span>
            <span className="payment-icon" title="Mastercard"><FaCcMastercard size={28} color="#eb001b" /></span>
          </div>
        </div>
      </div>
      <div className="footer-copyright">
        <div className="container">
          <p>&copy; {new Date().getFullYear()} - Made by <strong>5/Sync IT</strong> 77 097 29 08</p>
        </div>
      </div>
    </footer>
  );
}
