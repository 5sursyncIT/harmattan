import { useState, useEffect, useCallback } from 'react';
import { FiSave, FiTrash2, FiX, FiCheck, FiAlertCircle, FiLoader, FiRefreshCw } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { validateBook } from '../../../utils/bookValidation.js';
import { createBook, updateBook, deleteBook, checkIsbn } from '../../../api/admin';
import { getCategories } from '../../../api/dolibarr';
import { listTags, getBookTags, setBookTags } from '../../../api/tags';
import { EXCLUDED_CATEGORIES_SET } from '../../../utils/excludedCategories.js';
import { hydrateBook, decodeEntities } from '../../../utils/bookForm.js';
import ConfirmModal from '../../../components/common/ConfirmModal.jsx';
import AuthorAutocomplete from '../../../components/common/AuthorAutocomplete.jsx';
import CoverUploader from '../../../components/common/CoverUploader.jsx';
import { useFormBinder } from '../../../hooks/useFormField.js';

export default function BookForm({ book, onSaved, onDeleted, onCancel, onCoverUpdated }) {
  const [form, setForm] = useState(() => hydrateBook(book));
  const [errors, setErrors] = useState({});
  const [genres, setGenres] = useState([]);
  const [genresLoaded, setGenresLoaded] = useState(false);
  const [isbnCheck, setIsbnCheck] = useState({ state: 'idle', message: '' });
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null);

  // Tags de curation (Notre sélection, Livre du mois, Nouveauté, Promotion, …)
  const [availableTags, setAvailableTags] = useState([]);
  const [selectedTags, setSelectedTags] = useState([]); // [{ slug, discount_pct? }]

  const isEdit = !!(book && book.id);

  // Build validation payload (genre_id = premier du multi-select)
  const asValidationPayload = useCallback((f = form) => ({
    ...f,
    genre_id: f.genre_ids && f.genre_ids.length > 0 ? f.genre_ids[0] : '',
  }), [form]);

  const validateField = useCallback((key) => {
    const allowedIds = genres.map((g) => g.id);
    const result = validateBook(asValidationPayload(), { allowedGenreIds: allowedIds });
    if (result.errors[key]) {
      setErrors((e) => ({ ...e, [key]: result.errors[key] }));
    }
  }, [genres, asValidationPayload]);

  const bind = useFormBinder(form, setForm, setErrors, validateField);

  // Load genres
  useEffect(() => {
    getCategories()
      .then((res) => {
        const list = (res.data || [])
          .map((c) => ({ id: parseInt(c.id, 10), label: decodeEntities(c.label) }))
          .filter((c) => !EXCLUDED_CATEGORIES_SET.has(c.label))
          .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
        setGenres(list);
      })
      .catch(() => setGenres([]))
      .finally(() => setGenresLoaded(true));
  }, []);

  // Load tags (catalogue global + tags du livre si édition)
  useEffect(() => {
    listTags()
      .then((res) => setAvailableTags((res.data || []).filter((t) => t.is_active)))
      .catch(() => setAvailableTags([]));
  }, []);

  useEffect(() => {
    if (!isEdit || !book?.id) {
      setSelectedTags([]);
      return;
    }
    getBookTags(book.id)
      .then((res) => {
        setSelectedTags((res.data || []).map((t) => ({
          slug: t.slug,
          discount_pct: t.discount_pct || null,
        })));
      })
      .catch(() => setSelectedTags([]));
  }, [isEdit, book?.id]);

  const toggleTag = (slug) => {
    setSelectedTags((prev) => {
      const exists = prev.find((t) => t.slug === slug);
      if (exists) return prev.filter((t) => t.slug !== slug);
      return [...prev, { slug, discount_pct: slug === 'promotion' ? 10 : null }];
    });
  };

  const updateTagDiscount = (slug, value) => {
    const num = value === '' ? null : Math.max(0, Math.min(100, parseFloat(value)));
    setSelectedTags((prev) =>
      prev.map((t) => t.slug === slug ? { ...t, discount_pct: Number.isFinite(num) ? num : null } : t)
    );
  };

  useEffect(() => {
    setForm(hydrateBook(book));
    setErrors({});
    setIsbnCheck({ state: 'idle', message: '' });
  }, [book]);

  const toggleGenre = (genreId) => {
    setForm((f) => {
      const has = f.genre_ids.includes(genreId);
      return {
        ...f,
        genre_ids: has ? f.genre_ids.filter((g) => g !== genreId) : [...f.genre_ids, genreId],
      };
    });
    setErrors((e) => {
      if (!e.genre_id) return e;
      const n = { ...e };
      delete n.genre_id;
      return n;
    });
  };

  const handleIsbnBlur = useCallback(async () => {
    validateField('isbn');
    if (!form.isbn || form.isbn.length < 10) return;
    setIsbnCheck({ state: 'checking', message: 'Vérification...' });
    try {
      const excludeId = isEdit ? form.id : null;
      const res = await checkIsbn(form.isbn.replace(/[\s-]/g, ''), excludeId);
      if (res.data.exists) {
        setIsbnCheck({ state: 'duplicate', message: `ISBN déjà utilisé (livre ${res.data.ref})` });
      } else {
        setIsbnCheck({ state: 'available', message: 'ISBN disponible' });
      }
    } catch (err) {
      setIsbnCheck({ state: 'error', message: err.response?.data?.error || 'Erreur vérification' });
    }
  }, [form.isbn, form.id, isEdit, validateField]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!genresLoaded) {
      toast.error('Chargement des genres en cours — merci de patienter');
      return;
    }
    const allowedIds = genres.map((g) => g.id);
    const result = validateBook(asValidationPayload(), { allowedGenreIds: allowedIds });
    if (!result.valid) {
      setErrors(result.errors);
      toast.error('Veuillez corriger les erreurs du formulaire');
      return;
    }
    if (isbnCheck.state === 'duplicate') {
      setErrors((err) => ({ ...err, isbn: isbnCheck.message }));
      toast.error('ISBN en doublon, choisissez un autre identifiant');
      return;
    }
    setShowConfirm('save');
  };

  const confirmSave = async () => {
    setShowConfirm(null);
    setSaving(true);
    try {
      const payload = { ...form, genre_id: form.genre_ids[0] || '' };
      let bookId;
      if (isEdit) {
        await updateBook(form.id, payload);
        bookId = form.id;
        toast.success('Livre mis à jour');
      } else {
        const res = await createBook(payload);
        bookId = res.data.id;
        toast.success(`Livre créé (ID ${bookId})`);
      }
      // Propagation des tags (si édition, ou si création avec bookId retourné)
      if (bookId) {
        try {
          await setBookTags(bookId, selectedTags);
        } catch (tagErr) {
          toast.error('Livre sauvegardé mais erreur sur les tags — ' + (tagErr.response?.data?.error || tagErr.message));
        }
      }
      onSaved && onSaved();
    } catch (err) {
      const payload = err.response?.data;
      if (payload?.errors) setErrors(payload.errors);
      toast.error(payload?.error || 'Erreur enregistrement');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setShowConfirm(null);
    setSaving(true);
    try {
      await deleteBook(form.id);
      toast.success('Livre masqué du catalogue');
      onDeleted && onDeleted();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression');
    } finally {
      setSaving(false);
    }
  };

  const selectAuthorSuggestion = (authorName) => {
    const parts = authorName.trim().split(/\s+/);
    const nom = parts[0] || '';
    const prenom = parts.slice(1).join(' ') || '';
    setForm((f) => ({ ...f, author_nom: nom, author_prenom: prenom }));
    setErrors((e) => {
      const n = { ...e };
      delete n.author;
      return n;
    });
  };

  const formValidation = validateBook(asValidationPayload(), { allowedGenreIds: genres.map((g) => g.id) });
  const canSave = genresLoaded && formValidation.valid && isbnCheck.state !== 'duplicate' && !saving;

  return (
    <form onSubmit={handleSubmit} className="book-form" noValidate>
      <div className="book-form-header">
        {isEdit && book?.id && (
          <CoverUploader
            productId={book.id}
            title={form.title}
            onUpdated={onCoverUpdated}
          />
        )}
        <div className="book-form-header-text">
          <h3>{isEdit ? 'Modifier le livre' : 'Nouveau livre'}</h3>
          <div className="book-form-validity">
            {!genresLoaded ? (
              <span className="book-loading-tag"><FiLoader className="spin" /> Chargement des genres…</span>
            ) : formValidation.valid ? (
              <span className="book-valid"><FiCheck aria-hidden="true" /> Formulaire valide</span>
            ) : (
              <span className="book-invalid"><FiAlertCircle aria-hidden="true" /> {Object.keys(formValidation.errors).length} champ(s) invalide(s)</span>
            )}
          </div>
        </div>
      </div>

      <Field label="Titre" required error={errors.title}>
        <input type="text" {...bind('title')} maxLength={200} placeholder="Titre de l'ouvrage" />
      </Field>

      <div className="book-form-row">
        <Field label="Nom auteur" required error={errors.author} grow>
          <AuthorAutocomplete
            value={form.author_nom}
            onChange={(v) => bind('author_nom').onChange(v)}
            onSelect={selectAuthorSuggestion}
            extraQuery={form.author_prenom}
            onBlur={() => validateField('author')}
            maxLength={80}
            placeholder="Rechercher un auteur existant..."
          />
        </Field>
        <Field label="Prénom auteur" grow>
          <input type="text" {...bind('author_prenom')} maxLength={80} placeholder="Papa" />
        </Field>
      </div>

      <Field label="ISBN" required error={errors.isbn}>
        <div className="book-isbn-wrap">
          <input
            type="text"
            value={form.isbn}
            onChange={(e) => bind('isbn').onChange(e)}
            onBlur={handleIsbnBlur}
            placeholder="978-2-343-20790-2"
          />
          {isbnCheck.state === 'checking' && (
            <span className="isbn-status checking"><FiLoader className="spin" aria-hidden="true" /> {isbnCheck.message}</span>
          )}
          {isbnCheck.state === 'available' && (
            <span className="isbn-status ok"><FiCheck aria-hidden="true" /> {isbnCheck.message}</span>
          )}
          {isbnCheck.state === 'duplicate' && (
            <span className="isbn-status ko"><FiAlertCircle aria-hidden="true" /> {isbnCheck.message}</span>
          )}
          {isbnCheck.state === 'error' && (
            <span className="isbn-status ko">
              <FiAlertCircle aria-hidden="true" /> {isbnCheck.message}
              <button type="button" className="isbn-retry" onClick={handleIsbnBlur} aria-label="Réessayer la vérification ISBN">
                <FiRefreshCw size={11} aria-hidden="true" /> Réessayer
              </button>
            </span>
          )}
        </div>
      </Field>

      <div className="book-form-row">
        <Field label="Éditeur" required error={errors.editeur} grow>
          <input type="text" {...bind('editeur')} maxLength={100} />
        </Field>
        <Field label="Année publication" required error={errors.publication_year}>
          <input
            type="number"
            {...bind('publication_year')}
            min="1000"
            max={new Date().getFullYear()}
          />
        </Field>
      </div>

      <div className="book-form-row">
        <Field label="Genres" required error={errors.genre_id} grow hint="Sélectionnez un ou plusieurs genres">
          <div className="genre-multiselect" role="group" aria-label="Sélection des genres">
            {!genresLoaded ? (
              <span className="genre-loading"><FiLoader className="spin" size={12} /> Chargement…</span>
            ) : genres.length === 0 ? (
              <span className="genre-loading">Aucun genre disponible</span>
            ) : (
              genres.map((g) => {
                const selected = form.genre_ids.includes(g.id);
                return (
                  <button
                    type="button"
                    key={g.id}
                    className={`genre-chip ${selected ? 'selected' : ''}`}
                    onClick={() => toggleGenre(g.id)}
                    aria-pressed={selected}
                  >
                    {selected && <FiCheck size={11} aria-hidden="true" />}
                    {g.label}
                  </button>
                );
              })
            )}
          </div>
        </Field>
        <Field label="Nombre de pages" required error={errors.nombre_pages}>
          <input type="number" {...bind('nombre_pages')} min="1" step="1" />
        </Field>
      </div>

      <Field label="Prix TTC (FCFA)" required error={errors.price_ttc}>
        <input type="number" {...bind('price_ttc')} min="1" step="0.01" />
      </Field>

      <Field label="Sous-titre">
        <input type="text" {...bind('soustitre')} maxLength={200} />
      </Field>

      <Field label="Description">
        <textarea rows={4} {...bind('description')} maxLength={5000} />
      </Field>

      {/* Tags de curation */}
      {availableTags.length > 0 && (
        <Field label="Tags de curation" hint="Cochez les tags à afficher sur la home (ex: Notre sélection, Livres du mois…)">
          <div className="book-tags-picker" role="group" aria-label="Tags de curation">
            {availableTags.map((t) => {
              const picked = selectedTags.find((s) => s.slug === t.slug);
              const isPromo = t.slug === 'promotion';
              return (
                <div key={t.id} className={`book-tag-row ${picked ? 'selected' : ''}`}>
                  <label className="book-tag-check">
                    <input
                      type="checkbox"
                      checked={!!picked}
                      onChange={() => toggleTag(t.slug)}
                    />
                    <span
                      className="book-tag-pill"
                      style={picked ? { background: t.color, color: '#fff', borderColor: t.color } : {}}
                    >
                      {t.label}
                    </span>
                  </label>
                  {picked && isPromo && (
                    <div className="book-tag-discount">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        value={picked.discount_pct ?? ''}
                        onChange={(e) => updateTagDiscount(t.slug, e.target.value)}
                        aria-label="Pourcentage de remise"
                      />
                      <span>% remise</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Field>
      )}

      <div className="book-form-actions">
        {isEdit && (
          <button
            type="button"
            className="btn-icon danger"
            onClick={() => setShowConfirm('delete')}
            disabled={saving}
            title="Masquer ce livre"
            aria-label="Masquer ce livre"
          >
            <FiTrash2 aria-hidden="true" /> Masquer
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
            <FiX aria-hidden="true" /> Annuler
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          <FiSave aria-hidden="true" /> {isEdit ? 'Enregistrer les modifications' : 'Créer le livre'}
        </button>
      </div>

      {showConfirm === 'save' && (
        <ConfirmModal
          title={isEdit ? 'Confirmer la modification' : 'Confirmer la création'}
          message={isEdit
            ? `Enregistrer les modifications du livre "${form.title}" ?`
            : `Créer le livre "${form.title}" dans le catalogue Dolibarr ?`}
          onConfirm={confirmSave}
          onCancel={() => setShowConfirm(null)}
        />
      )}
      {showConfirm === 'delete' && (
        <ConfirmModal
          title="Confirmer le masquage"
          message={`Masquer "${form.title}" du catalogue public ? Le livre reste dans Dolibarr et peut être réactivé.`}
          confirmLabel="Masquer"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setShowConfirm(null)}
        />
      )}
    </form>
  );
}

function Field({ label, required, error, grow, hint, children }) {
  return (
    <div className={`admin-field ${grow ? 'grow' : ''} ${error ? 'has-error' : ''}`}>
      <label>{label}{required && <span className="required" aria-label="requis">*</span>}</label>
      {children}
      {hint && !error && <p className="field-hint">{hint}</p>}
      {error && <p className="field-error" role="alert"><FiAlertCircle size={12} aria-hidden="true" /> {error}</p>}
    </div>
  );
}
