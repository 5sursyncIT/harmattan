import { Link } from 'react-router-dom';
import { FiHome, FiSearch } from 'react-icons/fi';
import './NotFoundPage.css';

export default function NotFoundPage() {
  return (
    <div className="notfound-page">
      <div className="container notfound-content">
        <h1>404</h1>
        <h2>Page introuvable</h2>
        <p>La page que vous recherchez n'existe pas ou a été déplacée.</p>
        <div className="notfound-actions">
          <Link to="/" className="btn btn-primary"><FiHome /> Accueil</Link>
          <Link to="/catalogue" className="btn btn-outline"><FiSearch /> Catalogue</Link>
        </div>
      </div>
    </div>
  );
}
