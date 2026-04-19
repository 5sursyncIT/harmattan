import { useMemo, useState } from 'react';
import { FiArrowRight, FiClock, FiMail, FiMapPin, FiPhone, FiSend } from 'react-icons/fi';
import useSiteConfig from '../hooks/useSiteConfig.jsx';
import api from '../api/dolibarr';
import toast from 'react-hot-toast';
import './ContactPage.css';

function buildMapsLink(address) {
  if (!address) return '#';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function normalizePhone(phone = '') {
  return phone.replace(/\s+/g, '');
}

function getValidationErrors(form) {
  const errors = {};

  if (!form.name.trim()) {
    errors.name = 'Veuillez renseigner votre nom.';
  }

  if (!form.email.trim()) {
    errors.email = 'Veuillez renseigner votre email.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = 'Veuillez renseigner une adresse email valide.';
  }

  if (!form.department.trim()) {
    errors.department = 'Veuillez choisir le service à contacter.';
  }

  if (!form.subject.trim()) {
    errors.subject = 'Veuillez préciser le sujet.';
  } else if (form.subject.trim().length < 5) {
    errors.subject = 'Le sujet doit comporter au moins 5 caractères.';
  }

  if (!form.message.trim()) {
    errors.message = 'Veuillez rédiger votre message.';
  } else if (form.message.trim().length < 20) {
    errors.message = 'Le message doit comporter au moins 20 caractères.';
  }

  return errors;
}

export default function ContactPage() {
  const config = useSiteConfig();
  const contact = config?.contact || {};
  const [form, setForm] = useState({ name: '', email: '', department: '', subject: '', message: '' });
  const [sending, setSending] = useState(false);
  const [touched, setTouched] = useState({});
  const [errors, setErrors] = useState({});

  const departments = contact.departments || [
    { value: 'edition', label: 'Édition' },
    { value: 'librairie', label: 'Librairie' },
    { value: 'direction', label: 'Direction' },
    { value: 'promotion', label: 'Promotion' },
  ];

  const address = contact.address || 'Dakar, 10, VDN après le pont de Fann, Sicap Karak 45034';
  const addressShort = contact.address_short || address;
  const phones = contact.phones || ['+221 33 825 98 58', '+221 70 953 02 40', '+221 77 545 23 00'];
  const directEmails = contact.emails || ['direction@senharmattan.com'];
  const departmentEmails = departments.filter((department) => department.email);
  const emailEntries = departmentEmails.length > 0
    ? departmentEmails
    : directEmails.map((email, index) => ({ value: `email-${index}`, label: 'Contact', email }));

  const hoursLines = [
    contact.hours_detail?.weekdays || 'Lundi - Vendredi : 8h - 18h30',
    contact.hours_detail?.saturday || 'Samedi : 9h - 18h30',
    contact.hours_detail?.sunday || 'Dimanche : Fermé',
  ];

  const selectedDepartment = useMemo(
    () => departments.find((department) => department.value === form.department),
    [departments, form.department]
  );

  const updateForm = (field, value) => {
    const nextForm = { ...form, [field]: value };
    setForm(nextForm);
    setErrors(getValidationErrors(nextForm));
  };

  const markTouched = (field) => {
    setTouched((current) => ({ ...current, [field]: true }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const nextErrors = getValidationErrors(form);
    setErrors(nextErrors);
    setTouched({
      name: true,
      email: true,
      department: true,
      subject: true,
      message: true,
    });

    if (Object.keys(nextErrors).length > 0) {
      toast.error('Veuillez corriger les champs signalés.');
      return;
    }

    setSending(true);
    try {
      await api.post('/admin/contact', form);
      toast.success('Message envoyé avec succès !');
      setForm({ name: '', email: '', department: '', subject: '', message: '' });
      setTouched({});
      setErrors({});
    } catch {
      toast.error("Erreur lors de l'envoi");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="contact-page">
      <div className="container">
        <section className="contact-hero">
          <div className="contact-hero-copy">
            <span className="contact-kicker">Contact</span>
            <h1>Parlons de votre besoin</h1>
            <p className="contact-hero-subtitle">
              Une question sur l’édition, la librairie, une commande ou un événement ? Choisissez le bon interlocuteur et obtenez une réponse plus rapidement.
            </p>
            <div className="contact-hero-stats" aria-label="Aperçu des moyens de contact">
              <div className="contact-stat">
                <strong>{phones.length}</strong>
                <span>numéros directs</span>
              </div>
              <div className="contact-stat">
                <strong>{emailEntries.length}</strong>
                <span>services joignables</span>
              </div>
              <div className="contact-stat">
                <strong>6j/7</strong>
                <span>accueil en librairie</span>
              </div>
            </div>
            <div className="contact-hero-actions">
              <a href="#contact-form" className="btn btn-primary">
                Envoyer un message <FiSend />
              </a>
              <a
                href={buildMapsLink(address)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline"
              >
                Ouvrir l’adresse <FiMapPin />
              </a>
            </div>
          </div>

          <div className="contact-highlight-card">
            <p className="contact-highlight-label">Réponse guidée</p>
            <h2>Choisissez le bon service dès le premier message</h2>
            <p className="contact-highlight-text">
              Nous orientons votre demande vers l’édition, la librairie, la direction ou la promotion selon votre besoin.
            </p>
            <div className="contact-highlight-list">
              {departments.map((department) => (
                <button
                  key={department.value}
                  type="button"
                  className={`contact-department-chip ${form.department === department.value ? 'active' : ''}`}
                  onClick={() => {
                    updateForm('department', department.value);
                    markTouched('department');
                  }}
                >
                  <span>{department.label}</span>
                  <FiArrowRight />
                </button>
              ))}
            </div>
            <p className="contact-highlight-footnote">
              {selectedDepartment?.email
                ? `Votre message sera adressé à ${selectedDepartment.label} via ${selectedDepartment.email}.`
                : 'Sélectionnez un service pour personnaliser votre demande.'}
            </p>
          </div>
        </section>

        <section className="contact-quick-grid" aria-label="Moyens de contact rapides">
          <a
            className="contact-quick-card"
            href={phones[0] ? `tel:${normalizePhone(phones[0])}` : '#'}
          >
            <FiPhone />
            <div>
              <span>Appelez-nous</span>
              <strong>{phones[0] || '+221 33 825 98 58'}</strong>
            </div>
          </a>
          <a
            className="contact-quick-card"
            href={emailEntries[0]?.email ? `mailto:${emailEntries[0].email}` : '#'}
          >
            <FiMail />
            <div>
              <span>Écrivez-nous</span>
              <strong>{emailEntries[0]?.email || 'direction@senharmattan.com'}</strong>
            </div>
          </a>
          <a
            className="contact-quick-card"
            href={buildMapsLink(address)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <FiMapPin />
            <div>
              <span>Adresse</span>
              <strong>{addressShort}</strong>
            </div>
          </a>
          <div className="contact-quick-card contact-quick-static">
            <FiClock />
            <div>
              <span>Horaires</span>
              <strong>{contact.hours || 'Lun - Ven: 8h - 18h30 | Sam: 9h - 18h30'}</strong>
            </div>
          </div>
        </section>

        <div className="contact-grid">
          <div className="contact-info">
            <div className="contact-section-heading">
              <span className="contact-section-kicker">Coordonnées</span>
              <h3>Nos coordonnées</h3>
              <p>Retrouvez toutes les informations utiles pour venir à la librairie ou joindre le bon interlocuteur.</p>
            </div>

            <div className="contact-item">
              <FiMapPin size={20} />
              <div>
                <h4>Adresse</h4>
                <p>{address}</p>
                <a href={buildMapsLink(address)} target="_blank" rel="noopener noreferrer" className="contact-inline-link">
                  Voir l’itinéraire
                </a>
              </div>
            </div>

            <div className="contact-item">
              <FiPhone size={20} />
              <div>
                <h4>Téléphone</h4>
                <div className="contact-stack">
                  {phones.map((phone, index) => (
                    <a key={index} href={`tel:${normalizePhone(phone)}`} className="contact-inline-link">
                      {phone}
                    </a>
                  ))}
                </div>
              </div>
            </div>

            <div className="contact-item">
              <FiMail size={20} />
              <div>
                <h4>Email</h4>
                <div className="contact-stack">
                  {emailEntries.map((entry) => (
                    <p key={entry.value}>
                      <strong>{entry.label} :</strong>{' '}
                      <a href={`mailto:${entry.email}`} className="contact-inline-link">{entry.email}</a>
                    </p>
                  ))}
                </div>
              </div>
            </div>

            <div className="contact-item">
              <FiClock size={20} />
              <div>
                <h4>Horaires</h4>
                <div className="contact-stack">
                  {hoursLines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="contact-form-section" id="contact-form">
            <div className="contact-section-heading">
              <span className="contact-section-kicker">Formulaire</span>
              <h3>Envoyez-nous un message</h3>
              <p>Décrivez votre besoin en quelques lignes et choisissez le service concerné pour accélérer le traitement.</p>
            </div>
            <form className="contact-form" onSubmit={handleSubmit} noValidate>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="contact-name">Nom</label>
                  <input
                    id="contact-name"
                    type="text"
                    value={form.name}
                    onChange={(e) => updateForm('name', e.target.value)}
                    onBlur={() => markTouched('name')}
                    aria-invalid={Boolean(touched.name && errors.name)}
                    aria-describedby={touched.name && errors.name ? 'contact-name-error' : undefined}
                    required
                  />
                  {touched.name && errors.name && <p id="contact-name-error" className="contact-field-error">{errors.name}</p>}
                </div>
                <div className="form-group">
                  <label htmlFor="contact-email">Email</label>
                  <input
                    id="contact-email"
                    type="email"
                    value={form.email}
                    onChange={(e) => updateForm('email', e.target.value)}
                    onBlur={() => markTouched('email')}
                    aria-invalid={Boolean(touched.email && errors.email)}
                    aria-describedby={touched.email && errors.email ? 'contact-email-error' : undefined}
                    required
                  />
                  {touched.email && errors.email && <p id="contact-email-error" className="contact-field-error">{errors.email}</p>}
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="contact-department">Destinataire</label>
                <select
                  id="contact-department"
                  value={form.department}
                  onChange={(e) => updateForm('department', e.target.value)}
                  onBlur={() => markTouched('department')}
                  aria-invalid={Boolean(touched.department && errors.department)}
                  aria-describedby={touched.department && errors.department ? 'contact-department-error' : 'contact-department-help'}
                  required
                >
                  <option value="">Choisir un service</option>
                  {departments.map((department) => <option key={department.value} value={department.value}>{department.label}</option>)}
                </select>
                <p id="contact-department-help" className="contact-field-help">
                  {selectedDepartment?.email
                    ? `Le message sera envoyé au service ${selectedDepartment.label}.`
                    : 'Choisissez le service le plus proche de votre demande.'}
                </p>
                {touched.department && errors.department && <p id="contact-department-error" className="contact-field-error">{errors.department}</p>}
              </div>
              <div className="form-group">
                <label htmlFor="contact-subject">Sujet</label>
                <input
                  id="contact-subject"
                  type="text"
                  value={form.subject}
                  onChange={(e) => updateForm('subject', e.target.value)}
                  onBlur={() => markTouched('subject')}
                  aria-invalid={Boolean(touched.subject && errors.subject)}
                  aria-describedby={touched.subject && errors.subject ? 'contact-subject-error' : undefined}
                  required
                />
                {touched.subject && errors.subject && <p id="contact-subject-error" className="contact-field-error">{errors.subject}</p>}
              </div>
              <div className="form-group">
                <label htmlFor="contact-message">Message</label>
                <textarea
                  id="contact-message"
                  rows="6"
                  value={form.message}
                  onChange={(e) => updateForm('message', e.target.value)}
                  onBlur={() => markTouched('message')}
                  aria-invalid={Boolean(touched.message && errors.message)}
                  aria-describedby={touched.message && errors.message ? 'contact-message-error' : 'contact-message-help'}
                  required
                />
                <div className="contact-form-footer">
                  <p id="contact-message-help" className="contact-field-help">
                    Donnez un maximum de contexte pour faciliter le traitement de votre demande.
                  </p>
                  <span className="contact-character-count">
                    {form.message.trim().length} caractères
                  </span>
                </div>
                {touched.message && errors.message && <p id="contact-message-error" className="contact-field-error">{errors.message}</p>}
              </div>
              <button type="submit" className="btn btn-primary contact-submit" disabled={sending}>
                {sending ? 'Envoi...' : 'Envoyer le message'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
