import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiBook, FiDownload, FiInfo, FiX } from 'react-icons/fi';
import { getRoyalties, getRoyaltyDetails, exportAccounting } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

const MONTH_NAMES = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const CONTRACT_TYPES = {
  harmattan_2024: 'Harmattan 2024',
  harmattan_dll: 'Harmattan DLL',
  tamarinier: 'Le Tamarinier',
};

export default function AccountingRoyalties() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [filters, setFilters] = useState({
    year: new Date().getFullYear(),
    month: '',
    contract_type: '',
    author: '',
    threshold_mode: 'cumulative',
  });
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getRoyalties(filters)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => toast.error('Erreur chargement'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const handleExport = async () => {
    setExporting(true);
    try {
      const r = await exportAccounting('royalties', { year: filters.year, month: filters.month });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      a.download = `royalties-${filters.year}${filters.month ? '-' + filters.month : ''}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success('Export téléchargé');
    } catch { toast.error('Erreur export'); }
    finally { setExporting(false); }
  };

  const openDetail = async (row) => {
    setLoadingDetail(true);
    setDetail({ row, invoices: [] });
    try {
      const r = await getRoyaltyDetails(row.contract_id, { year: filters.year, month: filters.month });
      setDetail({ row, ...r.data });
    } catch { toast.error('Erreur détails'); }
    finally { setLoadingDetail(false); }
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiBook /> Royalties auteurs
          </h3>
        </div>
        <button onClick={handleExport} disabled={exporting} className="btn btn-outline">
          <FiDownload size={14} /> {exporting ? 'Export...' : 'Export CSV'}
        </button>
      </div>

      <div className="ac-info-box">
        <FiInfo size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
        <strong>Formule : </strong>
        royalty = (unités vendues − seuil − exemplaires gratuits) × prix moyen HT × taux % — chiffres indicatifs pour règlement trimestriel, à valider.
      </div>

      {/* Filtres période */}
      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Année</label>
          <select className="ac-filter-select" value={filters.year} onChange={e => update('year', parseInt(e.target.value))}>
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Mois</label>
          <select className="ac-filter-select" value={filters.month} onChange={e => update('month', e.target.value)}>
            <option value="">Toute l'année</option>
            {MONTH_NAMES.map((n, i) => <option key={i + 1} value={i + 1}>{n}</option>)}
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Type contrat</label>
          <select className="ac-filter-select" value={filters.contract_type} onChange={e => update('contract_type', e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(CONTRACT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Seuil</label>
          <select className="ac-filter-select" value={filters.threshold_mode} onChange={e => update('threshold_mode', e.target.value)}>
            <option value="cumulative">Cumulatif (depuis publication)</option>
            <option value="period">Par période</option>
          </select>
        </div>
        <div className="ac-filter-group" style={{ flex: 2, minWidth: 180 }}>
          <label className="ac-filter-label">Auteur</label>
          <input type="text" className="ac-filter-input" value={filters.author} onChange={e => update('author', e.target.value)} placeholder="Rechercher..." />
        </div>
      </div>

      {loading ? <Loader /> : data && (
        <>
          {/* Résumé */}
          <div className="ac-kpi-grid">
            <div className="ac-kpi primary">
              <div className="ac-kpi-label">Auteurs concernés</div>
              <div className="ac-kpi-value">{data.summary.nb_authors}</div>
              <div className="ac-kpi-sub">{data.summary.nb_contracts} contrats</div>
            </div>
            <div className="ac-kpi info">
              <div className="ac-kpi-label">Unités vendues</div>
              <div className="ac-kpi-value">{data.summary.total_units_sold.toLocaleString('fr-FR')}</div>
              <div className="ac-kpi-sub">sur la période</div>
            </div>
            <div className="ac-kpi success">
              <div className="ac-kpi-label">Royalties dues</div>
              <div className="ac-kpi-value" style={{ color: '#10531a' }}>{formatPrice(data.summary.total_royalties_due)}</div>
              <div className="ac-kpi-sub">à verser aux auteurs</div>
            </div>
            <div className="ac-kpi warning">
              <div className="ac-kpi-label">Sans ventes</div>
              <div className="ac-kpi-value">{data.summary.nb_contracts_without_sales}</div>
              <div className="ac-kpi-sub">contrats sans vente</div>
            </div>
          </div>

          {data.summary.nb_contracts_without_isbn > 0 && (
            <div className="ac-warning-box">
              <strong>{data.summary.nb_contracts_without_isbn} contrat(s) sans ISBN</strong> — impossibles à rapprocher aux ventes. Renseignez l'ISBN du livre dans le contrat pour les inclure.
            </div>
          )}

          {/* Table */}
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Contrat</th><th>Auteur</th><th>Ouvrage</th>
                  <th className="ac-amount">Taux</th>
                  <th className="ac-amount">Seuil</th>
                  <th className="ac-amount">Vendus</th>
                  <th className="ac-amount">Au-dessus</th>
                  <th className="ac-amount">CA HT</th>
                  <th className="ac-amount">Royalty due</th>
                </tr>
              </thead>
              <tbody>
                {data.royalties.map(r => (
                  <tr key={r.contract_id} onClick={() => openDetail(r)} style={{ cursor: 'pointer' }}>
                    <td className="ac-ref">{r.contract_ref}</td>
                    <td style={{ fontWeight: 600 }}>{r.author_name}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{r.book_title}</td>
                    <td className="ac-amount">{r.royalty_rate}%</td>
                    <td className="ac-amount" style={{ color: '#64748b' }}>{r.threshold}</td>
                    <td className="ac-amount">{r.units_sold}</td>
                    <td className="ac-amount" style={{ fontWeight: 700, color: r.units_over_threshold > 0 ? '#10531a' : '#94a3b8' }}>{r.units_over_threshold}</td>
                    <td className="ac-amount">{formatPrice(r.gross_ht)}</td>
                    <td className="ac-amount ac-royalty-due">{formatPrice(r.royalty_due)}</td>
                  </tr>
                ))}
                {data.royalties.length === 0 && (
                  <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucune vente sur la période pour les contrats actifs</td></tr>
                )}
              </tbody>
              {data.royalties.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'right' }}>Total royalties dues :</td>
                    <td className="ac-amount" style={{ fontSize: '1.1rem' }}>{formatPrice(data.summary.total_royalties_due)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}

      {/* Modal détail contrat */}
      {detail && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
             onClick={() => setDetail(null)}>
          <div style={{ background: '#fff', borderRadius: 14, maxWidth: 800, width: '100%', maxHeight: '85vh', overflow: 'auto', padding: 24 }}
               onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>Détail des ventes</h3>
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><FiX size={20} /></button>
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontWeight: 700 }}>{detail.row.book_title}</div>
              <div style={{ fontSize: '0.85rem', color: '#64748b' }}>
                {detail.row.author_name} · Contrat {detail.row.contract_ref} · ISBN {detail.row.book_isbn}
              </div>
            </div>
            {loadingDetail ? <Loader /> : detail.invoices?.length > 0 ? (
              <div className="ac-table-wrap">
                <table className="ac-table">
                  <thead><tr><th>Date</th><th>Facture</th><th>Client</th><th className="ac-amount">Qté</th><th className="ac-amount">Prix U.</th><th className="ac-amount">Total HT</th></tr></thead>
                  <tbody>
                    {detail.invoices.map(inv => (
                      <tr key={inv.id}>
                        <td className="ac-date">{fmtDate(inv.date)}</td>
                        <td className="ac-ref">{inv.ref}</td>
                        <td style={{ fontSize: '0.82rem' }}>{inv.customer || '—'}</td>
                        <td className="ac-amount">{inv.qty}</td>
                        <td className="ac-amount">{formatPrice(inv.subprice)}</td>
                        <td className="ac-amount" style={{ fontWeight: 700 }}>{formatPrice(inv.total_ht)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p style={{ textAlign: 'center', color: '#94a3b8' }}>Aucune vente</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
