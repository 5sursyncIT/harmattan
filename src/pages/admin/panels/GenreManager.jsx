import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  FiX, FiPlus, FiEdit2, FiTrash2, FiCheck, FiLoader, FiSearch, FiAlertTriangle, FiTag,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import { listGenres, createGenre, updateGenre, deleteGenre } from '../../../api/admin';
import './GenreManager.css';

/**
 * Gestionnaire de genres (catégories produit Dolibarr) — CRUD complet.
 * - Créer, renommer, supprimer un genre
 * - Supprimer un genre utilisé : réaffecter les livres vers un autre genre (fusion)
 *   ou supprimer sans réaffecter (les livres perdent ce genre).
 * Sert à nettoyer les doublons (« Roman »/« ROMAN ») et les libellés erronés.
 */
export default function GenreManager({ onClose, onChanged }) {
  const [genres, setGenres] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  // création
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);

  // renommage
  const [editId, setEditId] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [savingId, setSavingId] = useState(null);

  // suppression
  const [deleteId, setDeleteId] = useState(null);
  const [reassignTo, setReassignTo] = useState('__none__');
  const [deletingId, setDeletingId] = useState(null);

  const sortFr = (list) => [...list].sort((a, b) => a.label.localeCompare(b.label, 'fr'));

  const load = useCallback(() => {
    setLoading(true);
    listGenres()
      .then((res) => setGenres(sortFr(res.data.genres || [])))
      .catch(() => toast.error('Impossible de charger les genres'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Esc pour fermer
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const notifyChanged = () => onChanged?.();

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return genres;
    return genres.filter((g) => g.label.toLowerCase().includes(q));
  }, [genres, filter]);

  // ── CREATE ──
  const handleCreate = async () => {
    const label = newLabel.trim();
    if (!label || creating) return;
    setCreating(true);
    try {
      const res = await createGenre(label);
      const created = { id: parseInt(res.data.id, 10), label: res.data.label, count: 0 };
      setGenres((prev) => (prev.some((g) => g.id === created.id) ? prev : sortFr([...prev, created])));
      setNewLabel('');
      notifyChanged();
      toast.success(`Genre « ${created.label} » créé`);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        toast(err.response.data?.error || 'Ce genre existe déjà', { icon: 'ℹ️' });
      } else {
        toast.error(err?.response?.data?.error || 'Création impossible');
      }
    } finally {
      setCreating(false);
    }
  };

  // ── RENAME ──
  const startEdit = (g) => { cancelDelete(); setEditId(g.id); setEditLabel(g.label); };
  const cancelEdit = () => { setEditId(null); setEditLabel(''); };
  const handleRename = async (g) => {
    const label = editLabel.trim();
    if (!label) return;
    if (label === g.label) { cancelEdit(); return; }
    setSavingId(g.id);
    try {
      const res = await updateGenre(g.id, label);
      setGenres((prev) => sortFr(prev.map((x) => (x.id === g.id ? { ...x, label: res.data.label } : x))));
      cancelEdit();
      notifyChanged();
      toast.success('Genre renommé');
    } catch (err) {
      const status = err?.response?.status;
      if (status === 409) {
        toast.error(err.response.data?.error || 'Ce genre existe déjà');
      } else {
        toast.error(err?.response?.data?.error || 'Renommage impossible');
      }
    } finally {
      setSavingId(null);
    }
  };

  // ── DELETE / MERGE ──
  const startDelete = (g) => { cancelEdit(); setDeleteId(g.id); setReassignTo('__none__'); };
  const cancelDelete = () => { setDeleteId(null); setReassignTo('__none__'); };
  const handleDelete = async (g) => {
    setDeletingId(g.id);
    const opts = {};
    if (g.count > 0) {
      if (reassignTo !== '__none__') opts.reassignTo = parseInt(reassignTo, 10);
      else opts.force = true;
    }
    try {
      const res = await deleteGenre(g.id, opts);
      const { reassigned = 0, reassignedTo = null } = res.data || {};
      const destLabel = reassignedTo ? genres.find((x) => x.id === reassignedTo)?.label : null;
      setGenres((prev) => prev
        .filter((x) => x.id !== g.id)
        .map((x) => (reassignedTo && x.id === reassignedTo ? { ...x, count: x.count + reassigned } : x)));
      cancelDelete();
      notifyChanged();
      if (reassignedTo) {
        toast.success(`« ${g.label} » supprimé — ${reassigned} livre(s) déplacé(s)${destLabel ? ` vers « ${destLabel} »` : ''}`);
      } else {
        toast.success(`Genre « ${g.label} » supprimé`);
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Suppression impossible');
    } finally {
      setDeletingId(null);
    }
  };

  const otherGenres = (g) => genres.filter((x) => x.id !== g.id);

  return (
    <div className="gm-overlay" onClick={onClose} role="presentation">
      <div
        className="gm-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gm-title"
      >
        <div className="gm-header">
          <h3 id="gm-title"><FiTag aria-hidden="true" /> Gestion des genres</h3>
          <button type="button" className="gm-close" onClick={onClose} aria-label="Fermer">
            <FiX size={18} />
          </button>
        </div>

        <div className="gm-create">
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
            placeholder="Nouveau genre…"
            maxLength={80}
            disabled={creating}
            aria-label="Nom du nouveau genre"
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={creating || !newLabel.trim()}
          >
            {creating ? <FiLoader className="spin" size={14} /> : <FiPlus size={14} />} Ajouter
          </button>
        </div>

        <label className="gm-search">
          <FiSearch aria-hidden="true" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filtrer les genres…"
            aria-label="Filtrer les genres"
          />
        </label>

        <div className="gm-body">
          {loading ? (
            <div className="gm-empty"><FiLoader className="spin" size={20} /> Chargement…</div>
          ) : filtered.length === 0 ? (
            <div className="gm-empty">
              {genres.length === 0 ? 'Aucun genre. Créez-en un ci-dessus.' : 'Aucun genre ne correspond au filtre.'}
            </div>
          ) : (
            <ul className="gm-list">
              {filtered.map((g) => (
                <li key={g.id} className={`gm-row ${deleteId === g.id ? 'is-deleting' : ''}`}>
                  {editId === g.id ? (
                    <div className="gm-row-edit">
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); handleRename(g); }
                          if (e.key === 'Escape') cancelEdit();
                        }}
                        maxLength={80}
                        autoFocus
                        disabled={savingId === g.id}
                        aria-label={`Nouveau nom pour ${g.label}`}
                      />
                      <button
                        type="button"
                        className="gm-icon-btn confirm"
                        onClick={() => handleRename(g)}
                        disabled={savingId === g.id || !editLabel.trim()}
                        aria-label="Valider le nom"
                      >
                        {savingId === g.id ? <FiLoader className="spin" size={14} /> : <FiCheck size={14} />}
                      </button>
                      <button
                        type="button"
                        className="gm-icon-btn"
                        onClick={cancelEdit}
                        disabled={savingId === g.id}
                        aria-label="Annuler"
                      >
                        <FiX size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="gm-row-main">
                      <span className="gm-label">{g.label}</span>
                      <span className={`gm-count ${g.count === 0 ? 'is-zero' : ''}`}>
                        {g.count} livre{g.count > 1 ? 's' : ''}
                      </span>
                      <span className="gm-actions">
                        <button
                          type="button"
                          className="gm-icon-btn"
                          onClick={() => startEdit(g)}
                          title="Renommer"
                          aria-label={`Renommer ${g.label}`}
                        >
                          <FiEdit2 size={14} />
                        </button>
                        <button
                          type="button"
                          className="gm-icon-btn danger"
                          onClick={() => startDelete(g)}
                          title="Supprimer"
                          aria-label={`Supprimer ${g.label}`}
                        >
                          <FiTrash2 size={14} />
                        </button>
                      </span>
                    </div>
                  )}

                  {deleteId === g.id && (
                    <div className="gm-delete-confirm">
                      <p className="gm-delete-title">
                        <FiAlertTriangle aria-hidden="true" /> Supprimer «&nbsp;{g.label}&nbsp;» ?
                      </p>
                      {g.count > 0 && (
                        <div className="gm-reassign">
                          <label htmlFor={`gm-reassign-${g.id}`}>
                            {g.count} livre{g.count > 1 ? 's' : ''} rattaché{g.count > 1 ? 's' : ''} :
                          </label>
                          <select
                            id={`gm-reassign-${g.id}`}
                            value={reassignTo}
                            onChange={(e) => setReassignTo(e.target.value)}
                            disabled={deletingId === g.id}
                          >
                            <option value="__none__">Supprimer sans réaffecter (les livres perdront ce genre)</option>
                            {otherGenres(g).map((x) => (
                              <option key={x.id} value={x.id}>Réaffecter vers «&nbsp;{x.label}&nbsp;»</option>
                            ))}
                          </select>
                        </div>
                      )}
                      <div className="gm-confirm-actions">
                        <button type="button" className="btn btn-outline" onClick={cancelDelete} disabled={deletingId === g.id}>
                          Annuler
                        </button>
                        <button type="button" className="gm-danger-btn" onClick={() => handleDelete(g)} disabled={deletingId === g.id}>
                          {deletingId === g.id ? <FiLoader className="spin" size={14} /> : <FiTrash2 size={14} />}
                          {g.count > 0 && reassignTo !== '__none__' ? ' Fusionner' : ' Supprimer'}
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="gm-footer">
          <span className="gm-count-total">{genres.length} genre{genres.length > 1 ? 's' : ''}</span>
          <button type="button" className="btn btn-primary" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}
