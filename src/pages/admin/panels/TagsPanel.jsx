import { useState, useEffect, useCallback } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiTag, FiLock, FiEye, FiEyeOff, FiSave, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { listTags, createTag, updateTag, deleteTag } from '../../../api/tags';
import ConfirmModal from '../../../components/common/ConfirmModal';
import './TagsPanel.css';

const ICONS = ['FiTag', 'FiStar', 'FiCalendar', 'FiZap', 'FiAward', 'FiHeart', 'FiTrendingUp', 'FiBookmark', 'FiGift', 'FiFlag'];
const COLORS = ['#10531a', '#059669', '#ea580c', '#dc2626', '#7c3aed', '#0284c7', '#0891b2', '#d97706', '#be185d', '#4b5563'];

export default function TagsPanel() {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // tag object or 'new'
  const [confirmDelete, setConfirmDelete] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    listTags()
      .then((res) => setTags(res.data || []))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur chargement tags'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (data) => {
    try {
      if (editing === 'new') {
        await createTag(data);
        toast.success('Tag créé');
      } else {
        await updateTag(editing.id, data);
        toast.success('Tag mis à jour');
      }
      setEditing(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur enregistrement');
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteTag(confirmDelete.id);
      toast.success('Tag supprimé');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression');
      setConfirmDelete(null);
    }
  };

  const handleToggle = async (tag, field) => {
    try {
      await updateTag(tag.id, { [field]: tag[field] ? 0 : 1 });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  return (
    <div className="tags-panel">
      <div className="tags-header">
        <div>
          <h2><FiTag aria-hidden="true" /> Tags de curation</h2>
          <p>Organisez l'affichage du site : "Notre sélection", "Livres du mois", "Nouveautés", "Promotions"…</p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing('new')} type="button">
          <FiPlus aria-hidden="true" /> Nouveau tag
        </button>
      </div>

      {loading ? (
        <div className="tags-loading">Chargement…</div>
      ) : (
        <table className="tags-table">
          <thead>
            <tr>
              <th>Ordre</th>
              <th>Tag</th>
              <th>Slug</th>
              <th>Description</th>
              <th>Livres</th>
              <th>Actif</th>
              <th>Home</th>
              <th>Max</th>
              <th style={{ width: 100 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tags.map((t) => (
              <tr key={t.id}>
                <td>{t.sort_order}</td>
                <td>
                  <span className="tag-badge" style={{ background: t.color, color: '#fff' }}>
                    {t.is_system && <FiLock size={10} aria-label="Système" />}
                    {t.label}
                  </span>
                </td>
                <td><code className="tag-slug">{t.slug}</code></td>
                <td className="tag-desc">{t.description || '—'}</td>
                <td style={{ textAlign: 'center', fontWeight: 700 }}>{t.book_count}</td>
                <td>
                  <button
                    type="button"
                    className={`tag-toggle ${t.is_active ? 'on' : 'off'}`}
                    onClick={() => handleToggle(t, 'is_active')}
                    title={t.is_active ? 'Actif — cliquer pour désactiver' : 'Inactif — cliquer pour activer'}
                    aria-pressed={!!t.is_active}
                  >
                    {t.is_active ? 'Oui' : 'Non'}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className={`tag-toggle ${t.show_on_home ? 'on' : 'off'}`}
                    onClick={() => handleToggle(t, 'show_on_home')}
                    title={t.show_on_home ? 'Visible sur la home' : 'Masqué de la home'}
                    aria-pressed={!!t.show_on_home}
                  >
                    {t.show_on_home ? <FiEye size={14} /> : <FiEyeOff size={14} />}
                  </button>
                </td>
                <td style={{ textAlign: 'center' }}>{t.max_items}</td>
                <td className="tag-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => setEditing(t)}
                    title="Éditer"
                    aria-label="Éditer le tag"
                  >
                    <FiEdit2 size={14} aria-hidden="true" />
                  </button>
                  {!t.is_system && (
                    <button
                      type="button"
                      className="btn-icon danger"
                      onClick={() => setConfirmDelete(t)}
                      title="Supprimer"
                      aria-label="Supprimer le tag"
                    >
                      <FiTrash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <TagEditor
          tag={editing === 'new' ? null : editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Supprimer le tag"
          message={`Supprimer le tag "${confirmDelete.label}" ? Les livres associés ne seront pas supprimés, ils perdront simplement ce tag.`}
          confirmLabel="Supprimer"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function TagEditor({ tag, onSave, onCancel }) {
  const [form, setForm] = useState({
    label: tag?.label || '',
    slug: tag?.slug || '',
    description: tag?.description || '',
    color: tag?.color || '#10531a',
    icon: tag?.icon || 'FiTag',
    sort_order: tag?.sort_order ?? 0,
    is_active: tag?.is_active ?? 1,
    show_on_home: tag?.show_on_home ?? 1,
    max_items: tag?.max_items ?? 12,
  });

  const isEdit = !!tag;
  const isSystem = tag?.is_system;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.label || form.label.trim().length < 2) {
      toast.error('Label requis');
      return;
    }
    onSave(form);
  };

  return (
    <div className="tag-editor-overlay" onClick={onCancel} role="presentation">
      <form className="tag-editor" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
        <div className="tag-editor-header">
          <h3>{isEdit ? 'Modifier le tag' : 'Nouveau tag'}</h3>
          <button type="button" onClick={onCancel} className="btn-icon" aria-label="Fermer">
            <FiX aria-hidden="true" />
          </button>
        </div>

        <div className="tag-editor-field">
          <label>Label <span className="required">*</span></label>
          <input
            type="text"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            maxLength={50}
            autoFocus
          />
        </div>

        {!isSystem && (
          <div className="tag-editor-field">
            <label>Slug {!isEdit && <em>(auto-généré si vide)</em>}</label>
            <input
              type="text"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              maxLength={50}
              placeholder={form.label ? form.label.toLowerCase().replace(/[^a-z0-9]+/g, '_') : ''}
              disabled={isSystem}
            />
          </div>
        )}
        {isSystem && (
          <p className="tag-editor-system-note">
            <FiLock size={12} aria-hidden="true" /> Tag système — le slug <code>{form.slug}</code> ne peut être modifié.
          </p>
        )}

        <div className="tag-editor-field">
          <label>Description</label>
          <textarea
            rows={2}
            value={form.description || ''}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            maxLength={200}
          />
        </div>

        <div className="tag-editor-row">
          <div className="tag-editor-field">
            <label>Couleur</label>
            <div className="color-picker">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`color-swatch ${form.color === c ? 'active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setForm({ ...form, color: c })}
                  aria-label={`Couleur ${c}`}
                  aria-pressed={form.color === c}
                />
              ))}
            </div>
          </div>

          <div className="tag-editor-field">
            <label>Icône</label>
            <select
              value={form.icon}
              onChange={(e) => setForm({ ...form, icon: e.target.value })}
            >
              {ICONS.map((i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
        </div>

        <div className="tag-editor-row">
          <div className="tag-editor-field">
            <label>Ordre d'affichage</label>
            <input
              type="number"
              min="0"
              max="99"
              value={form.sort_order}
              onChange={(e) => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="tag-editor-field">
            <label>Max items (home)</label>
            <input
              type="number"
              min="1"
              max="50"
              value={form.max_items}
              onChange={(e) => setForm({ ...form, max_items: parseInt(e.target.value) || 12 })}
            />
          </div>
        </div>

        <div className="tag-editor-row">
          <label className="tag-editor-check">
            <input
              type="checkbox"
              checked={!!form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked ? 1 : 0 })}
            />
            Tag actif
          </label>
          <label className="tag-editor-check">
            <input
              type="checkbox"
              checked={!!form.show_on_home}
              onChange={(e) => setForm({ ...form, show_on_home: e.target.checked ? 1 : 0 })}
            />
            Afficher sur la home
          </label>
        </div>

        <div className="tag-editor-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            <FiX aria-hidden="true" /> Annuler
          </button>
          <button type="submit" className="btn btn-primary">
            <FiSave aria-hidden="true" /> {isEdit ? 'Enregistrer' : 'Créer'}
          </button>
        </div>
      </form>
    </div>
  );
}
