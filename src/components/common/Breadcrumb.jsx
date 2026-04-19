import { Link } from 'react-router-dom';
import { FiChevronRight, FiHome } from 'react-icons/fi';
import './Breadcrumb.css';

export default function Breadcrumb({ items = [] }) {
  return (
    <nav className="breadcrumb" aria-label="Fil d'Ariane">
      <ol>
        <li>
          <Link to="/"><FiHome size={14} /> Accueil</Link>
        </li>
        {items.map((item, i) => (
          <li key={i}>
            <FiChevronRight size={12} className="breadcrumb-sep" />
            {item.to ? (
              <Link to={item.to}>{item.label}</Link>
            ) : (
              <span className="breadcrumb-current" aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
