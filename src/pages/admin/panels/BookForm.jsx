import { useState, useEffect, useCallback } from 'react';
import { FiSave, FiTrash2, FiX, FiCheck, FiAlertCircle, FiLoader, FiRefreshCw, FiPlus } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { validateBook } from '../../../utils/bookValidation.js';
import { createBook, updateBook, deleteBook, checkIsbn, createGenre } from '../../../api/admin';
import { getCategories } from '../../../api/dolibarr';
import { listTags, getBookTags, setBookTags } from '../../../api/tags';
import { EXCLUDED_CATEGORIES_SET } from '../../../utils/excludedCategories.js';
import { hydrateBook, decodeEntities } from '../../../utils/bookForm.js';
import ConfirmModal from '../../../components/common/ConfirmModal.jsx';
import AuthorAutocomplete from '../../../components/common/AuthorAutocomplete.jsx';
import MultiAuthorPicker from '../../../components/common/MultiAuthorPicker.jsx';
import CoverUploader from '../../../components/common/CoverUploader.jsx';
import { useFormBinder } from '../../../hooks/useFormField.js';

export default function BookForm({ book, onSaved, onDeleted, onCancel, onCoverUpdated }) {
  const [form, setForm] = useState(() => hydrateBook(book));
  const [errors, setErrors] = useState({});
  const [genres, setGenres] = useState([]);
  const [genresLoaded, setGenresLoaded] = useState(false);
  const [addingGenre, setAddingGenre] = useState(false); // formulaire d'ajout ouvert
  const [newGenre, setNewGenre] = useState('');
  const [creatingGenre, setCreatingGenre] = useState(false);
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

  const handleCreateGenre = async () => {
    const label = newGenre.trim();
    if (!label) return;
    setCreatingGenre(true);
    try {
      const res = await createGenre(label);
      const created = { id: parseInt(res.data.id, 10), label: decodeEntities(res.data.label) };
      // Ajoute (s'il n'y est pas déjà) en gardant le tri alphabétique FR, puis sélectionne
      setGenres((prev) => {
        if (prev.some((g) => g.id === created.id)) return prev;
        return [...prev, created].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
      });
      if (!form.genre_ids.includes(created.id)) toggleGenre(created.id);
      setNewGenre('');
      setAddingGenre(false);
      toast.success(`Genre « ${created.label} » ajouté`);
    } catch (err) {
      const status = err?.response?.status;
      const existing = err?.response?.data?.genre;
      if (status === 409 && existing) {
        // Doublon : on récupère le genre existant et on le sélectionne
        const g = { id: parseInt(existing.id, 10), label: decodeEntities(existing.label) };
        setGenres((prev) => (prev.some((x) => x.id === g.id) ? prev : [...prev, g].sort((a, b) => a.label.localeCompare(b.label, 'fr'))));
        if (!form.genre_ids.includes(g.id)) toggleGenre(g.id);
        setNewGenre('');
        setAddingGenre(false);
        toast(`Ce genre existait déjà — « ${g.label} » sélectionné`, { icon: 'ℹ️' });
      } else {
        toast.error(err?.response?.data?.error || "Impossible de créer le genre");
      }
    } finally {
      setCreatingGenre(false);
    }
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
      const payload = {
        ...form,
        genre_id: form.genre_ids[0] || '',
        author_ids: (form.authors || []).map((a) => a.id), // Phase 4 : envoi des FK
      };
      let bookId;
      if (isEdit) {
        const res = await updateBook(form.id, payload);
        bookId = form.id;
        // 207 Multi-Status : sync genres partielle, prévenir l'admin
        if (res?.status === 207 || res?.data?.warning === 'genres_partial_sync') {
          const failed = res?.data?.genres_failures || {};
          const n = (failed.link?.length || 0) + (failed.unlink?.length || 0);
          toast.error(`Livre enregistré mais ${n} genre(s) n'ont pas pu être synchronisés. Voir la fiche pour confirmer.`, { duration: 8000 });
        } else {
          toast.success('Livre mis à jour');
        }
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

      <Field label="Auteur(s)" required error={errors.author}>
        <MultiAuthorPicker
          value={form.authors || []}
          onChange={(newAuthors) => {
            // Maintient la rétrocompat : author_nom = display_names joints (pour validation et display)
            const display = newAuthors.map((a) => a.display_name).filter(Boolean).join(' ; ');
            setForm((f) => ({
              ...f,
              authors: newAuthors,
              author_nom: display,
              author_prenom: '',
            }));
            setErrors((e) => ({ ...e, author: undefined }));
          }}
        />
      </Field>

      {/* Fallback texte libre si l'auteur n'est dans aucun référentiel : on garde
          l'AuthorAutocomplete pour les cas legacy (livres importés sans match SQLite). */}
      {(!form.authors || form.authors.length === 0) && (
        <div className="book-form-row">
          <Field label="Nom auteur (texte libre, fallback)" error={errors.author} grow>
            <AuthorAutocomplete
              value={form.author_nom}
              onChange={(v) => bind('author_nom').onChange(v)}
              onSelect={selectAuthorSuggestion}
              extraQuery={form.author_prenom}
              onBlur={() => validateField('author')}
              maxLength={80}
              placeholder="Ou tapez librement si l'auteur n'est pas encore référencé…"
            />
          </Field>
          <Field label="Prénom auteur" grow>
            <input type="text" {...bind('author_prenom')} maxLength={80} placeholder="Papa" />
          </Field>
        </div>
      )}

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

            {genresLoaded && (
              addingGenre ? (
                <span className="genre-add-form">
                  <input
                    type="text"
                    className="genre-add-input"
                    value={newGenre}
                    onChange={(e) => setNewGenre(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); handleCreateGenre(); }
                      if (e.key === 'Escape') { setAddingGenre(false); setNewGenre(''); }
                    }}
                    placeholder="Nouveau genre…"
                    maxLength={80}
                    autoFocus
                    disabled={creatingGenre}
                    aria-label="Nom du nouveau genre"
                  />
                  <button
                    type="button"
                    className="genre-add-confirm"
                    onClick={handleCreateGenre}
                    disabled={creatingGenre || !newGenre.trim()}
                    aria-label="Valider le nouveau genre"
                  >
                    {creatingGenre ? <FiLoader className="spin" size={12} /> : <FiCheck size={12} />}
                  </button>
                  <button
                    type="button"
                    className="genre-add-cancel"
                    onClick={() => { setAddingGenre(false); setNewGenre(''); }}
                    disabled={creatingGenre}
                    aria-label="Annuler"
                  >
                    <FiX size={12} />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="genre-chip genre-chip-add"
                  onClick={() => setAddingGenre(true)}
                >
                  <FiPlus size={11} aria-hidden="true" /> Ajouter
                </button>
              )
            )}
          </div>
        </Field>
        <Field label="Nombre de pages" required error={errors.nombre_pages}>
          <input type="number" {...bind('nombre_pages')} min="1" step="1" />
        </Field>
      </div>

      <Field label="Prix TTC (FCFA)" required error={errors.price_ttc}>
        <input type="number" {...bind('price_ttc')} min="1" step="1" inputMode="numeric" />
      </Field>

      <Field label="Sous-titre">
        <input type="text" {...bind('soustitre')} maxLength={200} />
      </Field>

      <Field label="Description">
        <textarea rows={4} {...bind('description')} maxLength={5000} />
      </Field>

      {/* Section « Ouvrages à paraître » — pilote la home + la précommande */}
      <Field
        label="Mise en avant"
        hint="Affiche ce livre dans la section « Ouvrages à paraître » de la page d'accueil et active la précommande sur sa fiche."
      >
        <label className="book-upcoming-check">
          <input
            type="checkbox"
            checked={!!form.is_upcoming}
            onChange={(e) => setForm((f) => ({ ...f, is_upcoming: e.target.checked }))}
          />
          <span>Ouvrage à paraître</span>
        </label>
      </Field>

      {form.is_upcoming && (
        <>
          <div className="book-form-row">
            <Field label="Date de parution prévue" hint="Affichée sur la carte (optionnelle).">
              <input type="date" {...bind('release_date')} />
            </Field>
            <Field label="Remise précommande (%)" hint="0 = pas de remise.">
              <input type="number" min="0" max="100" step="0.5" inputMode="numeric" {...bind('preorder_discount_pct')} />
            </Field>
          </div>
          <Field label="Accroche « à paraître »" hint="Texte court sur la carte. Si vide, la description du livre est utilisée.">
            <textarea rows={3} {...bind('upcoming_summary')} maxLength={2000} />
          </Field>
        </>
      )}

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
