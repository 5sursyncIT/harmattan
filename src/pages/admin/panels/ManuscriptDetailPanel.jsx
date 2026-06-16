import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiUser, FiPlus, FiExternalLink } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { manuscriptsApi, intervenantsApi } from '../../../api/manuscripts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import ManuscriptTimeline from '../../../components/common/ManuscriptTimeline';
import './ManuscriptsWorkflow.css';

// Acteurs externes affectés depuis le carnet d'intervenants (colonnes *_contact_id).
// La Production éditoriale (validation éditoriale + couverture/BAT) reste un
// compte admin_users (assigned_editor_id) : fusion Éditeur + Infographiste.
const ASSIGN_ROWS = [
  'assigned_evaluator_contact_id',
  'assigned_corrector_contact_id',
  'assigned_editor_id',
  'assigned_printer_contact_id',
];
const ROLE_LABELS = {
  assigned_evaluator_contact_id: 'Évaluateur / lecteur',
  assigned_corrector_contact_id: 'Correcteur',
  assigned_editor_id: 'Production éditoriale',
  assigned_printer_contact_id: 'Imprimeur',
};
const ROLE_API = {
  assigned_evaluator_contact_id: 'evaluateur',
  assigned_corrector_contact_id: 'correcteur',
  assigned_editor_id: 'editor',
  assigned_printer_contact_id: 'imprimeur',
};
// Ancienne colonne (historique admin_users) associée à chaque ligne, pour rappel en lecture seule.
const LEGACY_COL = {
  assigned_evaluator_contact_id: 'assigned_evaluator_id',
  assigned_corrector_contact_id: 'assigned_corrector_id',
  assigned_printer_contact_id: 'assigned_printer_id',
};

export default function ManuscriptDetailPanel() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [assignModal, setAssignModal] = useState(null); // col name
  const [adminUsers, setAdminUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [applyToSeries, setApplyToSeries] = useState(false);
  // Création d'un intervenant directement depuis la fenêtre d'affectation.
  const [showNewIntervenant, setShowNewIntervenant] = useState(false);
  const [newIntervenant, setNewIntervenant] = useState({ nom: '', email: '' });
  const [creatingIntervenant, setCreatingIntervenant] = useState(false);

  const load = () => {
    setLoading(true);
    manuscriptsApi.get(id)
      .then((res) => setData(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load();   }, [id]);

  const openAssign = (col) => {
    setAssignModal(col);
    setSelectedUser('');
    setApplyToSeries(false);
    setShowNewIntervenant(false);
    setNewIntervenant({ nom: '', email: '' });
    manuscriptsApi.adminsByRole(ROLE_API[col])
      .then((res) => setAdminUsers(res.data))
      .catch(() => setAdminUsers([]));
  };

  // Crée un intervenant (carnet) pour le métier du modal courant, puis le sélectionne.
  const createIntervenant = async () => {
    const nom = newIntervenant.nom.trim();
    const email = newIntervenant.email.trim();
    if (!nom) return toast.error('Nom requis');
    if (!EMAIL_RE.test(email)) return toast.error('Email invalide');
    setCreatingIntervenant(true);
    try {
      const res = await intervenantsApi.create({ nom, email, metier: ROLE_API[assignModal] });
      const created = res.data;
      // Même forme {id, username, role} que adminsByRole pour réutiliser le select.
      setAdminUsers((prev) => [...prev, { id: created.id, username: created.nom, role: created.metier }]);
      setSelectedUser(String(created.id));
      setShowNewIntervenant(false);
      setNewIntervenant({ nom: '', email: '' });
      toast.success(`« ${created.nom} » ajouté et sélectionné`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setCreatingIntervenant(false);
    }
  };

  const confirmAssign = async () => {
    try {
      const res = await manuscriptsApi.assign(id, ROLE_API[assignModal], selectedUser ? parseInt(selectedUser, 10) : null, applyToSeries);
      const count = res.data?.count || 1;
      toast.success(applyToSeries && count > 1 ? `Assignation appliquée à ${count} tomes` : 'Assignation mise à jour');
      setAssignModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const markPaid = async () => {
    if (!confirm('Confirmer le paiement reçu et lancer la phase de correction ?')) return;
    try {
      await manuscriptsApi.markPaid(id, 'Paiement confirmé');
      toast.success('Paiement confirmé');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  if (loading) return <p>Chargement...</p>;
  if (!data) return null;
  const { manuscript, stages, files, evaluations, validations, series } = data;
  const seriesTomes = Array.isArray(series) ? series : [];
  const isSeries = Boolean(manuscript.series_ref) && seriesTomes.length > 1;

  return (
    <div className="ms-panel">
      <Link to="/admin/manuscripts" className="back-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, color: '#10531a', textDecoration: 'none' }}>
        <FiArrowLeft /> Retour à la liste
      </Link>
      <h2>{manuscript.title}</h2>
      {manuscript.subtitle && (
        <p style={{ margin: '-6px 0 8px', fontSize: '1.05rem', fontStyle: 'italic', color: '#475569' }}>{manuscript.subtitle}</p>
      )}
      <p className="ms-subtitle">
        Référence <strong>{manuscript.ref}</strong> ·
        <span className={`ms-stage-badge ms-stage-${manuscript.current_stage}`} style={{ marginLeft: 8 }}>
          {manuscript.stage_label}
        </span>
      </p>

      {isSeries && (
        <div className="ms-series-banner">
          <div className="ms-series-banner-head">
            <span>
              Fait partie de la série <strong>« {manuscript.series_title || manuscript.title} »</strong>
              {manuscript.tome_number ? ` — Tome ${manuscript.tome_number} sur ${manuscript.tome_total || seriesTomes.length}` : ''}
            </span>
          </div>
          <div className="ms-series-tomes">
            {seriesTomes.map((t) => (
              t.id === manuscript.id ? (
                <span key={t.id} className="ms-series-tome current" title={t.title}>
                  Tome {t.tome_number || '?'} (ce dossier)
                </span>
              ) : (
                <Link key={t.id} to={`/admin/manuscripts/${t.id}`} className="ms-series-tome" title={t.title}>
                  Tome {t.tome_number || '?'} — {t.stage_label}
                </Link>
              )
            ))}
          </div>
        </div>
      )}

      {manuscript.current_stage === 'payment_pending' && (
        <div className="ms-action-banner">
          <h4>Paiement en attente</h4>
          <p>Confirmez le paiement pour déclencher la phase de correction.</p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={markPaid}>Confirmer le paiement</button>
          </div>
        </div>
      )}

      <div className="ms-detail-layout">
        <div>
          <div className="ms-card">
            <h3>Informations</h3>
            <dl className="ms-meta-grid">
              <div>
                <dt>Auteur</dt>
                <dd><FiUser style={{ verticalAlign: 'middle' }} /> {manuscript.author_name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{manuscript.author_email}</dd>
              </div>
              <div>
                <dt>Genre</dt>
                <dd>{manuscript.genre || '—'}</dd>
              </div>
              <div>
                <dt>ISBN</dt>
                <dd>{manuscript.isbn || '—'}</dd>
              </div>
              <div>
                <dt>Tirage prévu</dt>
                <dd>{manuscript.print_qty || '—'}</dd>
              </div>
              <div>
                <dt>Contrat Dolibarr</dt>
                <dd>{manuscript.contract_id ? `#${manuscript.contract_id}` : '—'}</dd>
              </div>
              <div>
                <dt>Ordre d'impression</dt>
                <dd>{manuscript.dolibarr_mo_ref || '—'}</dd>
              </div>
            </dl>
            {manuscript.synopsis && (
              <>
                <h3 style={{ marginTop: 16 }}>Synopsis</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{manuscript.synopsis}</p>
              </>
            )}
          </div>

          <div className="ms-card">
            <h3>Fichiers ({files?.length || 0})</h3>
            {files?.length ? (
              <ul className="ms-file-list">
                {files.map((f) => (
                  <li key={f.id}>
                    <div>
                      <span className="ms-file-kind">{f.kind}</span>
                      {f.version > 1 && <strong>v{f.version}</strong>} {f.file_name}
                    </div>
                    {f.external_url ? (
                      <a href={f.external_url}
                        target="_blank" rel="noopener noreferrer"
                        className="ms-btn">
                        <FiExternalLink /> Ouvrir le lien
                      </a>
                    ) : (
                      <a href={manuscriptsApi.downloadUrl(manuscript.id, f.id)}
                        target="_blank" rel="noopener noreferrer"
                        className="ms-btn">
                        <FiDownload /> Télécharger
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p style={{ color: '#6b7280' }}>Aucun fichier.</p>}
          </div>

          {evaluations?.length > 0 && (
            <div className="ms-card">
              <h3>Évaluations ({evaluations.length})</h3>
              {evaluations.map((ev) => (
                <div key={ev.id} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <strong style={{ color: ev.verdict === 'positive' ? '#10531a' : '#dc2626' }}>
                    {ev.verdict === 'positive' ? 'Avis favorable' : 'Avis défavorable'}
                  </strong>
                  {ev.recommendation && <span> · {ev.recommendation}</span>}
                  {ev.note && <p style={{ color: '#4b5563', margin: '4px 0 0' }}>{ev.note}</p>}
                  <small style={{ color: '#6b7280' }}>{new Date(ev.created_at).toLocaleString('fr-FR')}</small>
                </div>
              ))}
            </div>
          )}

          {validations?.length > 0 && (
            <div className="ms-card">
              <h3>Validations auteur ({validations.length})</h3>
              {validations.map((v) => (
                <div key={v.id} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <strong>{v.kind === 'bat' ? 'BAT' : 'Correction'}</strong> · {v.decision === 'approved' ? '✓ Validé' : '✗ Modifications demandées'}
                  {v.comment && <p style={{ color: '#4b5563', margin: '4px 0 0' }}>{v.comment}</p>}
                  <small style={{ color: '#6b7280' }}>{new Date(v.created_at).toLocaleString('fr-FR')}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside>
          <div className="ms-card">
            <h3>Assignations</h3>
            {ASSIGN_ROWS.map((col) => {
              const legacyCol = LEGACY_COL[col];
              const legacyVal = legacyCol ? manuscript[legacyCol] : null;
              return (
                <div key={col} style={{ marginBottom: 10, fontSize: '0.88rem' }}>
                  <div style={{ color: '#6b7280', fontSize: '0.78rem' }}>{ROLE_LABELS[col]}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{manuscript[col] ? (manuscript[`${col}_name`] || `#${manuscript[col]}`) : <em style={{ color: '#6b7280' }}>non assigné</em>}</span>
                    <button type="button" className="ms-btn" onClick={() => openAssign(col)}>Modifier</button>
                  </div>
                  {legacyVal && (
                    <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 2 }}>
                      Ancien (historique) : {manuscript[`${legacyCol}_name`] || `#${legacyVal}`}
                    </div>
                  )}
                  {col === 'assigned_editor_id' && manuscript.assigned_infographist_contact_id && (
                    <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 2 }}>
                      Ancien infographiste : {manuscript.assigned_infographist_contact_id_name || `#${manuscript.assigned_infographist_contact_id}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ms-card">
            <h3>Historique</h3>
            <ManuscriptTimeline stages={stages} />
          </div>
        </aside>
      </div>

      {assignModal && (
        <div className="ms-modal-backdrop" onClick={() => setAssignModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Assigner : {ROLE_LABELS[assignModal]}</h3>
            <div className="form-group">
              <label>Destinataire</label>
              <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                <option value="">— Aucun —</option>
                {adminUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>

              {/* Création inline d'un intervenant (uniquement pour les acteurs externes du carnet). */}
              {assignModal !== 'assigned_editor_id' && (
                showNewIntervenant ? (
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginTop: 10 }}>
                    <div style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: 8 }}>
                      Nouvel intervenant — {ROLE_LABELS[assignModal]}
                    </div>
                    <input
                      type="text" placeholder="Nom" value={newIntervenant.nom}
                      onChange={(e) => setNewIntervenant({ ...newIntervenant, nom: e.target.value })}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 8 }}
                    />
                    <input
                      type="email" placeholder="Email" value={newIntervenant.email}
                      onChange={(e) => setNewIntervenant({ ...newIntervenant, email: e.target.value })}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 10 }}
                    />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="ms-btn" onClick={() => { setShowNewIntervenant(false); setNewIntervenant({ nom: '', email: '' }); }}>Annuler</button>
                      <button type="button" className="ms-btn ms-btn-primary" onClick={createIntervenant} disabled={creatingIntervenant}>
                        {creatingIntervenant ? 'Ajout…' : 'Ajouter & sélectionner'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button" className="ms-btn"
                    onClick={() => setShowNewIntervenant(true)}
                    style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}
                  >
                    <FiPlus /> Nouvel intervenant
                  </button>
                )
              )}
            </div>
            {isSeries && (
              <label className="ms-series-apply">
                <input
                  type="checkbox"
                  checked={applyToSeries}
                  onChange={(e) => setApplyToSeries(e.target.checked)}
                />
                <span>Appliquer à toute la série ({seriesTomes.length} tomes)</span>
              </label>
            )}
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setAssignModal(null)}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmAssign}>Confirmer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
