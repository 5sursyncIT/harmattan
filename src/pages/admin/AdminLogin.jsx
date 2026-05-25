import { useState } from 'react';
import { adminLogin, adminLogin2FA } from '../../api/admin';
import toast from 'react-hot-toast';
import './Admin.css';

export default function AdminLogin({ onLogin }) {
  const [step, setStep] = useState('credentials'); // 'credentials' | '2fa'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState(null);
  const [loading, setLoading] = useState(false);

  const submitCredentials = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await adminLogin(username, password);
      if (res.data?.requires2FA) {
        setPendingToken(res.data.pendingToken);
        setStep('2fa');
        setCode('');
      } else {
        onLogin(res.data);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Identifiants invalides');
    } finally {
      setLoading(false);
    }
  };

  const submit2FA = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) return toast.error('Code à 6 chiffres requis');
    setLoading(true);
    try {
      const res = await adminLogin2FA(pendingToken, code.trim());
      onLogin(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Code invalide');
    } finally {
      setLoading(false);
    }
  };

  function reset() {
    setStep('credentials');
    setCode('');
    setPendingToken(null);
    setPassword('');
  }

  return (
    <div className="admin-login">
      {step === 'credentials' && (
        <form onSubmit={submitCredentials} className="admin-login-form">
          <img src="/images/logo.png" alt="Logo" className="admin-login-logo" />
          <h2>Administration</h2>
          <input type="text" placeholder="Nom d'utilisateur" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" />
          <input type="password" placeholder="Mot de passe" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          <button type="submit" disabled={loading}>{loading ? 'Connexion…' : 'Se connecter'}</button>
        </form>
      )}

      {step === '2fa' && (
        <form onSubmit={submit2FA} className="admin-login-form">
          <img src="/images/logo.png" alt="Logo" className="admin-login-logo" />
          <h2>Vérification 2FA</h2>
          <p style={{ margin: '0 0 12px', color: '#6b7280', fontSize: 14, textAlign: 'center' }}>
            Ouvrez votre app authenticator et saisissez le code à 6 chiffres pour <strong>{username}</strong>.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
            required
            style={{ textAlign: 'center', letterSpacing: 4, fontFamily: 'monospace', fontSize: 18 }}
          />
          <button type="submit" disabled={loading || code.length !== 6}>{loading ? 'Vérification…' : 'Valider'}</button>
          <button type="button" onClick={reset} style={{ background: 'transparent', color: '#6b7280', marginTop: 8 }}>
            ← Recommencer
          </button>
        </form>
      )}
    </div>
  );
}
