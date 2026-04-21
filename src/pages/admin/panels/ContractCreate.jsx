import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createContract, searchAuthors } from '../../../api/contracts';
import { FiArrowLeft, FiArrowRight, FiCheck, FiSearch, FiUser, FiAlertCircle, FiBookOpen, FiLayers, FiFilm } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './Contracts.css';

const TYPES = [
  {
    value: 'edition_simple',
    label: 'Édition · papier',
    desc: 'Cession des droits d\'édition sous forme imprimée uniquement',
    icon: FiBookOpen,
    color: '#10531a',
    defaults: { royalty_rate_print: 8, royalty_rate_digital: 0, royalty_threshold: 500, free_author_copies: 10 },
  },
  {
    value: 'edition_numerique',
    label: 'Édition · papier + numérique',
    desc: 'Contrat principal + avenant pour les droits numériques',
    icon: FiLayers,
    color: '#0284c7',
    defaults: { royalty_rate_print: 8, royalty_rate_digital: 15, royalty_threshold: 500, free_author_copies: 10 },
  },
  {
    value: 'edition_complete',
    label: 'Édition · complète',
    desc: 'Papier, numérique + adaptations audiovisuelle et théâtrale',
    icon: FiFilm,
    color: '#7c3aed',
    defaults: { royalty_rate_print: 8, royalty_rate_digital: 15, royalty_threshold: 500, free_author_copies: 10 },
  },
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
  if (isNaN(th) || th < 0) errors.royalty_threshold = 'Doit être positif';
  const fc = parseInt(form.free_author_copies);
  if (isNaN(fc) || fc < 0 || fc > 100) errors.free_author_copies = 'Entre 0 et 100';
  const ti = parseInt(form.tirage_initial);
  if (isNaN(ti) || ti < 1) errors.tirage_initial = 'Tirage minimum : 1';
  const np = parseInt(form.nombre_pages_estime);
  if (isNaN(np) || np < 10) errors.nombre_pages_estime = 'Minimum 10 pages';
  const pp = parseInt(form.prix_public_previsionnel);
  if (isNaN(pp) || pp < 0) errors.prix_public_previsionnel = 'Prix positif';
  const sp = parseInt(form.exemplaires_sp);
  if (isNaN(sp) || sp < 0) errors.exemplaires_sp = 'Nombre positif';
  if (!form.editeur_signataire_nom?.trim()) errors.editeur_signataire_nom = 'Nom requis';
  if (form.service_start && form.service_end && form.service_end < form.service_start) {
    errors.service_end = 'Doit être postérieure au début';
  }
  return errors;
}

function Field({ label, required, error, children, hint }) {
  return (
    <div className={`ct-field ${error ? 'has-error' : ''}`}>
      <label>{label}{required && <span style={{ color: '#ef4444' }}> *</span>}</label>
      {children}
      {hint && !error && <span style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 2 }}>{hint}</span>}
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

  const today = new Date().toISOString().split('T')[0];

  // Step 2 -- Terms
  const [form, setForm] = useState({
    contract_type: 'edition_simple',
    book_title: searchParams.get('title') || '',
    book_isbn: '',
    // Royalties (type-dependent)
    royalty_rate_print: 8,
    royalty_rate_digital: 0,
    royalty_threshold: 500,
    free_author_copies: 10,
    // Paramètres de fabrication (v2)
    tirage_initial: 100,
    format_ouvrage: '15 × 21 cm',
    nombre_pages_estime: 200,
    prix_public_previsionnel: 8000,
    exemplaires_sp: 5,
    // Signature
    date_signature: today,
    editeur_signataire_nom: '',
    editeur_signataire_qualite: 'Directeur général',
    // Période de service
    service_start: today,
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

  // Appliquer les defaults du type au changement
  const selectType = (typeValue) => {
    const type = TYPES.find(t => t.value === typeValue);
    if (!type) return;
    setForm(f => ({
      ...f,
      contract_type: typeValue,
      royalty_rate_print: type.defaults.royalty_rate_print,
      royalty_rate_digital: type.defaults.royalty_rate_digital,
      royalty_threshold: type.defaults.royalty_threshold,
      free_author_copies: type.defaults.free_author_copies,
    }));
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
      toast.error('Veuillez corriger les champs signalés');
      return;
    }
    setStep(3);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await createContract({ thirdparty_id: selectedAuthor.id, ...form });
      toast.success('Contrat créé avec succès');
      navigate(`/admin/contracts/${res.data.id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally {
      setSubmitting(false);
    }
  };

  const formValid = Object.keys(validateForm(form)).length === 0;
  const activeType = TYPES.find(t => t.value === form.contract_type);

  return (
    <div className="admin-panel">
      <div className="ct-wizard-header admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => navigate('/admin/contracts')} className="ct-btn-ghost"><FiArrowLeft size={18} /></button>
          <h3 style={{ margin: 0 }}>Nouveau contrat d'édition</h3>
        </div>
        <div className="ct-steps">
          {[1, 2, 3].map(s => <div key={s} className={`ct-step-dot ${step >= s ? 'active' : ''}`} />)}
        </div>
      </div>

      {/* Step 1 -- Select Author */}
      {step === 1 && (
        <div className="admin-card">
          <h4 className="ct-step-title"><FiUser size={16} /> Étape 1 — Sélectionner l'auteur</h4>

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
                <p style={{ fontSize: '0.85rem', color: '#94a3b8' }}>Aucun auteur trouvé pour « {authorQuery} »</p>
              )}
              <div className="ct-author-results">
                {authorResults.map(a => (
                  <button key={a.id} onClick={() => { setSelectedAuthor(a); setAuthorResults([]); }} className="ct-author-item">
                    <div>
                      <span className="ct-author-item-name">{a.name}</span>
                      {a.phone && <span className="ct-author-item-phone">{a.phone}</span>}
                    </div>
                    <span className="ct-author-item-email">{a.email || '—'}</span>
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
          <h4 className="ct-step-title">Étape 2 — Type et conditions du contrat</h4>

          {/* Contract type selection — 3 tuiles avec icônes */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', marginBottom: 8 }}>Type de contrat</label>
          </div>
          <div className="ct-type-grid">
            {TYPES.map(t => {
              const Icon = t.icon;
              return (
                <button key={t.value} type="button" onClick={() => selectType(t.value)}
                  className={`ct-type-option ${form.contract_type === t.value ? 'selected' : ''}`}
                  style={{ '--ct-type-color': t.color }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <Icon size={20} color={t.color} />
                    <div className="ct-type-option-label" style={{ color: t.color }}>{t.label}</div>
                  </div>
                  <div className="ct-type-option-desc">{t.desc}</div>
                </button>
              );
            })}
          </div>

          {/* Book info */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ouvrage</h5>
          <div className="ct-form-row cols-2-1">
            <Field label="Titre de l'ouvrage" required error={errors.book_title}>
              <input type="text" value={form.book_title} onChange={e => set('book_title', e.target.value)}
                onBlur={() => handleBlur('book_title')} maxLength={200} />
            </Field>
            <Field label="ISBN" error={errors.book_isbn} hint="Facultatif — peut être renseigné plus tard">
              <input type="text" value={form.book_isbn} onChange={e => set('book_isbn', e.target.value)}
                onBlur={() => handleBlur('book_isbn')} placeholder="978..." />
            </Field>
          </div>

          {/* Fabrication */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Caractéristiques de fabrication</h5>
          <div className="ct-form-row cols-4">
            <Field label="Tirage initial" error={errors.tirage_initial}>
              <input type="number" value={form.tirage_initial} onChange={e => set('tirage_initial', e.target.value)}
                onBlur={() => handleBlur('tirage_initial')} min={1} />
            </Field>
            <Field label="Format" hint="Ex : 15 × 21 cm">
              <input type="text" value={form.format_ouvrage} onChange={e => set('format_ouvrage', e.target.value)} />
            </Field>
            <Field label="Pages (estimé)" error={errors.nombre_pages_estime}>
              <input type="number" value={form.nombre_pages_estime} onChange={e => set('nombre_pages_estime', e.target.value)}
                onBlur={() => handleBlur('nombre_pages_estime')} min={10} />
            </Field>
            <Field label="Prix public (FCFA)" error={errors.prix_public_previsionnel}>
              <input type="number" value={form.prix_public_previsionnel} onChange={e => set('prix_public_previsionnel', e.target.value)}
                onBlur={() => handleBlur('prix_public_previsionnel')} min={0} step={500} />
            </Field>
          </div>

          {/* Royalties */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Rémunération de l'auteur</h5>
          <div className="ct-form-row cols-4">
            <Field label="Royalties papier (%)" error={errors.royalty_rate_print}>
              <input type="number" value={form.royalty_rate_print} onChange={e => set('royalty_rate_print', e.target.value)}
                onBlur={() => handleBlur('royalty_rate_print')} min={0} max={50} step={0.5} />
            </Field>
            <Field label="Royalties numérique (%)" error={errors.royalty_rate_digital}>
              <input type="number" value={form.royalty_rate_digital} onChange={e => set('royalty_rate_digital', e.target.value)}
                onBlur={() => handleBlur('royalty_rate_digital')} min={0} max={50} step={0.5}
                disabled={form.contract_type === 'edition_simple'} />
            </Field>
            <Field label="Seuil de versement" error={errors.royalty_threshold} hint="Exemplaires vendus">
              <input type="number" value={form.royalty_threshold} onChange={e => set('royalty_threshold', e.target.value)}
                onBlur={() => handleBlur('royalty_threshold')} min={0} />
            </Field>
            <Field label="Ex. auteur gratuits" error={errors.free_author_copies}>
              <input type="number" value={form.free_author_copies} onChange={e => set('free_author_copies', e.target.value)}
                onBlur={() => handleBlur('free_author_copies')} min={0} max={100} />
            </Field>
          </div>
          <div className="ct-form-row cols-2">
            <Field label="Exemplaires service de presse" error={errors.exemplaires_sp}>
              <input type="number" value={form.exemplaires_sp} onChange={e => set('exemplaires_sp', e.target.value)}
                onBlur={() => handleBlur('exemplaires_sp')} min={0} />
            </Field>
          </div>

          {/* Signature */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Signature</h5>
          <div className="ct-form-row cols-2-1">
            <Field label="Nom du signataire éditeur" required error={errors.editeur_signataire_nom} hint="Personne qui signe côté L'Harmattan">
              <input type="text" value={form.editeur_signataire_nom} onChange={e => set('editeur_signataire_nom', e.target.value)}
                onBlur={() => handleBlur('editeur_signataire_nom')} placeholder="Ex : Moussa Mbaye" />
            </Field>
            <Field label="Qualité">
              <input type="text" value={form.editeur_signataire_qualite} onChange={e => set('editeur_signataire_qualite', e.target.value)} />
            </Field>
          </div>
          <div className="ct-form-row cols-2">
            <Field label="Date de signature">
              <input type="date" value={form.date_signature} onChange={e => set('date_signature', e.target.value)} />
            </Field>
          </div>

          {/* Période de cession */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Période de cession</h5>
          <div className="ct-form-row cols-2">
            <Field label="Date de début" hint="Date d'effet du contrat">
              <input type="date" value={form.service_start} onChange={e => set('service_start', e.target.value)} />
            </Field>
            <Field label="Date de fin" error={errors.service_end} hint="Laisser vide pour durée indéterminée">
              <input type="date" value={form.service_end} onChange={e => set('service_end', e.target.value)}
                onBlur={() => handleBlur('service_end')} />
            </Field>
          </div>

          {/* Notes */}
          <div className="ct-field" style={{ marginTop: 20, marginBottom: 20 }}>
            <label>Notes internes (non visibles dans le contrat)</label>
            <textarea rows={3} value={form.note_private} onChange={e => set('note_private', e.target.value)} style={{ resize: 'vertical' }} />
          </div>

          <div className="ct-step-nav">
            <button className="ct-btn ct-btn-outline" onClick={() => setStep(1)}><FiArrowLeft size={14} /> Retour</button>
            <button className="ct-btn ct-btn-primary" disabled={!form.book_title.trim()} onClick={goToStep3}>
              Vérifier <FiArrowRight size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Step 3 -- Review */}
      {step === 3 && (
        <div className="admin-card">
          <h4 className="ct-step-title"><FiCheck size={16} /> Étape 3 — Vérification</h4>

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
              <p className="ct-review-label">Type de contrat</p>
              <p className="ct-review-value" style={{ color: activeType?.color }}>{activeType?.label}</p>
              <p className="ct-review-sub">{activeType?.desc}</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Fabrication</p>
              <p className="ct-review-value">{form.tirage_initial} ex. · {form.format_ouvrage}</p>
              <p className="ct-review-sub">{form.nombre_pages_estime} pages · {Number(form.prix_public_previsionnel).toLocaleString('fr-FR')} FCFA</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Royalties</p>
              <p className="ct-review-value">
                Papier : {form.royalty_rate_print}%
                {form.contract_type !== 'edition_simple' && ` · Numérique : ${form.royalty_rate_digital}%`}
              </p>
              <p className="ct-review-sub">Seuil {form.royalty_threshold} ex. · {form.free_author_copies} gratuits · SP {form.exemplaires_sp}</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Signataire</p>
              <p className="ct-review-value">{form.editeur_signataire_nom}</p>
              <p className="ct-review-sub">{form.editeur_signataire_qualite}</p>
            </div>
            {(form.service_start || form.service_end) && (
              <div className="ct-review-card">
                <p className="ct-review-label">Période de cession</p>
                <p className="ct-review-value">
                  {form.service_start ? new Date(form.service_start).toLocaleDateString('fr-FR') : '—'}
                  {' → '}
                  {form.service_end ? new Date(form.service_end).toLocaleDateString('fr-FR') : 'Durée de la propriété littéraire'}
                </p>
              </div>
            )}
            {form.note_private && (
              <div className="ct-review-card">
                <p className="ct-review-label">Notes internes</p>
                <p className="ct-review-sub" style={{ whiteSpace: 'pre-wrap' }}>{form.note_private}</p>
              </div>
            )}
          </div>

          <div className="ct-step-nav">
            <button className="ct-btn ct-btn-outline" onClick={() => setStep(2)}><FiArrowLeft size={14} /> Modifier</button>
            <button className="ct-btn ct-btn-primary" onClick={handleSubmit} disabled={submitting || !formValid}>
              {submitting ? 'Création...' : 'Créer le contrat'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
