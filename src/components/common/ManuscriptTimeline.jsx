import { FiCheck, FiClock, FiFileText, FiAlertTriangle } from 'react-icons/fi';
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

  return (
    <ol className="mt-list">
      {stages.map((stage, idx) => {
        const Icon = STAGE_ICONS[stage.to_stage] || FiFileText;
        const isLast = idx === stages.length - 1;
        return (
          <li key={stage.id || idx} className={`mt-item${isLast ? ' mt-item-current' : ''}`}>
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
