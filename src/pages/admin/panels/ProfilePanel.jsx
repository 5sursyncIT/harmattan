import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  adminChangePassword, adminMe,
  setup2FA, verify2FA, disable2FA,
} from '../../../api/admin';
import toast from 'react-hot-toast';
import { FiShield, FiSmartphone, FiCopy, FiCheck, FiAlertTriangle } from 'react-icons/fi';

const ROLE_LABELS = {
  super_admin: 'Super Administrateur',
  admin: 'Administrateur',
  editor: 'Éditeur',
  support: 'Support',
  librarian: 'Libraire',
  comptable: 'Comptable',
  vendeur: 'Vendeur POS',
  evaluateur: 'Évaluateur',
  correcteur: 'Correcteur',
  infographiste: 'Infographiste',
  imprimeur: 'Imprimeur',
};

export default function ProfilePanel() {
  const { adminUsername, adminRole } = useOutletContext();
  const [current, setCurrent] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  // Données /me (pour totpEnabled, email)
  const [me, setMe] = useState(null);

  // 2FA setup state
  const [setupData, setSetupData] = useState(null); // { secret, otpauthUrl }
  const [setupCode, setSetupCode] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // 2FA disable state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);

  useEffect(() => {
    adminMe().then((r) => setMe(r.data)).catch(() => {});
  }, []);

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (newPw.length < 8 || !/[A-Z]/.test(newPw) || !/[0-9]/.test(newPw)) return toast.error('Min. 8 caractères, 1 majuscule et 1 chiffre');
    if (newPw !== confirm) return toast.error('Les mots de passe ne correspondent pas');
    setSaving(true);
    try {
      await adminChangePassword(current, newPw);
      toast.success('Mot de passe modifié');
      setCurrent(''); setNewPw(''); setConfirm('');
      const r = await adminMe();
      setMe(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  async function handleStartSetup() {
    setSetupBusy(true);
    try {
      const res = await setup2FA();
      setSetupData(res.data);
      setSetupCode('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setSetupBusy(false);
    }
  }

  async function handleVerifySetup() {
    if (!/^\d{6}$/.test(setupCode.trim())) return toast.error('Code à 6 chiffres requis');
    setSetupBusy(true);
    try {
      await verify2FA(setupCode.trim());
      toast.success('2FA activée');
      setSetupData(null);
      setSetupCode('');
      const r = await adminMe();
      setMe(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Code invalide');
    } finally {
      setSetupBusy(false);
    }
  }

  async function handleDisable() {
    if (!disablePw) return toast.error('Mot de passe requis');
    if (!/^\d{6}$/.test(disableCode.trim())) return toast.error('Code 2FA à 6 chiffres requis');
    setDisableBusy(true);
    try {
      await disable2FA(disablePw, disableCode.trim());
      toast.success('2FA désactivée');
      setShowDisable(false);
      setDisablePw(''); setDisableCode('');
      const r = await adminMe();
      setMe(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setDisableBusy(false);
    }
  }

  function copySecret() {
    if (!setupData?.secret) return;
    navigator.clipboard.writeText(setupData.secret).then(() => {
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 2000);
    });
  }

  return (
    <div className="admin-panel">
      {adminRole === 'vendeur' && (
        <div className="admin-card" style={{ background: '#fef3c7', border: '1px solid #fcd34d' }}>
          <h3 style={{ margin: '0 0 8px', color: '#92400e' }}>Profil Vendeur POS</h3>
          <p style={{ margin: 0, color: '#78350f', fontSize: '0.9rem' }}>
            Votre compte est dédié à la caisse. Pour vendre, utilisez l'interface POS avec votre code PIN :{' '}
            <a href="/pos/connexion" style={{ color: '#92400e', fontWeight: 700, textDecoration: 'underline' }}>→ Accéder au POS</a>
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
          {me?.email && (
            <div className="admin-field" style={{ marginTop: 12 }}>
              <label>Email</label>
              <input value={me.email} disabled />
            </div>
          )}
        </div>
      </div>

      {/* ─── 2FA ─────────────────────────────────────────────── */}
      <div className="admin-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <FiSmartphone size={20} style={{ color: '#7c3aed' }} />
          <h3 style={{ margin: 0 }}>Authentification à deux facteurs (2FA)</h3>
          {me?.totpEnabled && (
            <span style={{ marginLeft: 'auto', padding: '4px 10px', borderRadius: 12, background: '#ede9fe', color: '#6d28d9', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <FiShield size={12} /> Activée
            </span>
          )}
        </div>

        {!me?.totpEnabled && !setupData && (
          <>
            <p style={{ color: '#374151', fontSize: 14, marginTop: 0 }}>
              Renforcez la sécurité de votre compte en ajoutant un code à 6 chiffres généré par une app authenticator (Google Authenticator, Authy, 1Password, Microsoft Authenticator…).
            </p>
            <button className="btn btn-primary" onClick={handleStartSetup} disabled={setupBusy}>
              {setupBusy ? 'Génération…' : 'Activer la 2FA'}
            </button>
          </>
        )}

        {!me?.totpEnabled && setupData && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ padding: 12, background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, color: '#92400e', fontSize: 13 }}>
              <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 6 }} />
              <strong>Important :</strong> notez le code de récupération dans un endroit sûr. Sans accès à votre app, vous devrez demander à un super_admin de réinitialiser votre 2FA.
            </div>

            <div>
              <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', display: 'block', marginBottom: 6 }}>
                1. Ouvrez votre app authenticator → « Ajouter un compte » → « Saisir une clé manuellement »
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{
                  flex: 1, padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb',
                  borderRadius: 6, fontSize: 14, fontFamily: 'monospace', letterSpacing: 2, wordBreak: 'break-all',
                }}>{setupData.secret}</code>
                <button onClick={copySecret} className="btn-icon" title="Copier le secret" style={{ padding: '8px 12px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6 }}>
                  {copiedSecret ? <FiCheck size={16} style={{ color: '#10531a' }} /> : <FiCopy size={16} />}
                </button>
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', margin: '6px 0 0' }}>
                Type : TOTP — Algorithme : SHA1 — Chiffres : 6 — Période : 30s
              </p>
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: '#0284c7' }}>Ou collez ce lien dans l'app</summary>
                <code style={{ display: 'block', marginTop: 6, padding: 8, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 11, wordBreak: 'break-all', fontFamily: 'monospace' }}>
                  {setupData.otpauthUrl}
                </code>
              </details>
            </div>

            <div>
              <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', display: 'block', marginBottom: 6 }}>
                2. Saisissez le code à 6 chiffres affiché dans l'app
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  style={{ flex: 1, padding: 10, border: '1px solid #d1d5db', borderRadius: 6, fontSize: 18, letterSpacing: 4, fontFamily: 'monospace', textAlign: 'center' }}
                />
                <button className="btn btn-primary" onClick={handleVerifySetup} disabled={setupBusy || setupCode.length !== 6}>
                  {setupBusy ? '…' : 'Activer'}
                </button>
                <button className="btn" onClick={() => { setSetupData(null); setSetupCode(''); }} disabled={setupBusy} style={{ background: '#fff', border: '1px solid #d1d5db' }}>
                  Annuler
                </button>
              </div>
            </div>
          </div>
        )}

        {me?.totpEnabled && !showDisable && (
          <>
            <p style={{ color: '#374151', fontSize: 14, marginTop: 0 }}>
              Votre compte est protégé par la 2FA. À chaque connexion, vous devrez saisir le code à 6 chiffres généré par votre app authenticator.
            </p>
            <button className="btn" onClick={() => setShowDisable(true)} style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
              Désactiver la 2FA
            </button>
          </>
        )}

        {me?.totpEnabled && showDisable && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={{ margin: 0, color: '#dc2626', fontSize: 13 }}>
              Pour désactiver la 2FA, confirmez votre mot de passe et saisissez un code valide.
            </p>
            <div className="admin-field">
              <label>Mot de passe actuel</label>
              <input type="password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
            </div>
            <div className="admin-field">
              <label>Code 2FA actuel</label>
              <input type="text" inputMode="numeric" maxLength={6} value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={handleDisable} disabled={disableBusy} style={{ background: '#dc2626' }}>
                {disableBusy ? '…' : 'Désactiver'}
              </button>
              <button className="btn" onClick={() => { setShowDisable(false); setDisablePw(''); setDisableCode(''); }} style={{ background: '#fff', border: '1px solid #d1d5db' }}>
                Annuler
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="admin-card">
        <h3>Changer le mot de passe</h3>
        <form onSubmit={handlePasswordSubmit} className="admin-password-form">
          <div className="admin-field">
            <label>Mot de passe actuel</label>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
          </div>
          <div className="admin-field">
            <label>Nouveau mot de passe</label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} required minLength={8} placeholder="Min. 8 caractères, 1 majuscule, 1 chiffre" autoComplete="new-password" />
          </div>
          <div className="admin-field">
            <label>Confirmer le nouveau mot de passe</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
          </div>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Modification…' : 'Modifier le mot de passe'}
          </button>
        </form>
      </div>
    </div>
  );
}
