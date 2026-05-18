import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiCheck, FiAlertCircle, FiBookOpen } from 'react-icons/fi';
import { authorApi } from '../../api/author';
import '../AuthPages.css';
import './AuthorActivatePage.css';

export default function AuthorActivatePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token');
  const email = params.get('email') || '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token || !email) {
      toast.error('Lien d\'activation invalide.');
    }
  }, [token, email]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      toast.error('Mot de passe : 8 caractères min, 1 majuscule, 1 chiffre.');
      return;
    }
    if (password !== confirm) {
      toast.error('Les mots de passe ne correspondent pas.');
      return;
    }
    setLoading(true);
    try {
      await authorApi.resetPassword({ email, token, password });
      setDone(true);
      toast.success('Espace activé ! Connexion en cours…');
      // Auto-login après activation
      try {
        await authorApi.login(email, password);
        setTimeout(() => navigate('/auteur/dashboard'), 800);
      } catch {
        setTimeout(() => navigate('/auteur/connexion'), 1200);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Lien expiré ou invalide.');
    } finally { setLoading(false); }
  };

  if (!token || !email) {
    return (
      <div className="auth-page">
        <div className="container">
          <div className="auth-card act-card">
            <FiAlertCircle size={36} color="#dc2626" />
            <h1>Lien invalide</h1>
            <p>Le lien d'activation est incomplet ou a expiré.</p>
            <p className="auth-link">
              <Link to="/auteur/connexion">Aller à la connexion</Link>
              {' · '}
              <Link to="/auteur/mot-de-passe-oublie">Recevoir un nouveau lien</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="auth-page">
        <div className="container">
          <div className="auth-card act-card">
            <FiCheck size={48} color="#10531a" />
            <h1>Bienvenue !</h1>
            <p>Votre espace auteur est actif. Redirection en cours…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-card act-card">
          <div className="act-icon"><FiBookOpen size={28} /></div>
          <h1>Activez votre espace auteur</h1>
          <p className="auth-subtitle">
            Pour suivre votre manuscrit et échanger avec notre équipe, créez votre mot de passe ci-dessous.
          </p>
          <p className="act-email">
            <strong>Compte :</strong> {email}
          </p>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="password">Mot de passe</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                autoFocus
              />
              <small style={{ color: '#666', fontSize: '0.78rem' }}>
                8 caractères min, une majuscule et un chiffre.
              </small>
            </div>
            <div className="form-group">
              <label htmlFor="confirm">Confirmer le mot de passe</label>
              <input
                id="confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-lg"
              style={{ width: '100%' }}
              disabled={loading}
            >
              {loading ? 'Activation…' : 'Activer mon espace'}
            </button>
          </form>

          <p className="auth-link" style={{ marginTop: 16 }}>
            Vous avez déjà un mot de passe ? <Link to="/auteur/connexion">Connectez-vous</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
