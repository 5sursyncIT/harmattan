import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUpload } from 'react-icons/fi';
import { manuscriptsApi } from '../../../api/manuscripts';
import './ManuscriptsWorkflow.css';

export default function CorrectionsPanel() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Transmission à la Production éditoriale
  const [editorialModal, setEditorialModal] = useState(null);
  const [editorialUsers, setEditorialUsers] = useState([]);
  const [selectedEditor, setSelectedEditor] = useState('');

  const load = () => {
    setLoading(true);
    manuscriptsApi.listCorrections()
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const upload = async () => {
    if (!file) return toast.error('Fichier requis');
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await manuscriptsApi.uploadCorrection(modal, fd);
      toast.success('Version corrigée uploadée');
      setModal(null);
      setFile(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  const sendToAuthor = async (id) => {
    if (!confirm('Envoyer ces corrections à l\'auteur pour validation ?')) return;
    try {
      await manuscriptsApi.submitCorrectionToAuthor(id);
      toast.success('Corrections envoyées à l\'auteur');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const openEditorial = (id) => {
    setEditorialModal(id);
    setSelectedEditor('');
    manuscriptsApi.adminsByRole('editor')
      .then((res) => setEditorialUsers(res.data || []))
      .catch(() => setEditorialUsers([]));
  };

  const confirmEditorial = async () => {
    setSubmitting(true);
    try {
      await manuscriptsApi.sendCorrectionToEditorial(editorialModal, selectedEditor ? parseInt(selectedEditor, 10) : null);
      toast.success('Document transmis à la Production éditoriale');
      setEditorialModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="ms-panel">
      <h2>Corrections</h2>
      <p className="ms-subtitle">Manuscrits en correction ou en attente de validation auteur.</p>

      {loading ? <p>Chargement...</p> : !rows.length ? (
        <div className="ms-empty">Aucune correction en cours.</div>
      ) : (
        <table className="ms-table">
          <thead>
            <tr><th>Réf.</th><th>Titre</th><th>Auteur</th><th>Étape</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>{m.ref}</td>
                <td>{m.title}</td>
                <td>{m.author_name}</td>
                <td><span className={`ms-stage-badge ms-stage-${m.current_stage}`}>{m.stage_label}</span></td>
                <td>
                  <button className="ms-btn" onClick={() => navigate(`/admin/manuscripts/${m.id}`)}>Détail</button>
                  {m.current_stage === 'in_correction' && (
                    <>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => { setModal(m.id); setFile(null); }}>
                        Uploader
                      </button>
                      <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => sendToAuthor(m.id)}>
                        Envoyer à l'auteur
                      </button>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => openEditorial(m.id)}>
                        → Production éditoriale
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <div className="ms-modal-backdrop" onClick={() => setModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Uploader une version corrigée</h3>
            <div className="form-group">
              <label>Fichier (PDF, DOC, DOCX, ODT — max 20 Mo)</label>
              <label className="ms-upload-box">
                <FiUpload /> {file ? file.name : 'Sélectionner un fichier'}
                <input type="file" accept=".pdf,.doc,.docx,.odt" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
            </div>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={upload} disabled={submitting || !file}>
                {submitting ? 'Envoi...' : 'Uploader'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editorialModal && (
        <div className="ms-modal-backdrop" onClick={() => setEditorialModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Transmettre à la Production éditoriale</h3>
            <p className="ms-subtitle" style={{ marginTop: 0 }}>
              Le document corrigé (renvoyé par le correcteur) doit avoir été <strong>uploadé</strong> au préalable.
              Cette action transmet le manuscrit à la Production éditoriale, sans relecture par l'auteur.
            </p>
            <div className="form-group">
              <label>Responsable de la production éditoriale (facultatif)</label>
              <select value={selectedEditor} onChange={(e) => setSelectedEditor(e.target.value)}>
                <option value="">Toute l'équipe de production éditoriale</option>
                {editorialUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username} ({u.role})</option>
                ))}
              </select>
            </div>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setEditorialModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={confirmEditorial} disabled={submitting}>
                {submitting ? 'Envoi...' : 'Transmettre'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
