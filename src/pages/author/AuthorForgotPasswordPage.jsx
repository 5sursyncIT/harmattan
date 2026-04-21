import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import '../AuthPages.css';

export default function AuthorForgotPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const emailFromUrl = params.get('email') || '';

  const [email, setEmail] = useState(emailFromUrl);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleRequest = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await authorApi.forgotPassword(email);
      setSent(true);
      toast.success('Si cet email existe, un lien de réinitialisation vous a été envoyé.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setLoading(false); }
  };

  const handleReset = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await authorApi.resetPassword({ email, token, password });
      toast.success('Mot de passe réinitialisé, vous pouvez vous connecter.');
      setTimeout(() => window.location.assign('/auteur/connexion'), 1200);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setLoading(false); }
  };

  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-card">
          <h1>{token ? 'Nouveau mot de passe' : 'Mot de passe oublié'}</h1>
          {token ? (
            <form onSubmit={handleReset}>
              <div className="form-group">
                <label>Nouveau mot de passe</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
                <small style={{ color: '#666', fontSize: '0.75rem' }}>
                  8 caractères min, une majuscule et un chiffre
                </small>
              </div>
              <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
                {loading ? 'Envoi...' : 'Réinitialiser'}
              </button>
            </form>
          ) : sent ? (
            <p>Si un compte existe avec cette adresse, un email a été envoyé avec les instructions.</p>
          ) : (
            <form onSubmit={handleRequest}>
              <p className="auth-subtitle">Recevez un lien de réinitialisation par email</p>
              <div className="form-group">
                <label>Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
                {loading ? 'Envoi...' : 'Envoyer le lien'}
              </button>
            </form>
          )}
          <p className="auth-link">
            <Link to="/auteur/connexion">Retour à la connexion</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
