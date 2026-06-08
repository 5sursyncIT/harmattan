import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiBook, FiDownload, FiFilePlus, FiInfo, FiX } from 'react-icons/fi';
import { getRoyalties, getRoyaltyDetails, exportAccounting, createRoyaltySupplierInvoices } from '../../../api/accounting';
import { getPendingIsbnContracts } from '../../../api/contracts';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import DolibarrLink from '../../../components/admin/DolibarrLink';
import { dolibarrUrls } from '../../../utils/dolibarrLinks';
import toast from 'react-hot-toast';
import './Accounting.css';
import { CONTRACT_TYPE_FILTER_GROUPS } from '../../../utils/contractTypes';

const MONTH_NAMES = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

export default function AccountingRoyalties() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [invoicing, setInvoicing] = useState(false);
  const [filters, setFilters] = useState({
    year: new Date().getFullYear(),
    month: '',
    contract_type: '',
    author: '',
    threshold_mode: 'cumulative',
  });
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Rappel : nombre de contrats validés sans ISBN — leurs ventes ne sont PAS
  // rattachées, donc leurs droits manquent au total affiché ici.
  const [pendingIsbn, setPendingIsbn] = useState(0);
  useEffect(() => { getPendingIsbnContracts().then(r => setPendingIsbn(r.data.count || 0)).catch(() => {}); }, []);

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

  const handleExport = async (journalType = 'royalties') => {
    setExporting(true);
    try {
      const r = await exportAccounting(journalType, filters);
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a'); a.href = url;
      const prefix = journalType === 'royalties_od' ? 'royalties-OD' : 'royalties';
      a.download = `${prefix}-${filters.year}${filters.month ? '-' + filters.month : ''}.csv`; a.click();
      URL.revokeObjectURL(url);
      toast.success(journalType === 'royalties_od'
        ? 'Export OD téléchargé — à utiliser seulement si aucune facture fournisseur n’est créée'
        : 'Export téléchargé');
    } catch { toast.error('Erreur export'); }
    finally { setExporting(false); }
  };

  const handleCreateSupplierInvoices = async () => {
    const total = data?.summary?.total_royalties_due || 0;
    if (!data?.royalties?.length || total <= 0) {
      toast.error('Aucune royalty à facturer sur la sélection');
      return;
    }
    const ok = window.confirm(
      `Créer les factures fournisseur auteur pour les royalties affichées (${formatPrice(total)}) ?\n\nLes factures déjà existantes seront ignorées. N'importez pas ensuite l'OD pour les mêmes montants.`
    );
    if (!ok) return;

    setInvoicing(true);
    try {
      const r = await createRoyaltySupplierInvoices(filters);
      const { created = [], skipped = [], errors = [] } = r.data || {};
      if (errors.length > 0) {
        toast.error(`${created.length} créée(s), ${skipped.length} déjà existante(s), ${errors.length} erreur(s)`);
      } else {
        toast.success(`${created.length} facture(s) créée(s), ${skipped.length} déjà existante(s)`);
      }
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erreur création factures royalties');
    } finally {
      setInvoicing(false);
    }
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <DolibarrLink href={dolibarrUrls.miscJournal()} title="Journal d'opérations diverses (OD)">Journal OD</DolibarrLink>
          <DolibarrLink href={dolibarrUrls.importAccounting()} variant="ghost" title="Importer un fichier d'écritures">Importer écritures</DolibarrLink>
          <button onClick={handleCreateSupplierInvoices} disabled={invoicing || loading || !data?.royalties?.length} className="btn btn-primary" title="Crée une facture fournisseur auteur par contrat, avec déduplication par référence fournisseur">
            <FiFilePlus size={14} /> {invoicing ? 'Création...' : 'Créer factures fournisseur'}
          </button>
          <button onClick={() => handleExport('royalties_od')} disabled={exporting} className="btn btn-outline" title="Export de contrôle / solution exceptionnelle. Ne pas importer si les factures fournisseur sont créées.">
            <FiDownload size={14} /> {exporting ? 'Préparation...' : 'Export OD'}
          </button>
          <button onClick={() => handleExport('royalties')} disabled={exporting} className="btn btn-outline">
            <FiDownload size={14} /> Export détaillé CSV
          </button>
        </div>
      </div>

      {pendingIsbn > 0 && (
        <div className="ac-info-box" style={{ background: '#fffbeb', borderColor: '#f59e0b', color: '#92400e', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiInfo size={16} />
            <strong>{pendingIsbn}</strong>&nbsp;contrat{pendingIsbn > 1 ? 's' : ''} validé{pendingIsbn > 1 ? 's' : ''} sans ISBN : leurs droits ne sont pas inclus dans ce total.
          </span>
          <Link to="/admin/contracts" className="btn btn-outline" style={{ borderColor: '#f59e0b', color: '#b45309' }}>
            Compléter les ISBN
          </Link>
        </div>
      )}

      <div className="ac-info-box">
        <FiInfo size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
        <strong>Formule : </strong>
        contrats classiques : droits sur les ventes au-delà du seuil. Contrats DLL : 15 % sur les
        1 000 premiers exemplaires subventionnés, puis 10 % au-delà. Les exemplaires gratuits et
        le service de presse ne sont jamais facturés : ils sont déjà hors du décompte des ventes.
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
            {CONTRACT_TYPE_FILTER_GROUPS.map(g => (
              <optgroup key={g.model} label={g.label}>
                {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </optgroup>
            ))}
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
                    <td className="ac-ref">
                      <a
                        href={dolibarrUrls.contract(r.contract_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Ouvrir le contrat dans Dolibarr"
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: '#10531a', textDecoration: 'none' }}
                      >{r.contract_ref}</a>
                    </td>
                    <td style={{ fontWeight: 600 }}>{r.author_name}</td>
                    <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{r.book_title}</td>
                    <td className="ac-amount">{r.royalty_rate_label || `${r.royalty_rate}%`}</td>
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
