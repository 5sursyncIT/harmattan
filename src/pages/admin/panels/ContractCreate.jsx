import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createContract, searchAuthors } from '../../../api/contracts';
import { FiArrowLeft, FiArrowRight, FiCheck, FiSearch, FiUser, FiAlertCircle } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './Contracts.css';

const TYPES = [
  { value: 'harmattan_2024', label: 'Harmattan 2024', desc: 'Contrat d\u2019\u00e9dition standard L\u2019Harmattan S\u00e9n\u00e9gal', color: '#10531a' },
  { value: 'harmattan_dll', label: 'Harmattan DLL', desc: 'Contrat Droit de Licence Libre', color: '#0284c7' },
  { value: 'tamarinier', label: 'Le Tamarinier', desc: 'Contrat \u00e9ditions Le Tamarinier', color: '#7c3aed' },
];

function validateISBN(isbn) {
  if (!isbn) return null;
  const clean = isbn.replace(/[-\s]/g, '');
  if (clean.length === 0) return null;
  if (!/^(97[89]\d{10}|\d{10})$/.test(clean)) return 'ISBN invalide (10 ou 13 chiffres)';
  return null;
}

function validateForm(form) {
  const errors = {};
  if (!form.book_title?.trim()) errors.book_title = 'Le titre est requis';
  const isbnErr = validateISBN(form.book_isbn);
  if (isbnErr) errors.book_isbn = isbnErr;
  const rp = parseFloat(form.royalty_rate_print);
  if (isNaN(rp) || rp < 0 || rp > 50) errors.royalty_rate_print = 'Entre 0 et 50%';
  const rd = parseFloat(form.royalty_rate_digital);
  if (isNaN(rd) || rd < 0 || rd > 50) errors.royalty_rate_digital = 'Entre 0 et 50%';
  const th = parseInt(form.royalty_threshold);
  if (isNaN(th) || th < 0) errors.royalty_threshold = 'Doit \u00eatre positif';
  const fc = parseInt(form.free_author_copies);
  if (isNaN(fc) || fc < 0 || fc > 100) errors.free_author_copies = 'Entre 0 et 100';
  if (form.service_start && form.service_end && form.service_end < form.service_start) {
    errors.service_end = 'Doit \u00eatre post\u00e9rieure au d\u00e9but';
  }
  return errors;
}

function Field({ label, required, error, children }) {
  return (
    <div className={`ct-field ${error ? 'has-error' : ''}`}>
      <label>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      {children}
      {error && <span className="ct-field-error"><FiAlertCircle size={12} /> {error}</span>}
    </div>
  );
}

export default function ContractCreate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});

  // Step 1 -- Author
  const [authorQuery, setAuthorQuery] = useState('');
  const [authorResults, setAuthorResults] = useState([]);
  const [authorLoading, setAuthorLoading] = useState(false);
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  const searchTimer = useRef(null);

  // Step 2 -- Terms
  const [form, setForm] = useState({
    contract_type: 'harmattan_2024',
    book_title: searchParams.get('title') || '',
    book_isbn: '',
    royalty_rate_print: 10,
    royalty_rate_digital: 10,
    royalty_threshold: 500,
    free_author_copies: 5,
    service_start: new Date().toISOString().split('T')[0],
    service_end: '',
    note_private: '',
    manuscript_id: searchParams.get('manuscript_id') || '',
  });

  // Pre-fill from manuscript query params
  const authorName = searchParams.get('author');
  useEffect(() => {
    if (authorName) {
      setAuthorQuery(authorName);
      searchAuthors(authorName).then(r => {
        if (r.data?.length > 0) setSelectedAuthor(r.data[0]);
      }).catch(() => {});
    }
  }, [authorName]);

  const handleAuthorSearch = (q) => {
    setAuthorQuery(q);
    setAuthorResults([]);
    clearTimeout(searchTimer.current);
    if (q.length < 2) return;
    setAuthorLoading(true);
    searchTimer.current = setTimeout(() => {
      searchAuthors(q)
        .then(r => setAuthorResults(r.data || []))
        .catch(() => {})
        .finally(() => setAuthorLoading(false));
    }, 300);
  };

  const set = (key, val) => {
    setForm(f => ({ ...f, [key]: val }));
    if (touched[key]) {
      const updated = { ...form, [key]: val };
      const fieldErrors = validateForm(updated);
      setErrors(e => {
        const n = { ...e };
        if (fieldErrors[key]) n[key] = fieldErrors[key];
        else delete n[key];
        return n;
      });
    }
  };

  const handleBlur = (key) => {
    setTouched(t => ({ ...t, [key]: true }));
    const fieldErrors = validateForm(form);
    setErrors(e => {
      const n = { ...e };
      if (fieldErrors[key]) n[key] = fieldErrors[key];
      else delete n[key];
      return n;
    });
  };

  const goToStep3 = () => {
    const allErrors = validateForm(form);
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      setTouched(Object.fromEntries(Object.keys(allErrors).map(k => [k, true])));
      toast.error('Veuillez corriger les champs signal\u00e9s');
      return;
    }
    setStep(3);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await createContract({ thirdparty_id: selectedAuthor.id, ...form });
      toast.success('Contrat cr\u00e9\u00e9 avec succ\u00e8s');
      navigate(`/admin/contracts/${res.data.id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur cr\u00e9ation');
    } finally {
      setSubmitting(false);
    }
  };

  const formValid = Object.keys(validateForm(form)).length === 0;

  return (
    <div className="admin-panel">
      <div className="ct-wizard-header admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate('/admin/contracts')} className="ct-btn-ghost"><FiArrowLeft size={18} /></button>
          <h3 style={{ margin: 0 }}>Nouveau contrat d'\u00e9dition</h3>
        </div>
        <div className="ct-steps">
          {[1, 2, 3].map(s => <div key={s} className={`ct-step-dot ${step >= s ? 'active' : ''}`} />)}
        </div>
      </div>

      {/* Step 1 -- Select Author */}
      {step === 1 && (
        <div className="admin-card">
          <h4 className="ct-step-title"><FiUser size={16} /> \u00c9tape 1 \u2014 S\u00e9lectionner l'auteur</h4>

          {selectedAuthor ? (
            <div className="ct-author-selected">
              <div>
                <div className="ct-author-selected-name">{selectedAuthor.name}</div>
                <div className="ct-author-selected-email">{selectedAuthor.email}</div>
                {selectedAuthor.phone && <div style={{ fontSize: '0.82rem', color: '#888', marginTop: 2 }}>{selectedAuthor.phone}</div>}
              </div>
              <button onClick={() => setSelectedAuthor(null)} className="ct-author-change-btn">Changer</button>
            </div>
          ) : (
            <>
              <div className="ct-author-search">
                <FiSearch size={16} className="ct-search-icon" />
                <input type="text" value={authorQuery} onChange={e => handleAuthorSearch(e.target.value)}
                  placeholder="Rechercher un auteur par nom, email ou identifiant..." autoFocus />
              </div>
              {authorLoading && <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Recherche en cours...</p>}
              {!authorLoading && authorQuery.length >= 2 && authorResults.length === 0 && (
                <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Aucun auteur trouv\u00e9 pour \u00ab {authorQuery} \u00bb</p>
              )}
              <div className="ct-author-results">
                {authorResults.map(a => (
                  <button key={a.id} onClick={() => { setSelectedAuthor(a); setAuthorResults([]); }} className="ct-author-item">
                    <div>
                      <span className="ct-author-item-name">{a.name}</span>
                      {a.phone && <span className="ct-author-item-phone">{a.phone}</span>}
                    </div>
                    <span className="ct-author-item-email">{a.email || '\u2014'}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="ct-step-nav">
            <div />
            <button className="ct-btn ct-btn-primary" disabled={!selectedAuthor} onClick={() => setStep(2)}>
              Suivant <FiArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Step 2 -- Contract Terms */}
      {step === 2 && (
        <div className="admin-card">
          <h4 className="ct-step-title">\u00c9tape 2 \u2014 Conditions du contrat</h4>

          {/* Contract type */}
          <div style={{ marginBottom: 8 }}>
            <label style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', marginBottom: 8 }}>Type de contrat</label>
          </div>
          <div className="ct-type-grid">
            {TYPES.map(t => (
              <button key={t.value} onClick={() => set('contract_type', t.value)}
                className={`ct-type-option ${form.contract_type === t.value ? 'selected' : ''}`}
                style={{ '--ct-type-color': t.color }}>
                <div className="ct-type-option-label" style={{ color: t.color }}>{t.label}</div>
                <div className="ct-type-option-desc">{t.desc}</div>
              </button>
            ))}
          </div>

          {/* Book info */}
          <div className="ct-form-row cols-2-1">
            <Field label="Titre de l'ouvrage" required error={errors.book_title}>
              <input type="text" value={form.book_title} onChange={e => set('book_title', e.target.value)}
                onBlur={() => handleBlur('book_title')} maxLength={200} />
            </Field>
            <Field label="ISBN" error={errors.book_isbn}>
              <input type="text" value={form.book_isbn} onChange={e => set('book_isbn', e.target.value)}
                onBlur={() => handleBlur('book_isbn')} placeholder="978..." />
            </Field>
          </div>

          {/* Royalties */}
          <div className="ct-form-row cols-4">
            <Field label="Royalties print (%)" error={errors.royalty_rate_print}>
              <input type="number" value={form.royalty_rate_print} onChange={e => set('royalty_rate_print', e.target.value)}
                onBlur={() => handleBlur('royalty_rate_print')} min={0} max={50} />
            </Field>
            <Field label="Royalties digital (%)" error={errors.royalty_rate_digital}>
              <input type="number" value={form.royalty_rate_digital} onChange={e => set('royalty_rate_digital', e.target.value)}
                onBlur={() => handleBlur('royalty_rate_digital')} min={0} max={50} />
            </Field>
            <Field label="Seuil (exemplaires)" error={errors.royalty_threshold}>
              <input type="number" value={form.royalty_threshold} onChange={e => set('royalty_threshold', e.target.value)}
                onBlur={() => handleBlur('royalty_threshold')} min={0} />
            </Field>
            <Field label="Ex. gratuits" error={errors.free_author_copies}>
              <input type="number" value={form.free_author_copies} onChange={e => set('free_author_copies', e.target.value)}
                onBlur={() => handleBlur('free_author_copies')} min={0} max={100} />
            </Field>
          </div>

          {/* Dates */}
          <div className="ct-form-row cols-2">
            <Field label="Date de d\u00e9but">
              <input type="date" value={form.service_start} onChange={e => set('service_start', e.target.value)} />
            </Field>
            <Field label="Date de fin" error={errors.service_end}>
              <input type="date" value={form.service_end} onChange={e => set('service_end', e.target.value)}
                onBlur={() => handleBlur('service_end')} />
            </Field>
          </div>

          {/* Notes */}
          <div className="ct-field" style={{ marginBottom: 20 }}>
            <label>Notes internes</label>
            <textarea rows={3} value={form.note_private} onChange={e => set('note_private', e.target.value)} style={{ resize: 'vertical' }} />
          </div>

          <div className="ct-step-nav">
            <button className="ct-btn ct-btn-outline" onClick={() => setStep(1)}><FiArrowLeft size={14} /> Retour</button>
            <button className="ct-btn ct-btn-primary" disabled={!form.book_title.trim()} onClick={goToStep3}>
              V\u00e9rifier <FiArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3 -- Review */}
      {step === 3 && (
        <div className="admin-card">
          <h4 className="ct-step-title"><FiCheck size={16} /> \u00c9tape 3 \u2014 V\u00e9rification</h4>

          <div className="ct-review-grid">
            <div className="ct-review-card">
              <p className="ct-review-label">Auteur</p>
              <p className="ct-review-value">{selectedAuthor?.name}</p>
              <p className="ct-review-sub">{selectedAuthor?.email}</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Ouvrage</p>
              <p className="ct-review-value">{form.book_title}</p>
              {form.book_isbn && <p className="ct-review-sub">ISBN : {form.book_isbn}</p>}
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Type</p>
              <p className="ct-review-value">{TYPES.find(t => t.value === form.contract_type)?.label}</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Royalties</p>
              <p className="ct-review-value">Print : {form.royalty_rate_print}% | Digital : {form.royalty_rate_digital}%</p>
              <p className="ct-review-sub">Seuil : {form.royalty_threshold} ex. | Gratuits : {form.free_author_copies} ex.</p>
            </div>
            {(form.service_start || form.service_end) && (
              <div className="ct-review-card">
                <p className="ct-review-label">P\u00e9riode</p>
                <p className="ct-review-value">
                  {form.service_start ? new Date(form.service_start).toLocaleDateString('fr-FR') : '\u2014'}
                  {' \u2192 '}
                  {form.service_end ? new Date(form.service_end).toLocaleDateString('fr-FR') : 'Ind\u00e9termin\u00e9e'}
                </p>
              </div>
            )}
            {form.note_private && (
              <div className="ct-review-card">
                <p className="ct-review-label">Notes</p>
                <p className="ct-review-sub" style={{ whiteSpace: 'pre-wrap' }}>{form.note_private}</p>
              </div>
            )}
          </div>

          <div className="ct-step-nav">
            <button className="ct-btn ct-btn-outline" onClick={() => setStep(2)}><FiArrowLeft size={14} /> Modifier</button>
            <button className="ct-btn ct-btn-primary" onClick={handleSubmit} disabled={submitting || !formValid}>
              {submitting ? 'Cr\u00e9ation...' : 'Cr\u00e9er le contrat'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
