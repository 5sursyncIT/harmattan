import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import { loginCustomer } from '../api/dolibarr';
import useAuthStore from '../store/authStore';
import toast from 'react-hot-toast';
import './AuthPages.css';

export default function LoginPage() {
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
    <div className="auth-page">
      <div className="container">
        <div className="auth-card">
          <h1>Connexion</h1>
          <p className="auth-subtitle">Connectez-vous à votre compte</p>

          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="votre@email.com"
                required
              />
            </div>
            <div className="form-group">
              <label>Mot de passe</label>
              <div className="password-field">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Votre mot de passe"
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
      </div>
    </div>
  );
}
