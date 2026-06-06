import { FiCheck, FiClock, FiFileText, FiAlertTriangle, FiSend, FiMail, FiTrash2, FiDollarSign } from 'react-icons/fi';
import './ManuscriptTimeline.css';

const STAGE_ICONS = {
  submitted: FiFileText,
  in_evaluation: FiClock,
  evaluation_positive: FiCheck,
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
  quote_deleted: FiTrash2,
  contract_doc_sent: FiMail,
};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function ManuscriptTimeline({ stages = [] }) {
  if (!stages.length) {
    return <p className="mt-empty">Aucun événement pour le moment.</p>;
  }

  // Le repère « étape courante » suit la dernière VRAIE transition de stage,
  // pas le dernier évènement informatif (devis, contrat envoyé…) qui peut
  // survenir après coup sans faire avancer le workflow.
  let currentIdx = -1;
  for (let i = stages.length - 1; i >= 0; i--) {
    if (!stages[i].event) { currentIdx = i; break; }
  }

  return (
    <ol className="mt-list">
      {stages.map((stage, idx) => {
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
  );
}
