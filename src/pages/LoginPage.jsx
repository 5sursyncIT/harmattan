import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiEye, FiEyeOff, FiShoppingBag, FiEdit3 } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { loginCustomer } from '../api/dolibarr';
import { authorApi } from '../api/author';
import useAuthStore from '../store/authStore';
import useAuthorAuthStore from '../store/authorAuthStore';
import './AuthPages.css';

function ClientLoginForm() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    try {
      const res = await loginCustomer(email, password);
      login(res.data);
      toast.success(`Bienvenue, ${res.data.firstname || res.data.name} !`);
      navigate('/compte');
    } catch (err) {
      const status = err.response?.status;
      const msg = status === 404
        ? 'Aucun compte trouvé avec cet email'
        : status === 401
          ? 'Mot de passe incorrect'
          : err.response?.data?.error || 'Erreur de connexion';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card auth-card--client">
      <div className="auth-scope-header auth-scope-header--client">
        <span className="auth-scope-icon">
          <FiShoppingBag size={18} />
        </span>
        <div>
          <div className="auth-scope-label">Espace Client</div>
          <div className="auth-scope-sublabel">Achats, commandes, abonnement</div>
        </div>
      </div>

      <h2>Connexion client</h2>
      <p className="auth-subtitle">Connectez-vous à votre compte</p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="client-email">Email</label>
          <input
            id="client-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="votre@email.com"
            autoComplete="email"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="client-password">Mot de passe</label>
          <div className="password-field">
            <input
              id="client-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Votre mot de passe"
              autoComplete="current-password"
              required
              minLength={6}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? 'Masquer' : 'Afficher'}
            >
              {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
            </button>
          </div>
        </div>
        <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
          {loading ? 'Connexion...' : 'Se connecter'}
        </button>
        <p style={{ textAlign: 'right', marginTop: 8 }}>
          <Link to="/mot-de-passe-oublie" style={{ fontSize: '0.85rem', color: '#666' }}>Mot de passe oublié ?</Link>
        </p>
      </form>

      <p className="auth-link">
        Pas encore de compte ? <Link to="/inscription">Créer un compte</Link>
      </p>
    </div>
  );
}

function AuthorLoginForm() {
  const navigate = useNavigate();
  const login = useAuthorAuthStore((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    try {
      const res = await authorApi.login(email, password);
      login(res.data);
      toast.success(`Bienvenue, ${res.data.firstname || ''} !`);
      navigate('/auteur/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || 'Erreur de connexion';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-card auth-card--author">
      <div className="auth-scope-header auth-scope-header--author">
        <span className="auth-scope-icon">
          <FiEdit3 size={18} />
        </span>
        <div>
          <div className="auth-scope-label">Espace Auteur</div>
          <div className="auth-scope-sublabel">Soumission et suivi de manuscrits</div>
        </div>
      </div>

      <h2>Connexion auteur</h2>
      <p className="auth-subtitle">Suivez vos manuscrits et leurs étapes éditoriales</p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="author-email">Email</label>
          <input
            id="author-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="votre@email.com"
            autoComplete="email"
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="author-password">Mot de passe</label>
          <div className="password-field">
            <input
              id="author-password"
              type={showPwd ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Votre mot de passe"
              autoComplete="current-password"
              required
              minLength={6}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPwd(!showPwd)}
              aria-label={showPwd ? 'Masquer' : 'Afficher'}
            >
              {showPwd ? <FiEyeOff size={16} /> : <FiEye size={16} />}
            </button>
          </div>
        </div>
        <button type="submit" className="btn btn-author btn-lg" style={{ width: '100%' }} disabled={loading}>
          {loading ? 'Connexion...' : 'Se connecter'}
        </button>
        <p style={{ textAlign: 'right', marginTop: 8 }}>
          <Link to="/auteur/mot-de-passe-oublie" style={{ fontSize: '0.85rem', color: '#666' }}>Mot de passe oublié ?</Link>
        </p>
      </form>

      <p className="auth-link auth-link--author">
        Pas encore d'espace auteur ? <Link to="/auteur/inscription">Créer mon espace</Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-grid">
          <ClientLoginForm />
          <AuthorLoginForm />
        </div>
      </div>
    </div>
  );
}

export { ClientLoginForm, AuthorLoginForm };
