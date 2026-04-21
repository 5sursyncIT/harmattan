import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiCheck, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { authorApi } from '../../api/author';
import ManuscriptTimeline from '../../components/common/ManuscriptTimeline';
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
  const [modal, setModal] = useState(null); // 'correction' | 'bat' | null
  const [decision, setDecision] = useState('approved');
  const [comment, setComment] = useState('');

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

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

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

  if (loading) return <div className="author-page"><div className="container"><p>Chargement...</p></div></div>;
  if (!data) return null;
  const { manuscript, stages, files, evaluations } = data;

  const canValidateCorrection = manuscript.current_stage === 'correction_author_review';
  const canValidateBat = manuscript.current_stage === 'bat_author_review';

  return (
    <div className="author-page">
      <div className="container">
        <Link to="/auteur/dashboard" className="back-link"><FiArrowLeft /> Retour au tableau de bord</Link>
        <div className="author-detail-header">
          <div>
            <h1>{manuscript.title}</h1>
            <p className="author-subtitle">
              Référence : <strong>{manuscript.ref}</strong> · Statut : <strong>{manuscript.stage_label}</strong>
            </p>
          </div>
        </div>

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
                  <strong>{ev.verdict === 'positive' ? 'Avis favorable' : 'Avis défavorable'}</strong>
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
                    <div className="author-file-meta">{f.file_name} · {formatSize(f.file_size)}</div>
                  </div>
                  <a
                    href={authorApi.downloadFile(manuscript.id, f.id)}
                    className="btn btn-ghost"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <FiDownload /> Télécharger
                  </a>
                </li>
              ))}
            </ul>
          ) : <p>Aucun fichier disponible pour le moment.</p>}
        </section>

        {modal && (
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
