import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiBarChart2 } from 'react-icons/fi';
import { getBalance, exportAccounting } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function yearStart() { return `${new Date().getFullYear()}-01-01`; }
function today() { return new Date().toISOString().split('T')[0]; }

const CLASSES = [
  { id: '', label: 'Toutes' },
  { id: '1', label: '1 — Ressources' },
  { id: '2', label: '2 — Immobilisations' },
  { id: '3', label: '3 — Stocks' },
  { id: '4', label: '4 — Tiers' },
  { id: '5', label: '5 — Trésorerie' },
  { id: '6', label: '6 — Charges' },
  { id: '7', label: '7 — Produits' },
];

export default function AccountingBalance() {
  const [data, setData] = useState({ accounts: [], totals: {} });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({ date_from: yearStart(), date_to: today(), account_class: '' });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getBalance(filters)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('balance', { date_from: filters.date_from, date_to: filters.date_to });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `balance-${filters.date_from}-${filters.date_to}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Export téléchargé');
    } catch { toast.error('Erreur export'); }
    finally { setExporting(false); }
  };

  const t = data.totals || {};

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiBarChart2 /> Balance générale ({data.accounts.length} comptes)
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
          <label className="ac-filter-label">Classe</label>
          <select className="ac-filter-select" value={filters.account_class} onChange={e => update('account_class', e.target.value)}>
            {CLASSES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
      </div>

      {loading ? <Loader /> : (
        <div className="ac-table-wrap">
          <table className="ac-table">
            <thead>
              <tr>
                <th>Compte</th><th>Libellé</th>
                <th className="ac-amount">Report</th>
                <th className="ac-amount">Débit période</th>
                <th className="ac-amount">Crédit période</th>
                <th className="ac-amount">Solde débiteur</th>
                <th className="ac-amount">Solde créditeur</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map(a => (
                <tr key={a.number}>
                  <td className="ac-ref">{a.number}</td>
                  <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label}</td>
                  <td className="ac-amount" style={{ color: '#94a3b8' }}>{a.opening ? formatPrice(a.opening) : '—'}</td>
                  <td className="ac-amount">{a.period_debit ? formatPrice(a.period_debit) : '—'}</td>
                  <td className="ac-amount">{a.period_credit ? formatPrice(a.period_credit) : '—'}</td>
                  <td className="ac-amount" style={{ fontWeight: 700, color: '#0f172a' }}>{a.solde_debit ? formatPrice(a.solde_debit) : '—'}</td>
                  <td className="ac-amount" style={{ fontWeight: 700, color: '#0f172a' }}>{a.solde_credit ? formatPrice(a.solde_credit) : '—'}</td>
                </tr>
              ))}
              {data.accounts.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucun mouvement sur la période</td></tr>
              )}
            </tbody>
            {data.accounts.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={3}>Totaux</td>
                  <td className="ac-amount">{formatPrice(t.period_debit)}</td>
                  <td className="ac-amount">{formatPrice(t.period_credit)}</td>
                  <td className="ac-amount">{formatPrice(t.solde_debit)}</td>
                  <td className="ac-amount">{formatPrice(t.solde_credit)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
