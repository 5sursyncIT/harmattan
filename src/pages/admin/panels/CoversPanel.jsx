import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUpload } from 'react-icons/fi';
import { manuscriptsApi } from '../../../api/manuscripts';
import './ManuscriptsWorkflow.css';

export default function CoversPanel() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [artworkModal, setArtworkModal] = useState(null);
  const [batModal, setBatModal] = useState(null);
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    manuscriptsApi.listCovers()
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const uploadArtwork = async () => {
    if (!file) return toast.error('Fichier requis');
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await manuscriptsApi.uploadCoverArtwork(artworkModal, fd);
      toast.success('Maquette couverture uploadée');
      setArtworkModal(null);
      setFile(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  const submitBat = async () => {
    if (!file) return toast.error('BAT PDF requis');
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('bat', file);
      await manuscriptsApi.submitBat(batModal, fd);
      toast.success('BAT soumis à l\'auteur');
      setBatModal(null);
      setFile(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="ms-panel">
      <h2>Couvertures</h2>
      <p className="ms-subtitle">Manuscrits en conception de couverture ou BAT à valider.</p>

      {loading ? <p>Chargement...</p> : !rows.length ? (
        <div className="ms-empty">Aucune couverture en cours.</div>
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
                  {m.current_stage === 'cover_design' && (
                    <>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => { setArtworkModal(m.id); setFile(null); }}>
                        Maquette
                      </button>
                      <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => { setBatModal(m.id); setFile(null); }}>
                        Soumettre BAT
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {artworkModal && (
        <div className="ms-modal-backdrop" onClick={() => setArtworkModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Uploader la maquette couverture</h3>
            <p style={{ fontSize: '0.85rem', color: '#6b7280' }}>PDF, AI, PSD, INDD, JPG ou PNG — max 50 Mo</p>
            <label className="ms-upload-box">
              <FiUpload /> {file ? file.name : 'Sélectionner un fichier'}
              <input type="file" accept=".pdf,.ai,.psd,.indd,.jpg,.jpeg,.png" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setArtworkModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={uploadArtwork} disabled={submitting || !file}>
                {submitting ? 'Envoi...' : 'Uploader'}
              </button>
            </div>
          </div>
        </div>
      )}

      {batModal && (
        <div className="ms-modal-backdrop" onClick={() => setBatModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Soumettre le BAT couverture à l'auteur</h3>
            <p style={{ fontSize: '0.85rem', color: '#6b7280' }}>PDF uniquement — max 50 Mo. L'auteur recevra un email et devra valider.</p>
            <label className="ms-upload-box">
              <FiUpload /> {file ? file.name : 'Sélectionner le BAT PDF'}
              <input type="file" accept=".pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setBatModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={submitBat} disabled={submitting || !file}>
                {submitting ? 'Envoi...' : 'Soumettre à l\'auteur'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
