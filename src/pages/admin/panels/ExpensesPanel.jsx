import { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  FiTrendingDown, FiX, FiRefreshCw, FiCalendar, FiSearch, FiList,
  FiDownload, FiCheck, FiSlash, FiInfo,
} from 'react-icons/fi';
import {
  listExpenses, getExpense, cancelExpense, acknowledgeExpense,
  getExpenseMeta, getCashReport,
} from '../../../api/expenses';
import { formatPrice } from '../../../utils/formatters';
import {
  downloadCashCsv, openCashPdf, dailyRange, monthlyRange,
  formatPeriodLabel, buildFilename,
} from '../../../utils/expenseReports';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function firstDayOfMonth() { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0]; }
function today() { return new Date().toISOString().split('T')[0]; }
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '—');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('fr-FR') : '—');

const labelStyle = { display: 'block', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6b7280', marginBottom: 2 };

const STATUS_OPTIONS = [
  { value: '', label: 'Tous statuts' },
  { value: 'recorded', label: 'Enregistrées' },
  { value: 'cancelled', label: 'Annulées' },
];

const ACTION_LABELS = { create: 'Création', cancel: 'Annulation' };

function statusBadge(status) {
  if (status === 'cancelled') return <span className="ac-badge ac-badge-cancel">Annulée</span>;
  return <span className="ac-badge ac-badge-paid">Enregistrée</span>;
}

export default function ExpensesPanel() {
  const [data, setData] = useState({ expenses: [], total: 0, pages: 1, kpis: { total: 0, nb: 0, by_category: [] } });
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState({ categories: [] });
  const [filters, setFilters] = useState({
    category: '', status: '', search: '',
    date_from: firstDayOfMonth(), date_to: today(), page: 1,
  });
  const [selected, setSelected] = useState(null);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [reportModal, setReportModal] = useState(null); // 'daily' | 'monthly'

  const ctx = useOutletContext() || {};
  const isAdmin = ctx.adminRole === 'super_admin' || ctx.adminRole === 'admin';

  const reload = useCallback(() => {
    setLoading(true);
    listExpenses(filters)
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => { toast.error('Erreur chargement des dépenses'); setLoading(false); });
  }, [filters]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { getExpenseMeta().then(r => setMeta(r.data)).catch(() => {}); }, []);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));
  const changePage = (p) => setFilters(f => ({ ...f, page: p }));

  const openDetail = async (id) => {
    setSelected({ loading: true });
    try { const r = await getExpense(id); setSelected(r.data); }
    catch { toast.error('Erreur chargement de la dépense'); setSelected(null); }
  };

  const onCancelled = () => { setCancelTarget(null); reload(); if (selected?.expense?.id) openDetail(selected.expense.id); };

  const ack = async (id) => {
    try { await acknowledgeExpense(id); reload(); }
    catch { toast.error('Erreur'); }
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiTrendingDown /> Sorties d'argent ({data.total})
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={() => setReportModal('daily')}>
            <FiCalendar size={14} /> Rapport journalier
          </button>
          <button className="btn btn-outline" onClick={() => setReportModal('monthly')}>
            <FiCalendar size={14} /> Rapport mensuel
          </button>
        </div>
      </div>

      <div className="ac-info-box" style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <FiInfo /> Les sorties d'argent sont saisies au POS (caisse). Cet écran est en consultation ; un administrateur peut annuler une sortie.
      </div>

      {/* KPIs */}
      {!loading && (
        <div className="ac-breakdown">
          <div className="ac-breakdown-item" style={{ background: '#fff7ed' }}>
            <strong style={{ color: '#9a3412' }}>{formatPrice(data.kpis.total || 0)}</strong>
            Total dépenses ({data.kpis.nb || 0})
          </div>
          {(data.kpis.by_category || []).slice(0, 4).map(c => (
            <div key={c.category} className="ac-breakdown-item" style={{ background: '#f3f4f6' }}>
              <strong style={{ color: '#4b5563' }}>{formatPrice(c.total)}</strong>
              {c.label} ({c.nb})
            </div>
          ))}
        </div>
      )}

      {/* Recherche */}
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
        <input
          type="text"
          placeholder="Rechercher (référence, bénéficiaire, motif)…"
          value={filters.search}
          onChange={e => update('search', e.target.value)}
          style={{ width: '100%', padding: '10px 12px 10px 36px', borderRadius: 8, border: '1px solid #e2e8f0' }}
        />
      </div>

      {/* Filtres */}
      <div className="ac-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={filters.category} onChange={e => update('category', e.target.value)}>
          <option value="">Toutes catégories</option>
          {meta.categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={filters.status} onChange={e => update('status', e.target.value)}>
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={e => update('date_from', e.target.value)} />
        <input type="date" value={filters.date_to} onChange={e => update('date_to', e.target.value)} />
        <button className="btn btn-outline" onClick={reload}><FiRefreshCw size={14} /></button>
      </div>

      {loading ? <Loader /> : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table className="ac-table">
              <thead>
                <tr>
                  <th>Date</th><th>Référence</th><th>Catégorie</th><th>Bénéficiaire</th>
                  <th>Origine</th><th style={{ textAlign: 'right' }}>Montant</th>
                  <th>Saisi par</th><th>Statut</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.expenses.length === 0 ? (
                  <tr><td colSpan={9} style={{ textAlign: 'center', color: '#94a3b8', padding: 24 }}>Aucune dépense</td></tr>
                ) : data.expenses.map(e => (
                  <tr key={e.id} style={{ cursor: 'pointer', opacity: e.status === 'cancelled' ? 0.55 : 1 }} onClick={() => openDetail(e.id)}>
                    <td>{fmtDate(e.expense_date || e.created_at)}</td>
                    <td style={{ fontFamily: 'monospace' }}>{e.ref}</td>
                    <td>{e.category_label}</td>
                    <td>{e.beneficiary}</td>
                    <td>{e.in_register ? `Caisse${e.terminal ? ' T' + e.terminal : ''}` : 'Hors-caisse'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: '#9a3412' }}>{formatPrice(e.amount)}</td>
                    <td>{e.created_by}</td>
                    <td>{statusBadge(e.status)}</td>
                    <td onClick={ev => ev.stopPropagation()}>
                      {isAdmin && e.status === 'recorded' && !e.acknowledged && (
                        <button className="btn btn-tiny btn-outline" title="Marquer comme vu" onClick={() => ack(e.id)}><FiCheck size={12} /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div className="ac-pagination">
              <button className="btn btn-outline" disabled={filters.page <= 1} onClick={() => changePage(filters.page - 1)}>Précédent</button>
              <span>Page {filters.page} / {data.pages}</span>
              <button className="btn btn-outline" disabled={filters.page >= data.pages} onClick={() => changePage(filters.page + 1)}>Suivant</button>
            </div>
          )}
        </>
      )}

      {selected && <DetailModal data={selected} isAdmin={isAdmin} onClose={() => setSelected(null)} onCancel={(exp) => setCancelTarget(exp)} />}
      {cancelTarget && <CancelModal expense={cancelTarget} onClose={() => setCancelTarget(null)} onDone={onCancelled} />}
      {reportModal && <ReportModal kind={reportModal} onClose={() => setReportModal(null)} />}
    </div>
  );
}

// ─── Modal détail ───────────────────────────────────────────
function DetailModal({ data, isAdmin, onClose, onCancel }) {
  if (data.loading) return <ModalShell onClose={onClose}><Loader /></ModalShell>;
  const { expense, audit } = data;
  return (
    <ModalShell onClose={onClose}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <FiTrendingDown /> {expense.ref} {statusBadge(expense.status)}
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '12px 0' }}>
        <div><span style={labelStyle}>Montant</span><strong style={{ color: '#9a3412', fontSize: '1.2rem' }}>{formatPrice(expense.amount)}</strong></div>
        <div><span style={labelStyle}>Catégorie</span>{expense.category_label}</div>
        <div><span style={labelStyle}>Bénéficiaire</span>{expense.beneficiary}</div>
        <div><span style={labelStyle}>Origine</span>{expense.in_register ? `Caisse POS${expense.terminal ? ' · Terminal ' + expense.terminal : ''}` : 'Hors-caisse'}</div>
        <div><span style={labelStyle}>Date</span>{fmtDate(expense.expense_date || expense.created_at)}</div>
        <div><span style={labelStyle}>Saisi par</span>{expense.created_by} ({expense.created_by_role})</div>
      </div>
      <div style={{ margin: '12px 0' }}>
        <span style={labelStyle}>Motif / justification</span>
        <p style={{ margin: '4px 0', padding: '10px 12px', background: '#fff7ed', borderLeft: '3px solid #9a3412', borderRadius: 6 }}>{expense.reason}</p>
      </div>
      {expense.note && (
        <div style={{ marginBottom: 12 }}><span style={labelStyle}>Note</span><p style={{ margin: '4px 0' }}>{expense.note}</p></div>
      )}
      {expense.status === 'cancelled' && (
        <div style={{ marginBottom: 12, padding: '10px 12px', background: '#fef2f2', borderRadius: 6 }}>
          <strong style={{ color: '#991b1b' }}>Annulée</strong> par {expense.cancelled_by} le {fmtDateTime(expense.cancelled_at)}
          <div style={{ fontStyle: 'italic' }}>« {expense.cancel_reason} »</div>
        </div>
      )}

      <h4 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><FiList /> Journal d'audit</h4>
      <div className="ac-audit-list">
        {(audit || []).length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Aucune entrée.</p>
        ) : audit.map(a => (
          <div key={a.id} className="ac-audit-entry">
            <div className="ac-audit-head">
              <span className="ac-audit-action">{ACTION_LABELS[a.action] || a.action}</span>
              <span className="ac-audit-meta">par {a.user_name} ({a.user_role}) — {fmtDateTime(a.created_at)}</span>
            </div>
            {a.reason && <div className="ac-audit-reason">« {a.reason} »</div>}
          </div>
        ))}
      </div>

      <div className="ac-modal-footer">
        {isAdmin && expense.status === 'recorded' && (
          <button className="btn btn-danger" onClick={() => onCancel(expense)}><FiSlash /> Annuler cette sortie</button>
        )}
        <button className="btn btn-outline" onClick={onClose}>Fermer</button>
      </div>
    </ModalShell>
  );
}

// ─── Modal annulation ───────────────────────────────────────
function CancelModal({ expense, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (reason.trim().length < 4) return toast.error('Motif requis (4 caractères min.)');
    setSubmitting(true);
    try {
      await cancelExpense(expense.id, reason);
      toast.success('Sortie annulée');
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur annulation');
      setSubmitting(false);
    }
  };
  return (
    <ModalShell onClose={onClose} narrow>
      <h3 style={{ marginTop: 0, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 8 }}><FiSlash /> Annuler {expense.ref}</h3>
      <p>Annulation tracée dans le journal d'audit. La sortie est retirée des totaux et rapports. Montant : <strong>{formatPrice(expense.amount)}</strong>.</p>
      <form onSubmit={submit}>
        <label style={labelStyle}>Motif de l'annulation *</label>
        <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} style={{ width: '100%' }} autoFocus />
        <div className="ac-modal-footer">
          <button type="button" className="btn btn-outline" onClick={onClose}>Retour</button>
          <button type="submit" className="btn btn-danger" disabled={submitting}>{submitting ? 'Annulation…' : 'Confirmer l\'annulation'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Modal rapport de caisse ────────────────────────────────
function ReportModal({ kind, onClose }) {
  const [dateIso, setDateIso] = useState(today());
  const [yearMonth, setYearMonth] = useState(today().slice(0, 7));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const period = kind === 'daily' ? { kind, dateIso } : { kind, yearMonth };
  const range = useMemo(
    () => (kind === 'daily' ? dailyRange(dateIso) : monthlyRange(yearMonth)),
    [kind, dateIso, yearMonth]
  );
  const periodLabel = formatPeriodLabel(period);

  const load = useCallback(() => {
    setLoading(true);
    getCashReport(range)
      .then(r => { setReport(r.data); setLoading(false); })
      .catch(() => { toast.error('Erreur génération du rapport'); setLoading(false); });
  }, [range]);

  useEffect(() => { load(); }, [load]);

  const title = kind === 'daily' ? 'Rapport de caisse journalier' : 'Rapport de caisse mensuel';

  return (
    <ModalShell onClose={onClose}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiCalendar /> {title}</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        {kind === 'daily'
          ? <input type="date" value={dateIso} onChange={e => setDateIso(e.target.value)} />
          : <input type="month" value={yearMonth} onChange={e => setYearMonth(e.target.value)} />}
        <span style={{ color: '#64748b' }}>{periodLabel}</span>
      </div>

      {loading || !report ? <Loader /> : (
        <>
          <div className="ac-breakdown">
            <div className="ac-breakdown-item" style={{ background: '#ecfdf5' }}>
              <strong style={{ color: '#166534' }}>{formatPrice(report.receipts_total)}</strong>Recettes encaissées
            </div>
            <div className="ac-breakdown-item" style={{ background: '#fff7ed' }}>
              <strong style={{ color: '#9a3412' }}>{formatPrice(report.expenses_total)}</strong>Total dépenses
            </div>
            <div className="ac-breakdown-item" style={{ background: report.net >= 0 ? '#eff6ff' : '#fef2f2' }}>
              <strong style={{ color: report.net >= 0 ? '#1d4ed8' : '#991b1b' }}>{formatPrice(report.net)}</strong>Solde net
            </div>
          </div>

          {(report.expenses_by_category || []).length > 0 && (
            <table className="ac-table" style={{ marginTop: 12 }}>
              <thead><tr><th>Catégorie</th><th style={{ textAlign: 'right' }}>Nombre</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
              <tbody>
                {report.expenses_by_category.map(c => (
                  <tr key={c.category}><td>{c.label}</td><td style={{ textAlign: 'right' }}>{c.count}</td><td style={{ textAlign: 'right', fontWeight: 600 }}>{formatPrice(c.total)}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="ac-modal-footer">
            <button className="btn btn-outline" onClick={() => downloadCashCsv({ report, title, periodLabel, filename: buildFilename({ ...period, ext: 'csv' }) })}>
              <FiDownload /> CSV / Excel
            </button>
            <button className="btn btn-primary" onClick={() => openCashPdf({ report, title, periodLabel })}>
              <FiDownload /> PDF imprimable
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// ─── Coquille de modale (mirroir de InvoicesPanel) ──────────
function ModalShell({ children, onClose, narrow }) {
  return (
    <div className="ac-modal-backdrop" onClick={onClose}>
      <div className={`ac-modal ${narrow ? '' : 'ac-modal-wide'}`} onClick={e => e.stopPropagation()}>
        <div className="ac-modal-body" style={{ position: 'relative' }}>
          <button className="ac-modal-close" onClick={onClose} aria-label="Fermer" style={{ position: 'absolute', top: 8, right: 8 }}><FiX /></button>
          {children}
        </div>
      </div>
    </div>
  );
}
