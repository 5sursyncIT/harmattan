import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { createContract, searchAuthors, createAuthor } from '../../../api/contracts';
import { FiArrowLeft, FiArrowRight, FiCheck, FiSearch, FiUser, FiAlertCircle, FiBookOpen, FiLayers, FiFilm, FiUserPlus, FiX, FiInfo, FiFileText } from 'react-icons/fi';
import toast from 'react-hot-toast';
import './Contracts.css';
import useAdminRole, { CONTRACT_WRITE_ROLES } from '../../../hooks/useAdminRole';

const CONTRACT_MODELS = [
  {
    value: 'harmattan_2024',
    label: 'Harmattan · classique',
    desc: 'Contrat standard L\'Harmattan Sénégal',
    icon: FiBookOpen,
    color: '#10531a',
    defaults: { royalty_rate_print: 10, royalty_rate_digital: 10, royalty_threshold: 500, free_author_copies: 5 },
  },
  {
    value: 'harmattan_dll',
    label: 'Harmattan · DLL',
    desc: 'DLL : 15 % sur les 1 000 premiers ex., puis 10 % au-delà',
    icon: FiLayers,
    color: '#0284c7',
    defaults: { royalty_rate_print: 15, royalty_rate_digital: 10, royalty_threshold: 1000, free_author_copies: 55 },
  },
  {
    value: 'tamarinier',
    label: 'Le Tamarinier',
    desc: 'Collection Le Tamarinier (s/c L\'Harmattan Sénégal)',
    icon: FiFilm,
    color: '#7c3aed',
    defaults: { royalty_rate_print: 10, royalty_rate_digital: 10, royalty_threshold: 500, free_author_copies: 5 },
  },
];

const RIGHTS_SCOPES = [
  {
    value: 'edition_simple',
    label: 'Édition · papier seul',
    desc: 'Sans avenant numérique, audiovisuel ni théâtral',
    icon: FiBookOpen,
    color: '#475569',
    defaults: { royalty_rate_digital: 0 },
  },
  {
    value: 'edition_numerique',
    label: 'Édition · papier + numérique',
    desc: 'Contrat principal + avenant droits numériques',
    icon: FiLayers,
    color: '#0d9488',
    defaults: { royalty_rate_digital: 10 },
  },
  {
    value: 'edition_complete',
    label: 'Édition · complète',
    desc: 'Papier + numérique + adaptations audiovisuelle & théâtrale',
    icon: FiFilm,
    color: '#7c3aed',
    defaults: { royalty_rate_digital: 10 },
  },
];

const TYPE_GUIDE = [
  'Cadre du contrat : Harmattan classique, DLL ou Le Tamarinier.',
  'Droits cédés : papier seul, papier + numérique, ou complet.',
  'Exemple possible : Harmattan DLL + édition complète.',
];

const buildContractType = (model, scope) => `${model}_${scope}`;

function validateISBN(isbn) {
  if (!isbn) return null;
  const clean = isbn.replace(/[-\s]/g, '');
  if (clean.length === 0) return null;
  if (!/^(97[89]\d{10}|\d{10})$/.test(clean)) return 'ISBN invalide (10 ou 13 chiffres)';
  return null;
}

function validateForm(form) {
  const errors = {};
  if (!form.book_title?.trim()) errors.book_title = 'Au moins un titre est requis';
  const isbnErr = validateISBN(form.book_isbn);
  if (isbnErr) errors.book_isbn = isbnErr;
  const rp = parseFloat(form.royalty_rate_print);
  if (isNaN(rp) || rp < 0 || rp > 50) errors.royalty_rate_print = 'Entre 0 et 50%';
  const rd = parseFloat(form.royalty_rate_digital);
  if (isNaN(rd) || rd < 0 || rd > 50) errors.royalty_rate_digital = 'Entre 0 et 50%';
  const th = parseInt(form.royalty_threshold);
  if (isNaN(th) || th < 0) errors.royalty_threshold = 'Doit être positif';
  const dth = parseInt(form.royalty_digital_threshold_fcfa);
  if (isNaN(dth) || dth < 0) errors.royalty_digital_threshold_fcfa = 'Doit être positif';
  const fc = parseInt(form.free_author_copies);
  if (isNaN(fc) || fc < 0 || fc > 100) errors.free_author_copies = 'Entre 0 et 100';
  const ti = parseInt(form.tirage_initial);
  if (isNaN(ti) || ti < 1) errors.tirage_initial = 'Tirage minimum : 1';
  const np = parseInt(form.nombre_pages_estime);
  if (isNaN(np) || np < 10) errors.nombre_pages_estime = 'Minimum 10 pages';
  const pp = parseFloat(form.prix_public_previsionnel);
  if (isNaN(pp) || pp < 0) errors.prix_public_previsionnel = 'Prix positif';
  const sp = parseInt(form.exemplaires_sp);
  if (isNaN(sp) || sp < 0) errors.exemplaires_sp = 'Nombre positif';
  if (!form.editeur_signataire_nom?.trim()) errors.editeur_signataire_nom = 'Nom requis';
  if (form.author_purchase_enabled) {
    const apq = parseInt(form.author_purchase_qty);
    if (isNaN(apq) || apq < 1) errors.author_purchase_qty = 'Quantité minimum 1';
    const apd = parseFloat(form.author_purchase_discount);
    if (isNaN(apd) || apd < 0 || apd > 100) errors.author_purchase_discount = 'Entre 0 et 100 %';
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
  const role = useAdminRole();
  // La création de contrat est réservée aux profils éditoriaux + comptable. Un rôle
  // non autorisé qui arriverait ici par URL directe est redirigé vers la liste.
  useEffect(() => {
    if (role && !CONTRACT_WRITE_ROLES.includes(role)) {
      navigate('/admin/contracts/list', { replace: true });
    }
  }, [role, navigate]);
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
  const searchSeq = useRef(0);

  // Nettoyage du timer de debounce au démontage (évite fuite + setState post-unmount).
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  // Step 1bis -- Inline author creation
  const [creatingAuthor, setCreatingAuthor] = useState(false);
  const [newAuthor, setNewAuthor] = useState({ name: '', firstname: '', email: '', phone: '' });
  const [newAuthorErrors, setNewAuthorErrors] = useState({});
  const [newAuthorSubmitting, setNewAuthorSubmitting] = useState(false);

  const today = new Date().toISOString().split('T')[0];

  // Step 2 -- Terms
  const _defaultModel = CONTRACT_MODELS.find(t => t.value === 'harmattan_2024') || CONTRACT_MODELS[0];
  const _defaultScope = RIGHTS_SCOPES.find(t => t.value === 'edition_simple') || RIGHTS_SCOPES[0];
  const [form, setForm] = useState({
    contract_model: _defaultModel.value,
    rights_scope: _defaultScope.value,
    contract_type: buildContractType(_defaultModel.value, _defaultScope.value),
    book_title: searchParams.get('title') || '',
    book_subtitle: '',
    book_isbn: '',
    // Royalties (type-dependent)
    royalty_rate_print: _defaultModel.defaults.royalty_rate_print,
    royalty_rate_digital: _defaultScope.defaults.royalty_rate_digital,
    royalty_threshold: _defaultModel.defaults.royalty_threshold,
    royalty_digital_threshold_fcfa: 20000, // Seuil de report des droits numériques (FCFA)
    free_author_copies: _defaultModel.defaults.free_author_copies,
    // Engagement d'achat de l'auteur (annexe)
    author_purchase_enabled: false,
    author_purchase_qty: 50,
    author_purchase_discount: 30,
    // Paramètres de fabrication (v2)
    tirage_initial: 100,
    format_ouvrage: '15,5 × 24 cm',
    nombre_pages_estime: 200,
    prix_public_previsionnel: 15,
    exemplaires_sp: 5,
    // Signature
    date_signature: today,
    editeur_signataire_nom: 'Dr Abdoulaye DIALLO',
    editeur_signataire_qualite: 'Administrateur Général',
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
    if (q.length < 2) { setAuthorLoading(false); return; }
    setAuthorLoading(true);
    // Garde anti-course : on ignore les réponses obsolètes (une réponse lente
    // ancienne ne doit pas écraser les résultats d'une frappe plus récente).
    const seq = ++searchSeq.current;
    searchTimer.current = setTimeout(() => {
      searchAuthors(q)
        .then(r => { if (seq === searchSeq.current) setAuthorResults(r.data || []); })
        .catch(() => {})
        .finally(() => { if (seq === searchSeq.current) setAuthorLoading(false); });
    }, 300);
  };

  const openCreateAuthor = () => {
    setNewAuthor({
      name: authorQuery.trim(),
      firstname: '',
      email: '',
      phone: '',
    });
    setNewAuthorErrors({});
    setCreatingAuthor(true);
  };

  const cancelCreateAuthor = () => {
    setCreatingAuthor(false);
    setNewAuthorErrors({});
  };

  const validateNewAuthor = (data) => {
    const errs = {};
    if (!data.name?.trim() || data.name.trim().length < 2) errs.name = 'Nom requis (2 caractères min.)';
    if (!data.firstname?.trim() || data.firstname.trim().length < 2) errs.firstname = 'Prénom requis (2 caractères min.)';
    // Email obligatoire pour un nouvel auteur (envoi du contrat à signer).
    if (!data.email?.trim()) {
      errs.email = 'Email requis';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
      errs.email = 'Email invalide';
    }
    // Téléphone optionnel, mais validé s'il est renseigné.
    if (data.phone?.trim() && data.phone.trim().replace(/[\s.\-()]/g, '').length < 6) errs.phone = 'Téléphone invalide';
    return errs;
  };

  const submitNewAuthor = async () => {
    const errs = validateNewAuthor(newAuthor);
    if (Object.keys(errs).length > 0) {
      setNewAuthorErrors(errs);
      return;
    }
    setNewAuthorSubmitting(true);
    try {
      const res = await createAuthor({
        name: newAuthor.name.trim(),
        firstname: newAuthor.firstname.trim(),
        email: newAuthor.email.trim(),
        phone: newAuthor.phone.trim(),
      });
      const author = res.data;
      setSelectedAuthor({ id: author.id, name: author.name, email: author.email, phone: author.phone });
      setCreatingAuthor(false);
      setAuthorQuery('');
      setAuthorResults([]);
      if (author.created === false) {
        toast.success(`Auteur existant sélectionné : ${author.name}`);
      } else {
        toast.success(`Auteur créé : ${author.name}`);
      }
    } catch (err) {
      const msg = err.response?.data?.error || 'Erreur création auteur';
      toast.error(msg);
    } finally {
      setNewAuthorSubmitting(false);
    }
  };

  const selectContractModel = (modelValue) => {
    const model = CONTRACT_MODELS.find(t => t.value === modelValue);
    if (!model) return;
    setForm(f => ({
      ...f,
      contract_model: modelValue,
      contract_type: buildContractType(modelValue, f.rights_scope),
      royalty_rate_print: model.defaults.royalty_rate_print,
      royalty_threshold: model.defaults.royalty_threshold,
      free_author_copies: model.defaults.free_author_copies,
    }));
  };

  const selectRightsScope = (scopeValue) => {
    const scope = RIGHTS_SCOPES.find(t => t.value === scopeValue);
    if (!scope) return;
    setForm(f => ({
      ...f,
      rights_scope: scopeValue,
      contract_type: buildContractType(f.contract_model, scopeValue),
      royalty_rate_digital: scope.defaults.royalty_rate_digital,
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
    if (submitting) return;
    // Garde : l'auteur peut avoir été désélectionné en revenant à l'étape 1.
    if (!selectedAuthor?.id) {
      toast.error('Veuillez sélectionner un auteur');
      setStep(1);
      return;
    }
    setSubmitting(true);
    try {
      const payload = { ...form, contract_type: buildContractType(form.contract_model, form.rights_scope) };
      const res = await createContract({ thirdparty_id: selectedAuthor.id, ...payload });
      toast.success('Contrat créé avec succès');
      navigate(`/admin/contracts/${res.data.id}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally {
      setSubmitting(false);
    }
  };

  const formValid = Object.keys(validateForm(form)).length === 0;
  const activeModel = CONTRACT_MODELS.find(t => t.value === form.contract_model);
  const activeScope = RIGHTS_SCOPES.find(t => t.value === form.rights_scope);
  const activeTypeLabel = activeModel && activeScope ? `${activeModel.label} + ${activeScope.label}` : '';

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
          ) : creatingAuthor ? (
            <div className="ct-author-create">
              <div className="ct-author-create-header">
                <h5 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <FiUserPlus size={16} /> Nouvel auteur
                </h5>
                <button type="button" onClick={cancelCreateAuthor} className="ct-btn-ghost" aria-label="Annuler">
                  <FiX size={18} />
                </button>
              </div>
              <div className="ct-form-row cols-2">
                <Field label="Prénom" required error={newAuthorErrors.firstname}>
                  <input type="text" value={newAuthor.firstname} autoFocus
                    onChange={e => setNewAuthor(a => ({ ...a, firstname: e.target.value }))}
                    placeholder="Ex : Aminata" maxLength={80} />
                </Field>
                <Field label="Nom" required error={newAuthorErrors.name} hint="Nom de famille">
                  <input type="text" value={newAuthor.name}
                    onChange={e => setNewAuthor(a => ({ ...a, name: e.target.value }))}
                    placeholder="Ex : Sow Fall" maxLength={120} />
                </Field>
              </div>
              <div className="ct-form-row cols-2">
                <Field label="Téléphone" error={newAuthorErrors.phone} hint="Optionnel">
                  <input type="tel" value={newAuthor.phone}
                    onChange={e => setNewAuthor(a => ({ ...a, phone: e.target.value }))}
                    placeholder="+221 ..." maxLength={30} />
                </Field>
                <Field label="Email" required error={newAuthorErrors.email} hint="Pour l'envoi du contrat à signer">
                  <input type="email" value={newAuthor.email}
                    onChange={e => setNewAuthor(a => ({ ...a, email: e.target.value }))}
                    placeholder="auteur@exemple.com" maxLength={150} />
                </Field>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                <button type="button" className="ct-btn ct-btn-outline" onClick={cancelCreateAuthor} disabled={newAuthorSubmitting}>
                  Annuler
                </button>
                <button type="button" className="ct-btn ct-btn-primary" onClick={submitNewAuthor} disabled={newAuthorSubmitting}>
                  {newAuthorSubmitting ? 'Création...' : <>Créer et sélectionner <FiCheck size={14} /></>}
                </button>
              </div>
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
                <div className="ct-author-empty">
                  <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: 0 }}>
                    Aucun auteur trouvé pour « {authorQuery} »
                  </p>
                  <button type="button" onClick={openCreateAuthor} className="ct-btn ct-btn-primary" style={{ marginTop: 10 }}>
                    <FiUserPlus size={14} /> Créer « {authorQuery} »
                  </button>
                </div>
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
              <div className="ct-author-create-cta">
                <span style={{ fontSize: '0.82rem', color: '#64748b' }}>L'auteur n'est pas encore dans la base ?</span>
                <button type="button" onClick={openCreateAuthor} className="ct-btn ct-btn-outline">
                  <FiUserPlus size={14} /> Nouvel auteur
                </button>
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

          <div className="ct-type-help">
            <div className="ct-type-help-icon"><FiInfo size={18} /></div>
            <div>
              <div className="ct-type-help-title">Deux choix se combinent pour générer le bon contrat</div>
              <div className="ct-type-help-grid">
                {TYPE_GUIDE.map(item => <span key={item}>{item}</span>)}
              </div>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div className="ct-type-section-head">
              <label>1. Cadre du contrat</label>
              <span>Choisissez la famille contractuelle officielle.</span>
            </div>
            <div className="ct-type-grid">
              {CONTRACT_MODELS.map(t => {
                const Icon = t.icon;
                return (
                  <button key={t.value} type="button" onClick={() => selectContractModel(t.value)}
                    className={`ct-type-option ${form.contract_model === t.value ? 'selected' : ''}`}
                    style={{ '--ct-type-color': t.color }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <Icon size={20} color={t.color} />
                      <div className="ct-type-option-label" style={{ color: t.color }}>{t.label}</div>
                    </div>
                    <div className="ct-type-option-desc">{t.desc}</div>
                    <div className="ct-type-option-desc">
                      {t.value === 'harmattan_dll'
                        ? '15 % jusqu’à 1 000 ex. · 10 % au-delà · 55 ex. auteur'
                        : `${t.defaults.royalty_rate_print} % · seuil ${t.defaults.royalty_threshold} ex. · ${t.defaults.free_author_copies} ex. auteur`}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <div className="ct-type-section-head">
              <label>2. Droits cédés</label>
              <span>Choisissez l'étendue juridique du contrat.</span>
            </div>
            <div className="ct-type-grid">
              {RIGHTS_SCOPES.map(t => {
                const Icon = t.icon;
                return (
                  <button key={t.value} type="button" onClick={() => selectRightsScope(t.value)}
                    className={`ct-type-option ${form.rights_scope === t.value ? 'selected' : ''}`}
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
          </div>

          {activeModel && activeScope && (
            <div className="ct-type-selected-summary" style={{ '--ct-type-color': activeModel.color }}>
              <FiFileText size={16} />
              <span>Document retenu : <strong>{activeTypeLabel}</strong></span>
              <small>{activeModel.desc} · {activeScope.desc}</small>
            </div>
          )}

          {/* Book info */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Ouvrage</h5>
          <div className="ct-form-row cols-2-1">
            <Field label="Titre(s) de l'ouvrage" required error={errors.book_title}
              hint="Un titre par ligne pour un recueil ou une œuvre en plusieurs tomes">
              <textarea rows={2} value={form.book_title} onChange={e => set('book_title', e.target.value)}
                onBlur={() => handleBlur('book_title')} maxLength={500}
                style={{ resize: 'vertical', minHeight: 42 }} />
            </Field>
            <Field label="ISBN" error={errors.book_isbn} hint="Facultatif — peut être renseigné plus tard">
              <input type="text" value={form.book_isbn} onChange={e => set('book_isbn', e.target.value)}
                onBlur={() => handleBlur('book_isbn')} placeholder="978..." />
            </Field>
          </div>
          <div className="ct-form-row">
            <Field label="Sous-titre" hint="Facultatif">
              <input type="text" value={form.book_subtitle} onChange={e => set('book_subtitle', e.target.value)}
                maxLength={200} placeholder="Sous-titre éventuel" />
            </Field>
          </div>

          {/* Fabrication */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Caractéristiques de fabrication</h5>
          <div className="ct-form-row cols-4">
            <Field label="Tirage initial" error={errors.tirage_initial}>
              <input type="number" value={form.tirage_initial} onChange={e => set('tirage_initial', e.target.value)}
                onBlur={() => handleBlur('tirage_initial')} min={1} />
            </Field>
            <Field label="Format">
              <select value={form.format_ouvrage} onChange={e => set('format_ouvrage', e.target.value)}>
                <option value="15,5 × 24 cm">15,5 × 24 cm (standard)</option>
                <option value="13,5 × 21,5 cm">13,5 × 21,5 cm (devis-fabrication)</option>
              </select>
            </Field>
            <Field label="Pages (estimé)" error={errors.nombre_pages_estime}>
              <input type="number" value={form.nombre_pages_estime} onChange={e => set('nombre_pages_estime', e.target.value)}
                onBlur={() => handleBlur('nombre_pages_estime')} min={10} />
            </Field>
            <Field label="Prix public (€)" error={errors.prix_public_previsionnel}>
              <input type="number" value={form.prix_public_previsionnel} onChange={e => set('prix_public_previsionnel', e.target.value)}
                onBlur={() => handleBlur('prix_public_previsionnel')} min={0} step={0.5} />
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
                onBlur={() => handleBlur('royalty_rate_digital')} min={0} max={50} step={0.5} />
            </Field>
            <Field
              label={form.contract_model === 'harmattan_dll' ? 'Palier DLL' : 'Seuil de versement'}
              error={errors.royalty_threshold}
              hint={form.contract_model === 'harmattan_dll' ? '15 % jusqu’à ce palier, puis 10 %' : 'Exemplaires vendus'}
            >
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
            <Field label="Seuil report droits numériques (FCFA)" error={errors.royalty_digital_threshold_fcfa}
              hint="Si solde inférieur, reporté à l'exercice suivant">
              <input type="number" value={form.royalty_digital_threshold_fcfa}
                onChange={e => set('royalty_digital_threshold_fcfa', e.target.value)}
                onBlur={() => handleBlur('royalty_digital_threshold_fcfa')} min={0} step={1000} />
            </Field>
          </div>

          {/* Engagement d'achat auteur (annexe) */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Engagement d'achat de l'auteur (annexe)
          </h5>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <input type="checkbox" id="author_purchase_enabled"
              checked={form.author_purchase_enabled}
              onChange={e => set('author_purchase_enabled', e.target.checked)} />
            <label htmlFor="author_purchase_enabled" style={{ fontSize: '0.9rem', cursor: 'pointer' }}>
              L'auteur s'engage à acheter un nombre minimum d'exemplaires
            </label>
          </div>
          {form.author_purchase_enabled && (
            <div className="ct-form-row cols-2">
              <Field label="Quantité (exemplaires)" required error={errors.author_purchase_qty}>
                <input type="number" value={form.author_purchase_qty}
                  onChange={e => set('author_purchase_qty', e.target.value)}
                  onBlur={() => handleBlur('author_purchase_qty')} min={1} />
              </Field>
              <Field label="Remise auteur (%)" required error={errors.author_purchase_discount}
                hint="Sur le prix public catalogue">
                <input type="number" value={form.author_purchase_discount}
                  onChange={e => set('author_purchase_discount', e.target.value)}
                  onBlur={() => handleBlur('author_purchase_discount')} min={0} max={100} step={0.5} />
              </Field>
            </div>
          )}

          {/* Signature */}
          <h5 style={{ marginTop: 24, marginBottom: 10, color: '#10531a', fontSize: '0.9rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Signature</h5>
          <div className="ct-form-row cols-2-1">
            <Field label="Nom du signataire éditeur" required error={errors.editeur_signataire_nom} hint="Personne qui signe côté L'Harmattan">
              <input type="text" value={form.editeur_signataire_nom} onChange={e => set('editeur_signataire_nom', e.target.value)}
                onBlur={() => handleBlur('editeur_signataire_nom')} placeholder="Ex : Dr Abdoulaye DIALLO" />
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
              <p className="ct-review-value" style={{ whiteSpace: 'pre-wrap' }}>{form.book_title}</p>
              {form.book_subtitle && <p className="ct-review-sub" style={{ fontStyle: 'italic' }}>{form.book_subtitle}</p>}
              {form.book_isbn && <p className="ct-review-sub">ISBN : {form.book_isbn}</p>}
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Type de contrat</p>
              <p className="ct-review-value" style={{ color: activeModel?.color }}>{activeTypeLabel}</p>
              <p className="ct-review-sub">{activeModel?.desc} · {activeScope?.desc}</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Fabrication</p>
              <p className="ct-review-value">{form.tirage_initial} ex. · {form.format_ouvrage}</p>
              <p className="ct-review-sub">{form.nombre_pages_estime} pages · {Number(form.prix_public_previsionnel).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €</p>
            </div>
            <div className="ct-review-card">
              <p className="ct-review-label">Royalties</p>
              <p className="ct-review-value">
                Papier : {form.royalty_rate_print}% · Numérique : {form.royalty_rate_digital}%
              </p>
              <p className="ct-review-sub">Seuil {form.royalty_threshold} ex. · {form.free_author_copies} gratuits · SP {form.exemplaires_sp}</p>
              <p className="ct-review-sub">Report num. &lt; {Number(form.royalty_digital_threshold_fcfa).toLocaleString('fr-FR')} FCFA</p>
            </div>
            {form.author_purchase_enabled && (
              <div className="ct-review-card">
                <p className="ct-review-label">Engagement d'achat auteur</p>
                <p className="ct-review-value">{form.author_purchase_qty} ex.</p>
                <p className="ct-review-sub">Remise : {form.author_purchase_discount} % sur le prix public</p>
              </div>
            )}
            <div className="ct-review-card">
              <p className="ct-review-label">Signataire</p>
              <p className="ct-review-value">{form.editeur_signataire_nom}</p>
              <p className="ct-review-sub">{form.editeur_signataire_qualite}</p>
            </div>
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
