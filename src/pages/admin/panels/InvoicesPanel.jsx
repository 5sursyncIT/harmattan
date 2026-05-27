import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  FiFileText, FiDollarSign, FiRefreshCw, FiEdit, FiTrash2, FiUser,
  FiCornerUpLeft, FiX, FiAlertTriangle, FiList, FiCalendar, FiPrinter,
  FiDownload, FiSearch,
} from 'react-icons/fi';
import {
  listInvoices, getInvoice, getInvoicesReport, getInvoiceBanks, searchInvoiceCustomers,
  payInvoice, createCreditNote, setInvoiceToDraft,
  reassignInvoiceCustomer, deleteInvoiceDraft,
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

function statusBadge(status, paid) {
  if (status === 0) return <span className="ac-badge ac-badge-draft">Brouillon</span>;
  if (status === 1 && !paid) return <span className="ac-badge ac-badge-unpaid">Impayée</span>;
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
                    <td>{statusBadge(inv.status, inv.paid)}</td>
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
      list.push({ key: 'pay',         label: 'Marquer payée', icon: <FiDollarSign /> });
      list.push({ key: 'settodraft',  label: 'Repasser en brouillon', icon: <FiCornerUpLeft />, danger: true });
      list.push({ key: 'credit-note', label: 'Créer un avoir', icon: <FiRefreshCw />, danger: true });
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
  if (data.loading) {
    return (
      <ModalShell onClose={onClose} title="Chargement…">
        <Loader />
      </ModalShell>
    );
  }
  const { invoice, lines, payments, audit } = data;
  return (
    <ModalShell onClose={onClose} title={`Facture ${invoice.ref || `#${invoice.id}`}`} wide>
      <div className="ac-detail-grid">
        <div><strong>Client :</strong> {invoice.customer_name || '—'}</div>
        <div><strong>Date :</strong> {fmtDate(invoice.datef)}</div>
        <div><strong>Échéance :</strong> {fmtDate(invoice.date_lim_reglement)}</div>
        <div><strong>Statut :</strong> {statusBadge(invoice.fk_statut, !!invoice.paye)}</div>
        <div><strong>Source :</strong> {invoice.source}</div>
        <div><strong>Total TTC :</strong> {formatPrice(invoice.total_ttc)}</div>
        <div><strong>Payé :</strong> {formatPrice(invoice.paid_amount)}</div>
        <div><strong>Reste :</strong> {formatPrice(Number(invoice.total_ttc) - Number(invoice.paid_amount))}</div>
      </div>

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

      <h4 style={{ marginTop: 16 }}>Paiements imputés</h4>
      <div className="ac-table-wrap">
        <table className="ac-table">
          <thead><tr><th>Date</th><th className="ac-amount">Montant</th><th>Méthode</th><th>Banque</th><th>Référence</th></tr></thead>
          <tbody>
            {payments.map((p, i) => (
              <tr key={i}>
                <td className="ac-date">{fmtDate(p.datep)}</td>
                <td className="ac-amount">{formatPrice(p.amount)}</td>
                <td>{p.method_label}</td>
                <td>{p.bank_label || '—'}</td>
                <td style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{p.num_paiement || '—'}</td>
              </tr>
            ))}
            {payments.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: '#94a3b8', padding: 16 }}>Aucun paiement</td></tr>}
          </tbody>
        </table>
      </div>

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

// ─── Champs spécifiques au paiement manuel ──────────────────
function PayFields({ invoice, extra, setExtra }) {
  const [banks, setBanks] = useState([]);
  useEffect(() => { getInvoiceBanks().then(r => setBanks(r.data.accounts || [])); }, []);
  const remaining = Number(invoice.total_ttc) - Number(invoice.paid_amount || 0);
  useEffect(() => {
    if (extra.amount == null) setExtra(prev => ({ ...prev, amount: remaining }));
  }, [remaining]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ac-form-grid">
      <div>
        <label className="ac-form-label">Montant *</label>
        <input type="number" className="ac-form-input" step="1" min="1" max={remaining}
          required value={extra.amount ?? remaining}
          onChange={e => setExtra({ ...extra, amount: Number(e.target.value) })} />
        <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Reste à payer : {formatPrice(remaining)}</div>
      </div>
      <div>
        <label className="ac-form-label">Méthode *</label>
        <select className="ac-form-select" required value={extra.method || ''} onChange={e => setExtra({ ...extra, method: e.target.value })}>
          <option value="">—</option>
          <option value="LIQ">Espèces</option>
          <option value="CB">Carte bancaire</option>
          <option value="CHQ">Chèque</option>
          <option value="WAVE">Wave</option>
          <option value="OM">Orange Money</option>
          <option value="VIR">Virement</option>
        </select>
      </div>
      <div>
        <label className="ac-form-label">Compte bancaire *</label>
        <select className="ac-form-select" required value={extra.bank_account || ''} onChange={e => setExtra({ ...extra, bank_account: Number(e.target.value) })}>
          <option value="">—</option>
          {banks.map(b => <option key={b.id} value={b.id}>{b.label || b.ref}</option>)}
        </select>
      </div>
      <div>
        <label className="ac-form-label">Date</label>
        <input type="date" className="ac-form-input"
          value={extra.date || today()} onChange={e => setExtra({ ...extra, date: e.target.value })} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <label className="ac-form-label">N° de transaction (chèque, virement…)</label>
        <input type="text" className="ac-form-input" maxLength={64}
          value={extra.num_payment || ''} onChange={e => setExtra({ ...extra, num_payment: e.target.value })} />
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

// ─── Métadonnées des actions ───────────────────────────────
const ACTION_META = {
  pay: {
    title: 'Marquer la facture payée',
    confirmLabel: 'Enregistrer le paiement',
    warning: (inv) => `Enregistre un paiement manuel sur la facture ${inv.ref}. Le paiement sera comptabilisé dans le journal de banque.`,
    danger: false,
    successMessage: 'Paiement enregistré',
    run: (inv, reason, extra) => payInvoice(inv.id, { reason, ...extra }),
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
    pay: 'Paiement manuel',
    credit_note: 'Avoir créé',
    settodraft: 'Repassée en brouillon',
    edit_lines: 'Lignes modifiées',
    reassign_customer: 'Client réassigné',
    delete: 'Brouillon supprimé',
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
