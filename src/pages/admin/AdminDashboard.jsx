import { useState, useEffect } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  FiSettings, FiMail, FiFileText, FiUsers, FiLogOut, FiHome, FiImage, FiHelpCircle,
  FiUser, FiShield, FiActivity, FiBookOpen, FiMonitor, FiPackage, FiTruck,
  FiDollarSign, FiBriefcase, FiClipboard, FiEdit3, FiLayers,
  FiPrinter, FiShoppingBag, FiPenTool, FiTag, FiChevronDown, FiRss, FiArchive,
  FiTrendingDown, FiBookmark,
} from 'react-icons/fi';
import { adminLogout, adminMe, getNotificationCounts, adminChangePassword } from '../../api/admin';
import AdminLogin from './AdminLogin';
import Loader from '../../components/common/Loader';
import toast from 'react-hot-toast';
import './Admin.css';

const ALL_ROLES = ['super_admin', 'admin', 'editor', 'production', 'librarian', 'comptable', 'vendeur', 'evaluateur', 'correcteur', 'infographiste', 'imprimeur'];

// Navigation regroupée par domaine métier
// Un groupe dont tous les items sont filtrés (RBAC) est masqué automatiquement.
const NAV_GROUPS = [
  {
    id: 'overview',
    label: null, // pas de titre pour le premier groupe
    items: [
      { path: '', label: 'Tableau de bord', icon: <FiHome />, roles: ['super_admin', 'admin', 'editor', 'librarian', 'comptable', 'gestionnaire_stock'] },
    ],
  },
  {
    id: 'catalog',
    label: 'Catalogue',
    items: [
      { path: 'books', label: 'Livres', icon: <FiBookOpen />, roles: ['super_admin', 'admin', 'editor', 'librarian', 'gestionnaire_stock'] },
      { path: 'tags', label: 'Tags curation', icon: <FiTag />, roles: ['super_admin', 'admin', 'editor', 'gestionnaire_stock'] },
      { path: 'authors', label: 'Auteurs', icon: <FiPenTool />, roles: ['super_admin', 'admin', 'editor', 'librarian', 'gestionnaire_stock'] },
      { path: 'stock', label: 'Stock', icon: <FiPackage />, roles: ['super_admin', 'admin', 'librarian', 'gestionnaire_stock'] },
      { path: 'inventory', label: 'Inventaire', icon: <FiClipboard />, roles: ['super_admin', 'admin', 'librarian', 'gestionnaire_stock'] },
      { path: 'suppliers', label: 'Fournisseurs', icon: <FiTruck />, roles: ['super_admin', 'admin', 'gestionnaire_stock'] },
    ],
  },
  {
    id: 'editorial',
    label: 'Édition',
    items: [
      { path: 'manuscripts', label: 'Manuscrits', icon: <FiFileText />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'intervenants', label: 'Intervenants', icon: <FiUsers />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'evaluations', label: 'Évaluations', icon: <FiClipboard />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'corrections', label: 'Corrections', icon: <FiEdit3 />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'production', label: 'Production éditoriale', icon: <FiLayers />, roles: ['super_admin', 'admin', 'editor', 'production'] },
      { path: 'printing', label: 'Impression', icon: <FiPrinter />, roles: ['super_admin', 'admin', 'editor'] },
      { path: 'legal-deposits', label: 'Dépôt légal', icon: <FiBookmark />, roles: ['super_admin', 'admin', 'editor', 'gestionnaire_stock'] },
      { path: 'contracts', label: 'Contrats', icon: <FiBookOpen />, roles: ['super_admin', 'admin', 'editor', 'comptable'] },
    ],
  },
  {
    id: 'sales',
    label: 'Ventes',
    items: [
      { path: 'pos', label: 'POS', icon: <FiMonitor />, roles: ['super_admin', 'admin'] },
      { path: 'tiers', label: 'Tiers', icon: <FiUsers />, roles: ['super_admin', 'admin', 'librarian', 'comptable', 'gestionnaire_stock'] },
      { path: 'orders', label: 'Commandes web', icon: <FiShoppingBag />, roles: ['super_admin', 'admin', 'comptable', 'librarian'] },
      { path: 'devis', label: 'Devis', icon: <FiClipboard />, roles: ['super_admin', 'admin', 'comptable', 'librarian'] },
      { path: 'invoices', label: 'Factures', icon: <FiFileText />, roles: ['super_admin', 'admin', 'librarian', 'comptable'] },
      { path: 'deliveries', label: 'Bons de livraison', icon: <FiTruck />, roles: ['super_admin', 'admin', 'librarian', 'comptable', 'gestionnaire_stock'] },
      { path: 'consignments', label: 'Dépôt-vente', icon: <FiArchive />, roles: ['super_admin', 'admin', 'comptable', 'librarian', 'gestionnaire_stock'] },
      { path: 'payments', label: 'Paiements', icon: <FiDollarSign />, roles: ['super_admin', 'admin', 'comptable'] },
      { path: 'expenses', label: "Sorties d'argent", icon: <FiTrendingDown />, roles: ['super_admin', 'admin', 'comptable'] },
      { path: 'accounting', label: 'Comptabilité', icon: <FiBriefcase />, roles: ['super_admin', 'admin', 'comptable'] },
    ],
  },
  {
    id: 'site',
    label: 'Site & contenu',
    items: [
      { path: 'config', label: 'Configuration', icon: <FiSettings />, roles: ['super_admin', 'admin', 'librarian'] },
      { path: 'slides', label: 'Bannières', icon: <FiImage />, roles: ['super_admin', 'admin', 'editor', 'librarian'] },
      { path: 'news', label: 'Actualités', icon: <FiRss />, roles: ['super_admin', 'admin', 'editor', 'librarian'] },
      { path: 'faq', label: 'FAQ', icon: <FiHelpCircle />, roles: ['super_admin', 'admin', 'librarian'] },
      { path: 'contacts', label: 'Messages', icon: <FiMail />, roles: ['super_admin', 'admin', 'librarian'] },
      { path: 'newsletter', label: 'Newsletter', icon: <FiUsers />, roles: ['super_admin', 'admin', 'librarian'] },
      { path: 'customers', label: 'Comptes web', icon: <FiShoppingBag />, roles: ['super_admin', 'admin', 'librarian'] },
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

// Correspondance chemin de nav → clé de module (pour les surcharges de permission).
// La plupart des chemins == clé de module ; seuls quelques-uns diffèrent.
const NAV_MODULE_ALIASES = { '': 'dashboard', 'legal-deposits': 'legal_deposits', devis: 'propals' };
function navModuleKey(path) {
  return NAV_MODULE_ALIASES[path] || path;
}

// Visibilité d'un onglet : une surcharge (octroi/retrait) prime sur les rôles de base.
function navVisible(tab, role, overrides) {
  const ov = overrides?.[navModuleKey(tab.path)];
  if (ov === '-') return false;       // accès retiré temporairement → masquer
  if (ov !== undefined) return true;  // accès accordé/modifié → afficher
  return tab.roles.includes(role);    // comportement de base
}

// Mapping onglet → clé de compteur notification
const BADGE_KEYS = {
  contacts: 'messages',
  payments: 'payments',
  expenses: 'expenses',
  stock: 'stock_alerts',
  manuscripts: 'manuscripts',
  evaluations: 'evaluations',
  corrections: 'corrections',
  production: 'production',  // somme éditorial + couvertures (calculée côté client)
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
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [checking, setChecking] = useState(true);
  const [badges, setBadges] = useState({});
  const [myOverrides, setMyOverrides] = useState({});
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    adminMe()
      .then((res) => {
        setAdmin(res.data.username);
        setRole(res.data.role || 'admin');
        setMustChangePassword(!!res.data.mustChangePassword);
        setMyOverrides(res.data.permissionOverrides || {});
      })
      .catch(() => { setAdmin(null); setRole(null); setMustChangePassword(false); })
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
    const fetchBadges = () => getNotificationCounts().then(r => {
      const d = r.data || {};
      // Badge unifié « Production éditoriale » = éditorial + couvertures.
      setBadges({ ...d, production: (d.editorial || 0) + (d.covers || 0) });
    }).catch(() => {});
    fetchBadges();
    const interval = setInterval(fetchBadges, 30000);
    return () => clearInterval(interval);
  }, [admin]);

  // Rediriger vers le premier onglet autorisé si la page courante n'est pas accessible
  useEffect(() => {
    if (!role) return;
    const allTabs = flattenTabs();
    const allowed = allTabs.filter(t => navVisible(t, role, myOverrides));
    const current = location.pathname.replace('/admin', '').replace(/^\//, '');
    // Le drill-down « Détail » d'un manuscrit (/admin/manuscripts/:id) est accessible
    // à tout profil pilotant le pipeline (Production éditoriale) ou ayant l'onglet Manuscrits.
    const canDrillManuscripts = allowed.some(t => t.path === 'production' || t.path === 'manuscripts');
    const isAllowed = allowed.some(t => t.path === current || (t.path && current.startsWith(t.path + '/')))
      || (canDrillManuscripts && current.startsWith('manuscripts/'));
    if (!isAllowed) {
      const fallback = allowed[0]?.path || 'profile';
      navigate(`/admin/${fallback}`, { replace: true });
    }
  }, [role, myOverrides, location.pathname, navigate]);

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

  const handleLoginSuccess = (data) => {
    setAdmin(data.username);
    setRole(data.role || 'admin');
    setMustChangePassword(!!data.mustChangePassword);
    // Récupère les surcharges de permission actives pour ce rôle (nav à jour).
    adminMe().then((r) => setMyOverrides(r.data.permissionOverrides || {})).catch(() => {});
  };

  if (checking) return <div className="admin-loading"><Loader /></div>;
  if (!admin) return <AdminLogin onLogin={handleLoginSuccess} />;
  if (mustChangePassword) {
    return (
      <ForcedPasswordChange
        username={admin}
        onSuccess={() => setMustChangePassword(false)}
        onLogout={handleLogout}
      />
    );
  }

  // Filtrer les groupes selon le rôle : ne garder que les items autorisés, masquer les groupes vides
  const visibleGroups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter((t) => navVisible(t, role, myOverrides)) }))
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
          <h1>{activeTab?.label || ''}</h1>
        </header>
        <div className="admin-content">
          <Outlet context={{ adminUsername: admin, adminRole: role }} />
        </div>
      </main>
    </div>
  );
}

// Écran bloquant affiché tant que `mustChangePassword` est vrai.
// L'utilisateur ne peut pas naviguer dans l'admin avant d'avoir changé son mot de passe.
function ForcedPasswordChange({ username, onSuccess, onLogout }) {
  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (newPw.length < 8 || !/[A-Z]/.test(newPw) || !/[0-9]/.test(newPw)) {
      return toast.error('Min. 8 caractères, 1 majuscule, 1 chiffre');
    }
    if (newPw !== confirm) return toast.error('Les mots de passe ne correspondent pas');
    if (newPw === current) return toast.error('Le nouveau mot de passe doit être différent');
    setSaving(true);
    try {
      await adminChangePassword(current, newPw);
      toast.success('Mot de passe modifié');
      onSuccess();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="admin-login">
      <form onSubmit={handleSubmit} className="admin-login-form" style={{ maxWidth: 420 }}>
        <img src="/images/logo.png" alt="Logo" className="admin-login-logo" />
        <h2>Renouvellement de mot de passe</h2>
        <p style={{ margin: '0 0 12px', color: '#92400e', fontSize: 14, textAlign: 'center', background: '#fef3c7', padding: 10, borderRadius: 6 }}>
          Bonjour <strong>{username}</strong>, vous devez définir un nouveau mot de passe avant d'accéder à l'administration.
        </p>
        <input type="password" placeholder="Mot de passe actuel" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        <input type="password" placeholder="Nouveau mot de passe (8+ car., 1 maj., 1 chiffre)" value={newPw} onChange={(e) => setNewPw(e.target.value)} required autoComplete="new-password" minLength={8} />
        <input type="password" placeholder="Confirmer le nouveau mot de passe" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        <button type="submit" disabled={saving}>{saving ? 'Enregistrement…' : 'Définir le nouveau mot de passe'}</button>
        <button type="button" onClick={onLogout} style={{ background: 'transparent', color: '#6b7280', marginTop: 8 }}>
          Se déconnecter
        </button>
      </form>
    </div>
  );
}
