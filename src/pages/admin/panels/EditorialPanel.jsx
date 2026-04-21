import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { manuscriptsApi } from '../../../api/manuscripts';
import './ManuscriptsWorkflow.css';

export default function EditorialPanel() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    manuscriptsApi.listEditorial()
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const validate = async (id) => {
    if (!confirm('Valider ce manuscrit éditorialement ?')) return;
    try {
      await manuscriptsApi.editorialValidate(id);
      toast.success('Validation éditoriale enregistrée');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  const returnToCorrection = async (id) => {
    const note = prompt('Motif du retour en correction :') || '';
    if (!note.trim()) return;
    try {
      await manuscriptsApi.editorialReturn(id, note);
      toast.success('Manuscrit retourné en correction');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  const toCover = async (id) => {
    if (!confirm('Lancer la conception de couverture ?')) return;
    try {
      await manuscriptsApi.editorialAdvanceToCover(id);
      toast.success('Passage à la conception de couverture');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  return (
    <div className="ms-panel">
      <h2>Validation éditoriale</h2>
      <p className="ms-subtitle">Manuscrits en attente de validation éditoriale et échanges avec l'auteur.</p>

      {loading ? <p>Chargement...</p> : !rows.length ? (
        <div className="ms-empty">Aucun manuscrit en validation éditoriale.</div>
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
                  {m.current_stage === 'in_editorial' && (
                    <>
                      <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => validate(m.id)}>Valider</button>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => returnToCorrection(m.id)}>Retour correction</button>
                    </>
                  )}
                  {m.current_stage === 'editorial_validated' && (
                    <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => toCover(m.id)}>
                      Lancer couverture
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
