import { useState, useEffect, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  FiTrendingDown, FiPlus, FiX, FiRefreshCw, FiCalendar, FiSearch, FiList,
  FiDownload, FiAlertTriangle, FiCheck, FiSlash, FiDatabase, FiPlusCircle,
} from 'react-icons/fi';
import {
  listExpenses, getExpense, createExpense, cancelExpense, acknowledgeExpense,
  getExpenseMeta, getCashSources, createCashSource, createTopup, getCashReport,
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

const STATUS_OPTIONS = [
  { value: '', label: 'Tous statuts' },
  { value: 'recorded', label: 'Enregistrées' },
  { value: 'cancelled', label: 'Annulées' },
];

function statusBadge(status) {
  if (status === 'cancelled') return <span className="ac-badge ac-badge-cancel">Annulée</span>;
  return <span className="ac-badge ac-badge-paid">Enregistrée</span>;
}

const ACTION_LABELS = { create: 'Création', cancel: 'Annulation' };

// Style libellé champ (classe ac-label inexistante dans Accounting.css → inline).
const labelStyle = { display: 'block', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#6b7280', marginBottom: 2 };

export default function ExpensesPanel() {
  const [data, setData] = useState({ expenses: [], total: 0, pages: 1, kpis: { total: 0, nb: 0, by_category: [] } });
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState({ categories: [], methods: [] });
  const [sources, setSources] = useState([]);
  const [filters, setFilters] = useState({
    category: '', method: '', source_id: '', status: '',
    search: '', date_from: firstDayOfMonth(), date_to: today(), page: 1,
  });
  const [selected, setSelected] = useState(null);   // détail dépense
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [reportModal, setReportModal] = useState(null); // 'daily' | 'monthly'

  // role courant (fourni par AdminDashboard via Outlet) — réserve annulation / sources aux admins
  const ctx = useOutletContext() || {};
  const isAdmin = ctx.adminRole === 'super_admin' || ctx.adminRole === 'admin';

  const reload = useCallback(() => {
    setLoading(true);
    listExpenses(filters)
      .then(r => { setData(r.data); setLoading(false); })
      .catch(() => { toast.error('Erreur chargement des dépenses'); setLoading(false); });
  }, [filters]);

  const reloadSources = useCallback(() => {
    getCashSources().then(r => setSources(r.data.sources || [])).catch(() => {});
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    getExpenseMeta().then(r => setMeta(r.data)).catch(() => {});
    reloadSources();
  }, [reloadSources]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));
  const changePage = (p) => setFilters(f => ({ ...f, page: p }));

  const openDetail = async (id) => {
    setSelected({ loading: true });
    try { const r = await getExpense(id); setSelected(r.data); }
    catch { toast.error('Erreur chargement de la dépense'); setSelected(null); }
  };

  const onCreated = () => { setCreateOpen(false); reload(); reloadSources(); };
  const onCancelled = () => { setCancelTarget(null); reload(); reloadSources(); if (selected?.expense?.id) openDetail(selected.expense.id); };

  const ack = async (id) => {
    try { await acknowledgeExpense(id); reload(); }
    catch { toast.error('Erreur'); }
  };

  const totalBalance = useMemo(() => sources.reduce((s, x) => s + (x.balance || 0), 0), [sources]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiTrendingDown /> Sorties d'argent ({data.total})
        </h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <FiPlus size={14} /> Nouvelle sortie
          </button>
          <button className="btn btn-outline" onClick={() => setSourcesOpen(true)}>
            <FiDatabase size={14} /> Sources & soldes
          </button>
          <button className="btn btn-outline" onClick={() => setReportModal('daily')}>
            <FiCalendar size={14} /> Rapport journalier
          </button>
          <button className="btn btn-outline" onClick={() => setReportModal('monthly')}>
            <FiCalendar size={14} /> Rapport mensuel
          </button>
        </div>
      </div>

      {/* KPIs */}
      {!loading && (
        <div className="ac-breakdown">
          <div className="ac-breakdown-item" style={{ background: '#fff7ed' }}>
            <strong style={{ color: '#9a3412' }}>{formatPrice(data.kpis.total || 0)}</strong>
            Total dépenses ({data.kpis.nb || 0})
          </div>
          <div className="ac-breakdown-item" style={{ background: '#ecfdf5' }}>
            <strong style={{ color: '#166534' }}>{formatPrice(totalBalance)}</strong>
            Solde de caisse global
          </div>
          {(data.kpis.by_category || []).slice(0, 3).map(c => (
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
        <select value={filters.method} onChange={e => update('method', e.target.value)}>
          <option value="">Toutes méthodes</option>
          {meta.methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <select value={filters.source_id} onChange={e => update('source_id', e.target.value)}>
          <option value="">Toutes sources</option>
          {sources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
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
                  <th>Méthode</th><th>Source</th><th style={{ textAlign: 'right' }}>Montant</th>
                  <th>Saisi par</th><th>Statut</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.expenses.length === 0 ? (
                  <tr><td colSpan={10} style={{ textAlign: 'center', color: '#94a3b8', padding: 24 }}>Aucune dépense</td></tr>
                ) : data.expenses.map(e => (
                  <tr key={e.id} style={{ cursor: 'pointer', opacity: e.status === 'cancelled' ? 0.55 : 1 }} onClick={() => openDetail(e.id)}>
                    <td>{fmtDate(e.expense_date || e.created_at)}</td>
                    <td style={{ fontFamily: 'monospace' }}>{e.ref}</td>
                    <td>{e.category_label}</td>
                    <td>{e.beneficiary}</td>
                    <td>{e.method_label}</td>
                    <td>{e.source_label}</td>
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

          {/* Pagination */}
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
      {createOpen && <CreateModal meta={meta} sources={sources} onClose={() => setCreateOpen(false)} onDone={onCreated} />}
      {cancelTarget && <CancelModal expense={cancelTarget} onClose={() => setCancelTarget(null)} onDone={onCancelled} />}
      {sourcesOpen && <SourcesModal sources={sources} isAdmin={isAdmin} onClose={() => setSourcesOpen(false)} onChanged={reloadSources} />}
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
        <div><span style={labelStyle}>Méthode</span>{expense.method_label}</div>
        <div><span style={labelStyle}>Source</span>{expense.source_label}</div>
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

// ─── Modal création ─────────────────────────────────────────
function CreateModal({ meta, sources, onClose, onDone }) {
  const [form, setForm] = useState({
    amount: '', category: '', beneficiary: '', payment_method: '',
    source_id: '', expense_date: today(), reason: '', note: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const activeSources = sources.filter(s => s.is_active);

  const submit = async (e) => {
    e.preventDefault();
    if (!form.amount || Number(form.amount) <= 0) return toast.error('Montant invalide');
    if (!form.category) return toast.error('Catégorie requise');
    if (!form.beneficiary.trim()) return toast.error('Bénéficiaire requis');
    if (!form.payment_method) return toast.error('Méthode requise');
    if (!form.source_id) return toast.error('Source de fonds requise');
    if (form.reason.trim().length < 4) return toast.error('Motif/justification requis (4 caractères min.)');
    setSubmitting(true);
    try {
      await createExpense(form);
      toast.success('Sortie enregistrée — admins notifiés');
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur enregistrement');
      setSubmitting(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiPlus /> Nouvelle sortie d'argent</h3>
      <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }} className="ac-form">
        <label>Montant (FCFA) *
          <input type="number" min="1" step="1" value={form.amount} onChange={e => set('amount', e.target.value)} autoFocus />
        </label>
        <label>Catégorie *
          <select value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">— Choisir —</option>
            {meta.categories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label>Bénéficiaire *
          <input type="text" value={form.beneficiary} onChange={e => set('beneficiary', e.target.value)} placeholder="Nom du fournisseur / personne" />
        </label>
        <label>Méthode de paiement *
          <select value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>
            <option value="">— Choisir —</option>
            {meta.methods.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
        <label>Source des fonds *
          <select value={form.source_id} onChange={e => set('source_id', e.target.value)}>
            <option value="">— Choisir —</option>
            {activeSources.map(s => <option key={s.id} value={s.id}>{s.label} (solde : {formatPrice(s.balance)})</option>)}
          </select>
        </label>
        <label>Date
          <input type="date" value={form.expense_date} onChange={e => set('expense_date', e.target.value)} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>Motif / justification *
          <textarea rows={2} value={form.reason} onChange={e => set('reason', e.target.value)} placeholder="Pourquoi cette dépense ?" />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>Note (facultatif)
          <textarea rows={2} value={form.note} onChange={e => set('note', e.target.value)} />
        </label>
        <div className="ac-modal-footer" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#9a3412', fontSize: '0.82rem' }}>
            <FiAlertTriangle /> Les administrateurs seront notifiés de ce retrait.
          </div>
          <button type="button" className="btn btn-outline" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? 'Enregistrement…' : 'Enregistrer la sortie'}</button>
        </div>
      </form>
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
      <p>Cette annulation est tracée et recrédite le solde de la source. Montant : <strong>{formatPrice(expense.amount)}</strong>.</p>
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

// ─── Modal sources & soldes ─────────────────────────────────
function SourcesModal({ sources, isAdmin, onClose, onChanged }) {
  const [topupFor, setTopupFor] = useState(null);
  const [topupAmount, setTopupAmount] = useState('');
  const [newSource, setNewSource] = useState({ label: '', type: 'caisse', opening_balance: '' });
  const [busy, setBusy] = useState(false);

  const doTopup = async (sourceId) => {
    if (!topupAmount || Number(topupAmount) <= 0) return toast.error('Montant invalide');
    setBusy(true);
    try {
      await createTopup({ source_id: sourceId, amount: topupAmount });
      toast.success('Source approvisionnée');
      setTopupFor(null); setTopupAmount(''); onChanged();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    setBusy(false);
  };

  const addSource = async (e) => {
    e.preventDefault();
    if (!newSource.label.trim()) return toast.error('Libellé requis');
    setBusy(true);
    try {
      await createCashSource(newSource);
      toast.success('Source créée');
      setNewSource({ label: '', type: 'caisse', opening_balance: '' }); onChanged();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    setBusy(false);
  };

  return (
    <ModalShell onClose={onClose}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiDatabase /> Sources de fonds & soldes</h3>
      <table className="ac-table">
        <thead><tr><th>Source</th><th>Type</th><th style={{ textAlign: 'right' }}>Solde</th>{isAdmin && <th></th>}</tr></thead>
        <tbody>
          {sources.map(s => (
            <tr key={s.id}>
              <td>{s.label}</td>
              <td>{s.type_label}</td>
              <td style={{ textAlign: 'right', fontWeight: 600, color: s.balance < 0 ? '#991b1b' : '#166534' }}>{formatPrice(s.balance)}</td>
              {isAdmin && (
                <td onClick={e => e.stopPropagation()}>
                  {topupFor === s.id ? (
                    <span style={{ display: 'flex', gap: 4 }}>
                      <input type="number" min="1" value={topupAmount} onChange={e => setTopupAmount(e.target.value)} style={{ width: 100 }} autoFocus />
                      <button className="btn btn-tiny btn-primary" disabled={busy} onClick={() => doTopup(s.id)}><FiCheck size={12} /></button>
                      <button className="btn btn-tiny btn-outline" onClick={() => setTopupFor(null)}><FiX size={12} /></button>
                    </span>
                  ) : (
                    <button className="btn btn-tiny btn-outline" onClick={() => { setTopupFor(s.id); setTopupAmount(''); }}><FiPlusCircle size={12} /> Approvisionner</button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {isAdmin && (
        <form onSubmit={addSource} style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '1 1 160px' }}>Nouvelle source
            <input type="text" value={newSource.label} onChange={e => setNewSource(s => ({ ...s, label: e.target.value }))} placeholder="Libellé" />
          </label>
          <label>Type
            <select value={newSource.type} onChange={e => setNewSource(s => ({ ...s, type: e.target.value }))}>
              <option value="caisse">Caisse</option>
              <option value="banque">Banque</option>
              <option value="mobile">Mobile money</option>
            </select>
          </label>
          <label>Solde d'ouverture
            <input type="number" min="0" value={newSource.opening_balance} onChange={e => setNewSource(s => ({ ...s, opening_balance: e.target.value }))} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}><FiPlus size={14} /> Ajouter</button>
        </form>
      )}
      <div className="ac-modal-footer"><button className="btn btn-outline" onClick={onClose}>Fermer</button></div>
    </ModalShell>
  );
}

// ─── Modal rapport de caisse ────────────────────────────────
function ReportModal({ kind, onClose }) {
  const [dateIso, setDateIso] = useState(today());
  const [yearMonth, setYearMonth] = useState(today().slice(0, 7));
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);

  const period = kind === 'daily'
    ? { kind, dateIso }
    : { kind, yearMonth };
  const range = kind === 'daily' ? dailyRange(dateIso) : monthlyRange(yearMonth);
  const periodLabel = formatPeriodLabel(period);

  const load = useCallback(() => {
    setLoading(true);
    getCashReport(range)
      .then(r => { setReport(r.data); setLoading(false); })
      .catch(() => { toast.error('Erreur génération du rapport'); setLoading(false); });
  }, [range.date_from, range.date_to]); // eslint-disable-line react-hooks/exhaustive-deps

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
