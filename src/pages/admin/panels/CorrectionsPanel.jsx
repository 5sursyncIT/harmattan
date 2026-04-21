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
    </div>
  );
}
