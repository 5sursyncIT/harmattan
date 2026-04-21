import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiEye, FiEyeOff } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import useAuthorAuthStore from '../../store/authorAuthStore';
import '../AuthPages.css';

export default function AuthorLoginPage() {
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
    <div className="auth-page">
      <div className="container">
        <div className="auth-card">
          <h1>Espace auteur</h1>
          <p className="auth-subtitle">Connectez-vous pour suivre vos manuscrits</p>

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
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Votre mot de passe"
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
            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
              {loading ? 'Connexion...' : 'Se connecter'}
            </button>
            <p style={{ textAlign: 'right', marginTop: 8 }}>
              <Link to="/auteur/mot-de-passe-oublie" style={{ fontSize: '0.85rem', color: '#666' }}>Mot de passe oublié ?</Link>
            </p>
          </form>

          <p className="auth-link">
            Pas encore d'espace auteur ? <Link to="/auteur/inscription">Créer mon espace</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
