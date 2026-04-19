import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Area, AreaChart } from 'recharts';

function formatDateShort(d) {
  if (!d) return '';
  const [, m, day] = String(d).split('-');
  return `${day}/${m}`;
}

function formatCompactFCFA(v) {
  const n = Number(v);
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',') + ' M';
  if (Math.abs(n) >= 10_000) return Math.round(n / 1000) + ' k';
  return n.toLocaleString('fr-FR');
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <strong>{row.date}</strong>
      <div>CA : <b>{Math.round(row.revenue).toLocaleString('fr-FR')} F</b></div>
      <div>Factures : {row.count}</div>
    </div>
  );
}

export default function RevenueChart({ data = [] }) {
  if (!data.length) {
    return <div className="chart-empty">Aucune donnée sur les 30 derniers jours</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10531a" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#10531a" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatDateShort}
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={{ stroke: '#e5e7eb' }}
          tickLine={false}
        />
        <YAxis
          tickFormatter={formatCompactFCFA}
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false}
          tickLine={false}
          width={50}
        />
        <Tooltip content={<CustomTooltip />} />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="#10531a"
          strokeWidth={2}
          fill="url(#revenueFill)"
          activeDot={{ r: 5, fill: '#10531a', stroke: '#fff', strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
