import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiList } from 'react-icons/fi';
import { getLedger, exportAccounting } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function yearStart() { return `${new Date().getFullYear()}-01-01`; }
function today() { return new Date().toISOString().split('T')[0]; }

const JOURNALS = [
  { code: '', label: 'Tous les journaux' },
  { code: 'VT', label: 'VT — Ventes' },
  { code: 'AC', label: 'AC — Achats' },
  { code: 'BQ', label: 'BQ — Banque' },
  { code: 'OD', label: 'OD — Opérations diverses' },
];

export default function AccountingLedger() {
  const [data, setData] = useState({ entries: [], totals: {}, opening: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    date_from: yearStart(), date_to: today(), account: '', journal: '', page: 1,
  });

  useEffect(() => {
    let cancelled = false;
    getLedger(filters)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (k, v) => { setLoading(true); setFilters(f => ({ ...f, [k]: v, page: 1 })); };
  const changePage = (p) => { setLoading(true); setFilters(f => ({ ...f, page: p })); };

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('ledger', { date_from: filters.date_from, date_to: filters.date_to });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `grand-livre-${filters.date_from}-${filters.date_to}.csv`; a.click();
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
            <FiList /> Grand livre ({data.totals.nb || 0} lignes)
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
          <label className="ac-filter-label">Compte</label>
          <input type="text" className="ac-filter-input" value={filters.account} onChange={e => update('account', e.target.value)} placeholder="ex: 411, 70..." />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Journal</label>
          <select className="ac-filter-select" value={filters.journal} onChange={e => update('journal', e.target.value)}>
            {JOURNALS.map(j => <option key={j.code} value={j.code}>{j.label}</option>)}
          </select>
        </div>
      </div>

      {!loading && filters.account && (
        <div className="ac-info-box">
          Report à nouveau du compte <strong>{filters.account}</strong> au {fmtDate(filters.date_from)} :
          <strong> {formatPrice(data.opening)}</strong> ({data.opening >= 0 ? 'débiteur' : 'créditeur'})
        </div>
      )}

      {loading ? <Loader /> : (
        <>
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Date</th><th>Pièce</th><th>Journal</th><th>Compte</th>
                  <th>Libellé</th><th>Tiers</th>
                  <th className="ac-amount">Débit</th><th className="ac-amount">Crédit</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map(e => (
                  <tr key={e.id}>
                    <td className="ac-date">{fmtDate(e.date)}</td>
                    <td className="ac-ref">#{e.piece}</td>
                    <td><span className="ac-badge ac-badge-draft">{e.journal}</span></td>
                    <td className="ac-ref" title={e.account_label}>{e.account}</td>
                    <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.label}{e.is_manual && <span style={{ color: '#7c3aed', fontSize: '0.7rem', marginLeft: 6 }}>OD</span>}
                    </td>
                    <td style={{ fontSize: '0.8rem', color: '#64748b' }}>{e.subledger || '—'}</td>
                    <td className="ac-amount">{e.debit ? formatPrice(e.debit) : '—'}</td>
                    <td className="ac-amount">{e.credit ? formatPrice(e.credit) : '—'}</td>
                  </tr>
                ))}
                {data.entries.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>
                    Aucune écriture. Lancez un transfert en comptabilité depuis l'onglet Écritures.
                  </td></tr>
                )}
              </tbody>
              {data.entries.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={6}>Totaux période</td>
                    <td className="ac-amount">{formatPrice(data.totals.debit)}</td>
                    <td className="ac-amount">{formatPrice(data.totals.credit)}</td>
                  </tr>
                </tfoot>
              )}
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
