function formatCompactFCFA(v) {
  const n = Number(v);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',') + ' M';
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + ' k';
  return n.toLocaleString('fr-FR');
}

export default function TopList({ title, items = [], labelKey = 'label', valueKey = 'revenue', unitsKey = 'units_sold', emptyLabel = 'Aucune donnée' }) {
  if (!items.length) {
    return (
      <div className="top-list">
        <h4>{title}</h4>
        <div className="top-empty">{emptyLabel}</div>
      </div>
    );
  }

  const maxValue = Math.max(...items.map((i) => Number(i[valueKey] || 0)));

  return (
    <div className="top-list">
      <h4>{title}</h4>
      <ul>
        {items.map((item, i) => {
          const value = Number(item[valueKey] || 0);
          const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
          return (
            <li key={i}>
              <div className="top-row">
                <span className="top-rank">#{i + 1}</span>
                <span className="top-label" title={item[labelKey]}>{item[labelKey] || '—'}</span>
                <span className="top-value">{formatCompactFCFA(value)} F</span>
              </div>
              <div className="top-bar-wrap">
                <div className="top-bar" style={{ width: `${pct}%` }} />
                {item[unitsKey] != null && (
                  <span className="top-units">{item[unitsKey]} u.</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
