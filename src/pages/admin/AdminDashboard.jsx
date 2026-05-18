import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  FiSettings, FiMail, FiFileText, FiUsers, FiLogOut, FiHome, FiImage, FiHelpCircle,
  FiUser, FiShield, FiActivity, FiBookOpen, FiMonitor, FiPackage, FiTruck,
  FiDollarSign, FiBriefcase, FiClipboard, FiEdit3, FiCheckSquare, FiLayers,
  FiPrinter, FiShoppingBag, FiPenTool, FiTag, FiChevronDown, FiRss,
} from 'react-icons/fi';
import { adminLogout, adminMe, getNotificationCounts } from '../../api/admin';
import AdminLogin from './AdminLogin';
import Loader from '../../components/common/Loader';
import toast from 'react-hot-toast';
import './Admin.css';

const ALL_ROLES = ['super_admin', 'admin', 'editor', 'support', 'librarian', 'comptable', 'vendeur', 'evaluateur', 'correcteur', 'infographiste', 'imprimeur'];

// Navigation regroupée par domaine métier
// Un groupe dont tous les items sont filtrés (RBAC) est masqué automatiquement.
const NAV_GROUPS = [
  {
    id: 'overview',
    label: null, // pas de titre pour le premier groupe
    items: [
      { path: '', label: 'Tableau de bord', icon: <FiHome />, roles: ['super_admin', 'admin', 'editor', 'support', 'comptable'] },
    ],
  },
  {
    id: 'catalog',
    label: 'Catalogue',
    items: [
      { path: 'books', label: 'Livres', icon: <FiBookOpen />, roles: ['super_admin', 'admin', 'editor', 'librarian'] },
      { path: 'tags', label: 'Tags curation', icon: <FiTag />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'authors', label: 'Auteurs', icon: <FiPenTool />, roles: ['super_admin', 'admin', 'editor', 'support'] },
      { path: 'stock', label: 'Stock', icon: <FiPackage />, roles: ['super_admin', 'admin', 'librarian'] },
      { path: 'suppliers', label: 'Fournisseurs', icon: <FiTruck />, roles: ['super_admin', 'admin'] },
    ],
  },
  {
    id: 'editorial',
    label: 'Édition',
    items: [
      { path: 'manuscripts', label: 'Manuscrits', icon: <FiFileText />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'evaluations', label: 'Évaluations', icon: <FiClipboard />, roles: ['super_admin', 'admin', 'evaluateur'] },
      { path: 'corrections', label: 'Corrections', icon: <FiEdit3 />, roles: ['super_admin', 'admin', 'correcteur'] },
      { path: 'editorial', label: 'Éditorial', icon: <FiCheckSquare />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'covers', label: 'Couvertures', icon: <FiLayers />, roles: ['super_admin', 'admin', 'editor', 'infographiste'] },
      { path: 'printing', label: 'Impression', icon: <FiPrinter />, roles: ['super_admin', 'admin', 'imprimeur'] },
      { path: 'contracts', label: 'Contrats', icon: <FiBookOpen />, roles: ['super_admin', 'admin', 'editor'] },
    ],
  },
  {
    id: 'sales',
    label: 'Ventes',
    items: [
      { path: 'pos', label: 'POS', icon: <FiMonitor />, roles: ['super_admin', 'admin'] },
      { path: 'payments', label: 'Paiements', icon: <FiDollarSign />, roles: ['super_admin', 'admin', 'comptable'] },
      { path: 'accounting', label: 'Comptabilité', icon: <FiBriefcase />, roles: ['super_admin', 'admin', 'comptable'] },
    ],
  },
  {
    id: 'site',
    label: 'Site & contenu',
    items: [
      { path: 'config', label: 'Configuration', icon: <FiSettings />, roles: ['super_admin', 'admin'] },
      { path: 'slides', label: 'Bannières', icon: <FiImage />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'news', label: 'Actualités', icon: <FiRss />, roles: ['super_admin', 'admin', 'editor', 'support'] },
      { path: 'faq', label: 'FAQ', icon: <FiHelpCircle />, roles: ['super_admin', 'admin', 'support'] },
      { path: 'contacts', label: 'Messages', icon: <FiMail />, roles: ['super_admin', 'admin', 'support'] },
      { path: 'newsletter', label: 'Newsletter', icon: <FiUsers />, roles: ['super_admin', 'admin', 'support'] },
      { path: 'customers', label: 'Clients', icon: <FiShoppingBag />, roles: ['super_admin', 'admin', 'support'] },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      { path: 'users', label: 'Équipe', icon: <FiShield />, roles: ['super_admin'] },
      { path: 'activity', label: 'Journal', icon: <FiActivity />, roles: ['super_admin', 'admin'] },
      { path: 'profile', label: 'Mon profil', icon: <FiUser />, roles: ALL_ROLES },
    ],
  },
];

// Aplatit la nav pour les besoins de redirection et recherche active
function flattenTabs() {
  return NAV_GROUPS.flatMap((g) => g.items);
}

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

const COLLAPSED_KEY = 'admin.nav.collapsed';

function loadCollapsed() {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCollapsed(state) {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

export default function AdminDashboard() {
  const [admin, setAdmin] = useState(null);
  const [role, setRole] = useState(null);
  const [checking, setChecking] = useState(true);
  const [badges, setBadges] = useState({});
  const [collapsed, setCollapsed] = useState(loadCollapsed);
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
    const allTabs = flattenTabs();
    const allowed = allTabs.filter(t => t.roles.includes(role));
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

  const toggleGroup = (groupId) => {
    setCollapsed((prev) => {
      const next = { ...prev, [groupId]: !prev[groupId] };
      saveCollapsed(next);
      return next;
    });
  };

  if (checking) return <div className="admin-loading"><Loader /></div>;
  if (!admin) return <AdminLogin onLogin={setAdmin} />;

  // Filtrer les groupes selon le rôle : ne garder que les items autorisés, masquer les groupes vides
  const visibleGroups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((t) => t.roles.includes(role)) }))
    .filter((g) => g.items.length > 0);

  const currentPath = location.pathname.replace('/admin', '').replace(/^\//, '');
  const allVisibleTabs = visibleGroups.flatMap((g) => g.items);
  const activeTab = allVisibleTabs.find(t => t.path === currentPath) || allVisibleTabs[0];

  // Groupe contenant le path actif : forcé déplié quoi qu'il se passe
  const activeGroupId = visibleGroups.find((g) =>
    g.items.some((t) => t.path === currentPath || (t.path && currentPath.startsWith(t.path + '/')))
  )?.id;

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <img src="/images/logo.png" alt="Logo" />
          <span>Admin</span>
        </div>
        <nav aria-label="Menu Admin" className="admin-nav">
          {visibleGroups.map((group) => {
            const isCollapsed = group.label && collapsed[group.id] && group.id !== activeGroupId;
            const badgeCount = group.items.reduce((sum, t) => sum + (BADGE_KEYS[t.path] ? (badges[BADGE_KEYS[t.path]] || 0) : 0), 0);
            return (
              <div key={group.id} className="admin-nav-group">
                {group.label && (
                  <button
                    type="button"
                    className={`admin-nav-group-header ${isCollapsed ? 'collapsed' : ''}`}
                    onClick={() => toggleGroup(group.id)}
                    aria-expanded={!isCollapsed}
                    aria-controls={`group-${group.id}`}
                  >
                    <span className="admin-nav-group-label">{group.label}</span>
                    {isCollapsed && badgeCount > 0 && (
                      <span className="admin-nav-group-badge">{badgeCount}</span>
                    )}
                    <FiChevronDown
                      size={14}
                      className="admin-nav-group-chevron"
                      aria-hidden="true"
                    />
                  </button>
                )}
                {!isCollapsed && (
                  <div id={`group-${group.id}`} className="admin-nav-group-items">
                    {group.items.map((tab) => (
                      <NavLink
                        key={tab.path}
                        to={`/admin${tab.path ? `/${tab.path}` : ''}`}
                        end={tab.path === ''}
                        className={({ isActive }) => `admin-nav-btn ${isActive ? 'active' : ''}`}
                      >
                        {tab.icon} <span>{tab.label}</span>
                        {BADGE_KEYS[tab.path] && badges[BADGE_KEYS[tab.path]] > 0 && (
                          <span className="admin-nav-badge">{badges[BADGE_KEYS[tab.path]]}</span>
                        )}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
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
