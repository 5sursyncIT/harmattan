import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { manuscriptsApi } from '../../../api/manuscripts';
import './ManuscriptsWorkflow.css';

export default function PrintingPanel() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // manuscript object
  const [qty, setQty] = useState('');
  const [isbn, setIsbn] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    manuscriptsApi.listPrinting()
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openPrepare = (m) => {
    setModal(m);
    setQty(m.print_qty ? String(m.print_qty) : '500');
    setIsbn(m.isbn || '');
  };

  const prepare = async () => {
    const q = parseInt(qty, 10);
    if (!q || q < 1) return toast.error('Quantité invalide');
    setSubmitting(true);
    try {
      const res = await manuscriptsApi.preparePrint(modal.id, q, isbn || null);
      if (res.data?.mo?.dolibarr_mo_ref) {
        toast.success(`Ordre d'impression créé : ${res.data.mo.dolibarr_mo_ref}`);
      } else {
        toast.success('Préparation enregistrée');
      }
      setModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  const markPrinted = async (id) => {
    if (!confirm('Marquer cette impression comme terminée ?')) return;
    try {
      await manuscriptsApi.markPrinted(id);
      toast.success('Impression marquée comme terminée');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
  };

  return (
    <div className="ms-panel">
      <h2>Impression</h2>
      <p className="ms-subtitle">Manuscrits prêts à être imprimés, en impression ou imprimés.</p>

      {loading ? <p>Chargement...</p> : !rows.length ? (
        <div className="ms-empty">Aucun manuscrit à imprimer.</div>
      ) : (
        <table className="ms-table">
          <thead>
            <tr><th>Réf.</th><th>Titre</th><th>Auteur</th><th>Étape</th><th>Qté</th><th>ISBN</th><th>MO</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>{m.ref}</td>
                <td>{m.title}</td>
                <td>{m.author_name}</td>
                <td><span className={`ms-stage-badge ms-stage-${m.current_stage}`}>{m.stage_label}</span></td>
                <td>{m.print_qty || '—'}</td>
                <td>{m.isbn || '—'}</td>
                <td>{m.dolibarr_mo_ref || '—'}</td>
                <td>
                  <button className="ms-btn" onClick={() => navigate(`/admin/manuscripts/${m.id}`)}>Détail</button>
                  {m.current_stage === 'print_preparation' && (
                    <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => openPrepare(m)}>
                      Préparer MO
                    </button>
                  )}
                  {m.current_stage === 'printing' && (
                    <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => markPrinted(m.id)}>
                      Marquer imprimé
                    </button>
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
            <h3>Préparer l'ordre d'impression</h3>
            <p style={{ fontSize: '0.85rem', color: '#6b7280' }}>
              Crée un produit + une MO Dolibarr et lance l'impression.
            </p>
            <div className="form-group">
              <label>Titre</label>
              <input type="text" value={modal.title} readOnly />
            </div>
            <div className="form-group">
              <label>Quantité à imprimer *</label>
              <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>ISBN (optionnel)</label>
              <input
                type="text"
                value={isbn}
                onChange={(e) => setIsbn(e.target.value)}
                placeholder="978-2-336-..."
              />
            </div>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={prepare} disabled={submitting}>
                {submitting ? 'Création...' : 'Lancer l\'impression'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
