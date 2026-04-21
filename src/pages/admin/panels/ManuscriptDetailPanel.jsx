import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiUser } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { manuscriptsApi } from '../../../api/manuscripts';
import ManuscriptTimeline from '../../../components/common/ManuscriptTimeline';
import './ManuscriptsWorkflow.css';

const ROLE_LABELS = {
  assigned_evaluator_id: 'Évaluateur',
  assigned_corrector_id: 'Correcteur',
  assigned_editor_id: 'Éditeur',
  assigned_infographist_id: 'Infographiste',
  assigned_printer_id: 'Imprimeur',
};
const ROLE_API = {
  assigned_evaluator_id: 'evaluateur',
  assigned_corrector_id: 'correcteur',
  assigned_editor_id: 'editor',
  assigned_infographist_id: 'infographiste',
  assigned_printer_id: 'imprimeur',
};

export default function ManuscriptDetailPanel() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [assignModal, setAssignModal] = useState(null); // col name
  const [adminUsers, setAdminUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');

  const load = () => {
    setLoading(true);
    manuscriptsApi.get(id)
      .then((res) => setData(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const openAssign = (col) => {
    setAssignModal(col);
    setSelectedUser('');
    manuscriptsApi.adminsByRole(ROLE_API[col])
      .then((res) => setAdminUsers(res.data))
      .catch(() => setAdminUsers([]));
  };

  const confirmAssign = async () => {
    try {
      await manuscriptsApi.assign(id, ROLE_API[assignModal], selectedUser ? parseInt(selectedUser, 10) : null);
      toast.success('Assignation mise à jour');
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
  const { manuscript, stages, files, evaluations, validations } = data;

  return (
    <div className="ms-panel">
      <Link to="/admin/manuscripts" className="back-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, color: '#10531a', textDecoration: 'none' }}>
        <FiArrowLeft /> Retour à la liste
      </Link>
      <h2>{manuscript.title}</h2>
      <p className="ms-subtitle">
        Référence <strong>{manuscript.ref}</strong> ·
        <span className={`ms-stage-badge ms-stage-${manuscript.current_stage}`} style={{ marginLeft: 8 }}>
          {manuscript.stage_label}
        </span>
      </p>

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
                    <a href={manuscriptsApi.downloadUrl(manuscript.id, f.id)}
                      target="_blank" rel="noopener noreferrer"
                      className="ms-btn">
                      <FiDownload /> Télécharger
                    </a>
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
            {['assigned_evaluator_id', 'assigned_corrector_id', 'assigned_editor_id', 'assigned_infographist_id', 'assigned_printer_id'].map((col) => (
              <div key={col} style={{ marginBottom: 10, fontSize: '0.88rem' }}>
                <div style={{ color: '#6b7280', fontSize: '0.78rem' }}>{ROLE_LABELS[col]}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{manuscript[col] ? `#${manuscript[col]}` : <em style={{ color: '#6b7280' }}>non assigné</em>}</span>
                  <button type="button" className="ms-btn" onClick={() => openAssign(col)}>Modifier</button>
                </div>
              </div>
            ))}
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
              <label>Utilisateur</label>
              <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                <option value="">— Désassigner —</option>
                {adminUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username} ({u.role})</option>
                ))}
              </select>
            </div>
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
