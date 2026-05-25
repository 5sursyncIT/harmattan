import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiSearch, FiRefreshCw, FiMail, FiEye, FiX, FiKey, FiCheckCircle, FiExternalLink, FiFileText, FiEdit2, FiDollarSign, FiGlobe } from 'react-icons/fi';
import toast from 'react-hot-toast';
import {
  getAdminAuthors, getAdminAuthor, resetAuthorPassword,
  updateAdminAuthor, notifyAuthorRoyalties,
} from '../../../api/admin';

const STAGE_LABELS = {
  submitted: 'Soumis', in_evaluation: 'En évaluation',
  evaluation_positive: 'Évaluation positive', evaluation_negative: 'Rejeté',
  contract_pending: 'Contrat en attente', contract_signed: 'Contrat signé',
  payment_pending: 'Paiement en attente', in_correction: 'En correction',
  correction_author_review: 'Relecture auteur', in_editorial: 'Validation éditoriale',
  editorial_validated: 'Validé', cover_design: 'Couverture',
  bat_author_review: 'BAT auteur', print_preparation: 'Préparation impression',
  printing: 'Impression', printed: 'Imprimé',
};
const STAGE_COLORS = {
  submitted: '#0284c7', in_evaluation: '#ea580c',
  evaluation_positive: '#10531a', evaluation_negative: '#dc2626',
  contract_pending: '#d97706', contract_signed: '#10531a',
  payment_pending: '#d97706', in_correction: '#0d9488',
  correction_author_review: '#7c3aed', in_editorial: '#0891b2',
  editorial_validated: '#10531a', cover_design: '#c026d3',
  bat_author_review: '#7c3aed', print_preparation: '#854d0e',
  printing: '#854d0e', printed: '#10531a',
};

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function StageBadge({ stage }) {
  if (!stage) return <span style={{ color: '#9ca3af' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 12,
      background: STAGE_COLORS[stage] || '#6b7280', color: '#fff',
      fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
    }}>
      {STAGE_LABELS[stage] || stage}
    </span>
  );
}

function AuthorDetailModal({ id, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [notifyLoading, setNotifyLoading] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    getAdminAuthor(id)
      .then((r) => {
        if (cancelled) return;
        setData(r.data);
        setForm({
          display_name: r.data.author.display_name || `${r.data.author.firstname} ${r.data.author.lastname}`.trim(),
          slug: r.data.author.slug || '',
          bio: r.data.author.bio || '',
          photo_url: r.data.author.photo_url || '',
          website: r.data.author.website || '',
          social_twitter: r.data.author.social_twitter || '',
          social_instagram: r.data.author.social_instagram || '',
          social_linkedin: r.data.author.social_linkedin || '',
          social_facebook: r.data.author.social_facebook || '',
          public_listed: !!r.data.author.public_listed,
        });
      })
      .catch(() => { if (!cancelled) toast.error('Erreur de chargement'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleReset = async () => {
    if (!window.confirm('Envoyer un email de réinitialisation de mot de passe à cet auteur ?')) return;
    try {
      const res = await resetAuthorPassword(id);
      toast.success(`Lien de réinitialisation envoyé à ${res.data.email}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await updateAdminAuthor(id, form);
      toast.success(`Profil mis à jour (slug: ${res.data.slug})`);
      setEditing(false);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  const handleNotifyRoyalties = async () => {
    if (!window.confirm('Envoyer à cet auteur un email récapitulatif de ses royalties dues sur l\'exercice en cours ?')) return;
    setNotifyLoading(true);
    try {
      const res = await notifyAuthorRoyalties(id);
      if (res.data.books === 0) {
        toast.success(`Email envoyé à ${res.data.email} (aucune royaltie due)`);
      } else {
        toast.success(`Email envoyé à ${res.data.email} — ${res.data.books} livre(s), ${res.data.total_due.toLocaleString('fr-FR')} XOF dus`);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    } finally {
      setNotifyLoading(false);
    }
  };

  const handleChange = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: val }));
  };

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal admin-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{loading ? 'Chargement…' : `${data?.author.firstname || ''} ${data?.author.lastname || ''}`}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Fermer"><FiX /></button>
        </div>
        {!loading && data && (
          <div className="admin-modal-body">
            <div className="admin-info-grid">
              <div><strong>Email</strong><span>{data.author.email} {data.author.email_verified ? <FiCheckCircle style={{ color: '#10531a', verticalAlign: 'middle' }} /> : null}</span></div>
              <div><strong>Téléphone</strong><span>{data.author.phone || '—'}</span></div>
              <div><strong>Inscrit le</strong><span>{formatDate(data.author.created_at)}</span></div>
              <div>
                <strong>Dolibarr</strong>
                <span>{data.author.dolibarr_thirdparty_id ? `#${data.author.dolibarr_thirdparty_id}` : '—'}</span>
              </div>
            </div>

            <section className="admin-modal-section">
              <h4>
                <FiFileText /> Manuscrits ({data.totals?.total || 0})
                <span className="admin-modal-section-total">
                  {data.totals?.accepted || 0} acceptés · {data.totals?.rejected || 0} rejetés · {data.totals?.pending || 0} en attente
                </span>
              </h4>
              {data.manuscripts?.length > 0 ? (
                <table className="admin-table">
                  <thead><tr><th>Réf.</th><th>Titre</th><th>Genre</th><th>Étape</th><th>Soumis le</th><th></th></tr></thead>
                  <tbody>
                    {data.manuscripts.map((m) => (
                      <tr key={m.id}>
                        <td>{m.ref}</td>
                        <td>{m.title}</td>
                        <td>{m.genre || '—'}</td>
                        <td><StageBadge stage={m.stage} /></td>
                        <td>{formatDate(m.created_at)}</td>
                        <td>
                          <Link to={`/admin/manuscripts/${m.id}`} className="btn-ghost" title="Ouvrir">
                            <FiExternalLink />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p style={{ color: '#6b7280', margin: 0 }}>Aucun manuscrit soumis.</p>}
            </section>

            <section className="admin-modal-section">
              <h4>
                <FiGlobe /> Profil public
                {data.author.public_listed && data.author.slug && (
                  <span style={{ marginLeft: 12, fontSize: 12, color: '#10531a', fontWeight: 600 }}>
                    Visible · <a href={`/auteur/${data.author.slug}`} target="_blank" rel="noreferrer" style={{ color: '#10531a' }}>/auteur/{data.author.slug}</a>
                  </span>
                )}
              </h4>
              {!editing ? (
                <div className="admin-info-grid">
                  <div><strong>Affichage</strong><span>{data.author.display_name || '—'}</span></div>
                  <div><strong>Slug</strong><span>{data.author.slug || '—'}</span></div>
                  <div><strong>Public</strong><span>{data.author.public_listed ? 'Oui' : 'Non'}</span></div>
                  <div><strong>Site web</strong><span>{data.author.website ? <a href={data.author.website} target="_blank" rel="noreferrer">{data.author.website}</a> : '—'}</span></div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <strong>Biographie</strong>
                    <span style={{ whiteSpace: 'pre-wrap' }}>{data.author.bio || '—'}</span>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSave} style={{ display: 'grid', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Nom d'affichage</strong>
                      <input type="text" value={form.display_name} onChange={handleChange('display_name')} style={{ width: '100%' }} />
                    </label>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Slug URL</strong>
                      <input type="text" value={form.slug} onChange={handleChange('slug')} placeholder="prenom-nom" style={{ width: '100%' }} />
                    </label>
                  </div>
                  <label>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Photo (URL)</strong>
                    <input type="url" value={form.photo_url} onChange={handleChange('photo_url')} placeholder="https://…/photo.jpg" style={{ width: '100%' }} />
                  </label>
                  <label>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Biographie</strong>
                    <textarea value={form.bio} onChange={handleChange('bio')} rows={6} maxLength={5000} style={{ width: '100%' }} />
                  </label>
                  <label>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Site web</strong>
                    <input type="url" value={form.website} onChange={handleChange('website')} placeholder="https://…" style={{ width: '100%' }} />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>Twitter / X</strong><input type="url" value={form.social_twitter} onChange={handleChange('social_twitter')} style={{ width: '100%' }} /></label>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>Instagram</strong><input type="url" value={form.social_instagram} onChange={handleChange('social_instagram')} style={{ width: '100%' }} /></label>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>LinkedIn</strong><input type="url" value={form.social_linkedin} onChange={handleChange('social_linkedin')} style={{ width: '100%' }} /></label>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>Facebook</strong><input type="url" value={form.social_facebook} onChange={handleChange('social_facebook')} style={{ width: '100%' }} /></label>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.public_listed} onChange={handleChange('public_listed')} />
                    <strong>Publier dans l'annuaire des auteurs</strong>
                  </label>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Annuler</button>
                    <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Sauvegarde…' : 'Enregistrer'}</button>
                  </div>
                </form>
              )}
            </section>

            <div className="admin-modal-actions">
              {!editing && (
                <button className="btn btn-primary" onClick={() => setEditing(true)}><FiEdit2 /> Éditer profil public</button>
              )}
              <button className="btn btn-outline" onClick={handleNotifyRoyalties} disabled={notifyLoading}>
                <FiDollarSign /> {notifyLoading ? 'Envoi…' : 'Envoyer récap royalties'}
              </button>
              <button className="btn btn-outline" onClick={handleReset}><FiKey /> Reset MDP</button>
              {data.author.dolibarr_thirdparty_id && (
                <a
                  className="btn btn-outline"
                  href={`/dolibarr/htdocs/societe/card.php?socid=${data.author.dolibarr_thirdparty_id}`}
                  target="_blank" rel="noreferrer"
                >
                  <FiExternalLink /> Fiche Dolibarr
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuthorsPanel() {
  const [authors, setAuthors] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    getAdminAuthors({ q, page, limit: 20 })
      .then((r) => {
        setAuthors(r.data.authors);
        setTotal(r.data.total);
        setPages(r.data.pages);
      })
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [q, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3 style={{ margin: 0 }}>Auteurs ({total})</h3>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Comptes du portail auteur (soumission de manuscrits). Liés aux fiches tiers Dolibarr.
          </p>
        </div>
        <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div className="admin-search-row">
          <div className="admin-search-input">
            <FiSearch />
            <input
              type="text"
              placeholder="Rechercher par email, nom, prénom ou téléphone…"
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value); }}
            />
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Auteur</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th style={{ textAlign: 'center' }}>Manuscrits</th>
              <th>Dernière étape</th>
              <th>Inscrit le</th>
              <th style={{ width: 130 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Chargement…</td></tr>
            ) : authors.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Aucun auteur</td></tr>
            ) : (
              authors.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.firstname} {a.lastname}</strong>
                    {!a.email_verified && <span style={{ marginLeft: 6, fontSize: 11, color: '#dc2626' }}>(email non vérifié)</span>}
                    {a.public_listed ? (
                      <span style={{ marginLeft: 6, fontSize: 10, padding: '2px 6px', background: '#dcfce7', color: '#166534', borderRadius: 999, fontWeight: 700 }}>PUBLIC</span>
                    ) : null}
                  </td>
                  <td><a href={`mailto:${a.email}`} style={{ color: '#10531a' }}>{a.email}</a></td>
                  <td>{a.phone || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{a.manuscript_count || 0}</td>
                  <td><StageBadge stage={a.latest_stage} /></td>
                  <td>{formatDate(a.created_at)}</td>
                  <td>
                    <button className="btn-ghost" onClick={() => setSelected(a.id)} title="Voir détails"><FiEye /></button>
                    <a href={`mailto:${a.email}`} className="btn-ghost" title="Envoyer un email"><FiMail /></a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="admin-pagination">
            <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button>
            <span>Page {page} / {pages}</span>
            <button className="btn btn-outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Suivant</button>
          </div>
        )}
      </div>

      {selected && <AuthorDetailModal id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
