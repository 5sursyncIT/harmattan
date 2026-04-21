import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiDollarSign } from 'react-icons/fi';
import { getPaymentsJournal, exportAccounting, getTreasury } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function firstDayOfMonth() { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0]; }
function today() { return new Date().toISOString().split('T')[0]; }

export default function AccountingPayments() {
  const [data, setData] = useState({ payments: [], totals: { by_method: [] }, total: 0, pages: 1 });
  const [banks, setBanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    date_from: firstDayOfMonth(),
    date_to: today(),
    method: '',
    bank_account: '',
    page: 1,
  });

  useEffect(() => { getTreasury().then(r => setBanks(r.data.accounts || [])).catch(() => {}); }, []);

  useEffect(() => {
    let cancelled = false;
    getPaymentsJournal(filters)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (k, v) => { setLoading(true); setFilters(f => ({ ...f, [k]: v, page: 1 })); };
  const changePage = (p) => { setLoading(true); setFilters(f => ({ ...f, page: p })); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('payments', { date_from: filters.date_from, date_to: filters.date_to });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `encaissements-${filters.date_from}-${filters.date_to}.csv`; a.click();
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
            <FiDollarSign /> Journal des encaissements ({data.total})
          </h3>
        </div>
        <button onClick={handleExport} disabled={exporting} className="btn btn-outline">
          <FiDownload size={14} /> {exporting ? 'Export...' : 'Export CSV'}
        </button>
      </div>

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
          <label className="ac-filter-label">Méthode</label>
          <select className="ac-filter-select" value={filters.method} onChange={e => update('method', e.target.value)}>
            <option value="">Toutes</option>
            <option value="LIQ">Espèces</option>
            <option value="CB">Carte bancaire</option>
            <option value="CHQ">Chèque</option>
            <option value="WAVE">Wave</option>
            <option value="OM">Orange Money</option>
            <option value="P5">Virement</option>
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Banque</label>
          <select className="ac-filter-select" value={filters.bank_account} onChange={e => update('bank_account', e.target.value)}>
            <option value="">Toutes</option>
            {banks.map(b => <option key={b.id} value={b.id}>{b.label || b.ref}</option>)}
          </select>
        </div>
      </div>

      {/* Breakdown par méthode */}
      {!loading && data.totals.by_method?.length > 0 && (
        <div className="ac-breakdown">
          <div className="ac-breakdown-item" style={{ background: '#f0fdf4' }}>
            <strong style={{ color: '#10531a' }}>{formatPrice(data.totals.sum_total)}</strong>Total
          </div>
          {data.totals.by_method.map(m => (
            <div key={m.method || 'none'} className="ac-breakdown-item">
              <strong>{formatPrice(m.total)}</strong>
              <span className={`ac-method-pill ac-method-${m.method || 'default'}`}>{m.label}</span> · {m.nb}
            </div>
          ))}
        </div>
      )}

      {loading ? <Loader /> : (
        <>
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Date</th><th>Référence</th><th>N° transaction</th>
                  <th className="ac-amount">Montant</th>
                  <th>Méthode</th><th>Banque</th>
                  <th>Factures imputées</th><th>Client(s)</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map(p => (
                  <tr key={p.id}>
                    <td className="ac-date">{fmtDate(p.date)}</td>
                    <td className="ac-ref">{p.ref || `#${p.id}`}</td>
                    <td style={{ fontSize: '0.78rem', color: '#64748b', fontFamily: 'monospace' }}>{p.num_payment || '—'}</td>
                    <td className="ac-amount" style={{ fontWeight: 700, color: '#10531a' }}>{formatPrice(p.amount)}</td>
                    <td><span className={`ac-method-pill ac-method-${p.method_code || 'default'}`}>{p.method_label}</span></td>
                    <td style={{ fontSize: '0.82rem' }}>{p.bank_label}</td>
                    <td style={{ fontSize: '0.78rem', fontFamily: 'monospace', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.allocations ? p.allocations.split(',').map(a => a.split('|')[0]).join(', ') : '—'}
                    </td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{p.customers || '—'}</td>
                  </tr>
                ))}
                {data.payments.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucun paiement sur cette période</td></tr>
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
