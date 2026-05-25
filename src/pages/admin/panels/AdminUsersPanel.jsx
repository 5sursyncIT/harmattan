import { useState, useEffect, useMemo } from 'react';
import {
  getAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  setAdminUserActive,
  forceLogoutAdminUser,
  forcePasswordResetAdminUser,
  resetAdminUser2FA,
  getAdminRoles,
} from '../../../api/admin';
import {
  FiUserPlus, FiTrash2, FiShield, FiEdit2, FiSave, FiX, FiKey,
  FiSearch, FiPower, FiLogOut, FiSmartphone, FiCheckCircle, FiSlash, FiFilter,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import RolePermissionsMatrix from './RolePermissionsMatrix';

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function formatRelative(iso) {
  if (!iso) return 'Jamais';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 30) return `il y a ${Math.floor(diff / 86400)} j`;
  return d.toLocaleDateString('fr-FR');
}

export default function AdminUsersPanel() {
  const [tab, setTab] = useState('users');
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState(null);
  const [loading, setLoading] = useState(true);

  // Création
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ username: '', email: '', password: '', role: 'admin', mustChangePassword: true });
  const [creating, setCreating] = useState(false);

  // Édition inline
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ username: '', role: '', email: '', password: '' });
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [updating, setUpdating] = useState(false);

  // Filtres
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterStatus, setFilterStatus] = useState(''); // '', 'active', 'inactive', 'online'
  const [sortKey, setSortKey] = useState('username');
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    Promise.all([
      getAdminUsers().then((r) => setUsers(r.data)).catch(() => setUsers([])),
      getAdminRoles().then((r) => setRoles(r.data)).catch(() => setRoles(null)),
    ]).finally(() => setLoading(false));
  }, []);

  const rolesArray = useMemo(() => {
    if (!roles) return [];
    return Object.entries(roles.roles).map(([key, r]) => ({ value: key, ...r }));
  }, [roles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = users.filter((u) => {
      if (q && !u.username.toLowerCase().includes(q) && !(u.email || '').toLowerCase().includes(q)) return false;
      if (filterRole && u.role !== filterRole) return false;
      if (filterStatus === 'active' && !u.is_active) return false;
      if (filterStatus === 'inactive' && u.is_active) return false;
      if (filterStatus === 'online' && !u.session_active) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      const va = a[sortKey];
      const vb = b[sortKey];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return String(va).localeCompare(String(vb), 'fr', { numeric: true }) * dir;
    });
    return list;
  }, [users, search, filterRole, filterStatus, sortKey, sortDir]);

  const stats = useMemo(() => ({
    total: users.length,
    actives: users.filter((u) => u.is_active).length,
    online: users.filter((u) => u.session_active).length,
    with2FA: users.filter((u) => u.totp_enabled).length,
  }), [users]);

  function changeSort(key) {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.username.trim() || !form.password) return;
    if (form.password.length < 8 || !/[A-Z]/.test(form.password) || !/[0-9]/.test(form.password)) {
      return toast.error('Min. 8 caractères, 1 majuscule, 1 chiffre');
    }
    const cleanEmail = form.email.trim();
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return toast.error('Email invalide');
    }
    setCreating(true);
    try {
      const res = await createAdminUser({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        email: cleanEmail || undefined,
        mustChangePassword: form.mustChangePassword,
      });
      setUsers([...users, res.data]);
      setForm({ username: '', email: '', password: '', role: 'admin', mustChangePassword: true });
      setShowForm(false);
      toast.success(`Utilisateur « ${res.data.username} » créé`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(user) {
    if (!confirm(`Supprimer l'utilisateur « ${user.username} » ?`)) return;
    try {
      await deleteAdminUser(user.id);
      setUsers(users.filter((u) => u.id !== user.id));
      toast.success('Utilisateur supprimé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  function startEdit(user) {
    setEditingId(user.id);
    setEditForm({ username: user.username, role: user.role, email: user.email || '', password: '' });
    setShowPasswordField(false);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm({ username: '', role: '', email: '', password: '' });
    setShowPasswordField(false);
  }

  async function handleUpdate(user) {
    const payload = {};
    if (editForm.username.trim() && editForm.username.trim() !== user.username) payload.username = editForm.username.trim();
    if (editForm.role && editForm.role !== user.role) payload.role = editForm.role;
    if ((editForm.email || '').trim() !== (user.email || '')) {
      const trimmed = editForm.email.trim();
      if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return toast.error('Email invalide');
      payload.email = trimmed;
    }
    if (showPasswordField && editForm.password) {
      if (editForm.password.length < 8 || !/[A-Z]/.test(editForm.password) || !/[0-9]/.test(editForm.password)) {
        return toast.error('Mot de passe : min. 8 car., 1 majuscule, 1 chiffre');
      }
      payload.password = editForm.password;
    }
    if (Object.keys(payload).length === 0) return toast.error('Aucune modification à enregistrer');
    setUpdating(true);
    try {
      const res = await updateAdminUser(user.id, payload);
      setUsers(users.map((u) => (u.id === user.id ? res.data : u)));
      toast.success('Utilisateur mis à jour');
      cancelEdit();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur mise à jour');
    } finally {
      setUpdating(false);
    }
  }

  async function toggleActive(user) {
    const next = !user.is_active;
    if (!next && !confirm(`Désactiver « ${user.username} » ? Sa session active sera coupée.`)) return;
    try {
      const res = await setAdminUserActive(user.id, next);
      setUsers(users.map((u) => (u.id === user.id ? res.data : u)));
      toast.success(next ? 'Compte activé' : 'Compte désactivé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  async function forceLogout(user) {
    if (!confirm(`Forcer la déconnexion de « ${user.username} » ?`)) return;
    try {
      const res = await forceLogoutAdminUser(user.id);
      setUsers(users.map((u) => (u.id === user.id ? res.data : u)));
      toast.success('Session révoquée');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  async function forcePasswordReset(user) {
    if (!confirm(`Imposer un renouvellement de mot de passe à « ${user.username} » au prochain login ?`)) return;
    try {
      const res = await forcePasswordResetAdminUser(user.id);
      setUsers(users.map((u) => (u.id === user.id ? res.data : u)));
      toast.success('Renouvellement imposé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  async function reset2FA(user) {
    if (!confirm(`Réinitialiser la 2FA de « ${user.username} » ? Il devra la reconfigurer.`)) return;
    try {
      const res = await resetAdminUser2FA(user.id);
      setUsers(users.map((u) => (u.id === user.id ? res.data : u)));
      toast.success('2FA réinitialisée');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  }

  if (loading) return <div className="admin-card">Chargement…</div>;

  return (
    <div className="admin-panel">
      <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid #e5e7eb', marginBottom: 12 }}>
        <TabBtn active={tab === 'users'} onClick={() => setTab('users')}>
          <FiShield /> Utilisateurs ({stats.total})
        </TabBtn>
        <TabBtn active={tab === 'permissions'} onClick={() => setTab('permissions')}>
          <FiFilter /> Permissions par rôle
        </TabBtn>
      </div>

      {tab === 'permissions' && <RolePermissionsMatrix />}

      {tab === 'users' && (
        <>
          {/* KPI cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <Stat label="Total" value={stats.total} color="#10531a" />
            <Stat label="Actifs" value={stats.actives} color="#059669" />
            <Stat label="En ligne" value={stats.online} color="#0284c7" />
            <Stat label="Avec 2FA" value={stats.with2FA} color="#7c3aed" />
          </div>

          {/* Toolbar */}
          <div className="admin-card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 200 }}>
                <FiSearch style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
                <input
                  type="text"
                  placeholder="Rechercher nom ou email…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px 8px 32px', border: '1px solid #d1d5db', borderRadius: 6 }}
                />
              </div>
              <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }}>
                <option value="">Tous les rôles</option>
                {rolesArray.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }}>
                <option value="">Tous les statuts</option>
                <option value="active">Actifs</option>
                <option value="inactive">Désactivés</option>
                <option value="online">En ligne</option>
              </select>
              <span style={{ flex: 1 }} />
              <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
                <FiUserPlus /> Nouvel utilisateur
              </button>
            </div>
          </div>

          {/* Formulaire création */}
          {showForm && (
            <div className="admin-card">
              <h3 style={{ margin: '0 0 12px' }}>Créer un nouvel utilisateur</h3>
              <form onSubmit={handleCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div className="admin-field" style={{ flex: 1, minWidth: 150 }}>
                  <label>Nom d'utilisateur</label>
                  <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="ex: bachir" required />
                </div>
                <div className="admin-field" style={{ flex: 1, minWidth: 200 }}>
                  <label>Email <span style={{ color: '#9ca3af', fontWeight: 400 }}>(notifications)</span></label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="ex: bachir@5sursync.com" />
                </div>
                <div className="admin-field" style={{ flex: 1, minWidth: 160 }}>
                  <label>Mot de passe initial</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Min. 8 car., 1 maj., 1 chiffre" required />
                </div>
                <div className="admin-field" style={{ minWidth: 160 }}>
                  <label>Rôle</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }} title={rolesArray.find(r => r.value === form.role)?.description || ''}>
                    {rolesArray.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#374151', minWidth: 200 }}>
                  <input type="checkbox" checked={form.mustChangePassword} onChange={(e) => setForm({ ...form, mustChangePassword: e.target.checked })} />
                  Forcer le changement au 1ᵉʳ login
                </label>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Création…' : 'Créer'}
                </button>
              </form>
              {form.role && rolesArray.find(r => r.value === form.role) && (
                <p style={{ marginTop: 10, fontSize: 12, color: '#6b7280' }}>
                  <strong>{rolesArray.find(r => r.value === form.role).label}</strong> — {rolesArray.find(r => r.value === form.role).description}
                </p>
              )}
            </div>
          )}

          {/* Tableau */}
          <div className="admin-card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table className="admin-table">
                <thead>
                  <tr>
                    <SortableTh sortKey="username" current={sortKey} dir={sortDir} onSort={changeSort}>Utilisateur</SortableTh>
                    <th>Email</th>
                    <SortableTh sortKey="role" current={sortKey} dir={sortDir} onSort={changeSort}>Rôle</SortableTh>
                    <th>Statut</th>
                    <SortableTh sortKey="last_login_at" current={sortKey} dir={sortDir} onSort={changeSort}>Dernière connexion</SortableTh>
                    <th>2FA</th>
                    <th style={{ width: 200 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>Aucun utilisateur ne correspond aux filtres.</td></tr>
                  )}
                  {filtered.map((u) => {
                    const roleInfo = rolesArray.find((r) => r.value === u.role) || { label: u.role, color: '#6b7280' };
                    const isEditing = editingId === u.id;

                    if (isEditing) {
                      return (
                        <tr key={u.id} style={{ background: '#fefce8' }}>
                          <td>
                            <input
                              type="text"
                              value={editForm.username}
                              onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
                            />
                            {showPasswordField ? (
                              <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                                <input
                                  type="password"
                                  value={editForm.password}
                                  onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                                  placeholder="Nouveau mot de passe"
                                  style={{ flex: 1, padding: '6px 10px', borderRadius: 6, border: '1px solid #f59e0b', fontSize: '0.85rem' }}
                                />
                                <button
                                  type="button"
                                  onClick={() => { setShowPasswordField(false); setEditForm({ ...editForm, password: '' }); }}
                                  style={{ padding: '4px 8px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer' }}
                                ><FiX size={12} /></button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setShowPasswordField(true)}
                                style={{ marginTop: 6, padding: '4px 10px', background: '#fff', border: '1px dashed #9ca3af', borderRadius: 6, cursor: 'pointer', fontSize: '0.75rem', color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                              ><FiKey size={11} /> Changer le mot de passe</button>
                            )}
                          </td>
                          <td>
                            <input
                              type="email"
                              value={editForm.email}
                              onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                              placeholder="email@…"
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
                            />
                          </td>
                          <td>
                            <select
                              value={editForm.role}
                              onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                              style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
                            >
                              {rolesArray.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                            </select>
                          </td>
                          <td colSpan={3} style={{ color: '#6b7280', fontSize: 12 }}>—</td>
                          <td>
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn-icon" onClick={() => handleUpdate(u)} disabled={updating} title="Enregistrer" style={{ color: '#10531a' }}>
                                <FiSave size={14} />
                              </button>
                              <button className="btn-icon" onClick={cancelEdit} disabled={updating} title="Annuler">
                                <FiX size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    }

                    return (
                      <tr key={u.id} style={{ opacity: u.is_active ? 1 : 0.55 }}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <FiShield size={16} style={{ color: roleInfo.color }} />
                            <strong>{u.username}</strong>
                            {u.session_active && (
                              <span title="Session active" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
                            )}
                            {u.must_change_password && (
                              <span title="Renouvellement du mot de passe imposé" style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontWeight: 700 }}>MDP</span>
                            )}
                          </div>
                        </td>
                        <td style={{ color: u.email ? '#374151' : '#9ca3af', fontSize: '0.85rem' }}>{u.email || '—'}</td>
                        <td>
                          <span title={roleInfo.description} style={{ padding: '2px 8px', borderRadius: 4, background: `${roleInfo.color}15`, color: roleInfo.color, fontSize: '0.8rem', fontWeight: 700, cursor: 'help' }}>
                            {roleInfo.label}
                          </span>
                        </td>
                        <td>
                          {u.is_active ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#059669', fontSize: 12, fontWeight: 600 }}>
                              <FiCheckCircle size={12} /> Actif
                            </span>
                          ) : (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#dc2626', fontSize: 12, fontWeight: 600 }}>
                              <FiSlash size={12} /> Désactivé
                            </span>
                          )}
                        </td>
                        <td title={u.last_login_at ? formatDateTime(u.last_login_at) + (u.last_login_ip ? ` (${u.last_login_ip})` : '') : 'Jamais connecté'} style={{ fontSize: 12, color: '#374151' }}>
                          {formatRelative(u.last_login_at)}
                        </td>
                        <td>
                          {u.totp_enabled ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#7c3aed', fontSize: 12, fontWeight: 600 }}>
                              <FiSmartphone size={12} /> Activée
                            </span>
                          ) : (
                            <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <button className="btn-icon" onClick={() => startEdit(u)} title="Modifier"><FiEdit2 size={14} /></button>
                            <button className="btn-icon" onClick={() => toggleActive(u)} title={u.is_active ? 'Désactiver' : 'Activer'} style={{ color: u.is_active ? '#dc2626' : '#059669' }}>
                              <FiPower size={14} />
                            </button>
                            <button className="btn-icon" onClick={() => forceLogout(u)} disabled={!u.session_active} title={u.session_active ? 'Forcer la déconnexion' : 'Pas de session active'} style={{ opacity: u.session_active ? 1 : 0.4 }}>
                              <FiLogOut size={14} />
                            </button>
                            <button className="btn-icon" onClick={() => forcePasswordReset(u)} disabled={u.must_change_password} title={u.must_change_password ? 'Déjà imposé' : 'Forcer renouvellement mot de passe'} style={{ opacity: u.must_change_password ? 0.4 : 1 }}>
                              <FiKey size={14} />
                            </button>
                            {u.totp_enabled && (
                              <button className="btn-icon" onClick={() => reset2FA(u)} title="Réinitialiser la 2FA" style={{ color: '#7c3aed' }}>
                                <FiSmartphone size={14} />
                              </button>
                            )}
                            <button className="btn-icon danger" onClick={() => handleDelete(u)} title="Supprimer"><FiTrash2 size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '10px 16px', border: 'none', background: 'transparent',
        borderBottom: active ? '2px solid #10531a' : '2px solid transparent',
        color: active ? '#10531a' : '#6b7280', fontWeight: 600,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14,
      }}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, color }) {
  return (
    <div className="admin-card" style={{ padding: 12, borderLeft: `3px solid ${color}` }}>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function SortableTh({ sortKey, current, dir, onSort, children }) {
  const active = sortKey === current;
  return (
    <th onClick={() => onSort(sortKey)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {children} {active ? (dir === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
}
