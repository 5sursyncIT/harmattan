import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiEye, FiEyeOff, FiCheck } from 'react-icons/fi';
import { resetPassword } from '../api/dolibarr';
import './AuthPages.css';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const email = searchParams.get('email');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  if (!token || !email) {
    return (
      <div className="auth-page">
        <div className="container">
          <div className="auth-card">
            <h1>Lien invalide</h1>
            <p>Ce lien de réinitialisation est invalide ou a expiré.</p>
            <Link to="/mot-de-passe-oublie" className="btn btn-primary" style={{ marginTop: 16 }}>
              Refaire une demande
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setError('Les mots de passe ne correspondent pas'); return; }
    setLoading(true);
    setError('');
    try {
      await resetPassword({ email, token, password });
      setSuccess(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur serveur');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="auth-page">
        <div className="container">
          <div className="auth-card">
            <div className="auth-success">
              <FiCheck size={48} style={{ color: '#10531a', marginBottom: 16 }} />
              <h2>Mot de passe modifié !</h2>
              <p>Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.</p>
              <Link to="/connexion" className="btn btn-primary" style={{ marginTop: 16 }}>
                Se connecter
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-card">
          <h1>Nouveau mot de passe</h1>
          <p style={{ color: '#666', marginBottom: 20 }}>
            Choisissez un nouveau mot de passe pour <strong>{email}</strong>
          </p>

          {error && <div className="auth-error">{error}</div>}

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Nouveau mot de passe</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8 caractères min., 1 majuscule, 1 chiffre"
                  required
                  minLength={8}
                  autoFocus
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)} className="password-toggle" aria-label="Afficher le mot de passe">
                  {showPwd ? <FiEyeOff size={16} /> : <FiEye size={16} />}
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Confirmer le mot de passe</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirmez votre mot de passe"
                required
              />
            </div>

            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
              {loading ? 'Modification...' : 'Réinitialiser le mot de passe'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
