import { useState } from 'react';
import { FiCheck, FiClock, FiFileText, FiAlertTriangle, FiSend, FiMail, FiTrash2, FiDollarSign, FiCreditCard, FiDownload, FiUserPlus, FiUserMinus, FiUpload, FiHash, FiLink2, FiRefreshCw, FiEdit3, FiFlag, FiCheckSquare, FiClipboard, FiEye, FiEyeOff } from 'react-icons/fi';
import './ManuscriptTimeline.css';

const STAGE_ICONS = {
  submitted: FiFileText,
  in_evaluation: FiClock,
  evaluation_positive: FiCheck,
  evaluation_rework: FiRefreshCw,
  evaluation_negative: FiAlertTriangle,
  contract_pending: FiClock,
  contract_signed: FiCheck,
  payment_pending: FiClock,
  in_correction: FiFileText,
  correction_author_review: FiClock,
  in_editorial: FiFileText,
  editorial_validated: FiCheck,
  cover_design: FiFileText,
  bat_author_review: FiClock,
  print_preparation: FiFileText,
  printing: FiClock,
  printed: FiCheck,
  in_communication: FiSend,
  published: FiFlag,
  // Évènements informatifs (colonne `event`)
  quote_created: FiDollarSign,
  quote_sent: FiSend,
  quote_paid: FiCreditCard,
  quote_deleted: FiTrash2,
  contract_doc_sent: FiDownload,
  contract_sent: FiMail,
  contract_deleted: FiTrash2,
  contract_validated: FiCheck,
  contract_linked: FiLink2,
  isbn_assigned: FiHash,
  details_updated: FiEdit3,
  intervenant_assigned: FiUserPlus,
  intervenant_unassigned: FiUserMinus,
  file_uploaded: FiUpload,
  email_sent: FiMail,
  comm_checklist: FiCheckSquare,
  communication_brief_ready: FiClipboard,
  launch_prepared: FiFlag,
};

// Tonalité sémantique par étape : structure la lecture de la frise d'un coup
// d'œil (vert = jalon franchi, ambre = attente/action requise, rouge = rejet,
// bleu = travail en cours). Le sens reste porté par icône + libellé (a11y :
// jamais par la couleur seule).
const STAGE_TONE = {
  submitted: 'info',
  in_evaluation: 'progress',
  evaluation_positive: 'success',
  evaluation_rework: 'warn',
  evaluation_negative: 'danger',
  contract_pending: 'warn',
  contract_signed: 'success',
  payment_pending: 'warn',
  in_correction: 'progress',
  correction_author_review: 'warn',
  in_editorial: 'progress',
  editorial_validated: 'success',
  cover_design: 'progress',
  bat_author_review: 'warn',
  print_preparation: 'progress',
  printing: 'progress',
  printed: 'success',
  in_communication: 'progress',
  published: 'success',
};

// Quelques évènements « jalons » profitent aussi d'une tonalité.
const EVENT_TONE = {
  quote_paid: 'success',
  contract_validated: 'success',
  isbn_assigned: 'success',
  communication_brief_ready: 'success',
  launch_prepared: 'success',
  quote_deleted: 'danger',
  contract_deleted: 'danger',
};

// Évènements « techniques » à faible valeur pour le suivi : brouillons,
// suppressions, téléchargements internes et rattachements redondants avec une
// transition de stage. Masqués par défaut pour garder une frise lisible (on ne
// montre que les jalons utiles). Ils restent tracés en base (audit conservé) et
// consultables côté admin via « journal complet ».
const NOISE_EVENTS = new Set([
  'quote_created',          // brouillon de devis (le « Devis envoyé » suffit au suivi)
  'quote_deleted',          // suppression d'un brouillon de devis
  'contract_deleted',       // suppression d'un brouillon de contrat
  'contract_doc_sent',      // téléchargement interne du PDF/ODT du contrat
  'contract_linked',        // rattachement (doublonne « Contrat à signer »)
  'intervenant_unassigned', // retrait d'intervenant
  'email_sent',             // e-mail générique
  'comm_checklist',         // chaque coche de la checklist parution (les jalons brief_ready/launch_prepared restent visibles)
]);

// SQLite renvoie « YYYY-MM-DD HH:MM:SS » : l'espace n'est pas parsé par Safari,
// on le remplace par « T » (même sémantique locale que l'ancien comportement).
function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

function dayKey(d) {
  return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : '';
}

// Libellé du séparateur de jour : « Aujourd'hui » / « Hier » / date complète.
function formatDay(d) {
  if (!d) return '';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return "Aujourd'hui";
  if (dayKey(d) === dayKey(yesterday)) return 'Hier';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(d) {
  return d ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
}

function formatFull(d) {
  return d ? d.toLocaleString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

// Initiales (2 lettres max) pour la pastille acteur.
function initials(label) {
  if (!label) return '';
  const parts = String(label).trim().split(/[\s._@-]+/).filter(Boolean);
  if (!parts.length) return '';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] || '' : '')).toUpperCase();
}

export default function ManuscriptTimeline({ stages = [], showFullJournalToggle = false }) {
  const [showAll, setShowAll] = useState(false);

  if (!stages.length) {
    return <p className="mt-empty">Aucun événement pour le moment.</p>;
  }

  // Le repère « étape courante » suit la dernière VRAIE transition de stage,
  // pas le dernier évènement informatif (devis, contrat envoyé…) qui peut
  // survenir après coup sans faire avancer le workflow. On le calcule sur la
  // liste COMPLÈTE pour rester juste même quand des évènements sont masqués.
  let currentIdx = -1;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (!stages[i].event) { currentIdx = i; break; }
  }

  const hiddenCount = stages.reduce((n, s) => (NOISE_EVENTS.has(s.event) ? n + 1 : n), 0);
  // Séparateurs par jour : structure les historiques longs sans alourdir les
  // lignes (l'heure seule suffit ensuite dans la méta). Dérivation pure : on
  // marque la première entrée visible de chaque journée.
  const visible = stages
    .map((stage, idx) => ({ stage, idx, d: parseDate(stage.created_at) }))
    .filter(({ stage }) => showAll || !NOISE_EVENTS.has(stage.event))
    .map((row, i, arr) => ({ ...row, showDay: i === 0 || dayKey(row.d) !== dayKey(arr[i - 1].d) }));

  return (
    <div className="mt-wrap">
      <ol className="mt-list">
        {visible.map(({ stage, idx, d, showDay }) => {
          const Icon = STAGE_ICONS[stage.event] || STAGE_ICONS[stage.to_stage] || FiFileText;
          const isCurrent = idx === currentIdx;
          const isEvent = Boolean(stage.event);
          const tone = (isEvent ? EVENT_TONE[stage.event] : STAGE_TONE[stage.to_stage]) || (isEvent ? 'muted' : 'info');
          return (
            <li key={stage.id || idx} className="mt-row">
              {showDay && (
                <div className="mt-day" role="presentation">
                  <span className="mt-day-label">{formatDay(d) || '—'}</span>
                </div>
              )}
              <div
                className={`mt-item mt-tone-${tone}${isCurrent ? ' mt-item-current' : ''}${isEvent ? ' mt-item-event' : ''}`}
              >
                <div className="mt-icon"><Icon aria-hidden="true" /></div>
                <div className="mt-body">
                  <div className="mt-head">
                    <span className="mt-stage">{stage.stage_label || stage.to_stage}</span>
                    {isCurrent && <span className="mt-current-badge">Étape actuelle</span>}
                  </div>
                  <div className="mt-meta">
                    {stage.actor_label && (
                      <span className="mt-actor">
                        <span className="mt-avatar" aria-hidden="true">{initials(stage.actor_label)}</span>
                        {stage.actor_label}
                      </span>
                    )}
                    {stage.actor_role && <span className="mt-role">{stage.actor_role}</span>}
                    {d && <time className="mt-date" dateTime={d.toISOString()} title={formatFull(d)}>{formatTime(d)}</time>}
                  </div>
                  {stage.note && <div className="mt-note">{stage.note}</div>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {showFullJournalToggle && hiddenCount > 0 && (
        <button type="button" className="mt-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? <FiEyeOff aria-hidden="true" /> : <FiEye aria-hidden="true" />}
          {showAll
            ? 'Masquer les événements techniques'
            : `Journal complet (${hiddenCount} événement${hiddenCount > 1 ? 's' : ''} technique${hiddenCount > 1 ? 's' : ''})`}
        </button>
      )}
    </div>
  );
}
