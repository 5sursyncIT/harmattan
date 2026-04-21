import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { adminChangePassword } from '../../../api/admin';
import toast from 'react-hot-toast';

const ROLE_LABELS = {
  super_admin: 'Super Administrateur',
  admin: 'Administrateur',
  editor: 'Éditeur',
  support: 'Support',
  librarian: 'Libraire',
  comptable: 'Comptable',
  vendeur: 'Vendeur POS',
};

export default function ProfilePanel() {
  const { adminUsername, adminRole } = useOutletContext();
  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (newPw.length < 8 || !/[A-Z]/.test(newPw) || !/[0-9]/.test(newPw)) return toast.error('Min. 8 caractères, 1 majuscule et 1 chiffre');
    if (newPw !== confirm) return toast.error('Les mots de passe ne correspondent pas');

    setSaving(true);
    try {
      await adminChangePassword(current, newPw);
      toast.success('Mot de passe modifié');
      setCurrent('');
      setNewPw('');
      setConfirm('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-panel">
      {adminRole === 'vendeur' && (
        <div className="admin-card" style={{ background: '#fef3c7', border: '1px solid #fcd34d', marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 8px', color: '#92400e' }}>Profil Vendeur POS</h3>
          <p style={{ margin: 0, color: '#78350f', fontSize: '0.9rem' }}>
            Votre compte est dédié à la caisse. Pour vendre, utilisez l'interface POS avec votre code PIN :
            <br />
            <a href="/pos/connexion" style={{ color: '#92400e', fontWeight: 700, textDecoration: 'underline' }}>
              → Accéder au POS
            </a>
          </p>
        </div>
      )}
      <div className="admin-card">
        <h3>Informations du compte</h3>
        <div className="admin-profile-info">
          <div className="admin-field">
            <label>Nom d'utilisateur</label>
            <input value={adminUsername || ''} disabled />
          </div>
          <div className="admin-field" style={{ marginTop: 12 }}>
            <label>Rôle</label>
            <input value={ROLE_LABELS[adminRole] || adminRole || ''} disabled />
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ marginTop: '1.5rem' }}>
        <h3>Changer le mot de passe</h3>
        <form onSubmit={handleSubmit} className="admin-password-form">
          <div className="admin-field">
            <label>Mot de passe actuel</label>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </div>
          <div className="admin-field">
            <label>Nouveau mot de passe</label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required minLength={8} placeholder="Min. 8 caractères, 1 majuscule, 1 chiffre" />
          </div>
          <div className="admin-field">
            <label>Confirmer le nouveau mot de passe</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Modification...' : 'Modifier le mot de passe'}
          </button>
        </form>
      </div>
    </div>
  );
}
