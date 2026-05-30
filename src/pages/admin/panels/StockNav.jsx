import { NavLink } from 'react-router-dom';
import { FiPieChart, FiPackage, FiAlertTriangle, FiShoppingCart, FiTruck } from 'react-icons/fi';

const TABS = [
  { to: '/admin/stock', label: 'Pilotage', icon: <FiPieChart size={15} />, end: true },
  { to: '/admin/stock/products', label: 'Produits', icon: <FiPackage size={15} /> },
  { to: '/admin/stock/alerts', label: 'Alertes', icon: <FiAlertTriangle size={15} /> },
  { to: '/admin/stock/recommendations', label: 'Recommandations', icon: <FiShoppingCart size={15} /> },
  { to: '/admin/stock/purchase-orders', label: 'Appro', icon: <FiTruck size={15} /> },
];

// Sous-navigation commune aux écrans Stock. `badges` = { alerts, reco, appro }.
export default function StockNav({ badges = {} }) {
  const badgeFor = (to) => {
    if (to.endsWith('/alerts')) return badges.alerts;
    if (to.endsWith('/recommendations')) return badges.reco;
    if (to.endsWith('/purchase-orders')) return badges.appro;
    return null;
  };
  return (
    <nav className="sk-subnav" aria-label="Navigation stock">
      {TABS.map(t => {
        const b = badgeFor(t.to);
        return (
          <NavLink key={t.to} to={t.to} end={t.end}
            className={({ isActive }) => `sk-subnav-link ${isActive ? 'active' : ''}`}>
            {t.icon}<span>{t.label}</span>
            {b > 0 && <span className="sk-subnav-badge">{b > 99 ? '99+' : b}</span>}
          </NavLink>
        );
      })}
    </nav>
  );
}
