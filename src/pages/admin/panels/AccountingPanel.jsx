import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiDollarSign, FiTrendingUp, FiAlertCircle, FiBriefcase, FiUsers, FiBook, FiFileText, FiCreditCard } from 'react-icons/fi';
import { getAccountingDashboard } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import './Accounting.css';

function KPI({ variant, label, value, sub, icon }) {
  return (
    <div className={`ac-kpi ${variant}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="ac-kpi-label">{label}</div>
        {icon && <div style={{ opacity: 0.5 }}>{icon}</div>}
      </div>
      <div className="ac-kpi-value">{value}</div>
      {sub && <div className="ac-kpi-sub">{sub}</div>}
    </div>
  );
}

function Tile({ to, icon, iconBg, iconColor, title, subtitle, metric }) {
  return (
    <Link to={to} className="ac-tile">
      <div className="ac-tile-icon" style={{ background: iconBg, color: iconColor }}>{icon}</div>
      <div className="ac-tile-title">{title}</div>
      <div className="ac-tile-sub">{subtitle}</div>
      {metric && <div className="ac-tile-metric">{metric}</div>}
    </Link>
  );
}

export default function AccountingPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getAccountingDashboard()
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <Loader />;
  if (!data) return <p>Erreur chargement</p>;

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const fmtMonth = (m) => {
    const [y, mo] = m.split('-');
    const names = ['Janv', 'Fév', 'Mars', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sept', 'Oct', 'Nov', 'Déc'];
    return `${names[parseInt(mo) - 1]} ${y.slice(2)}`;
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiBriefcase /> Comptabilité
        </h3>
        <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
          Période : {fmtDate(data.period?.from)} → {fmtDate(data.period?.to)}
        </span>
      </div>

      {/* KPIs principaux */}
      <div className="ac-kpi-grid">
        <KPI variant="primary" icon={<FiTrendingUp size={16} />}
             label="CA mois (HT)" value={formatPrice(data.revenue.ht)}
             sub={`${data.revenue.count} factures — TTC: ${formatPrice(data.revenue.ttc)}`} />
        <KPI variant="success" icon={<FiDollarSign size={16} />}
             label="Encaissements mois" value={formatPrice(data.cash_in.total)}
             sub={`${data.cash_in.count} paiements`} />
        <KPI variant="danger" icon={<FiAlertCircle size={16} />}
             label="Créances totales" value={formatPrice(data.receivables.outstanding)}
             sub={`${data.receivables.count} factures impayées`} />
        <KPI variant="info" icon={<FiCreditCard size={16} />}
             label="Trésorerie totale" value={formatPrice(data.treasury.total)}
             sub={`${data.treasury.accounts} comptes actifs`} />
      </div>

      {/* Tuiles de navigation */}
      <div className="ac-tiles">
        <Tile to="/admin/accounting/sales" icon={<FiFileText size={20} />} iconBg="#dbeafe" iconColor="#1e40af"
              title="Journal des ventes" subtitle="Factures émises avec statut paiement"
              metric={`${data.revenue.count} factures ce mois`} />
        <Tile to="/admin/accounting/payments" icon={<FiDollarSign size={20} />} iconBg="#dcfce7" iconColor="#14532d"
              title="Journal des encaissements" subtitle="Paiements reçus par méthode"
              metric={`${data.cash_in.count} paiements ce mois`} />
        <Tile to="/admin/accounting/receivables" icon={<FiAlertCircle size={20} />} iconBg="#fee2e2" iconColor="#991b1b"
              title="Balance âgée" subtitle="Créances clients par ancienneté"
              metric={formatPrice(data.receivables.outstanding)} />
        <Tile to="/admin/accounting/treasury" icon={<FiCreditCard size={20} />} iconBg="#dbeafe" iconColor="#1e40af"
              title="Trésorerie" subtitle="Soldes bancaires consolidés"
              metric={formatPrice(data.treasury.total)} />
        <Tile to="/admin/accounting/royalties" icon={<FiBook size={20} />} iconBg="#ede9fe" iconColor="#6d28d9"
              title="Royalties auteurs" subtitle="Droits dus par contrat et période"
              metric="Calcul automatique" />
      </div>

      {/* Graphique CA vs Encaissements */}
      {data.monthly_series?.length > 0 && (
        <div className="admin-card" style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 12px' }}>CA vs Encaissements — 12 mois</h4>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.monthly_series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="month" tickFormatter={fmtMonth} tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000000)}M`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatPrice(v)} labelFormatter={fmtMonth} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="ca" stroke="#10531a" strokeWidth={2.5} name="CA TTC" dot={{ r: 3 }} />
              <Line type="monotone" dataKey="encaissements" stroke="#0284c7" strokeWidth={2.5} name="Encaissements" dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Dernières factures + paiements */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Dernières factures</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.recent_invoices.map(inv => (
              <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#f8fafc', borderRadius: 6, fontSize: '0.85rem' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{inv.ref}</div>
                  <div style={{ color: '#64748b', fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.customer || '—'}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700 }}>{formatPrice(inv.total_ttc)}</div>
                  <span className={`ac-badge ${inv.paye === 1 ? 'ac-badge-paid' : 'ac-badge-unpaid'}`}>
                    {inv.paye === 1 ? 'Payée' : 'Impayée'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="admin-card">
          <h4 style={{ margin: '0 0 12px' }}>Derniers encaissements</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.recent_payments.map(pay => (
              <div key={pay.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: '#f8fafc', borderRadius: 6, fontSize: '0.85rem' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{pay.ref || `Paiement #${pay.id}`}</div>
                  <div style={{ color: '#64748b', fontSize: '0.78rem' }}>{fmtDate(pay.datep)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, color: '#10531a' }}>{formatPrice(pay.amount)}</div>
                  <span className={`ac-method-pill ac-method-${pay.method_code || 'default'}`}>{pay.method_label}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
