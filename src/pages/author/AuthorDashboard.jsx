import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FiPlus, FiLogOut, FiUser, FiSettings, FiBook, FiFileText, FiDollarSign, FiTrendingUp, FiExternalLink, FiEdit2 } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import useAuthorAuthStore from '../../store/authorAuthStore';
import NotificationBell from '../../components/author/NotificationBell';
import AuthorPublicProfileModal from './AuthorPublicProfileModal';
import { formatPrice } from '../../utils/formatters';
import './AuthorPages.css';
import './AuthorDashboard.css';

function stageBadge(stage) {
  const colorMap = {
    submitted: '#0284c7',
    in_evaluation: '#ea580c',
    evaluation_positive: '#10531a',
    evaluation_negative: '#dc2626',
    contract_pending: '#d97706',
    contract_signed: '#10531a',
    payment_pending: '#d97706',
    in_correction: '#0d9488',
    correction_author_review: '#7c3aed',
    in_editorial: '#0891b2',
    editorial_validated: '#10531a',
    cover_design: '#c026d3',
    bat_author_review: '#7c3aed',
    print_preparation: '#854d0e',
    printing: '#854d0e',
    printed: '#10531a',
  };
  return colorMap[stage] || '#6b7280';
}

function StatCard(props) {
  const { Icon, label, value, sub, color = '#10531a' } = props;
  return (
    <div className="author-stat-card" style={{ borderLeftColor: color }}>
      <div className="author-stat-icon" style={{ background: `${color}15`, color }}>
        <Icon size={20} />
      </div>
      <div className="author-stat-body">
        <p className="author-stat-label">{label}</p>
        <p className="author-stat-value">{value}</p>
        {sub && <p className="author-stat-sub">{sub}</p>}
      </div>
    </div>
  );
}

export default function AuthorDashboard() {
  const navigate = useNavigate();
  const { author, logout } = useAuthorAuthStore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const reload = () => {
    setLoading(true);
    authorApi.dashboard()
      .then((res) => setData(res.data))
      .catch((err) => {
        if (err.response?.status === 401) {
          logout();
          navigate('/auteur/connexion');
        } else {
          toast.error('Erreur de chargement du tableau de bord');
        }
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    try { await authorApi.logout(); } catch (e) { void e; }
    logout();
    navigate('/auteur/connexion');
  };

  if (loading) {
    return (
      <div className="author-page">
        <div className="container"><p>Chargement…</p></div>
      </div>
    );
  }

  const manuscripts = data?.manuscripts || [];
  const stats = data?.manuscript_stats || {};
  const sales = data?.sales || {};
  const royalties = data?.royalties || { by_book: [], total_due: 0, year: new Date().getFullYear() };
  const contracts = data?.contracts || [];
  const books = data?.books || [];

  return (
    <div className="author-page">
      <div className="container">
        <div className="author-header">
          <div>
            <h1>Mon espace auteur</h1>
            <p className="author-subtitle">
              <FiUser /> {author?.firstname} {author?.lastname}
              {data?.author?.public_listed && data?.author?.slug && (
                <Link
                  to={`/auteur/${data.author.slug}`}
                  className="author-public-link"
                  title="Voir mon profil public"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <FiExternalLink size={12} /> profil public
                </Link>
              )}
            </p>
          </div>
          <div className="author-actions">
            <NotificationBell />
            <button type="button" className="btn btn-outline" onClick={() => setEditProfileOpen(true)}>
              <FiEdit2 /> Mon profil public
            </button>
            <Link to="/auteur/soumettre" className="btn btn-primary">
              <FiPlus /> Soumettre un manuscrit
            </Link>
            <Link to="/auteur/preferences" className="btn btn-ghost" title="Préférences de notifications">
              <FiSettings /> Préférences
            </Link>
            <button type="button" className="btn btn-ghost" onClick={handleLogout}>
              <FiLogOut /> Déconnexion
            </button>
          </div>
        </div>

        {/* KPIs */}
        <div className="author-stats-grid">
          <StatCard
            Icon={FiFileText}
            label="Manuscrits"
            value={stats.total || 0}
            sub={`${stats.in_progress || 0} en cours · ${stats.printed || 0} publiés`}
            color="#0284c7"
          />
          <StatCard
            Icon={FiBook}
            label="Livres édités"
            value={books.length}
            sub={books.length ? `Dernière publication ${books[0]?.year || ''}` : 'Aucun ouvrage publié'}
            color="#10531a"
          />
          <StatCard
            Icon={FiTrendingUp}
            label="Exemplaires vendus"
            value={(sales.total_units || 0).toLocaleString('fr-FR')}
            sub={`${(sales.last_12_months_units || 0).toLocaleString('fr-FR')} sur 12 derniers mois`}
            color="#ea580c"
          />
          <StatCard
            Icon={FiDollarSign}
            label={`Royalties dues ${royalties.year}`}
            value={formatPrice(royalties.total_due || 0)}
            sub={royalties.by_book.length ? `${royalties.by_book.length} livre(s) au-dessus du seuil` : 'Aucune royaltie à ce jour'}
            color="#7c3aed"
          />
        </div>

        {/* Action requise (validations en attente) */}
        {stats.action_required > 0 && (
          <div className="author-action-banner">
            <div>
              <h3>{stats.action_required} action(s) requise(s)</h3>
              <p>Des corrections ou BAT attendent votre validation. Consultez vos manuscrits ci-dessous.</p>
            </div>
          </div>
        )}

        {/* Manuscrits */}
        <section className="author-section">
          <h2>Mes manuscrits</h2>
          {!manuscripts.length ? (
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
                    <span className="author-ms-stage" style={{ background: stageBadge(m.current_stage) }}>
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
        </section>

        {/* Royalties détail */}
        {royalties.by_book.length > 0 && (
          <section className="author-section">
            <h2>Royalties {royalties.year} — détail par livre</h2>
            <div className="author-table-wrap">
              <table className="author-table">
                <thead>
                  <tr>
                    <th>Livre</th>
                    <th>Contrat</th>
                    <th className="num">Ventes</th>
                    <th className="num">Au-dessus seuil</th>
                    <th className="num">Taux</th>
                    <th className="num">Royalty due</th>
                  </tr>
                </thead>
                <tbody>
                  {royalties.by_book.map((r) => (
                    <tr key={r.contract_id}>
                      <td><strong>{r.book_title}</strong></td>
                      <td>{r.contract_ref}</td>
                      <td className="num">{r.units_period}</td>
                      <td className="num">{r.units_over_threshold}</td>
                      <td className="num">{r.rate}%</td>
                      <td className="num"><strong>{formatPrice(r.royalty_due)}</strong></td>
                    </tr>
                  ))}
                  <tr className="author-table-total">
                    <td colSpan={5}><strong>Total dû {royalties.year}</strong></td>
                    <td className="num"><strong>{formatPrice(royalties.total_due)}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Contrats actifs */}
        {contracts.length > 0 && (
          <section className="author-section">
            <h2>Mes contrats ({contracts.length})</h2>
            <div className="author-table-wrap">
              <table className="author-table">
                <thead>
                  <tr>
                    <th>Référence</th>
                    <th>Titre</th>
                    <th>Type</th>
                    <th className="num">Taux</th>
                    <th>Statut</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id}>
                      <td>{c.ref}</td>
                      <td>{c.book_title || '—'}</td>
                      <td>{c.contract_type || '—'}</td>
                      <td className="num">{c.royalty_rate ? `${c.royalty_rate}%` : '—'}</td>
                      <td>
                        <span className={`author-contract-status status-${c.statut}`}>{c.statut_label}</span>
                      </td>
                      <td>{c.date ? new Date(c.date).toLocaleDateString('fr-FR') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Bibliographie */}
        {books.length > 0 && (
          <section className="author-section">
            <h2>Mes ouvrages publiés ({books.length})</h2>
            <div className="author-books-grid">
              {books.map((b) => (
                <Link key={b.id} to={`/produit/${b.id}`} className="author-book-mini">
                  <strong>{b.label}</strong>
                  <span>{b.year || ''}{b.editor ? ` · ${b.editor}` : ''}</span>
                  <span className="price">{formatPrice(b.price)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>

      {editProfileOpen && (
        <AuthorPublicProfileModal
          onClose={() => setEditProfileOpen(false)}
          onSaved={() => { setEditProfileOpen(false); reload(); }}
        />
      )}
    </div>
  );
}
