import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { FiSettings, FiMail, FiFileText, FiUsers, FiLogOut, FiHome, FiImage, FiHelpCircle, FiUser, FiShield, FiActivity, FiBookOpen, FiMonitor, FiPackage, FiTruck, FiDollarSign, FiBriefcase, FiClipboard, FiEdit3, FiCheckSquare, FiLayers, FiPrinter } from 'react-icons/fi';
import { adminLogout, adminMe, getNotificationCounts } from '../../api/admin';
import AdminLogin from './AdminLogin';
import Loader from '../../components/common/Loader';
import toast from 'react-hot-toast';
import './Admin.css';

const ALL_ROLES = ['super_admin', 'admin', 'editor', 'support', 'librarian', 'comptable', 'vendeur', 'evaluateur', 'correcteur', 'infographiste', 'imprimeur'];
const TABS = [
  { path: '', label: 'Tableau de bord', icon: <FiHome />, roles: ['super_admin', 'admin', 'editor', 'support', 'comptable'] },
  { path: 'books', label: 'Livres', icon: <FiBookOpen />, roles: ['super_admin', 'admin', 'editor', 'librarian'] },
  { path: 'pos', label: 'POS', icon: <FiMonitor />, roles: ['super_admin', 'admin'] },
  { path: 'config', label: 'Configuration', icon: <FiSettings />, roles: ['super_admin', 'admin'] },
  { path: 'slides', label: 'Bannières', icon: <FiImage />, roles: ['super_admin', 'admin', 'editor'] },
  { path: 'faq', label: 'FAQ', icon: <FiHelpCircle />, roles: ['super_admin', 'admin', 'support'] },
  { path: 'contacts', label: 'Messages', icon: <FiMail />, roles: ['super_admin', 'admin', 'support'] },
  { path: 'manuscripts', label: 'Manuscrits', icon: <FiFileText />, roles: ['super_admin', 'admin', 'editor'] },
  { path: 'evaluations', label: 'Évaluations', icon: <FiClipboard />, roles: ['super_admin', 'admin', 'evaluateur'] },
  { path: 'corrections', label: 'Corrections', icon: <FiEdit3 />, roles: ['super_admin', 'admin', 'correcteur'] },
  { path: 'editorial', label: 'Éditorial', icon: <FiCheckSquare />, roles: ['super_admin', 'admin', 'editor'] },
  { path: 'covers', label: 'Couvertures', icon: <FiLayers />, roles: ['super_admin', 'admin', 'editor', 'infographiste'] },
  { path: 'printing', label: 'Impression', icon: <FiPrinter />, roles: ['super_admin', 'admin', 'imprimeur'] },
  { path: 'contracts', label: 'Contrats', icon: <FiBookOpen />, roles: ['super_admin', 'admin', 'editor'] },
  { path: 'payments', label: 'Paiements', icon: <FiDollarSign />, roles: ['super_admin', 'admin', 'comptable'] },
  { path: 'accounting', label: 'Comptabilité', icon: <FiBriefcase />, roles: ['super_admin', 'admin', 'comptable'] },
  { path: 'stock', label: 'Stock', icon: <FiPackage />, roles: ['super_admin', 'admin', 'librarian'] },
  { path: 'suppliers', label: 'Fournisseurs', icon: <FiTruck />, roles: ['super_admin', 'admin'] },
  { path: 'newsletter', label: 'Newsletter', icon: <FiUsers />, roles: ['super_admin', 'admin', 'support'] },
  { path: 'users', label: 'Utilisateurs', icon: <FiShield />, roles: ['super_admin'] },
  { path: 'activity', label: 'Journal', icon: <FiActivity />, roles: ['super_admin', 'admin'] },
  { path: 'profile', label: 'Mon profil', icon: <FiUser />, roles: ALL_ROLES },
];

// Mapping onglet → clé de compteur notification
const BADGE_KEYS = {
  contacts: 'messages',
  payments: 'payments',
  stock: 'stock_alerts',
  manuscripts: 'manuscripts',
  evaluations: 'evaluations',
  corrections: 'corrections',
  editorial: 'editorial',
  covers: 'covers',
  printing: 'printing',
};

export default function AdminDashboard() {
  const [admin, setAdmin] = useState(null);
  const [role, setRole] = useState(null);
  const [checking, setChecking] = useState(true);
  const [badges, setBadges] = useState({});
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    adminMe()
      .then((res) => {
        setAdmin(res.data.username);
        setRole(res.data.role || 'admin');
      })
      .catch(() => { setAdmin(null); setRole(null); })
      .finally(() => setChecking(false));

    const handleUnauthorized = () => {
      setAdmin(null);
      setRole(null);
    };

    window.addEventListener('admin-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('admin-unauthorized', handleUnauthorized);
  }, []);

  // Polling des badges de notification (toutes les 30s)
  useEffect(() => {
    if (!admin) return;
    const fetchBadges = () => getNotificationCounts().then(r => setBadges(r.data)).catch(() => {});
    fetchBadges();
    const interval = setInterval(fetchBadges, 30000);
    return () => clearInterval(interval);
  }, [admin]);

  // Rediriger vers le premier onglet autorisé si la page courante n'est pas accessible
  useEffect(() => {
    if (!role) return;
    const allowed = TABS.filter(t => t.roles.includes(role));
    const current = location.pathname.replace('/admin', '').replace(/^\//, '');
    const isAllowed = allowed.some(t => t.path === current || (t.path && current.startsWith(t.path + '/')));
    if (!isAllowed) {
      const fallback = allowed[0]?.path || 'profile';
      navigate(`/admin/${fallback}`, { replace: true });
    }
  }, [role, location.pathname, navigate]);

  const handleLogout = async () => {
    await adminLogout().catch(() => {});
    setAdmin(null);
    navigate('/admin');
    toast.success('Déconnecté');
  };

  if (checking) return <div className="admin-loading"><Loader /></div>;
  if (!admin) return <AdminLogin onLogin={setAdmin} />;

  // Filtrer les tabs selon le rôle
  const visibleTabs = TABS.filter((t) => t.roles.includes(role));

  // Déduire le titre depuis le path
  const currentPath = location.pathname.replace('/admin', '').replace(/^\//, '');
  const activeTab = visibleTabs.find(t => t.path === currentPath) || visibleTabs[0];

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <img src="/images/logo.png" alt="Logo" />
          <span>Admin</span>
        </div>
        <nav aria-label="Menu Admin">
          {visibleTabs.map((tab) => (
            <NavLink
              key={tab.path}
              to={`/admin${tab.path ? `/${tab.path}` : ''}`}
              end={tab.path === ''}
              className={({ isActive }) => `admin-nav-btn ${isActive ? 'active' : ''}`}
              aria-current={({ isActive }) => isActive ? 'page' : undefined}
            >
              {tab.icon} <span>{tab.label}</span>
              {BADGE_KEYS[tab.path] && badges[BADGE_KEYS[tab.path]] > 0 && (
                <span className="admin-nav-badge">{badges[BADGE_KEYS[tab.path]]}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <span>{admin}</span>
          <button onClick={handleLogout} className="admin-logout-btn"><FiLogOut /> <span>Déconnexion</span></button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-header">
          <h1>{activeTab.label}</h1>
        </header>
        <div className="admin-content">
          <Outlet context={{ adminUsername: admin, adminRole: role }} />
        </div>
      </main>
    </div>
  );
}
