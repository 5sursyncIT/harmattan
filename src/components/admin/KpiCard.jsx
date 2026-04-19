import { FiTrendingUp, FiTrendingDown, FiMinus } from 'react-icons/fi';

function formatValue(value, format) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const n = Number(value);

  if (format === 'currency') {
    if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2).replace('.', ',') + ' Md';
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',') + ' M';
    if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + ' k';
    return Math.round(n).toLocaleString('fr-FR');
  }

  if (format === 'percent') return n.toFixed(1).replace('.', ',') + ' %';

  // number
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',') + ' M';
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + ' k';
  return Math.round(n).toLocaleString('fr-FR');
}

export default function KpiCard({
  icon,
  label,
  value,
  format = 'number',
  suffix,
  trend,
  trendLabel,
  sub,
  color = 'green',
}) {
  const formatted = formatValue(value, format);
  const hasTrend = typeof trend === 'number' && !Number.isNaN(trend);
  const trendPositive = hasTrend && trend > 0.1;
  const trendNegative = hasTrend && trend < -0.1;
  const trendNeutral = hasTrend && !trendPositive && !trendNegative;

  return (
    <div className={`kpi-card kpi-${color}`}>
      <div className="kpi-head">
        {icon && <span className="kpi-icon">{icon}</span>}
        <span className="kpi-label">{label}</span>
      </div>
      <div className="kpi-value-row">
        <span className="kpi-value">
          {formatted}
          {suffix && <span className="kpi-suffix"> {suffix}</span>}
        </span>
        {hasTrend && (
          <span
            className={`kpi-trend ${
              trendPositive ? 'up' : trendNegative ? 'down' : 'neutral'
            }`}
          >
            {trendPositive && <FiTrendingUp size={12} />}
            {trendNegative && <FiTrendingDown size={12} />}
            {trendNeutral && <FiMinus size={12} />}
            {Math.abs(trend).toFixed(1).replace('.', ',')}%
          </span>
        )}
      </div>
      {(sub || trendLabel) && (
        <div className="kpi-sub">
          {sub}
          {trendLabel && <span className="kpi-trend-label"> {trendLabel}</span>}
        </div>
      )}
    </div>
  );
}
