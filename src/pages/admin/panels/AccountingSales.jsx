import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiFileText } from 'react-icons/fi';
import { getSalesJournal, exportAccounting } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function firstDayOfMonth() {
  const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0];
}
function today() { return new Date().toISOString().split('T')[0]; }

export default function AccountingSales() {
  const [data, setData] = useState({ invoices: [], totals: {}, total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    date_from: firstDayOfMonth(),
    date_to: today(),
    status: '',
    channel: '',
    customer: '',
    page: 1,
  });
  useEffect(() => {
    let cancelled = false;
    getSalesJournal(filters)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (k, v) => { setLoading(true); setFilters(f => ({ ...f, [k]: v, page: 1 })); };
  const changePage = (p) => { setLoading(true); setFilters(f => ({ ...f, page: p })); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('sales', { date_from: filters.date_from, date_to: filters.date_to });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `ventes-${filters.date_from}-${filters.date_to}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Export téléchargé');
    } catch { toast.error('Erreur export'); }
    finally { setExporting(false); }
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiFileText /> Journal des ventes ({data.total})
          </h3>
        </div>
        <button onClick={handleExport} disabled={exporting} className="btn btn-outline">
          <FiDownload size={14} /> {exporting ? 'Export...' : 'Export CSV'}
        </button>
      </div>

      {/* Filtres */}
      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Du</label>
          <input type="date" className="ac-filter-input" value={filters.date_from} onChange={e => update('date_from', e.target.value)} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Au</label>
          <input type="date" className="ac-filter-input" value={filters.date_to} onChange={e => update('date_to', e.target.value)} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Statut</label>
          <select className="ac-filter-select" value={filters.status} onChange={e => update('status', e.target.value)}>
            <option value="">Tous</option>
            <option value="paye">Payées</option>
            <option value="impaye">Impayées</option>
            <option value="1">Validées</option>
            <option value="0">Brouillon</option>
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Canal</label>
          <select className="ac-filter-select" value={filters.channel} onChange={e => update('channel', e.target.value)}>
            <option value="">Tous</option>
            <option value="takepos">POS</option>
            <option value="web">E-commerce</option>
          </select>
        </div>
        <div className="ac-filter-group" style={{ flex: 2, minWidth: 200 }}>
          <label className="ac-filter-label">Client</label>
          <input type="text" className="ac-filter-input" value={filters.customer} onChange={e => update('customer', e.target.value)} placeholder="Rechercher..." />
        </div>
      </div>

      {/* Totaux du filtre */}
      {!loading && data.totals && (
        <div className="ac-breakdown">
          <div className="ac-breakdown-item">Total HT <strong>{formatPrice(data.totals.sum_ht)}</strong></div>
          <div className="ac-breakdown-item">Total TTC <strong>{formatPrice(data.totals.sum_ttc)}</strong></div>
          <div className="ac-breakdown-item" style={{ background: '#f0fdf4' }}>Encaissé <strong style={{ color: '#10531a' }}>{formatPrice(data.totals.sum_paid)}</strong></div>
          <div className="ac-breakdown-item" style={{ background: '#fef2f2' }}>Reste dû <strong style={{ color: '#dc2626' }}>{formatPrice(data.totals.sum_remaining)}</strong></div>
        </div>
      )}

      {loading ? <Loader /> : (
        <>
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Date</th><th>Référence</th><th>Client</th><th>Canal</th>
                  <th className="ac-amount">HT</th>
                  <th className="ac-amount">TTC</th>
                  <th className="ac-amount">Encaissé</th>
                  <th className="ac-amount">Reste</th>
                  <th>Statut</th><th>Échéance</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map(inv => (
                  <tr key={inv.id}>
                    <td className="ac-date">{fmtDate(inv.date)}</td>
                    <td className="ac-ref">{inv.ref}</td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.customer || '—'}</td>
                    <td style={{ fontSize: '0.78rem', color: '#64748b' }}>{inv.channel_label}</td>
                    <td className="ac-amount">{formatPrice(inv.total_ht)}</td>
                    <td className="ac-amount" style={{ fontWeight: 700 }}>{formatPrice(inv.total_ttc)}</td>
                    <td className="ac-amount" style={{ color: '#10531a' }}>{formatPrice(inv.paid)}</td>
                    <td className="ac-amount" style={{ color: inv.remaining > 0 ? '#dc2626' : '#94a3b8', fontWeight: 700 }}>{formatPrice(inv.remaining)}</td>
                    <td><span className={`ac-badge ${inv.is_paid ? 'ac-badge-paid' : 'ac-badge-unpaid'}`}>{inv.status_label}</span></td>
                    <td className="ac-date">{fmtDate(inv.date_due)}</td>
                  </tr>
                ))}
                {data.invoices.length === 0 && (
                  <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucune facture sur cette période</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="ac-pagination">
              <button className="ac-page-btn" disabled={filters.page <= 1} onClick={() => changePage(filters.page - 1)}>‹</button>
              <span className="ac-page-info">Page {filters.page} / {data.pages}</span>
              <button className="ac-page-btn" disabled={filters.page >= data.pages} onClick={() => changePage(filters.page + 1)}>›</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
