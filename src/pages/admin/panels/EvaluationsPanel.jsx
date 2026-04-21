import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUpload } from 'react-icons/fi';
import { manuscriptsApi } from '../../../api/manuscripts';
import './ManuscriptsWorkflow.css';

export default function EvaluationsPanel() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // manuscript id
  const [form, setForm] = useState({ verdict: 'positive', recommendation: '', strengths: '', weaknesses: '', note: '' });
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    manuscriptsApi.listEvaluations()
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openEval = (id) => {
    setModal(id);
    setForm({ verdict: 'positive', recommendation: '', strengths: '', weaknesses: '', note: '' });
    setFile(null);
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('verdict', form.verdict);
      if (form.recommendation) fd.append('recommendation', form.recommendation);
      if (form.strengths) fd.append('strengths', form.strengths);
      if (form.weaknesses) fd.append('weaknesses', form.weaknesses);
      if (form.note) fd.append('note', form.note);
      if (file) fd.append('report', file);
      await manuscriptsApi.submitEvaluation(modal, fd);
      toast.success('Évaluation enregistrée');
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="ms-panel">
      <h2>Évaluations à traiter</h2>
      <p className="ms-subtitle">Manuscrits en attente de votre évaluation.</p>

      {loading ? <p>Chargement...</p> : !rows.length ? (
        <div className="ms-empty">Aucun manuscrit à évaluer actuellement.</div>
      ) : (
        <table className="ms-table">
          <thead>
            <tr>
              <th>Réf.</th><th>Titre</th><th>Auteur</th><th>Reçu le</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>{m.ref}</td>
                <td>{m.title}</td>
                <td>{m.author_name}</td>
                <td>{new Date(m.created_at).toLocaleDateString('fr-FR')}</td>
                <td>
                  <button className="ms-btn" onClick={() => navigate(`/admin/manuscripts/${m.id}`)}>Détail</button>
                  <button className="ms-btn ms-btn-primary" onClick={() => openEval(m.id)} style={{ marginLeft: 6 }}>Évaluer</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <div className="ms-modal-backdrop" onClick={() => setModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Saisir l'évaluation</h3>
            <div className="form-group">
              <label>Verdict</label>
              <select value={form.verdict} onChange={(e) => setForm({ ...form, verdict: e.target.value })}>
                <option value="positive">Favorable</option>
                <option value="negative">Défavorable</option>
              </select>
            </div>
            <div className="form-group">
              <label>Recommandation</label>
              <input
                type="text"
                value={form.recommendation}
                onChange={(e) => setForm({ ...form, recommendation: e.target.value })}
                placeholder="Publier, retravailler, rejeter..."
              />
            </div>
            <div className="form-group">
              <label>Points forts</label>
              <textarea rows={3} value={form.strengths} onChange={(e) => setForm({ ...form, strengths: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Points faibles</label>
              <textarea rows={3} value={form.weaknesses} onChange={(e) => setForm({ ...form, weaknesses: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Note interne</label>
              <textarea rows={3} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Rapport d'évaluation (PDF/DOC, optionnel)</label>
              <label className="ms-upload-box">
                <FiUpload /> {file ? file.name : 'Sélectionner un fichier'}
                <input type="file" accept=".pdf,.doc,.docx,.odt" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
            </div>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? 'Envoi...' : 'Valider l\'évaluation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
