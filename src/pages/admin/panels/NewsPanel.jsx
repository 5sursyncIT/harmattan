import { useEffect, useState, useMemo } from 'react';
import {
  FiPlus, FiEdit2, FiTrash2, FiUpload, FiArrowLeft, FiSearch,
  FiStar, FiCheckCircle, FiFileText, FiX,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import {
  listNewsArticles,
  createNewsArticle,
  updateNewsArticle,
  deleteNewsArticle,
  uploadNewsImage,
} from '../../../api/admin';

const EMPTY_FORM = {
  id: null,
  title: '',
  category: '',
  excerpt: '',
  content: '',
  cover_image: '',
  status: 'draft',
  pinned: false,
};

function StatusBadge({ status }) {
  const label = status === 'published' ? 'Publiée' : 'Brouillon';
  const color = status === 'published' ? '#10531a' : '#6b7280';
  const bg = status === 'published' ? '#dcfce7' : '#f3f4f6';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
        color, background: bg,
      }}
    >
      {status === 'published' ? <FiCheckCircle size={12} /> : <FiFileText size={12} />}
      {label}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function NewsPanel() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [uploading, setUploading] = useState(false);

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await listNewsArticles();
      setItems(res.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (statusFilter !== 'all' && it.status !== statusFilter) return false;
      if (!q) return true;
      const hay = [it.title, it.excerpt, it.category].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, search, statusFilter]);

  const stats = useMemo(() => ({
    total: items.length,
    published: items.filter((i) => i.status === 'published').length,
    drafts: items.filter((i) => i.status === 'draft').length,
  }), [items]);

  const startCreate = () => setForm({ ...EMPTY_FORM });
  const startEdit = (item) => setForm({ ...EMPTY_FORM, ...item });
  const cancel = () => setForm(null);

  const handleImage = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadNewsImage(file);
      setForm((f) => ({ ...f, cover_image: res.data.path }));
      toast.success('Image téléversée');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur upload');
    } finally {
      setUploading(false);
    }
  };

  const save = async (publish = null) => {
    if (!form.title.trim()) {
      toast.error('Le titre est requis');
      return;
    }
    const payload = {
      title: form.title.trim(),
      category: form.category.trim(),
      excerpt: form.excerpt.trim(),
      content: form.content,
      cover_image: form.cover_image,
      status: publish === null ? form.status : (publish ? 'published' : 'draft'),
      pinned: form.pinned,
    };
    setSaving(true);
    try {
      if (form.id) {
        await updateNewsArticle(form.id, payload);
        toast.success('Actualité mise à jour');
      } else {
        await createNewsArticle(payload);
        toast.success(payload.status === 'published' ? 'Actualité publiée' : 'Brouillon enregistré');
      }
      await fetchList();
      setForm(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item) => {
    if (!confirm(`Supprimer définitivement « ${item.title} » ?`)) return;
    try {
      await deleteNewsArticle(item.id);
      toast.success('Actualité supprimée');
      setItems((arr) => arr.filter((i) => i.id !== item.id));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression');
    }
  };

  // ─── FORM VIEW ─────────────────────────────────────────
  if (form) {
    return (
      <div className="admin-panel">
        <div className="admin-panel-header">
          <button className="btn btn-outline" onClick={cancel}>
            <FiArrowLeft /> Retour à la liste
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-outline"
              onClick={() => save(false)}
              disabled={saving}
            >
              {saving ? 'Sauvegarde…' : 'Enregistrer en brouillon'}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => save(true)}
              disabled={saving}
            >
              {saving ? 'Publication…' : (form.status === 'published' ? 'Mettre à jour' : 'Publier')}
            </button>
          </div>
        </div>

        <div className="admin-card">
          <div className="admin-card-header">
            <h3>{form.id ? 'Modifier l’actualité' : 'Nouvelle actualité'}</h3>
            {form.id && <StatusBadge status={form.status} />}
          </div>

          <div className="admin-form-grid">
            <div className="admin-field" style={{ gridColumn: '1 / -1' }}>
              <label>Titre *</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Annonce, communiqué, lancement…"
                maxLength={200}
              />
            </div>

            <div className="admin-field">
              <label>Rubrique / catégorie</label>
              <input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="Communiqué, Lancement, Salon…"
                list="news-category-suggestions"
              />
              <datalist id="news-category-suggestions">
                <option value="Communiqué" />
                <option value="Lancement" />
                <option value="Salon" />
                <option value="Prix littéraire" />
                <option value="Dédicace" />
                <option value="Partenariat" />
                <option value="Annonce" />
              </datalist>
            </div>

            <div className="admin-field admin-checkbox">
              <label>
                <input
                  type="checkbox"
                  checked={form.pinned}
                  onChange={(e) => setForm({ ...form, pinned: e.target.checked })}
                />
                <FiStar size={14} style={{ marginLeft: 4, marginRight: 4, verticalAlign: 'middle' }} />
                Épingler en tête de liste
              </label>
            </div>
          </div>

          <div className="admin-field" style={{ marginBottom: 16 }}>
            <label>Image de couverture</label>
            {form.cover_image && (
              <div style={{ position: 'relative', display: 'inline-block', marginBottom: 8 }}>
                <img
                  src={form.cover_image}
                  alt=""
                  className="admin-slide-preview"
                  style={{ maxWidth: 360, maxHeight: 200, borderRadius: 8, objectFit: 'cover' }}
                />
                <button
                  type="button"
                  onClick={() => setForm({ ...form, cover_image: '' })}
                  title="Retirer l'image"
                  style={{
                    position: 'absolute', top: 6, right: 6,
                    background: 'rgba(0,0,0,0.65)', color: '#fff',
                    border: 'none', borderRadius: '50%', width: 28, height: 28,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <FiX size={14} />
                </button>
              </div>
            )}
            <div className="admin-file-upload">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => e.target.files[0] && handleImage(e.target.files[0])}
                disabled={uploading}
              />
              <span><FiUpload /> {uploading ? 'Téléversement…' : (form.cover_image ? "Changer l'image" : 'Téléverser une image')}</span>
            </div>
            <small>Formats acceptés : JPG, PNG, WEBP. Taille max 5 Mo.</small>
          </div>

          <div className="admin-field" style={{ marginBottom: 16 }}>
            <label>Extrait (résumé court affiché dans la liste)</label>
            <textarea
              rows={2}
              value={form.excerpt}
              onChange={(e) => setForm({ ...form, excerpt: e.target.value })}
              placeholder="2 à 3 phrases pour résumer l'actualité"
              style={{ resize: 'vertical', minHeight: 60 }}
              maxLength={400}
            />
            <small>{form.excerpt.length}/400 caractères</small>
          </div>

          <div className="admin-field">
            <label>Contenu *</label>
            <textarea
              rows={14}
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              placeholder="Rédigez le contenu complet de l'actualité. Les paragraphes seront séparés par des sauts de ligne."
              style={{ resize: 'vertical', minHeight: 280, lineHeight: 1.6 }}
            />
            <small>Les liens https:// et les sauts de ligne sont préservés à l'affichage.</small>
          </div>
        </div>
      </div>
    );
  }

  // ─── LIST VIEW ─────────────────────────────────────────
  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{stats.total}</strong> actualité{stats.total > 1 ? 's' : ''}
          <span style={{ color: '#10531a' }}>· {stats.published} publiée{stats.published > 1 ? 's' : ''}</span>
          <span style={{ color: '#6b7280' }}>· {stats.drafts} brouillon{stats.drafts > 1 ? 's' : ''}</span>
        </div>
        <button className="btn btn-primary" onClick={startCreate}>
          <FiPlus /> Nouvelle actualité
        </button>
      </div>

      <div className="admin-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 240px' }}>
            <FiSearch
              size={14}
              style={{ position: 'absolute', top: '50%', left: 10, transform: 'translateY(-50%)', color: '#6b7280' }}
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher par titre, extrait, catégorie…"
              style={{
                width: '100%', padding: '8px 12px 8px 30px',
                border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14,
              }}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }}
          >
            <option value="all">Tous statuts</option>
            <option value="published">Publiées</option>
            <option value="draft">Brouillons</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="admin-card">Chargement…</div>
      ) : filtered.length === 0 ? (
        <div className="admin-card" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: '#6b7280', marginBottom: 12 }}>
            {items.length === 0
              ? "Aucune actualité pour le moment. Créez la première !"
              : 'Aucun résultat ne correspond à votre recherche.'}
          </p>
          {items.length === 0 && (
            <button className="btn btn-primary" onClick={startCreate}>
              <FiPlus /> Créer une actualité
            </button>
          )}
        </div>
      ) : (
        <div className="admin-table-container">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Couverture</th>
                <th>Titre</th>
                <th>Rubrique</th>
                <th>Statut</th>
                <th>Publié le</th>
                <th>Mis à jour</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.id}>
                  <td style={{ width: 80 }}>
                    {item.cover_image ? (
                      <img
                        src={item.cover_image}
                        alt=""
                        style={{ width: 64, height: 44, objectFit: 'cover', borderRadius: 4 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 64, height: 44, background: '#f3f4f6', borderRadius: 4,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: '#9ca3af',
                        }}
                      >
                        <FiFileText size={18} />
                      </div>
                    )}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {item.pinned && <FiStar size={12} style={{ color: '#f59e0b', marginRight: 4, verticalAlign: 'middle' }} />}
                      {item.title}
                    </div>
                    {item.excerpt && (
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2, maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.excerpt}
                      </div>
                    )}
                  </td>
                  <td style={{ color: '#6b7280' }}>{item.category || '—'}</td>
                  <td><StatusBadge status={item.status} /></td>
                  <td style={{ color: '#6b7280', fontSize: 13 }}>{formatDate(item.published_at)}</td>
                  <td style={{ color: '#6b7280', fontSize: 13 }}>{formatDate(item.updated_at)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn-icon" onClick={() => startEdit(item)} title="Modifier">
                      <FiEdit2 size={14} />
                    </button>
                    <button className="btn-icon danger" onClick={() => remove(item)} title="Supprimer">
                      <FiTrash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
