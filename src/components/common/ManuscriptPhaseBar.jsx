import { FiUpload, FiSearch, FiEdit3, FiFileText, FiBookOpen, FiImage, FiPrinter, FiSend, FiFlag, FiCheck, FiX } from 'react-icons/fi';
import './ManuscriptPhaseBar.css';

/**
 * Frise « résumé » horizontale du parcours d'un manuscrit : les 19 stages de la
 * machine à états regroupés en 9 phases majeures, du dépôt à la parution.
 * Complète la frise détaillée (ManuscriptTimeline) sans la remplacer.
 *
 * Props :
 *  - currentStage : manuscripts.current_stage
 *  - stageLabel   : libellé précis du stage courant (affiché sous la phase active)
 *  - history      : entrées de manuscript_stages (pour dater l'entrée dans chaque phase)
 */
const PHASES = [
  { key: 'depot', label: 'Dépôt', icon: FiUpload, stages: ['submitted'] },
  { key: 'evaluation', label: 'Évaluation', icon: FiSearch, stages: ['in_evaluation', 'evaluation_rework', 'evaluation_negative', 'evaluation_positive'] },
  { key: 'contrat', label: 'Contrat', icon: FiEdit3, stages: ['contract_pending', 'contract_signed', 'payment_pending'] },
  { key: 'correction', label: 'Correction', icon: FiFileText, stages: ['in_correction', 'correction_author_review'] },
  { key: 'editorial', label: 'Éditorial', icon: FiBookOpen, stages: ['in_editorial', 'editorial_validated'] },
  { key: 'couverture', label: 'Couverture', icon: FiImage, stages: ['cover_design', 'bat_author_review'] },
  { key: 'impression', label: 'Impression', icon: FiPrinter, stages: ['print_preparation', 'printing', 'printed'] },
  { key: 'communication', label: 'Communication', icon: FiSend, stages: ['in_communication'] },
  { key: 'parution', label: 'Parution', icon: FiFlag, stages: ['published'] },
];

function fmtShort(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ManuscriptPhaseBar({ currentStage, stageLabel, history = [] }) {
  const currentPhaseIdx = PHASES.findIndex((p) => p.stages.includes(currentStage));
  if (currentPhaseIdx === -1) return null;

  const rejected = currentStage === 'evaluation_negative';
  const finished = currentStage === 'published';

  // Date d'entrée dans chaque phase : première vraie transition (event NULL)
  // vers l'un de ses stages.
  const entryDate = (phase) => {
    const hit = history.find((s) => !s.event && phase.stages.includes(s.to_stage));
    return hit ? fmtShort(hit.created_at) : null;
  };

  return (
    <div className="mpb-card" role="group" aria-label="Parcours du manuscrit (résumé)">
      <ol className="mpb">
        {PHASES.map((phase, i) => {
          let state; // done | current | upcoming | danger | off
          if (rejected) {
            state = i < currentPhaseIdx ? 'done' : i === currentPhaseIdx ? 'danger' : 'off';
          } else if (finished) {
            state = 'done';
          } else {
            state = i < currentPhaseIdx ? 'done' : i === currentPhaseIdx ? 'current' : 'upcoming';
          }
          const isCurrent = i === currentPhaseIdx;
          const Icon = state === 'done' && !isCurrent ? FiCheck : state === 'danger' ? FiX : phase.icon;
          const sub = isCurrent
            ? (rejected ? 'Rejeté' : stageLabel || entryDate(phase))
            : state === 'done' ? entryDate(phase) : null;
          return (
            <li
              key={phase.key}
              className={`mpb-phase mpb-${state}${isCurrent ? ' mpb-here' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="mpb-node"><Icon aria-hidden="true" /></span>
              <span className="mpb-label">{phase.label}</span>
              <span className="mpb-sub">{sub || ' '}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
