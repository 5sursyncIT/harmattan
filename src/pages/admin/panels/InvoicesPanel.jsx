import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  FiFileText, FiDollarSign, FiRefreshCw, FiEdit, FiTrash2, FiUser,
  FiCornerUpLeft, FiX, FiAlertTriangle, FiList, FiCalendar, FiPrinter,
  FiDownload, FiSearch, FiPlusCircle, FiPlus, FiGift,
} from 'react-icons/fi';
import {
  listInvoices, getInvoice, getInvoicePdf, getInvoicesReport, getInvoiceBanks, searchInvoiceCustomers,
  payInvoice, createCreditNote, setInvoiceToDraft,
  reassignInvoiceCustomer, deleteInvoiceDraft,
  getCustomerCredits, createDeposit, applyCredit,
} from '../../../api/invoices';
import { formatPrice } from '../../../utils/formatters';
import {
  computeReportKpis, downloadInvoicesCsv, openInvoicesPdf,
  dailyRange, monthlyRange, formatPeriodLabel, buildFilename,
} from '../../../utils/invoiceReports';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function firstDayOfMonth() { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0]; }
function today() { return new Date().toISOString().split('T')[0]; }
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

const STATUS_OPTIONS = [
  { value: '',  label: 'Tous statuts' },
  { value: '0', label: 'Brouillon' },
  { value: '1', label: 'Validée / Impayée' },
  { value: '2', label: 'Payée' },
  { value: '3', label: 'Abandonnée' },
];

const SOURCE_OPTIONS = [
  { value: '',        label: 'Toutes sources' },
  { value: 'takepos', label: 'POS' },
  { value: 'web',     label: 'Web' },
  { value: 'direct',  label: 'Direct' },
];

function statusBadge(status, paid, paidAmount = 0) {
  if (status === 0) return <span className="ac-badge ac-badge-draft">Brouillon</span>;
  if (status === 1 && !paid) {
    // Dolibarr garde paye=0 tant que la facture n'est pas soldée à 100 %.
    // On distingue le paiement partiel pour éviter la confusion « impayée alors
    // qu'un acompte/règlement est déjà encaissé ».
    if (Number(paidAmount) > 0) return <span className="ac-badge ac-badge-partial">Partiellement payée</span>;
    return <span className="ac-badge ac-badge-unpaid">Impayée</span>;
  }
  if (status === 2 || paid) return <span className="ac-badge ac-badge-paid">Payée</span>;
  if (status === 3) return <span className="ac-badge ac-badge-cancel">Abandonnée</span>;
  return <span className="ac-badge">?</span>;
}

export default function InvoicesPanel() {
  const [data, setData] = useState({ invoices: [], total: 0, pages: 1, kpis: {} });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    status: '',
    source: '',
    search: '',
    date_from: firstDayOfMonth(),
    date_to: today(),
    page: 1,
  });
  const [selected, setSelected] = useState(null); // facture en cours d'inspection
  const [actionModal, setActionModal] = useState(null); // { type, invoice }
  const [reportModal, setReportModal] = useState(null); // 'daily' | 'monthly'
  const [depositModal, setDepositModal] = useState(false); // modale création acompte

  const reload = useCallback(() => {
    setLoading(true);
    listInvoices(filters)
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => { toast.error('Erreur chargement factures'); setLoading(false); });
  }, [filters]);

  useEffect(() => { reload(); }, [reload]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));
  const changePage = (p) => setFilters(f => ({ ...f, page: p }));

  const openDetail = async (id) => {
    setSelected({ loading: true });
    try { const r = await getInvoice(id); setSelected(r.data); }
    catch { toast.error('Erreur chargement facture'); setSelected(null); }
  };

  const onActionDone = () => { setActionModal(null); reload(); if (selected?.invoice?.id) openDetail(selected.invoice.id); };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiFileText /> Factures ({data.total})
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => setDepositModal(true)}>
            <FiPlusCircle size={14} /> Acompte
          </button>
          <button className="btn btn-outline" onClick={() => setReportModal('daily')}>
            <FiCalendar size={14} /> Rapport journalier
          </button>
          <button className="btn btn-outline" onClick={() => setReportModal('monthly')}>
            <FiCalendar size={14} /> Rapport mensuel
          </button>
          <Link to="/admin/invoices/audit-log" className="btn btn-outline" style={{ textDecoration: 'none' }}>
            <FiList size={14} /> Journal d'audit
          </Link>
        </div>
      </div>

      {/* KPIs */}
      {!loading && (
        <div className="ac-breakdown">
          <div className="ac-breakdown-item" style={{ background: '#fff7ed' }}>
            <strong style={{ color: '#9a3412' }}>{formatPrice(data.kpis.unpaid_amount || 0)}</strong>
            Impayées ({data.kpis.nb_unpaid || 0})
          </div>
          <div className="ac-breakdown-item" style={{ background: '#f3f4f6' }}>
            <strong style={{ color: '#4b5563' }}>{formatPrice(data.kpis.draft_amount || 0)}</strong>
            Brouillons ({data.kpis.nb_draft || 0})
          </div>
        </div>
      )}

      {/* Barre de recherche proéminente */}
      <div style={{
        position: 'relative', marginBottom: 12,
        background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,.06)',
      }}>
        <FiSearch style={{
          position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)',
          color: '#9ca3af', fontSize: 18, pointerEvents: 'none',
        }} />
        <input
          type="text"
          value={filters.search}
          onChange={e => update('search', e.target.value)}
          placeholder="Rechercher par référence (LIBFAC…), nom client, code client, email, ville ou téléphone…"
          style={{
            width: '100%', padding: '12px 44px 12px 42px', border: '1px solid #e5e7eb',
            borderRadius: 10, fontSize: 14, background: 'transparent', outline: 'none',
          }}
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => update('search', '')}
            title="Effacer"
            style={{
              position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280',
              padding: 6, display: 'flex',
            }}
          >
            <FiX />
          </button>
        )}
      </div>

      {/* Filtres avancés */}
      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Statut</label>
          <select className="ac-filter-select" value={filters.status} onChange={e => update('status', e.target.value)}>
            {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Source</label>
          <select className="ac-filter-select" value={filters.source} onChange={e => update('source', e.target.value)}>
            {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Du</label>
          <input type="date" className="ac-filter-input" value={filters.date_from} onChange={e => update('date_from', e.target.value)} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Au</label>
          <input type="date" className="ac-filter-input" value={filters.date_to} onChange={e => update('date_to', e.target.value)} />
        </div>
      </div>

      {loading ? <Loader /> : (
        <>
          <div className="ac-table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Source</th>
                  <th className="ac-amount">Total TTC</th>
                  <th className="ac-amount">Reste</th>
                  <th>Statut</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map(inv => (
                  <tr key={inv.id} className={inv.status === 0 ? 'ac-row-draft' : ''}>
                    <td>
                      <button className="ac-link-btn" onClick={() => openDetail(inv.id)} title="Voir le détail">
                        {inv.ref || `#${inv.id}`}
                      </button>
                      {inv.type === 2 && <span style={{ marginLeft: 6, color: '#9333ea', fontSize: '0.7rem', fontWeight: 700 }}>AVOIR</span>}
                    </td>
                    <td className="ac-date">{fmtDate(inv.date)}</td>
                    <td>{inv.customer_name}</td>
                    <td style={{ fontSize: '0.78rem', color: '#64748b' }}>{inv.source}</td>
                    <td className="ac-amount" style={{ fontWeight: 700 }}>{formatPrice(inv.total_ttc)}</td>
                    <td className="ac-amount" style={{ color: inv.remaining > 0 ? '#9a3412' : '#10531a' }}>
                      {formatPrice(inv.remaining)}
                    </td>
                    <td>{statusBadge(inv.status, inv.paid, inv.paid_amount)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <InvoiceActions invoice={inv} onAction={(type) => setActionModal({ type, invoice: inv })} />
                    </td>
                  </tr>
                ))}
                {data.invoices.length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucune facture sur cette période</td></tr>
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

      {selected && (
        <InvoiceDetailModal
          data={selected}
          onClose={() => setSelected(null)}
          onAction={(type, invoice) => setActionModal({ type, invoice })}
        />
      )}

      {actionModal && (
        <ActionModal
          type={actionModal.type}
          invoice={actionModal.invoice}
          onClose={() => setActionModal(null)}
          onDone={onActionDone}
        />
      )}

      {reportModal && (
        <ReportModal kind={reportModal} onClose={() => setReportModal(null)} />
      )}

      {depositModal && (
        <DepositModal onClose={() => setDepositModal(false)} onDone={() => { setDepositModal(false); reload(); }} />
      )}
    </div>
  );
}

// ─── Modal de génération de rapport (jour / mois × PDF / Excel) ────
function ReportModal({ kind, onClose }) {
  const isDaily = kind === 'daily';
  const [dateIso, setDateIso] = useState(today());
  const [yearMonth, setYearMonth] = useState(() => today().slice(0, 7));
  const [busy, setBusy] = useState(false);

  const periodLabel = formatPeriodLabel({ kind, dateIso, yearMonth });

  async function fetchReport() {
    const range = isDaily ? dailyRange(dateIso) : monthlyRange(yearMonth);
    const r = await getInvoicesReport(range);
    return r.data; // { invoices, payments_by_method, ... }
  }

  async function run(format) {
    setBusy(true);
    try {
      const data = await fetchReport();
      const invoices = data.invoices || [];
      const paymentsByMethod = data.payments_by_method || [];
      if (invoices.length === 0) {
        toast('Aucune facture sur cette période', { icon: 'ℹ️' });
      }
      const kpis = computeReportKpis(invoices);
      const title = isDaily ? 'Rapport journalier des factures' : 'Rapport mensuel des factures';

      if (format === 'pdf') {
        openInvoicesPdf({ invoices, kpis, paymentsByMethod, title, periodLabel });
      } else {
        const filename = buildFilename({ kind, dateIso, yearMonth, ext: 'csv' });
        downloadInvoicesCsv({ invoices, kpis, paymentsByMethod, title, periodLabel, filename });
        toast.success('Fichier Excel téléchargé');
      }
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.error || err?.message || 'Erreur génération du rapport');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} title={isDaily ? 'Rapport journalier' : 'Rapport mensuel'}>
      <div style={{ marginBottom: 16 }}>
        {isDaily ? (
          <>
            <label className="ac-form-label">Date</label>
            <input
              type="date"
              className="ac-form-input"
              value={dateIso}
              max={today()}
              onChange={e => setDateIso(e.target.value)}
            />
          </>
        ) : (
          <>
            <label className="ac-form-label">Mois</label>
            <input
              type="month"
              className="ac-form-input"
              value={yearMonth}
              max={today().slice(0, 7)}
              onChange={e => setYearMonth(e.target.value)}
            />
          </>
        )}
        <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 6 }}>
          {periodLabel}
        </div>
      </div>

      <div className="ac-modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>
          Annuler
        </button>
        <button type="button" className="btn btn-outline" onClick={() => run('excel')} disabled={busy}>
          <FiDownload size={14} /> {busy ? '...' : 'Excel (CSV)'}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => run('pdf')} disabled={busy}>
          <FiPrinter size={14} /> {busy ? '...' : 'PDF'}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Actions menu par ligne ─────────────────────────────────
function InvoiceActions({ invoice, onAction }) {
  const actions = useMemo(() => {
    const list = [];
    const isCredit = invoice.type === 2;
    if (invoice.status === 0) {
      list.push({ key: 'reassign', label: 'Réassigner client', icon: <FiUser /> });
      list.push({ key: 'delete',   label: 'Supprimer brouillon', icon: <FiTrash2 />, danger: true });
    }
    if (invoice.status === 1 && !invoice.paid && !isCredit) {
      list.push({ key: 'pay',          label: 'Encaisser', icon: <FiDollarSign /> });
      list.push({ key: 'apply-credit', label: 'Imputer un acompte / avoir', icon: <FiGift /> });
      list.push({ key: 'settodraft',   label: 'Repasser en brouillon', icon: <FiCornerUpLeft />, danger: true });
      list.push({ key: 'credit-note',  label: 'Créer un avoir', icon: <FiRefreshCw />, danger: true });
    }
    if ((invoice.status === 2 || invoice.paid) && !isCredit) {
      list.push({ key: 'credit-note', label: 'Créer un avoir', icon: <FiRefreshCw />, danger: true });
    }
    return list;
  }, [invoice]);

  if (!actions.length) return <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>—</span>;

  return (
    <div className="ac-row-actions">
      {actions.map(a => (
        <button
          key={a.key}
          className={`ac-mini-btn ${a.danger ? 'danger' : ''}`}
          title={a.label}
          onClick={() => onAction(a.key)}
        >{a.icon}</button>
      ))}
    </div>
  );
}

// ─── Modal détail facture ───────────────────────────────────
function InvoiceDetailModal({ data, onClose, onAction }) {
  const [downloading, setDownloading] = useState(false);

  const downloadPdf = async (invoice) => {
    if (downloading) return;
    setDownloading(true);
    try {
      const res = await getInvoicePdf(invoice.id);
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${invoice.ref || `facture-${invoice.id}`}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      // Le backend renvoie un JSON d'erreur (en blob) — on tente de le lire.
      let msg = 'Échec du téléchargement du PDF';
      try {
        const txt = await err.response?.data?.text?.();
        if (txt) msg = JSON.parse(txt).error || msg;
      } catch { /* garde le message par défaut */ }
      toast.error(msg);
    } finally {
      setDownloading(false);
    }
  };

  if (data.loading) {
    return (
      <ModalShell onClose={onClose} title="Chargement…">
        <Loader />
      </ModalShell>
    );
  }
  const { invoice, lines, timeline = [], audit } = data;
  const totalTtc = Number(invoice.total_ttc) || 0;
  const paidAmount = Number(invoice.paid_amount) || 0;
  const remaining = invoice.remaining != null ? Number(invoice.remaining) : totalTtc - paidAmount;
  const pct = totalTtc > 0 ? Math.min(100, Math.round((paidAmount / totalTtc) * 100)) : 0;
  const isCreditNote = invoice.type === 2;
  return (
    <ModalShell onClose={onClose} title={`Facture ${invoice.ref || `#${invoice.id}`}`} wide>
      <div className="ac-detail-grid">
        <div><strong>Client :</strong> {invoice.customer_name || '—'}</div>
        <div><strong>Date :</strong> {fmtDate(invoice.datef)}</div>
        <div><strong>Échéance :</strong> {fmtDate(invoice.date_lim_reglement)}</div>
        <div><strong>Statut :</strong> {statusBadge(invoice.fk_statut, !!invoice.paye, paidAmount)}</div>
        <div><strong>Source :</strong> {invoice.source}</div>
        <div><strong>Total TTC :</strong> {formatPrice(invoice.total_ttc)}</div>
      </div>

      {/* Progression payé / reste à payer */}
      {!isCreditNote && (
        <div className="ac-progress-block">
          <div className="ac-progress-head">
            <span>Payé : <strong>{formatPrice(paidAmount)}</strong></span>
            <span>Reste : <strong style={{ color: remaining > 0 ? '#9a3412' : '#10531a' }}>{formatPrice(remaining)}</strong></span>
          </div>
          <div className="ac-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
            aria-label={`Facture payée à ${pct}%`}>
            <div className={`ac-progress-bar ${remaining <= 0 ? 'full' : ''}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="ac-progress-sub">
            {pct}% encaissé
            {Number(invoice.paid_credits) > 0 && <> · dont {formatPrice(invoice.paid_credits)} en acomptes/avoirs imputés</>}
          </div>
        </div>
      )}

      <h4 style={{ marginTop: 16 }}>Lignes</h4>
      <div className="ac-table-wrap">
        <table className="ac-table">
          <thead><tr><th>Produit</th><th>Description</th><th>Qté</th><th className="ac-amount">PU HT</th><th className="ac-amount">Total TTC</th></tr></thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id}>
                <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>{l.product_ref || '—'}</td>
                <td style={{ fontSize: '0.85rem' }}>{l.product_label || l.description || '—'}</td>
                <td>{l.qty}</td>
                <td className="ac-amount">{formatPrice(l.subprice)}</td>
                <td className="ac-amount">{formatPrice(l.total_ttc)}</td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: '#94a3b8', padding: 16 }}>Aucune ligne</td></tr>}
          </tbody>
        </table>
      </div>

      <h4 style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        <FiDollarSign /> Historique des paiements &amp; imputations
      </h4>
      {timeline.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Aucun paiement ni acompte imputé.</p>
      ) : (
        <div className="ac-timeline">
          {timeline.map((e, i) => (
            <div key={i} className={`ac-timeline-item kind-${e.kind}`}>
              <div className="ac-timeline-dot" />
              <div className="ac-timeline-body">
                <div className="ac-timeline-row1">
                  <span className="ac-timeline-amount">{formatPrice(e.amount)}</span>
                  {e.kind === 'payment'
                    ? <span className={`ac-method-pill ac-method-${e.method_code || 'default'}`}>{e.label}</span>
                    : <span className="ac-credit-pill">{e.label}{e.source_ref ? ` · ${e.source_ref}` : ''}</span>}
                  <span className="ac-timeline-date">{fmtDate(e.date)}</span>
                </div>
                <div className="ac-timeline-row2">
                  {e.kind === 'payment' && e.bank_label && <span>{e.bank_label}</span>}
                  {e.kind === 'payment' && e.num && <span className="ac-timeline-ref">Réf. {e.num}</span>}
                  <span className="ac-timeline-remaining">
                    Reste après : <strong>{formatPrice(e.running_remaining)}</strong>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <h4 style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
        <FiList /> Historique des régularisations
      </h4>
      <div className="ac-audit-list">
        {audit.length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Aucune régularisation enregistrée.</p>
        ) : audit.map(e => (
          <div key={e.id} className="ac-audit-entry">
            <div className="ac-audit-head">
              <span className="ac-audit-action">{actionLabel(e.action)}</span>
              <span className="ac-audit-meta">par {e.user_name} ({e.user_role}) — {new Date(e.created_at).toLocaleString('fr-FR')}</span>
            </div>
            <div className="ac-audit-reason">« {e.reason} »</div>
          </div>
        ))}
      </div>

      <div className="ac-modal-footer">
        <button
          type="button"
          className="btn btn-outline"
          onClick={() => downloadPdf(invoice)}
          disabled={downloading}
        >
          <FiDownload /> {downloading ? 'Génération…' : 'Télécharger PDF'}
        </button>
        <InvoiceActions invoice={{ ...invoice, id: invoice.id, status: invoice.fk_statut, paid: !!invoice.paye, type: invoice.type }}
          onAction={(type) => onAction(type, { ...invoice, id: invoice.id, status: invoice.fk_statut, paid: !!invoice.paye, type: invoice.type, ref: invoice.ref })} />
      </div>
    </ModalShell>
  );
}

// ─── Modal d'action (motif obligatoire) ─────────────────────
function ActionModal({ type, invoice, onClose, onDone }) {
  const meta = ACTION_META[type];
  const [reason, setReason] = useState('');
  const [extra, setExtra] = useState({});
  const [submitting, setSubmitting] = useState(false);

  if (!meta) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (reason.trim().length < 4) { toast.error('Motif requis (min 4 caractères)'); return; }
    setSubmitting(true);
    try {
      await meta.run(invoice, reason.trim(), extra);
      toast.success(meta.successMessage);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  return (
    <ModalShell onClose={onClose} title={meta.title}>
      <form onSubmit={handleSubmit}>
        <div className="ac-modal-warning">
          <FiAlertTriangle /> {meta.warning(invoice)}
        </div>

        {type === 'pay' && <PayFields invoice={invoice} extra={extra} setExtra={setExtra} />}
        {type === 'reassign' && <ReassignFields extra={extra} setExtra={setExtra} />}
        {type === 'apply-credit' && <ApplyCreditFields invoice={invoice} extra={extra} setExtra={setExtra} />}

        <label className="ac-form-label">Motif de la régularisation <span style={{ color: '#dc2626' }}>*</span></label>
        <textarea
          className="ac-form-textarea"
          rows={3}
          minLength={4}
          maxLength={500}
          required
          placeholder="Ex : client a payé en espèces le 15/05, à enregistrer manuellement"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
        <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginTop: 4 }}>{reason.length} / 500 — sera tracé dans le journal d'audit</div>

        <div className="ac-modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button type="submit" className={meta.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={submitting}>
            {submitting ? '...' : meta.confirmLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Méthodes de paiement autorisées (= PAYMENT_METHODS_ALLOWED backend) ──
const PAY_METHODS = [
  { code: 'LIQ', label: 'Espèces' },
  { code: 'CB', label: 'Carte bancaire' },
  { code: 'CHQ', label: 'Chèque' },
  { code: 'WAVE', label: 'Wave' },
  { code: 'OM', label: 'Orange Money' },
  { code: 'VIR', label: 'Virement' },
];

// Saisie d'un encaissement fractionné multi-méthode (réutilisée pour la facture
// et l'acompte). Gère la liste `splits` [{method, amount, num_payment}] dans extra.
function SplitPaymentEditor({ remaining, extra, setExtra, banks, withBank = true }) {
  const splits = extra.splits || [];
  const totalSplit = splits.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const left = Math.round((remaining - totalSplit) * 100) / 100;

  const setSplit = (i, patch) => {
    const next = splits.map((s, j) => (j === i ? { ...s, ...patch } : s));
    setExtra({ ...extra, splits: next });
  };
  const addSplit = () => setExtra({ ...extra, splits: [...splits, { method: '', amount: left > 0 ? left : 0, num_payment: '' }] });
  const removeSplit = (i) => setExtra({ ...extra, splits: splits.filter((_, j) => j !== i) });

  return (
    <div style={{ marginBottom: 12 }}>
      {withBank && (
        <div className="ac-form-grid" style={{ marginBottom: 10 }}>
          <div>
            <label className="ac-form-label">Compte bancaire *</label>
            <select className="ac-form-select" required value={extra.bank_account || ''}
              onChange={e => setExtra({ ...extra, bank_account: Number(e.target.value) })}>
              <option value="">—</option>
              {banks.map(b => <option key={b.id} value={b.id}>{b.label || b.ref}</option>)}
            </select>
          </div>
          <div>
            <label className="ac-form-label">Date</label>
            <input type="date" className="ac-form-input"
              value={extra.date || today()} onChange={e => setExtra({ ...extra, date: e.target.value })} />
          </div>
        </div>
      )}

      <label className="ac-form-label">Encaissement(s) {remaining != null && <>— reste à payer : {formatPrice(remaining)}</>}</label>
      {splits.map((s, i) => (
        <div key={i} className="ac-split-row">
          <select className="ac-form-select" required value={s.method || ''}
            onChange={e => setSplit(i, { method: e.target.value })}>
            <option value="">Méthode…</option>
            {PAY_METHODS.map(m => <option key={m.code} value={m.code}>{m.label}</option>)}
          </select>
          <input type="number" className="ac-form-input" step="1" min="1" placeholder="Montant"
            value={s.amount ?? ''} onChange={e => setSplit(i, { amount: Number(e.target.value) })} />
          <input type="text" className="ac-form-input" maxLength={64} placeholder="N° pièce (opt.)"
            value={s.num_payment || ''} onChange={e => setSplit(i, { num_payment: e.target.value })} />
          {splits.length > 1 && (
            <button type="button" className="ac-mini-btn danger" title="Retirer" onClick={() => removeSplit(i)}><FiX /></button>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-outline" style={{ marginTop: 6 }} onClick={addSplit}>
        <FiPlus size={14} /> Ajouter une méthode
      </button>
      <div className="ac-split-summary">
        <span>Total saisi : <strong>{formatPrice(totalSplit)}</strong></span>
        {remaining != null && (
          <span style={{ color: left < -0.01 ? '#b91c1c' : (left > 0.01 ? '#9a3412' : '#10531a') }}>
            {left > 0.01 ? `Reste à couvrir : ${formatPrice(left)}`
              : left < -0.01 ? `Dépasse de ${formatPrice(-left)}` : 'Solde complet ✓'}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Champs encaissement manuel de facture (multi-méthode) ──────────────
function PayFields({ invoice, extra, setExtra }) {
  const [banks, setBanks] = useState([]);
  useEffect(() => { getInvoiceBanks().then(r => setBanks(r.data.accounts || [])); }, []);
  const remaining = invoice.remaining != null
    ? Number(invoice.remaining)
    : Number(invoice.total_ttc) - Number(invoice.paid_amount || 0);
  useEffect(() => {
    if (!extra.splits) setExtra(prev => ({ ...prev, splits: [{ method: '', amount: remaining, num_payment: '' }], date: today() }));
  }, [remaining]); // eslint-disable-line react-hooks/exhaustive-deps
  return <SplitPaymentEditor remaining={remaining} extra={extra} setExtra={setExtra} banks={banks} />;
}

// ─── Champs imputation d'un acompte / avoir disponible ──────────────────
function ApplyCreditFields({ invoice, extra, setExtra }) {
  const socid = invoice.customer_id ?? invoice.fk_soc;
  const [credits, setCredits] = useState(null);
  const remaining = invoice.remaining != null
    ? Number(invoice.remaining)
    : Number(invoice.total_ttc) - Number(invoice.paid_amount || 0);

  useEffect(() => {
    if (!socid) { setCredits([]); return; }
    getCustomerCredits(socid)
      .then(r => setCredits(r.data.credits || []))
      .catch(() => setCredits([]));
  }, [socid]);

  if (credits === null) return <Loader />;
  if (credits.length === 0) {
    return <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: 12 }}>
      Aucun acompte ni avoir disponible pour ce client. Créez d'abord un acompte.
    </p>;
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <label className="ac-form-label">Crédit à imputer * <span style={{ color: '#64748b', fontWeight: 400 }}>(reste à payer : {formatPrice(remaining)})</span></label>
      <div className="ac-credit-list">
        {credits.map(c => (
          <label key={c.id} className={`ac-credit-choice ${extra.discountid === c.id ? 'active' : ''}`}>
            <input type="radio" name="credit" value={c.id}
              checked={extra.discountid === c.id}
              onChange={() => setExtra({ ...extra, discountid: c.id })} />
            <span className="ac-credit-pill">{c.label}</span>
            <span className="ac-credit-amount">{formatPrice(c.amount)}</span>
            <span className="ac-credit-meta">{c.source_ref || ''} · {fmtDate(c.date)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Champs réassignation client (autocomplete) ─────────────
function ReassignFields({ extra, setExtra }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      searchInvoiceCustomers(q).then(r => setResults(r.data.customers || []));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <label className="ac-form-label">Nouveau client *</label>
      <input
        type="text"
        className="ac-form-input"
        placeholder="Rechercher par nom, code client ou email…"
        value={extra.customer_label || q}
        onChange={e => { setQ(e.target.value); setExtra({ ...extra, socid: null, customer_label: e.target.value }); setOpen(true); }}
        onFocus={() => setOpen(true)}
        required={!extra.socid}
      />
      {open && results.length > 0 && (
        <div className="ac-autocomplete">
          {results.map(c => (
            <button type="button" key={c.id} className="ac-autocomplete-item"
              onClick={() => { setExtra({ ...extra, socid: c.id, customer_label: c.nom }); setQ(''); setOpen(false); }}>
              <strong>{c.nom}</strong>
              <span style={{ color: '#64748b', fontSize: '0.75rem', marginLeft: 8 }}>
                {c.code_client || '—'} · {c.town || ''}
              </span>
            </button>
          ))}
        </div>
      )}
      {extra.socid && <div style={{ fontSize: '0.75rem', color: '#10531a', marginTop: 4 }}>✓ Client sélectionné (id {extra.socid})</div>}
    </div>
  );
}

// ─── Modale de création d'un acompte (facture type 3) ───────
function DepositModal({ onClose, onDone }) {
  const [banks, setBanks] = useState([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [socid, setSocid] = useState(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [tvaTx, setTvaTx] = useState(0);
  const [dateIso, setDateIso] = useState(today());
  const [reason, setReason] = useState('');
  const [encash, setEncash] = useState(true);
  const [extra, setExtra] = useState({ splits: [], bank_account: '', date: today() });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { getInvoiceBanks().then(r => setBanks(r.data.accounts || [])); }, []);
  useEffect(() => {
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(() => { searchInvoiceCustomers(q).then(r => setResults(r.data.customers || [])); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  // Pré-remplit l'encaissement avec le montant de l'acompte.
  const amt = Number(amount) || 0;
  useEffect(() => {
    if (encash && amt > 0 && (!extra.splits || extra.splits.length === 0)) {
      setExtra(e => ({ ...e, splits: [{ method: '', amount: amt, num_payment: '' }] }));
    }
  }, [encash, amt]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e) => {
    e.preventDefault();
    if (!socid) { toast.error('Sélectionnez un client'); return; }
    if (!(amt > 0)) { toast.error('Montant de l\'acompte invalide'); return; }
    if (reason.trim().length < 4) { toast.error('Motif requis (min 4 caractères)'); return; }
    let pay;
    if (encash) {
      const splits = (extra.splits || []).filter(s => s.method && Number(s.amount) > 0);
      if (!splits.length) { toast.error('Ajoutez une méthode d\'encaissement'); return; }
      if (!extra.bank_account) { toast.error('Compte bancaire requis'); return; }
      pay = { splits, bank_account: extra.bank_account };
    }
    setSubmitting(true);
    try {
      await createDeposit({ socid, amount: amt, tva_tx: Number(tvaTx) || 0, date: dateIso, reason: reason.trim(), pay });
      toast.success('Acompte créé');
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.detail || err.response?.data?.error || 'Erreur création acompte');
    } finally { setSubmitting(false); }
  };

  return (
    <ModalShell onClose={onClose} title="Nouvel acompte">
      <form onSubmit={submit}>
        <div className="ac-modal-warning">
          <FiAlertTriangle /> Crée une facture d'acompte convertie en avoir disponible, imputable ensuite sur la facture finale du client.
        </div>

        {/* Client */}
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <label className="ac-form-label">Client *</label>
          <input type="text" className="ac-form-input"
            placeholder="Rechercher par nom, code client ou email…"
            value={customerLabel}
            onChange={e => { setQ(e.target.value); setSocid(null); setCustomerLabel(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)} />
          {open && results.length > 0 && (
            <div className="ac-autocomplete">
              {results.map(c => (
                <button type="button" key={c.id} className="ac-autocomplete-item"
                  onClick={() => { setSocid(c.id); setCustomerLabel(c.nom); setQ(''); setOpen(false); }}>
                  <strong>{c.nom}</strong>
                  <span style={{ color: '#64748b', fontSize: '0.75rem', marginLeft: 8 }}>{c.code_client || '—'} · {c.town || ''}</span>
                </button>
              ))}
            </div>
          )}
          {socid && <div style={{ fontSize: '0.75rem', color: '#10531a', marginTop: 4 }}>✓ Client sélectionné</div>}
        </div>

        <div className="ac-form-grid">
          <div>
            <label className="ac-form-label">Montant de l'acompte (TTC) *</label>
            <input type="number" className="ac-form-input" step="1" min="1" required
              value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="ac-form-label">TVA (%)</label>
            <input type="number" className="ac-form-input" step="0.1" min="0"
              value={tvaTx} onChange={e => setTvaTx(e.target.value)} />
          </div>
          <div>
            <label className="ac-form-label">Date</label>
            <input type="date" className="ac-form-input" value={dateIso} max={today()} onChange={e => setDateIso(e.target.value)} />
          </div>
        </div>

        <label className="ac-form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input type="checkbox" checked={encash} onChange={e => setEncash(e.target.checked)} />
          Encaisser l'acompte maintenant
        </label>
        {encash && (
          <SplitPaymentEditor remaining={amt > 0 ? amt : null} extra={extra} setExtra={setExtra} banks={banks} />
        )}

        <label className="ac-form-label">Motif <span style={{ color: '#dc2626' }}>*</span></label>
        <textarea className="ac-form-textarea" rows={2} minLength={4} maxLength={500} required
          placeholder="Ex : acompte de réservation commande client"
          value={reason} onChange={e => setReason(e.target.value)} />

        <div className="ac-modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? '...' : 'Créer l\'acompte'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Métadonnées des actions ───────────────────────────────
const ACTION_META = {
  pay: {
    title: 'Encaisser la facture',
    confirmLabel: 'Enregistrer l\'encaissement',
    warning: (inv) => `Enregistre un ou plusieurs paiements sur la facture ${inv.ref}. Les montants seront comptabilisés au journal de banque ; un encaissement partiel laisse la facture impayée.`,
    danger: false,
    successMessage: 'Encaissement enregistré',
    run: (inv, reason, extra) => {
      const splits = (extra.splits || []).filter(s => s.method && Number(s.amount) > 0);
      if (!splits.length) throw new Error('Ajoutez au moins une méthode de paiement');
      if (!extra.bank_account) throw new Error('Compte bancaire requis');
      return payInvoice(inv.id, { reason, bank_account: extra.bank_account, date: extra.date, splits });
    },
  },
  'apply-credit': {
    title: 'Imputer un acompte / avoir',
    confirmLabel: 'Imputer le crédit',
    warning: (inv) => `Le crédit sélectionné sera imputé sur la facture ${inv.ref} et réduira son reste à payer.`,
    danger: false,
    successMessage: 'Crédit imputé',
    run: (inv, reason, extra) => {
      if (!extra.discountid) throw new Error('Sélectionnez un crédit à imputer');
      return applyCredit(inv.id, extra.discountid, reason);
    },
  },
  'credit-note': {
    title: 'Créer un avoir (annulation)',
    confirmLabel: 'Créer l\'avoir',
    warning: (inv) => `Un avoir total sera créé pour la facture ${inv.ref}. L'opération est définitive.`,
    danger: true,
    successMessage: 'Avoir créé',
    run: (inv, reason) => createCreditNote(inv.id, reason),
  },
  settodraft: {
    title: 'Repasser en brouillon',
    confirmLabel: 'Repasser en brouillon',
    warning: (inv) => `La facture ${inv.ref} sera dévalidée. Seules les factures sans paiement peuvent l'être.`,
    danger: true,
    successMessage: 'Facture repassée en brouillon',
    run: (inv, reason) => setInvoiceToDraft(inv.id, reason),
  },
  reassign: {
    title: 'Réassigner le client',
    confirmLabel: 'Réassigner',
    warning: (inv) => `Le client de la facture ${inv.ref} (brouillon) sera remplacé.`,
    danger: false,
    successMessage: 'Client réassigné',
    run: (inv, reason, extra) => {
      if (!extra.socid) throw new Error('Aucun client sélectionné');
      return reassignInvoiceCustomer(inv.id, extra.socid, reason);
    },
  },
  delete: {
    title: 'Supprimer le brouillon',
    confirmLabel: 'Supprimer définitivement',
    warning: (inv) => `Le brouillon ${inv.ref} sera supprimé définitivement. Action irréversible.`,
    danger: true,
    successMessage: 'Brouillon supprimé',
    run: (inv, reason) => deleteInvoiceDraft(inv.id, reason),
  },
};

function actionLabel(action) {
  return {
    pay: 'Encaissement',
    credit_note: 'Avoir créé',
    settodraft: 'Repassée en brouillon',
    edit_lines: 'Lignes modifiées',
    reassign_customer: 'Client réassigné',
    delete: 'Brouillon supprimé',
    deposit_create: 'Acompte créé',
    apply_credit: 'Acompte / avoir imputé',
  }[action] || action;
}

// ─── Modal shell partagée ───────────────────────────────────
function ModalShell({ title, onClose, children, wide }) {
  return (
    <div className="ac-modal-backdrop" onClick={onClose}>
      <div className={`ac-modal ${wide ? 'ac-modal-wide' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="ac-modal-header">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button className="ac-modal-close" onClick={onClose} aria-label="Fermer"><FiX /></button>
        </div>
        <div className="ac-modal-body">{children}</div>
      </div>
    </div>
  );
}
