import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiPlus, FiLogOut, FiUser } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import useAuthorAuthStore from '../../store/authorAuthStore';
import './AuthorPages.css';

function stageBadge(stage) {
  const colorMap = {
    submitted: 'var(--badge-blue, #0284c7)',
    in_evaluation: 'var(--badge-orange, #ea580c)',
    evaluation_positive: 'var(--badge-green, #10531a)',
    evaluation_negative: 'var(--badge-red, #dc2626)',
    contract_pending: 'var(--badge-amber, #d97706)',
    contract_signed: 'var(--badge-green, #10531a)',
    payment_pending: 'var(--badge-amber, #d97706)',
    in_correction: 'var(--badge-teal, #0d9488)',
    correction_author_review: 'var(--badge-purple, #7c3aed)',
    in_editorial: 'var(--badge-cyan, #0891b2)',
    editorial_validated: 'var(--badge-green, #10531a)',
    cover_design: 'var(--badge-magenta, #c026d3)',
    bat_author_review: 'var(--badge-purple, #7c3aed)',
    print_preparation: 'var(--badge-brown, #854d0e)',
    printing: 'var(--badge-brown, #854d0e)',
    printed: 'var(--badge-green, #10531a)',
  };
  return colorMap[stage] || '#6b7280';
}

export default function AuthorDashboard() {
  const navigate = useNavigate();
  const { author, logout } = useAuthorAuthStore();
  const [manuscripts, setManuscripts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authorApi.listManuscripts()
      .then((res) => setManuscripts(res.data))
      .catch((err) => {
        if (err.response?.status === 401) {
          logout();
          navigate('/auteur/connexion');
        } else {
          toast.error('Erreur de chargement');
        }
      })
      .finally(() => setLoading(false));
  }, [logout, navigate]);

  const handleLogout = async () => {
    try { await authorApi.logout(); } catch (e) { void e; }
    logout();
    navigate('/auteur/connexion');
  };

  return (
    <div className="author-page">
      <div className="container">
        <div className="author-header">
          <div>
            <h1>Mon espace auteur</h1>
            <p className="author-subtitle">
              <FiUser /> {author?.firstname} {author?.lastname}
            </p>
          </div>
          <div className="author-actions">
            <Link to="/auteur/soumettre" className="btn btn-primary">
              <FiPlus /> Soumettre un manuscrit
            </Link>
            <button type="button" className="btn btn-ghost" onClick={handleLogout}>
              <FiLogOut /> Déconnexion
            </button>
          </div>
        </div>

        <h2>Mes manuscrits</h2>
        {loading ? (
          <p>Chargement...</p>
        ) : !manuscripts.length ? (
          <div className="author-empty">
            <p>Vous n'avez pas encore soumis de manuscrit.</p>
            <Link to="/auteur/soumettre" className="btn btn-primary">Soumettre mon premier manuscrit</Link>
          </div>
        ) : (
          <div className="author-manuscripts">
            {manuscripts.map((m) => (
              <Link
                key={m.id}
                to={`/auteur/manuscrits/${m.id}`}
                className="author-ms-card"
              >
                <div className="author-ms-header">
                  <h3>{m.title}</h3>
                  <span
                    className="author-ms-stage"
                    style={{ background: stageBadge(m.current_stage) }}
                  >
                    {m.stage_label}
                  </span>
                </div>
                <div className="author-ms-meta">
                  <span>{m.ref}</span>
                  {m.genre && <span>· {m.genre}</span>}
                  <span>· Soumis le {new Date(m.created_at).toLocaleDateString('fr-FR')}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
