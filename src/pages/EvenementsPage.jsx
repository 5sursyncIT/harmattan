import { useEffect, useMemo, useState } from 'react';
import {
  FiArrowRight,
  FiCalendar,
  FiChevronRight,
  FiClock,
  FiExternalLink,
  FiMail,
  FiMapPin,
  FiPhone,
  FiSearch,
} from 'react-icons/fi';
import { Link } from 'react-router-dom';
import { getEvenements } from '../api/dolibarr';
import useSiteConfig from '../hooks/useSiteConfig';
import './EvenementsPage.css';

function formatDate(timestamp) {
  const d = new Date(timestamp * 1000);
  return d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function formatDatePill(timestamp) {
  const d = new Date(timestamp * 1000);
  const day = d.toLocaleDateString('fr-FR', { day: '2-digit' });
  const month = d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '').toUpperCase();
  return { day, month };
}

function formatHeure(timestamp) {
  const d = new Date(timestamp * 1000);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function toGoogleCalendarDate(timestamp) {
  const d = new Date(timestamp * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}T${hh}${min}${ss}Z`;
}

function buildGoogleCalendarLink(event) {
  const start = toGoogleCalendarDate(event.datep);
  const end = toGoogleCalendarDate(event.datef || (event.datep + 3600));
  const title = event.title || 'Événement';
  const details = event.description || '';
  const location = event.lieu || '';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${start}/${end}`,
    details,
    location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildMapsLink(location) {
  if (!location) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

function getStatutLabel(statut) {
  switch (statut) {
    case 'a-venir':
      return { label: 'À venir', className: 'evt-badge-upcoming' };
    case 'en-cours':
      return { label: 'En cours', className: 'evt-badge-ongoing' };
    case 'passe':
      return { label: 'Terminé', className: 'evt-badge-past' };
    default:
      return { label: statut, className: '' };
  }
}

function getStatutOrder(statut) {
  switch (statut) {
    case 'en-cours':
      return 0;
    case 'a-venir':
      return 1;
    case 'passe':
      return 2;
    default:
      return 3;
  }
}

function getTypeKey(type = '') {
  return type
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function getModeInfo(event) {
  if (event.lien && event.lieu) {
    return { label: 'Hybride', className: 'evt-mode-hybrid' };
  }
  if (event.lien) {
    return { label: 'En ligne', className: 'evt-mode-online' };
  }
  if (event.lieu) {
    return { label: 'Présentiel', className: 'evt-mode-onsite' };
  }
  return { label: 'À confirmer', className: 'evt-mode-info' };
}

function getPrimaryAction(event) {
  if (event.lien) {
    return {
      href: event.lien,
      label: event.lieu ? 'Participer en ligne' : 'Rejoindre le live',
      external: true,
      icon: <FiExternalLink />,
    };
  }

  if (event.lieu) {
    return {
      href: buildMapsLink(event.lieu),
      label: 'Voir le lieu',
      external: true,
      icon: <FiMapPin />,
    };
  }

  return null;
}

function getEventSummary(event) {
  if (!event?.description) return 'Découvrez les temps forts de cet événement organisé par L’Harmattan Sénégal.';
  const summary = event.description.trim();
  if (summary.length <= 180) return summary;
  return `${summary.slice(0, 177).trimEnd()}…`;
}

function EventCard({ event }) {
  const { label, className } = getStatutLabel(event.statut);
  const heureDebut = formatHeure(event.datep);
  const heureFin = event.datef ? formatHeure(event.datef) : null;
  const datePill = formatDatePill(event.datep);
  const calendarLink = buildGoogleCalendarLink(event);
  const mapsLink = buildMapsLink(event.lieu);
  const modeInfo = getModeInfo(event);
  const primaryAction = getPrimaryAction(event);

  return (
    <article className={`evt-card evt-card-${getTypeKey(event.type)}`}>
      <div className="evt-card-header">
        <div className="evt-card-header-left">
          <div className="evt-datepill" aria-label={formatDate(event.datep)}>
            <span className="evt-datepill-day">{datePill.day}</span>
            <span className="evt-datepill-month">{datePill.month}</span>
          </div>
          <div className="evt-card-taxonomy">
            {event.type && <span className="evt-type">{event.type}</span>}
            <span className={`evt-mode ${modeInfo.className}`}>{modeInfo.label}</span>
          </div>
        </div>
        <span className={`evt-badge ${className}`}>{label}</span>
      </div>

      <h3 className="evt-card-title">{event.title}</h3>

      <div className="evt-card-meta">
        <div className="evt-meta-item">
          <FiCalendar />
          <span>{formatDate(event.datep)}</span>
        </div>
        <div className="evt-meta-item">
          <FiClock />
          <span>{heureDebut}{heureFin ? ` — ${heureFin}` : ''}</span>
        </div>
        {event.lieu && (
          <div className="evt-meta-item">
            <FiMapPin />
            <span>{event.lieu}</span>
          </div>
        )}
      </div>

      {event.description && (
        <p className="evt-card-description">{event.description}</p>
      )}

      <div className="evt-actions">
        {primaryAction && (
          <a
            href={primaryAction.href}
            target={primaryAction.external ? '_blank' : undefined}
            rel={primaryAction.external ? 'noopener noreferrer' : undefined}
            className="btn btn-sm btn-primary evt-action-primary"
          >
            {primaryAction.label} {primaryAction.icon}
          </a>
        )}
        <a
          href={calendarLink}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-sm btn-outline evt-action-secondary"
        >
          Ajouter au calendrier
        </a>
        {mapsLink && (
          <a
            href={mapsLink}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm btn-outline evt-action-secondary"
          >
            Itinéraire
          </a>
        )}
      </div>
    </article>
  );
}

function EventSkeleton() {
  return (
    <div className="evt-card evt-skeleton">
      <div className="evt-skeleton-line short" />
      <div className="evt-skeleton-line long" />
      <div className="evt-skeleton-line medium" />
      <div className="evt-skeleton-line medium" />
      <div className="evt-skeleton-line long" />
    </div>
  );
}

export default function EvenementsPage() {
  const siteConfig = useSiteConfig();
  const [evenements, setEvenements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('Tous');
  const [statusFilter, setStatusFilter] = useState('Tous');
  const [query, setQuery] = useState('');

  useEffect(() => {
    getEvenements()
      .then((res) => setEvenements(res.data || []))
      .catch(() => setEvenements([]))
      .finally(() => setLoading(false));
  }, []);

  const typeLabels = useMemo(() => {
    const preferredTypes = ['Dédicace', 'Salon', 'Prix littéraire', 'Annonces'];
    const availableTypes = [...new Set(evenements.map((event) => event.type).filter(Boolean))];
    const orderedTypes = [
      ...preferredTypes.filter((type) => availableTypes.includes(type)),
      ...availableTypes.filter((type) => !preferredTypes.includes(type)).sort((a, b) => a.localeCompare(b, 'fr')),
    ];
    return ['Tous', ...orderedTypes];
  }, [evenements]);

  const statusLabels = [
    { value: 'Tous', label: 'Tous' },
    { value: 'en-cours', label: 'En cours' },
    { value: 'a-venir', label: 'À venir' },
    { value: 'passe', label: 'Terminés' },
  ];

  const normalizedQuery = query.trim().toLowerCase();

  const sortedEvenements = useMemo(() => evenements
    .slice()
    .sort((a, b) => {
      const ao = getStatutOrder(a.statut);
      const bo = getStatutOrder(b.statut);
      if (ao !== bo) return ao - bo;

      const ad = Number(a.datep || 0);
      const bd = Number(b.datep || 0);
      if (a.statut === 'passe' && b.statut === 'passe') return bd - ad;
      return ad - bd;
    }), [evenements]);

  const featuredEvent = useMemo(
    () => sortedEvenements.find((event) => event.statut === 'en-cours')
      || sortedEvenements.find((event) => event.statut === 'a-venir')
      || sortedEvenements[0]
      || null,
    [sortedEvenements]
  );

  const filtered = sortedEvenements
    .filter((e) => (typeFilter === 'Tous' ? true : e.type === typeFilter))
    .filter((e) => (statusFilter === 'Tous' ? true : e.statut === statusFilter))
    .filter((e) => {
      if (!normalizedQuery) return true;
      const haystack = [
        e.title,
        e.description,
        e.lieu,
        e.type,
        e.statut,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });

  const eventSections = [
    {
      key: 'en-cours',
      title: 'En ce moment',
      description: 'Les rendez-vous actifs à suivre dès maintenant.',
      items: filtered.filter((event) => event.statut === 'en-cours'),
    },
    {
      key: 'a-venir',
      title: 'À venir',
      description: 'Les prochains rendez-vous à ne pas manquer.',
      items: filtered.filter((event) => event.statut === 'a-venir'),
    },
    {
      key: 'passe',
      title: 'Événements passés',
      description: 'Les derniers temps forts de la maison.',
      items: filtered.filter((event) => event.statut === 'passe'),
    },
  ].filter((section) => section.items.length > 0);

  const totalCount = evenements.length;
  const upcomingCount = evenements.filter((event) => event.statut === 'a-venir').length;
  const onlineCount = evenements.filter((event) => getModeInfo(event).label === 'En ligne').length;
  const featuredPrimaryAction = featuredEvent ? getPrimaryAction(featuredEvent) : null;
  const address = siteConfig?.contact?.address_short || siteConfig?.contact?.address || '10, VDN, Sicap Karak 45034, Dakar';
  const primaryPhone = siteConfig?.contact?.phones?.[0];
  const primaryEmail = siteConfig?.contact?.emails?.[0];
  const openingHours = siteConfig?.contact?.hours || 'Lun - Ven: 8h - 18h30 | Sam: 9h - 18h30';

  return (
    <div className="evt-page">
      <section className="evt-hero">
        <div className="container evt-hero-grid">
          <div className="evt-hero-copy">
            <span className="evt-kicker">Événements & actualités</span>
            <h1>Retrouvez les prochains rendez-vous de L’Harmattan Sénégal</h1>
            <p className="evt-hero-subtitle">
              Dédicaces, salons, prix littéraires et lancements en direct : trouvez rapidement l’événement qui vous correspond, en ligne ou à la librairie.
            </p>
            <div className="evt-hero-stats" aria-label="Aperçu des événements">
              <div className="evt-stat">
                <strong>{totalCount}</strong>
                <span>événement{totalCount > 1 ? 's' : ''}</span>
              </div>
              <div className="evt-stat">
                <strong>{upcomingCount}</strong>
                <span>à venir</span>
              </div>
              <div className="evt-stat">
                <strong>{onlineCount}</strong>
                <span>en ligne</span>
              </div>
            </div>
            <div className="evt-hero-actions">
              <a href="#evenements-list" className="btn btn-primary">
                Voir les événements <FiArrowRight />
              </a>
              <a
                href={buildMapsLink(address)}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-outline evt-hero-outline"
              >
                Ouvrir la librairie <FiMapPin />
              </a>
            </div>
          </div>

          {featuredEvent && (
            <article className="evt-spotlight-card" aria-labelledby="evt-spotlight-title">
              <div className="evt-spotlight-head">
                <span className="evt-spotlight-label">À la une</span>
                <span className={`evt-badge ${getStatutLabel(featuredEvent.statut).className}`}>
                  {getStatutLabel(featuredEvent.statut).label}
                </span>
              </div>
              {featuredEvent.type && <p className="evt-spotlight-type">{featuredEvent.type}</p>}
              <h2 id="evt-spotlight-title">{featuredEvent.title}</h2>
              <p className="evt-spotlight-summary">{getEventSummary(featuredEvent)}</p>
              <div className="evt-spotlight-meta">
                <div className="evt-meta-item">
                  <FiCalendar />
                  <span>{formatDate(featuredEvent.datep)}</span>
                </div>
                <div className="evt-meta-item">
                  <FiClock />
                  <span>
                    {formatHeure(featuredEvent.datep)}
                    {featuredEvent.datef ? ` — ${formatHeure(featuredEvent.datef)}` : ''}
                  </span>
                </div>
                {featuredEvent.lieu && (
                  <div className="evt-meta-item">
                    <FiMapPin />
                    <span>{featuredEvent.lieu}</span>
                  </div>
                )}
              </div>
              <div className="evt-actions evt-spotlight-actions">
                {featuredPrimaryAction && (
                  <a
                    href={featuredPrimaryAction.href}
                    target={featuredPrimaryAction.external ? '_blank' : undefined}
                    rel={featuredPrimaryAction.external ? 'noopener noreferrer' : undefined}
                    className="btn btn-primary evt-action-primary"
                  >
                    {featuredPrimaryAction.label} {featuredPrimaryAction.icon}
                  </a>
                )}
                <a
                  href={buildGoogleCalendarLink(featuredEvent)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-outline"
                >
                  Ajouter au calendrier
                </a>
              </div>
            </article>
          )}
        </div>
      </section>

      <section className="evt-content" id="evenements-list">
        <div className="container">
          {!loading && evenements.length > 0 && (
            <div className="evt-toolbar">
              <div className="evt-toolbar-top">
                <div className="evt-search">
                  <label htmlFor="events-search" className="evt-search-label">
                    Rechercher un événement
                  </label>
                  <div className="evt-search-field">
                    <FiSearch />
                    <input
                      id="events-search"
                      type="search"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Titre, lieu, type…"
                      aria-describedby="events-search-help"
                    />
                  </div>
                  <p id="events-search-help" className="evt-search-help">
                    Utilisez les filtres pour affiner par format ou par statut.
                  </p>
                </div>
                <div className="evt-counter" aria-live="polite">
                  {filtered.length} résultat{filtered.length > 1 ? 's' : ''}
                </div>
              </div>

              <div className="evt-filter-groups">
                <div className="evt-filter-block">
                  <span className="evt-filter-label">Type</span>
                  <div className="evt-filters" role="group" aria-label="Filtrer par type">
                    {typeLabels.map((type) => {
                      const count = type === 'Tous'
                        ? evenements.length
                        : evenements.filter((event) => event.type === type).length;

                      return (
                        <button
                          key={type}
                          className={`evt-filter-btn ${typeFilter === type ? 'active' : ''}`}
                          onClick={() => setTypeFilter(type)}
                          type="button"
                          aria-pressed={typeFilter === type}
                        >
                          {type} <span className="evt-filter-count">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="evt-filter-block">
                  <span className="evt-filter-label">Statut</span>
                  <div className="evt-status" role="group" aria-label="Filtrer par statut">
                    {statusLabels.map((status) => {
                      const count = status.value === 'Tous'
                        ? evenements.length
                        : evenements.filter((event) => event.statut === status.value).length;

                      return (
                        <button
                          key={status.value}
                          className={`evt-filter-btn ${statusFilter === status.value ? 'active' : ''}`}
                          onClick={() => setStatusFilter(status.value)}
                          type="button"
                          aria-pressed={statusFilter === status.value}
                        >
                          {status.label} <span className="evt-filter-count">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {(typeFilter !== 'Tous' || statusFilter !== 'Tous' || query.trim()) && (
                <div className="evt-toolbar-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline evt-reset"
                    onClick={() => {
                      setTypeFilter('Tous');
                      setStatusFilter('Tous');
                      setQuery('');
                    }}
                  >
                    Réinitialiser les filtres
                  </button>
                </div>
              )}
            </div>
          )}

          {loading ? (
            <div className="evt-grid">
              <EventSkeleton />
              <EventSkeleton />
              <EventSkeleton />
            </div>
          ) : filtered.length > 0 ? (
            <div className="evt-sections">
              {eventSections.map((section) => (
                <section key={section.key} className="evt-section-block" aria-labelledby={`evt-section-${section.key}`}>
                  <div className="evt-section-head">
                    <div>
                      <h2 id={`evt-section-${section.key}`}>{section.title}</h2>
                      <p>{section.description}</p>
                    </div>
                    <span className="evt-section-count">
                      {section.items.length} événement{section.items.length > 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="evt-grid">
                    {section.items.map((event) => (
                      <EventCard key={event.id} event={event} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="evt-empty">
              <h2>Aucun événement ne correspond à votre recherche</h2>
              <p>Essayez un autre mot-clé ou revenez à tous les formats pour retrouver l’agenda complet.</p>
              {(typeFilter !== 'Tous' || statusFilter !== 'Tous' || query.trim()) && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline evt-reset"
                  onClick={() => {
                    setTypeFilter('Tous');
                    setStatusFilter('Tous');
                    setQuery('');
                  }}
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="evt-location">
        <div className="container">
          <div className="evt-location-card">
            <div className="evt-location-info">
              <h2>Notre librairie</h2>
              <p>Retrouvez-nous pour les dédicaces, salons et rencontres en présentiel à Dakar.</p>
              <div className="evt-location-details">
                <div className="evt-meta-item">
                  <FiMapPin />
                  <span>{address}</span>
                </div>
                <div className="evt-meta-item">
                  <FiClock />
                  <span>{openingHours}</span>
                </div>
              </div>
              <div className="evt-location-actions">
                <a
                  href={buildMapsLink(address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="evt-location-btn"
                >
                  Itinéraire <FiMapPin />
                </a>
                <Link to="/contact" className="evt-location-btn evt-location-btn-secondary">
                  Nous contacter <FiChevronRight />
                </Link>
              </div>
            </div>
            <div className="evt-location-side">
              {primaryPhone && (
                <a className="evt-contact-card" href={`tel:${primaryPhone.replace(/\s+/g, '')}`}>
                  <FiPhone />
                  <div>
                    <span>Téléphone</span>
                    <strong>{primaryPhone}</strong>
                  </div>
                </a>
              )}
              {primaryEmail && (
                <a className="evt-contact-card" href={`mailto:${primaryEmail}`}>
                  <FiMail />
                  <div>
                    <span>Email</span>
                    <strong>{primaryEmail}</strong>
                  </div>
                </a>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
