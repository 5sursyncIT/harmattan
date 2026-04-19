import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';

const COLORS = {
  'POS': '#10531a',
  'E-commerce': '#f97316',
  'Facturation directe': '#0284c7',
  'default': '#9ca3af',
};

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="chart-tooltip">
      <strong>{row.label}</strong>
      <div>{Math.round(row.revenue).toLocaleString('fr-FR')} F</div>
      <div>{row.count} facture{row.count > 1 ? 's' : ''}</div>
    </div>
  );
}

export default function ChannelsPie({ data = [] }) {
  if (!data.length) {
    return <div className="chart-empty">Aucune donnée sur 30 jours</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie
          data={data}
          dataKey="revenue"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={90}
          paddingAngle={2}
        >
          {data.map((entry, i) => (
            <Cell key={i} fill={COLORS[entry.label] || COLORS.default} />
          ))}
        </Pie>
        <Tooltip content={<CustomTooltip />} />
        <Legend
          iconType="circle"
          wrapperStyle={{ fontSize: '0.82rem', paddingTop: 10 }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
