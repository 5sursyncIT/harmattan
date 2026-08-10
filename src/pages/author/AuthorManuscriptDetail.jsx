import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiCheck, FiX, FiExternalLink, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import { safeHttpUrl } from '../../utils/safeUrl';
import ManuscriptTimeline from '../../components/common/ManuscriptTimeline';
import NotificationBell from '../../components/author/NotificationBell';
import './AuthorPages.css';

const KIND_LABELS = {
  original: 'Manuscrit original',
  correction: 'Manuscrit corrigé',
  author_final: 'Version finale auteur',
  bat_cover: 'BAT couverture',
};

function formatSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} Mo` : `${(bytes / 1024).toFixed(0)} Ko`;
}

export default function AuthorManuscriptDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [modal, setModal] = useState(null); // 'correction' | 'bat' | 'rework' | null
  const [decision, setDecision] = useState('approved');
  const [comment, setComment] = useState('');
  const [reworkFile, setReworkFile] = useState(null);
  const [reworkNote, setReworkNote] = useState('');

  const load = () => {
    setLoading(true);
    authorApi.getManuscript(id)
      .then((res) => setData(res.data))
      .catch((err) => {
        toast.error(err.response?.data?.error || 'Erreur de chargement');
        if (err.response?.status === 404) navigate('/auteur/dashboard');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { load();   }, [id]);

  const handleValidate = async () => {
    setActionLoading(true);
    try {
      if (modal === 'correction') {
        await authorApi.validateCorrection(id, decision, comment);
      } else {
        await authorApi.validateBat(id, decision, comment);
      }
      toast.success('Votre décision a été enregistrée');
      setModal(null);
      setComment('');
      setDecision('approved');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setActionLoading(false); }
  };

  const handleSubmitRework = async () => {
    if (!reworkFile) {
      toast.error('Sélectionnez le fichier retravaillé');
      return;
    }
    setActionLoading(true);
    try {
      const fd = new FormData();
      fd.append('original', reworkFile);
      if (reworkNote.trim()) fd.append('note', reworkNote.trim());
      await authorApi.submitRework(id, fd);
      toast.success('Version retravaillée envoyée — nouvelle évaluation en cours');
      setModal(null);
      setReworkFile(null);
      setReworkNote('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors du dépôt');
    } finally { setActionLoading(false); }
  };

  if (loading) return <div className="author-page"><div className="container"><p>Chargement...</p></div></div>;
  if (!data) return null;
  const { manuscript, stages, files, evaluations } = data;

  const canValidateCorrection = manuscript.current_stage === 'correction_author_review';
  const canValidateBat = manuscript.current_stage === 'bat_author_review';
  const canSubmitRework = manuscript.current_stage === 'evaluation_rework';

  return (
    <div className="author-page">
      <div className="container">
        <Link to="/auteur/dashboard" className="back-link"><FiArrowLeft /> Retour au tableau de bord</Link>
        <div className="author-detail-header">
          <div>
            <h1>{manuscript.title}</h1>
            {manuscript.subtitle && (
              <p style={{ margin: '-4px 0 6px', fontSize: '1.1rem', fontStyle: 'italic', color: '#475569' }}>{manuscript.subtitle}</p>
            )}
            <p className="author-subtitle">
              Référence : <strong>{manuscript.ref}</strong> · Statut : <strong>{manuscript.stage_label}</strong>
            </p>
          </div>
          <div className="author-actions">
            <NotificationBell />
          </div>
        </div>

        {canSubmitRework && (
          <div className="author-action-banner">
            <div>
              <h3>Manuscrit à retravailler</h3>
              <p>Le comité vous invite à retravailler votre texte. Déposez ici la nouvelle version pour relancer l&apos;évaluation.</p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setModal('rework'); setReworkFile(null); setReworkNote(''); }}
            >
              <FiUpload style={{ marginRight: 6 }} /> Déposer ma version
            </button>
          </div>
        )}

        {(canValidateCorrection || canValidateBat) && (
          <div className="author-action-banner">
            <div>
              <h3>{canValidateCorrection ? 'Corrections à valider' : 'BAT à valider'}</h3>
              <p>Merci de prendre connaissance du fichier et de nous communiquer votre décision.</p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { setModal(canValidateCorrection ? 'correction' : 'bat'); setDecision('approved'); setComment(''); }}
            >
              Donner mon avis
            </button>
          </div>
        )}

        <section className="author-section">
          <h2>Suivi du manuscrit</h2>
          <ManuscriptTimeline stages={stages} />
        </section>

        {evaluations?.length > 0 && (
          <section className="author-section">
            <h2>Évaluations</h2>
            <ul className="author-eval-list">
              {evaluations.map((ev, idx) => (
                <li key={idx} className={`author-eval author-eval-${ev.verdict}`}>
                  <strong>{ev.verdict === 'positive' ? 'Avis favorable' : ev.verdict === 'rework' ? 'À retravailler' : 'Avis défavorable'}</strong>
                  {ev.recommendation && <span> — {ev.recommendation}</span>}
                  <em>{new Date(ev.created_at).toLocaleDateString('fr-FR')}</em>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="author-section">
          <h2>Fichiers disponibles</h2>
          {files?.length ? (
            <ul className="author-files">
              {files.map((f) => (
                <li key={f.id}>
                  <div>
                    <strong>{KIND_LABELS[f.kind] || f.kind}</strong>
                    {f.version > 1 && <span> (v{f.version})</span>}
                    <div className="author-file-meta">
                      {f.external_url ? 'Lien de téléchargement externe' : `${f.file_name} · ${formatSize(f.file_size)}`}
                    </div>
                  </div>
                  {safeHttpUrl(f.external_url) ? (
                    <a
                      href={safeHttpUrl(f.external_url)}
                      className="btn btn-ghost"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FiExternalLink /> Ouvrir le lien
                    </a>
                  ) : (
                    <a
                      href={authorApi.downloadFile(manuscript.id, f.id)}
                      className="btn btn-ghost"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FiDownload /> Télécharger
                    </a>
                  )}
                </li>
              ))}
            </ul>
          ) : <p>Aucun fichier disponible pour le moment.</p>}
        </section>

        {modal === 'rework' && (
          <div className="author-modal-backdrop" onClick={() => setModal(null)}>
            <div className="author-modal" onClick={(e) => e.stopPropagation()}>
              <h3>Déposer la version retravaillée</h3>
              <p style={{ marginTop: 0, fontSize: '0.9rem', color: '#6b7280' }}>
                Formats acceptés : PDF, DOC, DOCX, ODT, RTF — max 20 Mo.
              </p>
              <div className="form-group">
                <label>Fichier *</label>
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.odt,.rtf"
                  onChange={(e) => setReworkFile(e.target.files?.[0] || null)}
                />
                {reworkFile && (
                  <small style={{ display: 'block', marginTop: 6, color: '#374151' }}>
                    {reworkFile.name} ({formatSize(reworkFile.size)})
                  </small>
                )}
              </div>
              <div className="form-group">
                <label>Message pour le comité (optionnel)</label>
                <textarea
                  value={reworkNote}
                  onChange={(e) => setReworkNote(e.target.value)}
                  rows={3}
                  placeholder="Précisez les points retravaillés…"
                />
              </div>
              <div className="author-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setModal(null)} disabled={actionLoading}>Annuler</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSubmitRework}
                  disabled={actionLoading || !reworkFile}
                >
                  {actionLoading ? 'Envoi...' : 'Envoyer et relancer l\'évaluation'}
                </button>
              </div>
            </div>
          </div>
        )}

        {(modal === 'correction' || modal === 'bat') && (
          <div className="author-modal-backdrop" onClick={() => setModal(null)}>
            <div className="author-modal" onClick={(e) => e.stopPropagation()}>
              <h3>{modal === 'correction' ? 'Valider les corrections' : 'Valider le BAT couverture'}</h3>
              <div className="form-group">
                <label>Votre décision</label>
                <label className="radio-inline">
                  <input type="radio" name="decision" value="approved" checked={decision === 'approved'} onChange={() => setDecision('approved')} />
                  <FiCheck /> Je valide
                </label>
                <label className="radio-inline">
                  <input type="radio" name="decision" value="changes_requested" checked={decision === 'changes_requested'} onChange={() => setDecision('changes_requested')} />
                  <FiX /> Je demande des modifications
                </label>
              </div>
              <div className="form-group">
                <label>Commentaire {decision === 'changes_requested' && <span style={{ color: '#dc2626' }}>*</span>}</label>
                <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={4} />
              </div>
              <div className="author-modal-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setModal(null)} disabled={actionLoading}>Annuler</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleValidate}
                  disabled={actionLoading || (decision === 'changes_requested' && !comment.trim())}
                >
                  {actionLoading ? 'Envoi...' : 'Valider'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
