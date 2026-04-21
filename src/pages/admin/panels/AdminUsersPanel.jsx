import { useState, useEffect } from 'react';
import { getAdminUsers, createAdminUser, updateAdminUser, deleteAdminUser } from '../../../api/admin';
import { FiUserPlus, FiTrash2, FiShield, FiEdit2, FiSave, FiX, FiKey } from 'react-icons/fi';
import toast from 'react-hot-toast';

const ROLES = [
  { value: 'super_admin', label: 'Super Admin', color: '#7c3aed' },
  { value: 'admin', label: 'Admin', color: '#10531a' },
  { value: 'editor', label: 'Éditeur', color: '#0284c7' },
  { value: 'support', label: 'Support', color: '#f59e0b' },
  { value: 'librarian', label: 'Libraire', color: '#0891b2' },
  { value: 'comptable', label: 'Comptable', color: '#0d9488' },
  { value: 'vendeur', label: 'Vendeur POS', color: '#dc2626' },
  { value: 'evaluateur', label: 'Évaluateur', color: '#9333ea' },
  { value: 'correcteur', label: 'Correcteur', color: '#14b8a6' },
  { value: 'infographiste', label: 'Infographiste', color: '#c026d3' },
  { value: 'imprimeur', label: 'Imprimeur', color: '#854d0e' },
];

export default function AdminUsersPanel() {
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('admin');
  const [creating, setCreating] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ username: '', role: '', password: '' });
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    getAdminUsers().then((res) => setUsers(res.data)).catch(() => {});
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return toast.error('Min. 8 caractères, 1 majuscule, 1 chiffre');
    }
    setCreating(true);
    try {
      const res = await createAdminUser({ username: username.trim(), password, role });
      setUsers([...users, res.data]);
      setUsername('');
      setPassword('');
      setShowForm(false);
      toast.success(`Admin "${res.data.username}" créé`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (user) => {
    if (!confirm(`Supprimer l'administrateur "${user.username}" ?`)) return;
    try {
      await deleteAdminUser(user.id);
      setUsers(users.filter((u) => u.id !== user.id));
      toast.success('Administrateur supprimé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const startEdit = (user) => {
    setEditingId(user.id);
    setEditForm({ username: user.username, role: user.role, password: '' });
    setShowPasswordField(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ username: '', role: '', password: '' });
    setShowPasswordField(false);
  };

  const handleUpdate = async (user) => {
    const payload = {};
    if (editForm.username.trim() && editForm.username.trim() !== user.username) {
      payload.username = editForm.username.trim();
    }
    if (editForm.role && editForm.role !== user.role) {
      payload.role = editForm.role;
    }
    if (showPasswordField && editForm.password) {
      if (editForm.password.length < 8 || !/[A-Z]/.test(editForm.password) || !/[0-9]/.test(editForm.password)) {
        return toast.error('Mot de passe : min. 8 car., 1 majuscule, 1 chiffre');
      }
      payload.password = editForm.password;
    }
    if (Object.keys(payload).length === 0) {
      toast.error('Aucune modification à enregistrer');
      return;
    }
    setUpdating(true);
    try {
      const res = await updateAdminUser(user.id, payload);
      setUsers(users.map((u) => (u.id === user.id ? res.data : u)));
      toast.success('Administrateur mis à jour');
      cancelEdit();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur mise à jour');
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0 }}>Utilisateurs ({users.length})</h3>
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          <FiUserPlus /> Nouvel utilisateur
        </button>
      </div>

      {showForm && (
        <div className="admin-card" style={{ marginBottom: '1rem' }}>
          <form onSubmit={handleCreate} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="admin-field" style={{ flex: 1, minWidth: 180 }}>
              <label>Nom d'utilisateur</label>
              <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ex: bachir" required />
            </div>
            <div className="admin-field" style={{ flex: 1, minWidth: 200 }}>
              <label>Mot de passe</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Min. 8 car., 1 maj., 1 chiffre" required />
            </div>
            <div className="admin-field" style={{ minWidth: 140 }}>
              <label>Rôle</label>
              <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}>
                {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? 'Création...' : 'Créer'}
            </button>
          </form>
        </div>
      )}

      <div className="admin-card">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Utilisateur</th>
              <th>Rôle</th>
              <th>Créé le</th>
              <th style={{ width: 140 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const roleInfo = ROLES.find(r => r.value === u.role) || ROLES[1];
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
                            title="Annuler changement de mot de passe"
                          ><FiX size={12} /></button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setShowPasswordField(true)}
                          style={{ marginTop: 6, padding: '4px 10px', background: '#fff', border: '1px dashed #9ca3af', borderRadius: 6, cursor: 'pointer', fontSize: '0.75rem', color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          <FiKey size={11} /> Réinitialiser le mot de passe
                        </button>
                      )}
                    </td>
                    <td>
                      <select
                        value={editForm.role}
                        onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
                      >
                        {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </td>
                    <td>{new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="btn-icon"
                          onClick={() => handleUpdate(u)}
                          disabled={updating}
                          title="Enregistrer"
                          style={{ color: '#10531a' }}
                        ><FiSave size={14} /></button>
                        <button
                          className="btn-icon"
                          onClick={cancelEdit}
                          disabled={updating}
                          title="Annuler"
                        ><FiX size={14} /></button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
                <tr key={u.id}>
                  <td style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <FiShield size={16} style={{ color: roleInfo.color }} />
                    <strong>{u.username}</strong>
                  </td>
                  <td><span style={{ padding: '2px 8px', borderRadius: 4, background: `${roleInfo.color}15`, color: roleInfo.color, fontSize: '0.8rem', fontWeight: 700 }}>{roleInfo.label}</span></td>
                  <td>{new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-icon" onClick={() => startEdit(u)} title="Modifier"><FiEdit2 size={14} /></button>
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
  );
}
