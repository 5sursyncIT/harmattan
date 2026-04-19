import { useState, useEffect, useCallback, useRef } from 'react';
import { FiSave, FiTrash2, FiX, FiCheck, FiAlertCircle, FiLoader, FiUsers } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { validateBook } from '../../../utils/bookValidation.js';
import { createBook, updateBook, deleteBook, checkIsbn, searchAuthors } from '../../../api/admin';
import { getCategories } from '../../../api/dolibarr';

const EMPTY_BOOK = {
  title: '',
  author_nom: '',
  author_prenom: '',
  isbn: '',
  editeur: "L'Harmattan Sénégal",
  publication_year: new Date().getFullYear(),
  genre_id: '',
  nombre_pages: '',
  price_ttc: '',
  soustitre: '',
  description: '',
};

const EXCLUDED_GENRES = new Set([
  'LIBRAIRIE', 'LIVRES', 'Accueil', 'Racine', 'Services', 'Livres du mois', 'http://senharmattan.com/',
]);

function decodeEntities(str) {
  if (!str) return '';
  return str.replace(/&[a-z]+;/gi, (m) => {
    const map = { '&eacute;': 'é', '&egrave;': 'è', '&agrave;': 'à', '&ecirc;': 'ê', '&ocirc;': 'ô', '&ccedil;': 'ç', '&icirc;': 'î', '&ucirc;': 'û', '&amp;': '&' };
    return map[m.toLowerCase()] || m;
  });
}

export default function BookForm({ book, onSaved, onDeleted, onCancel }) {
  const [form, setForm] = useState(book || EMPTY_BOOK);
  const [errors, setErrors] = useState({});
  const [genres, setGenres] = useState([]);
  const [isbnCheck, setIsbnCheck] = useState({ state: 'idle', message: '' });
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(null);

  // Author autocomplete state
  const [authorSuggestions, setAuthorSuggestions] = useState([]);
  const [showAuthorSuggestions, setShowAuthorSuggestions] = useState(false);
  const [loadingAuthors, setLoadingAuthors] = useState(false);
  const authorDebounceRef = useRef(null);
  const authorWrapperRef = useRef(null);

  const isEdit = !!(book && book.id);

  // Load genres
  useEffect(() => {
    getCategories()
      .then((res) => {
        const list = (res.data || [])
          .map((c) => ({ id: c.id, label: decodeEntities(c.label) }))
          .filter((c) => !EXCLUDED_GENRES.has(c.label))
          .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
        setGenres(list);
      })
      .catch(() => setGenres([]));
  }, []);

  // Reset form when `book` prop changes
  useEffect(() => {
    setForm(book || EMPTY_BOOK);
    setErrors({});
    setIsbnCheck({ state: 'idle', message: '' });
  }, [book]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (authorWrapperRef.current && !authorWrapperRef.current.contains(e.target)) {
        setShowAuthorSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounced author search
  const handleAuthorNomChange = (value) => {
    set('author_nom', value);
    if (authorDebounceRef.current) clearTimeout(authorDebounceRef.current);
    if (!value || value.length < 2) {
      setAuthorSuggestions([]);
      setShowAuthorSuggestions(false);
      return;
    }
    // Combine nom + prenom for search if both present
    const query = form.author_prenom ? `${value} ${form.author_prenom}` : value;
    authorDebounceRef.current = setTimeout(async () => {
      setLoadingAuthors(true);
      try {
        const res = await searchAuthors(query.trim(), 8);
        setAuthorSuggestions(res.data.authors || []);
        setShowAuthorSuggestions(true);
      } catch {
        setAuthorSuggestions([]);
      } finally {
        setLoadingAuthors(false);
      }
    }, 300);
  };

  const selectAuthorSuggestion = (authorName) => {
    // Split author name: first word = nom, rest = prenom
    const parts = authorName.trim().split(/\s+/);
    const nom = parts[0] || '';
    const prenom = parts.slice(1).join(' ') || '';
    setForm((f) => ({ ...f, author_nom: nom, author_prenom: prenom }));
    setShowAuthorSuggestions(false);
    setAuthorSuggestions([]);
    setErrors((e) => {
      const n = { ...e };
      delete n.author;
      return n;
    });
  };

  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => {
      if (!e[key]) return e;
      const n = { ...e };
      delete n[key];
      return n;
    });
  };

  // Validate a single field on blur
  const validateField = (key) => {
    const allowedIds = genres.map((g) => g.id);
    const result = validateBook(form, { allowedGenreIds: allowedIds });
    if (result.errors[key]) {
      setErrors((e) => ({ ...e, [key]: result.errors[key] }));
    }
  };

  // Async ISBN uniqueness check on blur
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
  }, [form.isbn, form.id, isEdit]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const allowedIds = genres.map((g) => g.id);
    const result = validateBook(form, { allowedGenreIds: allowedIds });
    if (!result.valid) {
      setErrors(result.errors);
      toast.error('Veuillez corriger les erreurs du formulaire');
      return;
    }
    if (isbnCheck.state === 'duplicate') {
      setErrors((e) => ({ ...e, isbn: isbnCheck.message }));
      toast.error('ISBN en doublon, choisissez un autre identifiant');
      return;
    }
    setShowConfirm('save');
  };

  const confirmSave = async () => {
    setShowConfirm(null);
    setSaving(true);
    try {
      if (isEdit) {
        await updateBook(form.id, form);
        toast.success('Livre mis à jour');
      } else {
        const res = await createBook(form);
        toast.success(`Livre créé (ID ${res.data.id})`);
      }
      onSaved && onSaved();
    } catch (err) {
      const payload = err.response?.data;
      if (payload?.errors) {
        setErrors(payload.errors);
      }
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

  const formValidation = validateBook(form, { allowedGenreIds: genres.map((g) => g.id) });
  const canSave = formValidation.valid && isbnCheck.state !== 'duplicate' && !saving;

  return (
    <form onSubmit={handleSubmit} className="book-form">
      {/* Header */}
      <div className="book-form-header">
        <h3>{isEdit ? 'Modifier le livre' : 'Nouveau livre'}</h3>
        <div className="book-form-validity">
          {formValidation.valid ? (
            <span className="book-valid"><FiCheck /> Formulaire valide</span>
          ) : (
            <span className="book-invalid"><FiAlertCircle /> {Object.keys(formValidation.errors).length} champ(s) invalide(s)</span>
          )}
        </div>
      </div>

      {/* Title */}
      <Field label="Titre" required error={errors.title}>
        <input
          type="text"
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
          onBlur={() => validateField('title')}
          maxLength={200}
          placeholder="Titre de l'ouvrage"
        />
      </Field>

      {/* Author */}
      <div className="book-form-row">
        <Field label="Nom auteur" required error={errors.author} grow>
          <div className="author-autocomplete" ref={authorWrapperRef}>
            <input
              type="text"
              value={form.author_nom}
              onChange={(e) => handleAuthorNomChange(e.target.value)}
              onFocus={() => {
                if (authorSuggestions.length > 0) setShowAuthorSuggestions(true);
              }}
              onBlur={() => validateField('author')}
              maxLength={80}
              placeholder="Rechercher un auteur existant..."
              autoComplete="off"
            />
            {loadingAuthors && (
              <span className="author-loading"><FiLoader className="spin" size={14} /></span>
            )}
            {showAuthorSuggestions && authorSuggestions.length > 0 && (
              <ul className="author-suggestions">
                <li className="author-suggestions-header">
                  <FiUsers size={12} /> {authorSuggestions.length} auteur(s) existant(s) — cliquez pour réutiliser
                </li>
                {authorSuggestions.map((a, i) => (
                  <li key={i} className="author-suggestion-item" onClick={() => selectAuthorSuggestion(a.name)}>
                    <span className="author-suggestion-name">{a.name}</span>
                    <span className="author-suggestion-count">{a.book_count} livre{a.book_count > 1 ? 's' : ''}</span>
                  </li>
                ))}
              </ul>
            )}
            {showAuthorSuggestions && authorSuggestions.length === 0 && !loadingAuthors && form.author_nom.length >= 2 && (
              <ul className="author-suggestions">
                <li className="author-suggestions-empty">
                  <FiCheck size={12} /> Nouvel auteur — aucun doublon détecté
                </li>
              </ul>
            )}
          </div>
        </Field>
        <Field label="Prénom auteur" grow>
          <input
            type="text"
            value={form.author_prenom}
            onChange={(e) => set('author_prenom', e.target.value)}
            onBlur={() => validateField('author')}
            maxLength={80}
            placeholder="Papa"
          />
        </Field>
      </div>

      {/* ISBN */}
      <Field label="ISBN" required error={errors.isbn}>
        <div className="book-isbn-wrap">
          <input
            type="text"
            value={form.isbn}
            onChange={(e) => set('isbn', e.target.value)}
            onBlur={handleIsbnBlur}
            placeholder="978-2-343-20790-2"
          />
          {isbnCheck.state === 'checking' && (
            <span className="isbn-status checking"><FiLoader className="spin" /> {isbnCheck.message}</span>
          )}
          {isbnCheck.state === 'available' && (
            <span className="isbn-status ok"><FiCheck /> {isbnCheck.message}</span>
          )}
          {isbnCheck.state === 'duplicate' && (
            <span className="isbn-status ko"><FiAlertCircle /> {isbnCheck.message}</span>
          )}
          {isbnCheck.state === 'error' && (
            <span className="isbn-status ko"><FiAlertCircle /> {isbnCheck.message}</span>
          )}
        </div>
      </Field>

      {/* Editeur + Année */}
      <div className="book-form-row">
        <Field label="Éditeur" required error={errors.editeur} grow>
          <input
            type="text"
            value={form.editeur}
            onChange={(e) => set('editeur', e.target.value)}
            onBlur={() => validateField('editeur')}
            maxLength={100}
          />
        </Field>
        <Field label="Année publication" required error={errors.publication_year}>
          <input
            type="number"
            value={form.publication_year}
            onChange={(e) => set('publication_year', e.target.value)}
            onBlur={() => validateField('publication_year')}
            min="1000"
            max={new Date().getFullYear()}
          />
        </Field>
      </div>

      {/* Genre + Pages */}
      <div className="book-form-row">
        <Field label="Genre" required error={errors.genre_id} grow>
          <select
            value={form.genre_id}
            onChange={(e) => set('genre_id', e.target.value)}
            onBlur={() => validateField('genre_id')}
          >
            <option value="">— Sélectionner un genre —</option>
            {genres.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Nombre de pages" required error={errors.nombre_pages}>
          <input
            type="number"
            value={form.nombre_pages}
            onChange={(e) => set('nombre_pages', e.target.value)}
            onBlur={() => validateField('nombre_pages')}
            min="1"
            step="1"
          />
        </Field>
      </div>

      {/* Prix */}
      <Field label="Prix TTC (FCFA)" required error={errors.price_ttc}>
        <input
          type="number"
          value={form.price_ttc}
          onChange={(e) => set('price_ttc', e.target.value)}
          onBlur={() => validateField('price_ttc')}
          min="1"
          step="0.01"
        />
      </Field>

      {/* Sous-titre */}
      <Field label="Sous-titre">
        <input
          type="text"
          value={form.soustitre}
          onChange={(e) => set('soustitre', e.target.value)}
          maxLength={200}
        />
      </Field>

      {/* Description */}
      <Field label="Description">
        <textarea
          rows={4}
          value={form.description}
          onChange={(e) => set('description', e.target.value)}
          maxLength={5000}
        />
      </Field>

      {/* Actions */}
      <div className="book-form-actions">
        {isEdit && (
          <button
            type="button"
            className="btn-icon danger"
            onClick={() => setShowConfirm('delete')}
            disabled={saving}
            title="Masquer ce livre"
          >
            <FiTrash2 /> Masquer
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>
            <FiX /> Annuler
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          <FiSave /> {isEdit ? 'Enregistrer les modifications' : 'Créer le livre'}
        </button>
      </div>

      {/* Confirmation modals */}
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

// ─── Sub-components ───────────────────────────────

function Field({ label, required, error, grow, children }) {
  return (
    <div className={`admin-field ${grow ? 'grow' : ''} ${error ? 'has-error' : ''}`}>
      <label>{label}{required && <span className="required">*</span>}</label>
      {children}
      {error && <p className="field-error"><FiAlertCircle size={12} /> {error}</p>}
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel = 'Confirmer', danger = false, onConfirm, onCancel }) {
  return (
    <div className="book-modal-overlay" onClick={onCancel}>
      <div className="book-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="book-modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel}>Annuler</button>
          <button
            type="button"
            className={danger ? 'btn-icon danger' : 'btn btn-primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
