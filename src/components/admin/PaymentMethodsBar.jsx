import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';

const PAYMENT_COLORS = {
  LIQ: '#10531a',
  CB: '#0284c7',
  WAVE: '#7c3aed',
  OM: '#f97316',
  CHQ: '#64748b',
  P1: '#64748b',
  P5: '#0891b2',
  P16: '#0891b2',
  default: '#94a3b8',
};

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
      <strong>{row.label}</strong>
      <div>{Math.round(row.amount).toLocaleString('fr-FR')} F</div>
      <div>{row.count} transaction{row.count > 1 ? 's' : ''}</div>
    </div>
  );
}

export default function PaymentMethodsBar({ data = [] }) {
  if (!data.length) {
    return <div className="chart-empty">Aucun paiement enregistré sur 30 jours</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 10, right: 20, left: 0, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={formatCompactFCFA}
          tick={{ fontSize: 11, fill: '#6b7280' }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={{ fontSize: 11, fill: '#374151' }}
          axisLine={false}
          tickLine={false}
          width={100}
        />
        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.03)' }} />
        <Bar dataKey="amount" radius={[0, 6, 6, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={PAYMENT_COLORS[entry.code] || PAYMENT_COLORS.default} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
