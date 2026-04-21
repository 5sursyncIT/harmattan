import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import useAuthorAuthStore from '../../store/authorAuthStore';
import '../AuthPages.css';

export default function AuthorRegisterPage() {
  const navigate = useNavigate();
  const login = useAuthorAuthStore((s) => s.login);
  const [form, setForm] = useState({ email: '', password: '', firstname: '', lastname: '', phone: '' });
  const [loading, setLoading] = useState(false);

  const update = (k, v) => setForm((prev) => ({ ...prev, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await authorApi.register(form);
      login(res.data);
      toast.success('Espace auteur créé avec succès');
      navigate('/auteur/dashboard');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de création du compte');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="container">
        <div className="auth-card">
          <h1>Créer mon espace auteur</h1>
          <p className="auth-subtitle">Soumettez vos manuscrits et suivez leur évolution</p>

          <form onSubmit={handleSubmit}>
            <div className="form-row">
              <div className="form-group">
                <label>Prénom</label>
                <input type="text" value={form.firstname} onChange={(e) => update('firstname', e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Nom</label>
                <input type="text" value={form.lastname} onChange={(e) => update('lastname', e.target.value)} required />
              </div>
            </div>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Téléphone</label>
              <input type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} />
            </div>
            <div className="form-group">
              <label>Mot de passe</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                minLength={8}
                required
              />
              <small style={{ color: '#666', fontSize: '0.75rem' }}>
                Au moins 8 caractères, une majuscule et un chiffre
              </small>
            </div>
            <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={loading}>
              {loading ? 'Création...' : 'Créer mon espace'}
            </button>
          </form>

          <p className="auth-link">
            Déjà inscrit ? <Link to="/auteur/connexion">Se connecter</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
