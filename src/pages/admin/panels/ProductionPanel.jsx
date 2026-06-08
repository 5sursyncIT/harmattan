import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getNotificationCounts } from '../../../api/admin';
import EditorialPanel from './EditorialPanel';
import CoversPanel from './CoversPanel';
import './ManuscriptsWorkflow.css';

// Espace unifié « Production éditoriale » : un seul écran à onglets regroupant la
// validation éditoriale et la conception des couvertures (BAT). Remplace les deux
// items de menu « Éditorial » et « Couvertures ».
const TABS = [
  { key: 'editorial', label: 'Éditorial', badgeKey: 'editorial' },
  { key: 'covers', label: 'Couvertures', badgeKey: 'covers' },
];

export default function ProductionPanel() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const active = TABS.some((t) => t.key === requested) ? requested : 'editorial';
  const [counts, setCounts] = useState({});

  useEffect(() => {
    getNotificationCounts().then((r) => setCounts(r.data || {})).catch(() => {});
  }, []);

  return (
    <div className="ms-panel">
      <h2>Production éditoriale</h2>
      <p className="ms-subtitle">Validation éditoriale et conception des couvertures — pipeline de production unifié.</p>

      <div className="ms-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            className={`ms-tab ${active === t.key ? 'ms-tab-active' : ''}`}
            onClick={() => setParams({ tab: t.key }, { replace: true })}
          >
            {t.label}
            {counts[t.badgeKey] > 0 && <span className="ms-tab-badge">{counts[t.badgeKey]}</span>}
          </button>
        ))}
      </div>

      <div className="ms-tab-body">
        {active === 'editorial' ? <EditorialPanel /> : <CoversPanel />}
      </div>
    </div>
  );
}
