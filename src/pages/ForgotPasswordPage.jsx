import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiMail, FiArrowLeft } from 'react-icons/fi';
import { forgotPassword } from '../api/dolibarr';
import './AuthPages.css';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError('');
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur serveur');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-card">
          <h1>Mot de passe oublié</h1>

          {sent ? (
            <div className="auth-success">
              <FiMail size={48} style={{ color: '#10531a', marginBottom: 16 }} />
              <h2>Email envoyé !</h2>
              <p>Si un compte existe avec l'adresse <strong>{email}</strong>, vous recevrez un lien de réinitialisation.</p>
              <p style={{ fontSize: '0.85rem', color: '#666', marginTop: 12 }}>Pensez à vérifier vos spams.</p>
              <Link to="/connexion" className="btn btn-primary" style={{ marginTop: 16 }}>
                Retour à la connexion
              </Link>
            </div>
          ) : (
            <>
              <p style={{ color: '#666', marginBottom: 20 }}>
                Saisissez votre adresse email. Vous recevrez un lien pour réinitialiser votre mot de passe.
              </p>

              {error && <div className="auth-error">{error}</div>}

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label>Adresse email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="votre@email.com"
                    required
                    autoFocus
                  />
                </div>

                <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
                  {loading ? 'Envoi...' : 'Envoyer le lien de réinitialisation'}
                </button>
              </form>

              <p className="auth-link">
                <Link to="/connexion"><FiArrowLeft size={14} /> Retour à la connexion</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
