import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiAlertCircle } from 'react-icons/fi';
import { getReceivables, exportAccounting } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import './Accounting.css';

const BUCKET_LABELS = {
  current: 'Non échu',
  '0_30': '0-30 jours',
  '30_60': '30-60 jours',
  '60_90': '60-90 jours',
  '90_plus': '> 90 jours',
};
const BUCKET_COLORS = {
  current: '#10b981',
  '0_30': '#f59e0b',
  '30_60': '#f97316',
  '60_90': '#ea580c',
  '90_plus': '#dc2626',
};

export default function AccountingReceivables() {
  const [data, setData] = useState({ buckets: {}, rows: [], group_by: 'invoice', total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({ bucket: '', customer: '', group_by: 'invoice', page: 1 });

  useEffect(() => {
    let cancelled = false;
    getReceivables(filters)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (k, v) => { setLoading(true); setFilters(f => ({ ...f, [k]: v, page: 1 })); };
  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('receivables');
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `balance-agee-${new Date().toISOString().split('T')[0]}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Export téléchargé');
    } catch { toast.error('Erreur export'); }
    finally { setExporting(false); }
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  const chartData = Object.keys(BUCKET_LABELS).map(k => ({
    label: BUCKET_LABELS[k],
    value: data.buckets[k] || 0,
    color: BUCKET_COLORS[k],
  }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiAlertCircle /> Balance âgée
          </h3>
        </div>
        <button onClick={handleExport} disabled={exporting} className="btn btn-outline">
          <FiDownload size={14} /> {exporting ? 'Export...' : 'Export CSV'}
        </button>
      </div>

      {/* Tuiles buckets */}
      <div className="ac-bucket-grid">
        {Object.entries(BUCKET_LABELS).map(([key, label]) => (
          <div key={key} className={`ac-bucket ac-bucket-${key} ${filters.bucket === key ? 'active' : ''}`}
               onClick={() => update('bucket', filters.bucket === key ? '' : key)}>
            <div className="ac-bucket-label" style={{ color: BUCKET_COLORS[key] }}>{label}</div>
            <div className="ac-bucket-value">{formatPrice(data.buckets[key] || 0)}</div>
          </div>
        ))}
      </div>

      {/* Total + graphique */}
      {data.buckets.total > 0 && (
        <div className="admin-card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h4 style={{ margin: 0 }}>Répartition des créances</h4>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#dc2626' }}>
              Total : {formatPrice(data.buckets.total)} ({data.buckets.nb} factures)
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData}>
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => `${Math.round(v / 1000000)}M`} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v) => formatPrice(v)} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                {chartData.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Filtres + toggle */}
      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Groupement</label>
          <select className="ac-filter-select" value={filters.group_by} onChange={e => update('group_by', e.target.value)}>
            <option value="invoice">Par facture</option>
            <option value="customer">Par client</option>
          </select>
        </div>
        <div className="ac-filter-group" style={{ flex: 2, minWidth: 200 }}>
          <label className="ac-filter-label">Client</label>
          <input type="text" className="ac-filter-input" value={filters.customer} onChange={e => update('customer', e.target.value)} placeholder="Rechercher un client..." />
        </div>
      </div>

      {loading ? <Loader /> : (
        <div className="ac-table-wrap">
          <table className="ac-table">
            {filters.group_by === 'customer' ? (
              <>
                <thead>
                  <tr>
                    <th>Client</th><th>Email</th>
                    <th className="ac-amount">Factures</th>
                    <th className="ac-amount">Retard max (j)</th>
                    <th className="ac-amount">Montant dû</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.customer_id}>
                      <td style={{ fontWeight: 600 }}>{r.customer}</td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{r.email || '—'}</td>
                      <td className="ac-amount">{r.nb_invoices}</td>
                      <td className="ac-amount" style={{ color: r.max_days_overdue > 60 ? '#dc2626' : '#f59e0b', fontWeight: 700 }}>{r.max_days_overdue}</td>
                      <td className="ac-amount" style={{ fontWeight: 800, color: '#dc2626' }}>{formatPrice(r.total_due)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead>
                  <tr>
                    <th>Client</th><th>Facture</th><th>Émission</th><th>Échéance</th>
                    <th className="ac-amount">Jours retard</th>
                    <th className="ac-amount">Total</th>
                    <th className="ac-amount">Encaissé</th>
                    <th className="ac-amount">Dû</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.customer}</td>
                      <td className="ac-ref">{r.ref}</td>
                      <td className="ac-date">{fmtDate(r.date)}</td>
                      <td className="ac-date">{fmtDate(r.date_due)}</td>
                      <td className="ac-amount" style={{ color: r.days_overdue > 60 ? '#dc2626' : r.days_overdue > 0 ? '#f59e0b' : '#94a3b8', fontWeight: 700 }}>
                        {r.days_overdue > 0 ? `+${r.days_overdue}j` : '—'}
                      </td>
                      <td className="ac-amount">{formatPrice(r.total_ttc)}</td>
                      <td className="ac-amount" style={{ color: '#10531a' }}>{formatPrice(r.paid)}</td>
                      <td className="ac-amount" style={{ fontWeight: 800, color: '#dc2626' }}>{formatPrice(r.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
            {data.rows.length === 0 && (
              <tbody><tr><td colSpan={filters.group_by === 'customer' ? 5 : 8} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucune créance</td></tr></tbody>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
