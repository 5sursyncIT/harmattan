import React, { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiAlertCircle, FiArrowRight, FiBook, FiCheckCircle, FiChevronDown, FiChevronUp, FiClock, FiDollarSign, FiFileText, FiMail, FiMessageCircle, FiPhone, FiSend, FiShield, FiUpload, FiUser } from 'react-icons/fi';
import useSiteConfig from '../hooks/useSiteConfig.jsx';
import api from '../api/dolibarr';
import toast from 'react-hot-toast';
import './SeFaireEditerPage.css';

const formStepConfig = [
  {
    key: 'contact',
    label: 'Coordonnées',
    title: 'Vos coordonnées',
    description: 'Renseignez les informations qui permettront au comité éditorial de vous recontacter.',
  },
  {
    key: 'project',
    label: 'Projet',
    title: 'Votre projet éditorial',
    description: 'Décrivez votre manuscrit pour accélérer l’analyse et orienter le comité de lecture.',
  },
  {
    key: 'file',
    label: 'Fichier',
    title: 'Joindre votre manuscrit',
    description: 'Ajoutez votre manuscrit en PDF ou Word. Si vous n’avez pas encore le fichier final, vous pouvez envoyer votre demande et compléter plus tard.',
  },
];

const fieldStepMap = {
  firstname: 0,
  lastname: 0,
  email: 0,
  phone: 0,
  title: 1,
  genre: 1,
  synopsis: 1,
  file: 2,
};

const steps = [
  {
    icon: <FiSend />,
    number: '01',
    title: 'Envoi du manuscrit',
    description:
      'Déposez votre manuscrit au format Word ou PDF avec un synopsis clair et vos coordonnées. Nous acceptons tous les genres littéraires.',
    details: [
      'Formats acceptés : Word (.doc, .docx) ou PDF',
      'Synopsis recommandé pour accélérer l’étude',
      'Manuscrit complet préférable, version avancée acceptée',
    ],
  },
  {
    icon: <FiFileText />,
    number: '02',
    title: 'Évaluation du manuscrit',
    description:
      'Votre projet est examiné par le comité de lecture qui établit une première appréciation éditoriale et des recommandations.',
    details: [
      'Comité de lecture professionnel',
      'Retour éditorial qualifié',
      'Délai de réponse annoncé : 12 semaines maximum',
    ],
  },
  {
    icon: <FiDollarSign />,
    number: '03',
    title: 'Devis et contrat',
    description:
      'Si votre manuscrit est retenu, vous recevez un devis détaillé et un contrat expliquant clairement le modèle de coédition avant tout engagement.',
    details: [
      'Devis transparent et détaillé',
      'Contrat d’édition clair',
      'Modèle de coédition expliqué avant validation',
    ],
  },
  {
    icon: <FiBook />,
    number: '04',
    title: 'Fabrication du livre',
    description:
      'Après signature du contrat et règlement, la production de l’ouvrage démarre avec la collecte des éléments de couverture et de présentation.',
    details: [
      'Résumé de l’ouvrage à fournir',
      'Biographie de l’auteur en 3 à 4 lignes',
      'Photo de l’auteur pour la couverture',
    ],
  },
];

const heroHighlights = [
  { icon: <FiClock />, value: '12 semaines max', label: 'pour une première réponse éditoriale' },
  { icon: <FiFileText />, value: 'PDF, DOC, DOCX', label: 'formats acceptés pour le dépôt' },
  { icon: <FiShield />, value: 'Coédition expliquée', label: 'devis détaillé et contrat transparent' },
];

const preparationChecklist = [
  'Préparez le titre de votre manuscrit et son genre principal.',
  'Ajoutez un synopsis clair pour accélérer l’analyse.',
  'Prévoyez un fichier PDF ou Word de moins de 20 Mo.',
  'Rassemblez, si possible, votre biographie et la présentation du projet.',
];

const criteriaCards = [
  {
    title: 'Ce que nous attendons',
    items: [
      'Un manuscrit structuré ou une version de travail suffisamment avancée',
      'Un synopsis présentant le thème, l’intrigue ou l’objectif',
      'Des coordonnées fiables pour assurer le suivi éditorial',
    ],
  },
  {
    title: 'Ce que vous recevez',
    items: [
      'Une étude par le comité de lecture',
      'Un retour éditorial dans le délai annoncé',
      'Un devis et un contrat détaillés si le projet est retenu',
    ],
  },
  {
    title: 'Points de réassurance',
    items: [
      'Le modèle de coédition est présenté avant tout engagement',
      'Les formats acceptés sont rappelés dans le formulaire',
      'Vous pouvez contacter l’équipe avant ou après le dépôt',
    ],
  },
];

const supportCards = [
  {
    icon: <FiShield />,
    title: 'Confidentialité et clarté',
    text: 'Le comité éditorial traite votre soumission dans un cadre professionnel, avec des étapes, délais et documents clairement annoncés.',
  },
  {
    icon: <FiMessageCircle />,
    title: 'Accompagnement humain',
    text: 'Avant dépôt ou pendant l’étude, vous gardez un point de contact pour poser vos questions et préparer les pièces complémentaires.',
  },
  {
    icon: <FiBook />,
    title: 'Parcours lisible',
    text: 'Chaque étape précise ce que vous fournissez, ce que vous recevez et le résultat attendu avant la publication.',
  },
];

const faqItems = [
  {
    question: 'Quels genres de manuscrits peuvent être soumis ?',
    answer: 'Romans, essais, poésie, théâtre, contes, mémoires, thèses et autres genres sont acceptés. Le formulaire vous permet de sélectionner le genre principal pour orienter l’étude.',
  },
  {
    question: 'Dois-je envoyer un manuscrit complet ?',
    answer: 'Un manuscrit complet est préférable, mais une version de travail avancée accompagnée d’un synopsis clair peut déjà être étudiée pour un premier échange.',
  },
  {
    question: 'Comment fonctionne la coédition ?',
    answer: 'Si votre manuscrit est retenu, vous recevez un devis détaillé ainsi qu’un contrat d’édition expliquant la répartition des frais entre l’éditeur et l’auteur avant toute validation.',
  },
  {
    question: 'Puis-je poser une question avant de soumettre ?',
    answer: 'Oui. La page vous renvoie vers le formulaire de contact si vous avez besoin d’éclaircissements sur les critères, les pièces à fournir ou le processus éditorial.',
  },
];

function getInitialForm() {
  return {
    firstname: '',
    lastname: '',
    email: '',
    phone: '',
    title: '',
    genre: '',
    synopsis: '',
    message: '',
  };
}

function getValidationErrors(form, file) {
  const nextErrors = {};

  if (!form.firstname.trim()) nextErrors.firstname = 'Veuillez renseigner votre prénom.';
  if (!form.lastname.trim()) nextErrors.lastname = 'Veuillez renseigner votre nom.';

  if (!form.email.trim()) {
    nextErrors.email = 'Veuillez renseigner votre adresse email.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    nextErrors.email = 'Veuillez renseigner une adresse email valide.';
  }

  if (form.phone.trim() && !/^[+\d\s().-]{7,20}$/.test(form.phone.trim())) {
    nextErrors.phone = 'Veuillez renseigner un numéro de téléphone valide.';
  }

  if (!form.title.trim()) nextErrors.title = 'Veuillez renseigner le titre du manuscrit.';
  if (!form.genre.trim()) nextErrors.genre = 'Veuillez sélectionner un genre.';

  if (!form.synopsis.trim()) {
    nextErrors.synopsis = 'Ajoutez un court synopsis pour aider le comité à évaluer votre projet.';
  } else if (form.synopsis.trim().length < 80) {
    nextErrors.synopsis = 'Le synopsis doit comporter au moins 80 caractères.';
  }

  if (file && !/\.(pdf|doc|docx)$/i.test(file.name)) {
    nextErrors.file = 'Format accepté : PDF, DOC ou DOCX.';
  }

  return nextErrors;
}

function getEarliestStep(errors) {
  return Object.keys(errors).reduce((lowest, key) => {
    const stepIndex = fieldStepMap[key] ?? 0;
    return Math.min(lowest, stepIndex);
  }, formStepConfig.length - 1);
}

function FAQItem({ answer, question }) {
  const [open, setOpen] = useState(false);
  const buttonId = useId();
  const panelId = useId();

  return (
    <div className={`editer-faq-item ${open ? 'open' : ''}`}>
      <button
        id={buttonId}
        type="button"
        className="editer-faq-question"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span>{question}</span>
        {open ? <FiChevronUp /> : <FiChevronDown />}
      </button>
      <div
        id={panelId}
        className="editer-faq-answer"
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
      >
        <p>{answer}</p>
      </div>
    </div>
  );
}

function ManuscriptForm() {
  const config = useSiteConfig();
  const [form, setForm] = useState(getInitialForm);
  const [file, setFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [statusMessage, setStatusMessage] = useState('');

  const genres = config?.manuscript_genres || ['Roman', 'Essai', 'Poésie', 'Théâtre', 'Conte', 'Mémoire / Thèse', 'Autre'];

  const markFieldAsTouched = (name) => {
    setTouched((current) => ({ ...current, [name]: true }));
  };

  const syncValidation = (nextForm, nextFile = file) => {
    const nextErrors = getValidationErrors(nextForm, nextFile);
    setErrors(nextErrors);
    return nextErrors;
  };

  const validateStep = (stepIndex) => {
    const nextErrors = syncValidation(form, file);
    const hasStepError = Object.entries(nextErrors).some(([key]) => fieldStepMap[key] === stepIndex);

    if (hasStepError) {
      const nextTouched = { ...touched };
      Object.entries(fieldStepMap).forEach(([fieldName, fieldStep]) => {
        if (fieldStep === stepIndex) nextTouched[fieldName] = true;
      });
      setTouched(nextTouched);
      setStatusMessage('Veuillez corriger les champs signalés avant de continuer.');
      return false;
    }

    setStatusMessage('');
    return true;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    const nextForm = { ...form, [name]: value };
    setForm(nextForm);
    if (touched[name] || errors[name]) {
      syncValidation(nextForm, file);
    }
  };

  const handleBlur = (e) => {
    const { name } = e.target;
    markFieldAsTouched(name);
    syncValidation(form, file);
  };

  const handleFile = (e) => {
    const selectedFile = e.target.files?.[0];
    markFieldAsTouched('file');

    if (selectedFile) {
      const maxSize = 20 * 1024 * 1024;
      if (selectedFile.size > maxSize) {
        setErrors((current) => ({ ...current, file: 'Le fichier ne doit pas dépasser 20 Mo.' }));
        setFile(null);
        setStatusMessage('Le fichier sélectionné dépasse la taille maximale autorisée.');
        toast.error('Le fichier ne doit pas dépasser 20 Mo');
        return;
      }
      if (!/\.(pdf|doc|docx)$/i.test(selectedFile.name)) {
        setErrors((current) => ({ ...current, file: 'Format accepté : PDF, DOC ou DOCX.' }));
        setFile(null);
        setStatusMessage('Le format du fichier n’est pas pris en charge.');
        toast.error('Format accepté : PDF, DOC ou DOCX');
        return;
      }
      setFile(selectedFile);
      setErrors(getValidationErrors(form, selectedFile));
      setStatusMessage('Fichier ajouté avec succès.');
      return;
    }

    setFile(null);
    setErrors(getValidationErrors(form, null));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const nextErrors = getValidationErrors(form, file);
    if (Object.keys(nextErrors).length > 0) {
      const allTouched = Object.keys(fieldStepMap).reduce((accumulator, key) => ({ ...accumulator, [key]: true }), {});
      setTouched(allTouched);
      setErrors(nextErrors);
      setActiveStep(getEarliestStep(nextErrors));
      setStatusMessage('Veuillez corriger les champs signalés avant d’envoyer le formulaire.');
      toast.error('Veuillez corriger les champs signalés');
      return;
    }

    setSending(true);
    setStatusMessage('Envoi du formulaire en cours.');

    try {
      const fd = new FormData();
      Object.entries(form).forEach(([key, value]) => fd.append(key, value));
      if (file) fd.append('file', file);
      await api.post('/admin/manuscripts', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSent(true);
      setForm(getInitialForm());
      setFile(null);
      setErrors({});
      setTouched({});
      setActiveStep(0);
      setStatusMessage('Votre manuscrit a été soumis avec succès.');
      toast.success('Manuscrit soumis avec succès !');
    } catch {
      setStatusMessage('Une erreur est survenue pendant l’envoi du formulaire.');
      toast.error('Erreur lors de l’envoi');
    } finally {
      setSending(false);
    }
  };

  const handleStepChange = (stepIndex) => {
    if (stepIndex <= activeStep || validateStep(activeStep)) {
      setActiveStep(stepIndex);
    }
  };

  const goToNextStep = () => {
    if (activeStep < formStepConfig.length - 1 && validateStep(activeStep)) {
      setActiveStep((current) => current + 1);
    }
  };

  const goToPreviousStep = () => {
    setStatusMessage('');
    setActiveStep((current) => Math.max(current - 1, 0));
  };

  const isVisibleError = (fieldName) => Boolean(errors[fieldName] && touched[fieldName]);

  if (sent) {
    return (
      <div className="editer-form-success">
        <FiCheckCircle size={48} />
        <h3>Manuscrit soumis avec succès !</h3>
        <p>Merci pour votre soumission. Notre comité éditorial examinera votre manuscrit et vous répondra dans un délai maximum de 12 semaines.</p>
        <div className="editer-success-points">
          <span><FiClock /> Réponse éditoriale sous 12 semaines maximum</span>
          <span><FiMail /> Accusé de réception traité par l’équipe éditoriale</span>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setSent(false);
            setForm(getInitialForm());
            setFile(null);
            setErrors({});
            setTouched({});
            setActiveStep(0);
            setStatusMessage('');
          }}
        >
          Soumettre un autre manuscrit
        </button>
      </div>
    );
  }

  return (
    <form className="editer-form" onSubmit={handleSubmit}>
      <div className="sr-only" aria-live="polite">{statusMessage}</div>

      <div className="editer-form-progress" role="tablist" aria-label="Étapes du formulaire">
        {formStepConfig.map((step, index) => {
          const isActive = index === activeStep;
          const isCompleted = index < activeStep;

          return (
            <button
              key={step.key}
              type="button"
              className={`editer-progress-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
              onClick={() => handleStepChange(index)}
              role="tab"
              aria-selected={isActive}
              aria-controls={`editer-panel-${step.key}`}
              id={`editer-tab-${step.key}`}
            >
              <span className="editer-progress-step-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="editer-progress-step-text">
                <strong>{step.label}</strong>
                <small>{step.title}</small>
              </span>
            </button>
          );
        })}
      </div>

      <section
        className={`editer-form-step-panel ${activeStep === 0 ? 'active' : ''}`}
        id="editer-panel-contact"
        role="tabpanel"
        aria-labelledby="editer-tab-contact"
        hidden={activeStep !== 0}
      >
        <div className="editer-form-step-header">
          <h3>{formStepConfig[0].title}</h3>
          <p>{formStepConfig[0].description}</p>
        </div>
        <div className="editer-form-grid">
          <div className="editer-field">
            <label htmlFor="firstname"><FiUser size={14} /> Prénom <span>*</span></label>
            <input
              id="firstname"
              type="text"
              name="firstname"
              value={form.firstname}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="Votre prénom"
              aria-invalid={isVisibleError('firstname')}
              aria-describedby={isVisibleError('firstname') ? 'firstname-error' : undefined}
              required
            />
            {isVisibleError('firstname') && <p className="editer-field-error" id="firstname-error"><FiAlertCircle /> {errors.firstname}</p>}
          </div>
          <div className="editer-field">
            <label htmlFor="lastname"><FiUser size={14} /> Nom <span>*</span></label>
            <input
              id="lastname"
              type="text"
              name="lastname"
              value={form.lastname}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="Votre nom"
              aria-invalid={isVisibleError('lastname')}
              aria-describedby={isVisibleError('lastname') ? 'lastname-error' : undefined}
              required
            />
            {isVisibleError('lastname') && <p className="editer-field-error" id="lastname-error"><FiAlertCircle /> {errors.lastname}</p>}
          </div>
          <div className="editer-field">
            <label htmlFor="email"><FiMail size={14} /> Email <span>*</span></label>
            <input
              id="email"
              type="email"
              name="email"
              value={form.email}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="votre@email.com"
              aria-invalid={isVisibleError('email')}
              aria-describedby={isVisibleError('email') ? 'email-error' : 'email-help'}
              required
            />
            <p className="editer-field-help" id="email-help">Nous utilisons cette adresse pour vous envoyer l’accusé de réception et le suivi éditorial.</p>
            {isVisibleError('email') && <p className="editer-field-error" id="email-error"><FiAlertCircle /> {errors.email}</p>}
          </div>
          <div className="editer-field">
            <label htmlFor="phone"><FiPhone size={14} /> Téléphone</label>
            <input
              id="phone"
              type="tel"
              name="phone"
              value={form.phone}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="+221 7X XXX XX XX"
              aria-invalid={isVisibleError('phone')}
              aria-describedby={isVisibleError('phone') ? 'phone-error' : undefined}
            />
            {isVisibleError('phone') && <p className="editer-field-error" id="phone-error"><FiAlertCircle /> {errors.phone}</p>}
          </div>
        </div>
      </section>

      <section
        className={`editer-form-step-panel ${activeStep === 1 ? 'active' : ''}`}
        id="editer-panel-project"
        role="tabpanel"
        aria-labelledby="editer-tab-project"
        hidden={activeStep !== 1}
      >
        <div className="editer-form-step-header">
          <h3>{formStepConfig[1].title}</h3>
          <p>{formStepConfig[1].description}</p>
        </div>
        <div className="editer-form-grid">
          <div className="editer-field">
            <label htmlFor="title"><FiBook size={14} /> Titre du manuscrit <span>*</span></label>
            <input
              id="title"
              type="text"
              name="title"
              value={form.title}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="Le titre de votre ouvrage"
              aria-invalid={isVisibleError('title')}
              aria-describedby={isVisibleError('title') ? 'title-error' : undefined}
              required
            />
            {isVisibleError('title') && <p className="editer-field-error" id="title-error"><FiAlertCircle /> {errors.title}</p>}
          </div>
          <div className="editer-field">
            <label htmlFor="genre"><FiFileText size={14} /> Genre <span>*</span></label>
            <select
              id="genre"
              name="genre"
              value={form.genre}
              onChange={handleChange}
              onBlur={handleBlur}
              aria-invalid={isVisibleError('genre')}
              aria-describedby={isVisibleError('genre') ? 'genre-error' : undefined}
              required
            >
              <option value="">Sélectionner un genre</option>
              {genres.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            {isVisibleError('genre') && <p className="editer-field-error" id="genre-error"><FiAlertCircle /> {errors.genre}</p>}
          </div>
        </div>

        <div className="editer-field">
          <label htmlFor="synopsis">Synopsis / Résumé <span>*</span></label>
          <textarea
            id="synopsis"
            name="synopsis"
            value={form.synopsis}
            onChange={handleChange}
            onBlur={handleBlur}
            rows={5}
            placeholder="Décrivez brièvement votre ouvrage : thème, intrigue, objectif, public visé..."
            aria-invalid={isVisibleError('synopsis')}
            aria-describedby={isVisibleError('synopsis') ? 'synopsis-error' : 'synopsis-help'}
          />
          <p className="editer-field-help" id="synopsis-help">Un bon synopsis aide le comité à qualifier plus vite votre projet. Minimum : 80 caractères.</p>
          {isVisibleError('synopsis') && <p className="editer-field-error" id="synopsis-error"><FiAlertCircle /> {errors.synopsis}</p>}
        </div>

        <div className="editer-field">
          <label htmlFor="message">Message complémentaire</label>
          <textarea
            id="message"
            name="message"
            value={form.message}
            onChange={handleChange}
            rows={4}
            placeholder="Informations complémentaires, parcours d’auteur, publications précédentes, objectifs..."
          />
        </div>
      </section>

      <section
        className={`editer-form-step-panel ${activeStep === 2 ? 'active' : ''}`}
        id="editer-panel-file"
        role="tabpanel"
        aria-labelledby="editer-tab-file"
        hidden={activeStep !== 2}
      >
        <div className="editer-form-step-header">
          <h3>{formStepConfig[2].title}</h3>
          <p>{formStepConfig[2].description}</p>
        </div>

        <div className="editer-field">
          <label htmlFor="manuscript-file"><FiUpload size={14} /> Manuscrit (PDF, DOC, DOCX — max 20 Mo)</label>
          <div className="editer-file-input">
            <input type="file" id="manuscript-file" accept=".pdf,.doc,.docx" onChange={handleFile} />
            <label htmlFor="manuscript-file" className="editer-file-label">
              <FiUpload />
              {file ? 'Remplacer le fichier' : 'Choisir un fichier'}
            </label>
            <div className="editer-file-meta">
              <strong>{file ? file.name : 'Aucun fichier sélectionné'}</strong>
              <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} Mo` : 'Formats acceptés : PDF, DOC, DOCX'}</span>
            </div>
          </div>
          <p className="editer-field-help">Le dépôt de fichier est fortement recommandé pour permettre une évaluation complète dès la première lecture.</p>
          {isVisibleError('file') && <p className="editer-field-error" id="file-error"><FiAlertCircle /> {errors.file}</p>}
        </div>

        <div className="editer-form-summary">
          <div>
            <strong>Délais</strong>
            <span>Réponse éditoriale sous 12 semaines maximum après réception.</span>
          </div>
          <div>
            <strong>Besoin d’aide ?</strong>
            <span><Link to="/contact">Contactez l’équipe éditoriale</Link> avant d’envoyer votre dossier.</span>
          </div>
        </div>
      </section>

      <div className="editer-form-footer">
        <div className="editer-form-note">
          <FiClock size={14} />
          <span>Délai de réponse : 12 semaines maximum après réception.</span>
        </div>
        <div className="editer-form-actions">
          {activeStep > 0 && (
            <button type="button" className="btn btn-outline editer-secondary-action" onClick={goToPreviousStep}>
              Retour
            </button>
          )}
          {activeStep < formStepConfig.length - 1 ? (
            <button type="button" className="btn btn-primary btn-lg editer-submit" onClick={goToNextStep}>
              Continuer <FiArrowRight />
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-lg editer-submit" disabled={sending}>
              <FiSend /> {sending ? 'Envoi en cours...' : 'Soumettre le manuscrit'}
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

export default function SeFaireEditerPage() {
  return (
    <div className="editer-page">
      <section className="editer-hero">
        <div className="container editer-hero-layout">
          <div className="editer-hero-content">
            <span className="editer-hero-eyebrow">Accompagnement éditorial</span>
            <h1>Publiez votre manuscrit avec un parcours clair, des critères explicites et une réponse éditoriale en 12 semaines maximum.</h1>
            <p className="editer-hero-subtitle">
              Vous avez un manuscrit ? L&apos;Harmattan Sénégal vous accompagne de la soumission jusqu&apos;à la publication avec un parcours lisible, un modèle de coédition transparent et un point de contact avant chaque décision.
            </p>
            <div className="editer-hero-actions">
              <a href="#soumettre" className="btn btn-primary btn-lg">Soumettre mon manuscrit</a>
              <a href="#criteres" className="btn btn-outline btn-lg">Voir les critères</a>
            </div>
            <div className="editer-hero-highlights" aria-label="Informations clés">
              {heroHighlights.map((item) => (
                <div className="editer-highlight-card" key={item.value}>
                  <div className="editer-highlight-icon">{item.icon}</div>
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>
          <aside className="editer-hero-aside" aria-label="Checklist avant dépôt">
            <div className="editer-hero-checklist">
              <h2>Avant de commencer</h2>
              <p>Préparez votre dépôt en quelques minutes pour accélérer l’analyse de votre projet.</p>
              <ul>
                {preparationChecklist.map((item) => (
                  <li key={item}>
                    <FiCheckCircle />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="editer-hero-aside-footer">
                <span><FiClock /> Réponse éditoriale annoncée sous 12 semaines maximum</span>
                <Link to="/contact">Parler à l’équipe</Link>
              </div>
            </div>
          </aside>
        </div>
      </section>

      <nav className="editer-section-nav" aria-label="Navigation de la page">
        <div className="container editer-section-nav-links">
          <a href="#criteres">Critères</a>
          <a href="#parcours">Parcours</a>
          <a href="#faq">FAQ</a>
          <a href="#soumettre">Soumettre</a>
        </div>
      </nav>

      <section className="editer-criteria" id="criteres">
        <div className="container">
          <h2 className="editer-section-title">Les informations essentielles avant dépôt</h2>
          <p className="editer-section-subtitle">
            Avant de soumettre votre manuscrit, retrouvez ce qu’il faut préparer, ce que vous recevez et les éléments de réassurance clés.
          </p>
          <div className="editer-criteria-grid">
            {criteriaCards.map((card) => (
              <article className="editer-criteria-card" key={card.title}>
                <h3>{card.title}</h3>
                <ul>
                  {card.items.map((item) => (
                    <li key={item}>
                      <FiCheckCircle />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="editer-steps" id="parcours">
        <div className="container">
          <h2 className="editer-section-title">Le parcours de publication</h2>
          <p className="editer-section-subtitle">
            De la soumission à la fabrication, chaque étape précise les livrables attendus et le résultat que vous obtenez.
          </p>

          <div className="editer-steps-grid">
            {steps.map((step, index) => (
              <article className="editer-step-card" key={step.number}>
                <div className="editer-step-topline">
                  <div className="editer-step-icon">{step.icon}</div>
                  <div className="editer-step-headline">
                    <span className="editer-step-number">{step.number}</span>
                    <h3>{step.title}</h3>
                  </div>
                </div>
                <p>{step.description}</p>
                <ul className="editer-step-details">
                  {step.details.map((detail) => (
                    <li key={detail}>
                      <FiCheckCircle />
                      <span>{detail}</span>
                    </li>
                  ))}
                </ul>
                {index < steps.length - 1 && <div className="editer-step-connector" />}
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="editer-support">
        <div className="container">
          <h2 className="editer-section-title">Pourquoi ce parcours est plus simple à suivre</h2>
          <p className="editer-section-subtitle">
            Nous clarifions les délais, les attentes et les points de contact pour réduire les zones d’incertitude avant l’envoi.
          </p>
          <div className="editer-support-grid">
            {supportCards.map((card) => (
              <article className="editer-support-card" key={card.title}>
                <div className="editer-support-icon">{card.icon}</div>
                <h3>{card.title}</h3>
                <p>{card.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="editer-faq" id="faq">
        <div className="container">
          <h2 className="editer-section-title">Questions fréquentes avant soumission</h2>
          <p className="editer-section-subtitle">
            Les réponses ci-dessous couvrent les hésitations les plus courantes avant le dépôt d’un manuscrit.
          </p>
          <div className="editer-faq-list">
            {faqItems.map((item) => (
              <FAQItem key={item.question} question={item.question} answer={item.answer} />
            ))}
          </div>
        </div>
      </section>

      <section className="editer-form-section" id="soumettre">
        <div className="container">
          <div className="editer-form-layout">
            <aside className="editer-form-sidebar">
              <div className="editer-sidebar-card">
                <h2>Votre dépôt en un coup d’œil</h2>
                <ul>
                  <li><FiCheckCircle /> Coordonnées et titre du manuscrit</li>
                  <li><FiCheckCircle /> Synopsis pour accélérer l’évaluation</li>
                  <li><FiCheckCircle /> Fichier PDF ou Word recommandé</li>
                </ul>
              </div>
              <div className="editer-sidebar-card editer-sidebar-card-accent">
                <h3>Besoin d’aide avant d’envoyer ?</h3>
                <p>Si vous hésitez sur le format, le genre ou les pièces à joindre, écrivez-nous avant de soumettre votre dossier.</p>
                <Link to="/contact" className="btn btn-outline">Contacter l’équipe</Link>
              </div>
            </aside>
            <div className="editer-form-card">
              <div className="editer-form-header">
                <h2>Soumettre votre manuscrit</h2>
                <p>Formulaire guidé en 3 étapes avec validation en contexte, rappel des formats acceptés et aide au dépôt.</p>
              </div>
              <ManuscriptForm />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
