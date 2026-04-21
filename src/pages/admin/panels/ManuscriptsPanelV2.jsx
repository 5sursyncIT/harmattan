import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { manuscriptsApi } from '../../../api/manuscripts';
import './ManuscriptsWorkflow.css';

export default function ManuscriptsPanelV2() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [stageList, setStageList] = useState({ stages: [], labels: {} });
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    manuscriptsApi.list({ q: q || undefined, stage: stage || undefined })
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    manuscriptsApi.stages().then((res) => setStageList(res.data)).catch(() => {});
    load();
    // eslint-disable-next-line
  }, []);

  const handleFilter = (e) => { e.preventDefault(); load(); };

  return (
    <div className="ms-panel">
      <h2>Manuscrits — vue globale</h2>
      <p className="ms-subtitle">Tous les manuscrits avec leur étape dans le workflow éditorial.</p>

      <form className="ms-toolbar" onSubmit={handleFilter}>
        <input
          type="search"
          placeholder="Rechercher (titre, auteur, email, réf)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={stage} onChange={(e) => setStage(e.target.value)}>
          <option value="">Toutes les étapes</option>
          {stageList.stages?.map((s) => (
            <option key={s} value={s}>{stageList.labels?.[s] || s}</option>
          ))}
        </select>
        <button type="submit" className="ms-btn ms-btn-primary">Filtrer</button>
      </form>

      {loading ? (
        <p>Chargement...</p>
      ) : !rows.length ? (
        <div className="ms-empty">Aucun manuscrit pour ces critères.</div>
      ) : (
        <table className="ms-table">
          <thead>
            <tr>
              <th>Réf.</th>
              <th>Titre</th>
              <th>Auteur</th>
              <th>Étape</th>
              <th>Dernière MAJ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} onClick={() => navigate(`/admin/manuscripts/${m.id}`)}>
                <td>{m.ref}</td>
                <td>{m.title}</td>
                <td>{m.author_name}</td>
                <td>
                  <span className={`ms-stage-badge ms-stage-${m.current_stage}`}>
                    {m.stage_label || m.current_stage}
                  </span>
                </td>
                <td>{new Date(m.updated_at || m.created_at).toLocaleDateString('fr-FR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
