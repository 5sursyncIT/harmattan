import { useState } from 'react';
import { FiCheck, FiClock, FiFileText, FiAlertTriangle, FiSend, FiMail, FiTrash2, FiDollarSign, FiCreditCard, FiDownload, FiUserPlus, FiUserMinus, FiUpload, FiHash, FiLink2, FiRefreshCw } from 'react-icons/fi';
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
  intervenant_assigned: FiUserPlus,
  intervenant_unassigned: FiUserMinus,
  file_uploaded: FiUpload,
  email_sent: FiMail,
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
]);

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
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
  const visible = stages
    .map((stage, idx) => ({ stage, idx }))
    .filter(({ stage }) => showAll || !NOISE_EVENTS.has(stage.event));

  return (
    <>
      <ol className="mt-list">
        {visible.map(({ stage, idx }) => {
          const Icon = STAGE_ICONS[stage.event] || STAGE_ICONS[stage.to_stage] || FiFileText;
          const isCurrent = idx === currentIdx;
          const isEvent = Boolean(stage.event);
          return (
            <li
              key={stage.id || idx}
              className={`mt-item${isCurrent ? ' mt-item-current' : ''}${isEvent ? ' mt-item-event' : ''}`}
            >
              <div className="mt-icon"><Icon aria-hidden="true" /></div>
              <div className="mt-body">
                <div className="mt-stage">{stage.stage_label || stage.to_stage}</div>
                <div className="mt-meta">
                  {stage.actor_label && <span>{stage.actor_label}</span>}
                  {stage.actor_role && <span className="mt-role">{stage.actor_role}</span>}
                  <span className="mt-date">{formatDate(stage.created_at)}</span>
                </div>
                {stage.note && <div className="mt-note">{stage.note}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {showFullJournalToggle && hiddenCount > 0 && (
        <button type="button" className="mt-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll
            ? 'Masquer les événements techniques'
            : `Afficher le journal complet (${hiddenCount} événement${hiddenCount > 1 ? 's' : ''} technique${hiddenCount > 1 ? 's' : ''})`}
        </button>
      )}
    </>
  );
}
