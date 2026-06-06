import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  getInventorySession, getInventoryLines, startInventorySession,
  countInventory, bulkCountInventory, resetInventoryLine, cancelInventorySession,
  inventoryReportPdfUrl, inventoryReportCsvUrl, getStockProducts,
} from '../../../api/admin';
import useAdminRole from '../../../hooks/useAdminRole';
import {
  FiArrowLeft, FiClipboard, FiPlay, FiLock, FiUploadCloud, FiRotateCcw,
  FiSearch, FiSlash, FiCheckCircle, FiMaximize, FiCornerDownLeft,
  FiFileText, FiDownload, FiPlus, FiMinus, FiX,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import InventoryClosePreviewModal from './InventoryClosePreviewModal';
import './Stock.css';
import './Inventory.css';

const MANAGE_ROLES = ['super_admin', 'admin', 'gestionnaire_stock'];
const STATUS_LABEL = { draft: 'Brouillon', counting: 'En comptage', closed: 'Clôturé', canceled: 'Annulé' };
const FILTERS = [
  { key: 'all', label: 'Tous' },
  { key: 'uncounted', label: 'Non comptés' },
  { key: 'counted', label: 'Comptés' },
  { key: 'variance', label: 'Écarts' },
];

function parseCsv(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split(/[;,\t]/).map(s => s.trim());
    return { barcode: parts[0], qty: Number(parts[1]) };
  }).filter(r => r.barcode && Number.isFinite(r.qty) && r.qty >= 0);
}

export default function InventoryCountPanel() {
  const { id } = useParams();
  const navigate = useNavigate();
  const role = useAdminRole();
  const canManage = MANAGE_ROLES.includes(role);

  const [session, setSession] = useState(null);
  const [lines, setLines] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [linesLoading, setLinesLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok, msg }

  const scanRef = useRef(null);
  const fileRef = useRef(null);
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const loadSession = useCallback(() => {
    return getInventorySession(id)
      .then(r => setSession(r.data))
      .catch(() => toast.error('Session introuvable'));
  }, [id]);

  const loadLines = useCallback(() => {
    setLinesLoading(true);
    return getInventoryLines(id, { filter, q: q.trim() || undefined, page, limit: 100 })
      .then(r => { setLines(r.data.lines || []); setTotal(r.data.total || 0); setPages(r.data.pages || 1); })
      .catch(() => {})
      .finally(() => setLinesLoading(false));
  }, [id, filter, q, page]);

  useEffect(() => { loadSession().finally(() => setLoading(false)); }, [loadSession]);
  useEffect(() => { if (session?.status && session.status !== 'draft') loadLines(); }, [loadLines, session?.status]);
  useEffect(() => { if (session?.status === 'counting') scanRef.current?.focus(); }, [session?.status]);

  const refreshStats = (stats) => setSession(s => s ? { ...s, stats } : s);
  const patchLine = (line) => setLines(ls => {
    const idx = ls.findIndex(l => l.id === line.id);
    if (idx === -1) return ls;
    const copy = [...ls]; copy[idx] = line; return copy;
  });

  // Applique un retour de comptage (scan/recherche/saisie) à l'écran.
  const applyCount = (data) => {
    refreshStats(data.stats);
    const present = linesRef.current.some(l => l.id === data.line.id);
    if (present) patchLine(data.line);
    else if (filter === 'all' || filter === 'counted' || filter === 'variance') loadLines();
  };

  // ── Scan ISBN / réf (incrément +1) ──
  const onScan = async (e) => {
    e.preventDefault();
    const code = scanRef.current?.value.trim();
    if (!code) return;
    try {
      const r = await countInventory(id, { barcode: code });
      applyCount(r.data);
      setFeedback({ ok: true, msg: `${r.data.line.product_label || r.data.line.product_ref} → ${r.data.line.qty_counted}` });
    } catch (err) {
      setFeedback({ ok: false, msg: err.response?.data?.error || 'Code inconnu' });
    } finally {
      if (scanRef.current) { scanRef.current.value = ''; scanRef.current.focus(); }
    }
  };

  // ── Saisie absolue (stepper / champ) ──
  const onCommitQty = async (line, value) => {
    const qty = value === '' ? null : Math.max(0, parseInt(value, 10));
    if (qty === null || qty === line.qty_counted) return;
    try {
      const r = await countInventory(id, { product_id: line.product_id, qty });
      refreshStats(r.data.stats);
      patchLine(r.data.line);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de saisie');
    }
  };

  // ── Ajout par recherche-titre (incrément +1) ──
  const onAddProduct = async (product) => {
    try {
      const r = await countInventory(id, { product_id: product.product_id });
      applyCount(r.data);
      toast.success(`${product.label} → ${r.data.line.qty_counted} compté(s)`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur ajout');
    }
  };

  const onReset = async (line) => {
    try {
      const r = await resetInventoryLine(id, line.id);
      refreshStats(r.data.stats);
      if (filter === 'uncounted' || filter === 'all') loadLines(); else patchLine({ ...line, qty_counted: null });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const onStart = async () => {
    if (!window.confirm('Démarrer le comptage ? Le stock théorique actuel sera figé comme référence.')) return;
    setBusy(true);
    try {
      const r = await startInventorySession(id);
      toast.success(`Comptage démarré — ${r.data.snapshot_lines} titre(s) figé(s)`);
      await loadSession();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur démarrage');
    } finally { setBusy(false); }
  };

  const onCancel = async () => {
    if (!window.confirm('Annuler cet inventaire ? Aucun mouvement de stock ne sera appliqué.')) return;
    try {
      await cancelInventorySession(id);
      toast.success('Inventaire annulé');
      navigate('/admin/inventory');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const onCsv = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const rows = parseCsv(text);
    if (!rows.length) { toast.error('CSV vide ou invalide (attendu : code;quantité par ligne)'); return; }
    setBusy(true);
    try {
      const r = await bulkCountInventory(id, rows);
      toast.success(`Import : ${r.data.applied} ligne(s) appliquée(s)${r.data.errors?.length ? `, ${r.data.errors.length} erreur(s)` : ''}`);
      refreshStats(r.data.stats);
      loadLines();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur import');
    } finally { setBusy(false); }
  };

  const onClosed = (res) => {
    setShowClose(false);
    loadSession();
    if (res?.success) loadLines();
  };

  if (loading) return <div className="admin-panel"><Loader /></div>;
  if (!session) return <div className="admin-panel"><div className="sk-empty"><p style={{ fontWeight: 600 }}>Session introuvable</p></div></div>;

  const st = session.stats || {};
  const pct = st.total > 0 ? Math.round((st.counted / st.total) * 100) : 0;
  const isCounting = session.status === 'counting';
  const isClosed = session.status === 'closed' || session.status === 'canceled';

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Link to="/admin/inventory" aria-label="Retour à la liste des inventaires" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <FiClipboard size={18} style={{ color: '#1e40af', flexShrink: 0 }} />
          <span className="mono" style={{ color: '#1e40af' }}>{session.ref}</span>
          {session.title && <span style={{ fontWeight: 500, color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {session.title}</span>}
        </h3>
        <span className={`inv-status ${session.status}`}>{STATUS_LABEL[session.status]}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <p style={{ color: '#64748b', fontSize: '0.85rem', margin: 0, flex: 1, minWidth: 160 }}>{session.scope_label}</p>
        {session.status !== 'draft' && (
          <div style={{ display: 'flex', gap: 8 }}>
            <a href={inventoryReportPdfUrl(session.id)} target="_blank" rel="noreferrer"
              className="inv-btn inv-btn-outline" style={{ textDecoration: 'none' }}>
              <FiFileText size={14} /> Rapport PDF
            </a>
            <a href={inventoryReportCsvUrl(session.id)}
              className="inv-btn inv-btn-outline" style={{ textDecoration: 'none' }}>
              <FiDownload size={14} /> CSV
            </a>
          </div>
        )}
      </div>

      {/* ── BROUILLON : démarrer ── */}
      {session.status === 'draft' && (
        <div className="sk-empty" style={{ padding: 32 }}>
          <FiPlay size={40} style={{ color: '#1e40af', marginBottom: 10 }} />
          <p style={{ fontWeight: 700, fontSize: '1rem' }}>Prêt à compter</p>
          <p style={{ fontSize: '0.86rem', color: '#64748b', maxWidth: 440, textAlign: 'center' }}>
            Le démarrage <strong>fige le stock théorique actuel</strong> comme référence. Vous
            scannerez ensuite les exemplaires physiquement présents.
          </p>
          {canManage ? (
            <button className="inv-btn inv-btn-primary" onClick={onStart} disabled={busy}
              style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
              <FiPlay size={16} /> {busy ? 'Démarrage…' : 'Démarrer le comptage'}
            </button>
          ) : <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 10 }}>En attente de démarrage par un gestionnaire de stock.</p>}
          {canManage && <button className="sk-btn-ghost" onClick={onCancel} style={{ marginTop: 8, color: '#dc2626', minHeight: 44 }}>Supprimer / annuler</button>}
        </div>
      )}

      {/* ── EN COMPTAGE : scan + cartes ── */}
      {isCounting && (
        <>
          {/* Barre de scan collante */}
          <div className="inv-scan-sticky">
            <form onSubmit={onScan} className="inv-scan-box">
              <FiMaximize className="lead" size={18} aria-hidden="true" />
              <input ref={scanRef} className="inv-scan-input" autoFocus inputMode="numeric" enterKeyHint="done"
                aria-label="Scanner ou saisir un ISBN ou une référence"
                placeholder="Scannez ou tapez un ISBN / une référence, puis Entrée…" />
            </form>
            <div className="inv-scan-feedback" aria-live="polite">
              {feedback
                ? <span className={feedback.ok ? 'ok' : 'err'} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {feedback.ok ? <FiCheckCircle size={15} /> : <FiSlash size={15} />}{feedback.msg}
                  </span>
                : <span style={{ color: '#94a3b8', fontWeight: 400, display: 'flex', alignItems: 'center', gap: 6 }}><FiCornerDownLeft size={13} /> chaque scan ajoute +1 à l'exemplaire</span>}
            </div>

            {/* Progression */}
            <div className="inv-progress-wrap" style={{ margin: '4px 0 6px' }}>
              <div className="inv-progress-head">
                <span>Avancement</span>
                <span><strong>{st.counted}</strong> / {st.total} comptés · {st.with_variance} écart(s)</span>
              </div>
              <div className="inv-progress-track"><div className="inv-progress-fill" style={{ width: `${pct}%` }} /></div>
            </div>

            <button type="button" className="inv-add-toggle" onClick={() => setShowAdd(v => !v)} aria-expanded={showAdd}>
              {showAdd ? <FiX size={15} /> : <FiPlus size={15} />} Titre sans code-barres ?
            </button>
          </div>

          {showAdd && <SearchAdd onAdd={onAddProduct} onClose={() => setShowAdd(false)} />}

          {/* Actions gestionnaire */}
          {canManage && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              <button className="inv-btn inv-btn-outline" onClick={() => fileRef.current?.click()} disabled={busy}
                style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44 }}>
                <FiUploadCloud size={15} /> Importer CSV
              </button>
              <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" hidden onChange={onCsv} aria-hidden="true" />
              <button className="inv-btn inv-btn-danger" onClick={onCancel}>Annuler la session</button>
              <button className="inv-btn inv-btn-primary" onClick={() => setShowClose(true)}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <FiLock size={15} /> Clôturer l'inventaire
              </button>
            </div>
          )}

          <LinesSection
            lines={lines} total={total} page={page} pages={pages} filter={filter} q={q}
            linesLoading={linesLoading} editable
            onFilter={(f) => { setFilter(f); setPage(1); }} onSearch={(v) => { setQ(v); setPage(1); }}
            onPage={setPage} onCommitQty={onCommitQty} onReset={onReset}
          />
        </>
      )}

      {/* ── CLÔTURÉ / ANNULÉ : résumé lecture seule ── */}
      {isClosed && (
        <>
          <div className="inv-stats" style={{ margin: '6px 0 16px' }}>
            <div className="inv-stat-pill"><span className="v">{st.total}</span><span className="l">Lignes</span></div>
            <div className="inv-stat-pill"><span className="v">{st.counted}</span><span className="l">Comptés</span></div>
            <div className="inv-stat-pill variance"><span className="v">{st.with_variance}</span><span className="l">Écarts</span></div>
          </div>
          {session.status === 'closed' && (
            <p style={{ fontSize: '0.82rem', color: '#64748b' }}>
              Clôturé par {session.closed_by} le {session.closed_at ? new Date(session.closed_at).toLocaleString('fr-FR') : '—'}. Les mouvements d'ajustement ont été appliqués au stock.
            </p>
          )}
          <LinesSection
            lines={lines} total={total} page={page} pages={pages} filter={filter} q={q}
            linesLoading={linesLoading} editable={false}
            onFilter={(f) => { setFilter(f); setPage(1); }} onSearch={(v) => { setQ(v); setPage(1); }}
            onPage={setPage}
          />
        </>
      )}

      {showClose && <InventoryClosePreviewModal session={session} onClose={() => setShowClose(false)} onClosed={onClosed} />}
    </div>
  );
}

// ─── Recherche-ajout (titres sans code-barres) ────────────────
function SearchAdd({ onAdd, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      getStockProducts({ q: term, limit: 12, sort: 'label', order: 'ASC' })
        .then(r => { if (!cancelled) setResults(r.data.products || []); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  return (
    <div className="inv-search-add">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontWeight: 600, fontSize: '0.85rem', flex: 1 }}>Ajouter un titre par recherche</span>
        <button className="inv-line-reset" onClick={onClose} aria-label="Fermer la recherche"><FiX size={16} /></button>
      </div>
      <div style={{ position: 'relative' }}>
        <FiSearch size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} aria-hidden="true" />
        <input ref={inputRef} type="text" value={q} onChange={e => setQ(e.target.value)}
          aria-label="Rechercher un titre à ajouter"
          placeholder="Titre, ISBN ou référence…" style={{ paddingLeft: 36 }} />
      </div>

      {q.trim().length >= 2 && (
        loading ? <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: '8px 4px' }}>Recherche…</p>
        : results.length === 0 ? <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: '8px 4px' }}>Aucun titre pour « {q} »</p>
        : (
          <div className="inv-search-results">
            {results.map(p => (
              <div key={p.product_id} className="inv-search-row">
                <div className="inv-search-row-main">
                  <div className="inv-search-row-title">{p.label}</div>
                  <div className="inv-search-row-meta">Réf. {p.ref} · stock {p.stock}</div>
                </div>
                <button className="inv-btn inv-btn-primary" onClick={() => onAdd(p)}
                  style={{ minHeight: 44, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <FiPlus size={14} /> Ajouter
                </button>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ─── Liste des lignes en cartes (filtre + recherche + pagination) ──
function LinesSection({ lines, total, page, pages, filter, q, linesLoading, editable, onFilter, onSearch, onPage, onCommitQty, onReset }) {
  return (
    <>
      <div className="sk-filters" style={{ marginBottom: 10, gap: 8, alignItems: 'center' }}>
        {FILTERS.map(f => (
          <button key={f.key} className={`sk-filter-btn ${filter === f.key ? 'active' : ''}`} style={{ minHeight: 44 }} onClick={() => onFilter(f.key)}>{f.label}</button>
        ))}
        <div className="inv-filter-search">
          <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} aria-hidden="true" />
          <input value={q} onChange={e => onSearch(e.target.value)} placeholder="Filtrer titre/réf…" aria-label="Filtrer les lignes" />
        </div>
      </div>

      {linesLoading ? <Loader /> : lines.length === 0 ? (
        <div className="sk-empty"><p style={{ fontWeight: 600 }}>Aucune ligne</p></div>
      ) : (
        <div className="inv-line-list">
          {lines.map(l => <LineCard key={l.id} line={l} editable={editable} onCommitQty={onCommitQty} onReset={onReset} />)}
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 14, fontSize: '0.85rem', color: '#64748b' }}>
          <button className="sk-btn-ghost" style={{ minHeight: 44 }} disabled={page <= 1} onClick={() => onPage(page - 1)}>← Précédent</button>
          <span>Page {page} / {pages} · {total} lignes</span>
          <button className="sk-btn-ghost" style={{ minHeight: 44 }} disabled={page >= pages} onClick={() => onPage(page + 1)}>Suivant →</button>
        </div>
      )}
    </>
  );
}

function DeltaPill({ delta }) {
  if (delta == null) return <span className="inv-delta zero">—</span>;
  const cls = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero';
  return <span className={`inv-delta ${cls}`}>{delta > 0 ? '+' : ''}{delta}</span>;
}

function LineCard({ line, editable, onCommitQty, onReset }) {
  const [val, setVal] = useState(line.qty_counted == null ? '' : String(line.qty_counted));
  useEffect(() => { setVal(line.qty_counted == null ? '' : String(line.qty_counted)); }, [line.qty_counted]);

  const counted = line.qty_counted;
  const delta = counted == null ? null : counted - line.qty_snapshot;
  const cur = val === '' ? null : Math.max(0, parseInt(val, 10) || 0);

  const setAndCommit = (n) => { setVal(String(n)); onCommitQty(line, String(n)); };

  return (
    <div className="inv-line">
      <div className="inv-line-main">
        <div className="inv-line-title">{line.product_label}</div>
        <div className="inv-line-ref">{line.product_ref}</div>
      </div>
      <div className="inv-line-theo">Théo.<strong>{line.qty_snapshot}</strong></div>
      <div className="inv-line-ctrl">
        {editable ? (
          <>
            <div className="inv-stepper">
              <button type="button" className="inv-step-btn" aria-label={`Retirer un exemplaire de ${line.product_label}`}
                onClick={() => setAndCommit(Math.max(0, (cur ?? 0) - 1))} disabled={(cur ?? 0) <= 0}>
                <FiMinus size={16} />
              </button>
              <input type="number" min={0} inputMode="numeric" value={val}
                className={`inv-qty-input ${counted != null ? 'counted' : ''}`}
                aria-label={`Quantité comptée pour ${line.product_label}`}
                onChange={e => setVal(e.target.value)}
                onBlur={() => onCommitQty(line, val)}
                onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
              <button type="button" className="inv-step-btn" aria-label={`Ajouter un exemplaire de ${line.product_label}`}
                onClick={() => setAndCommit((cur ?? 0) + 1)}>
                <FiPlus size={16} />
              </button>
            </div>
            <DeltaPill delta={delta} />
            <button type="button" className="inv-line-reset" aria-label={`Réinitialiser le comptage de ${line.product_label}`}
              onClick={() => onReset(line)} disabled={counted == null}>
              <FiRotateCcw size={15} />
            </button>
          </>
        ) : (
          <>
            <span className="inv-line-readval">{counted == null ? '—' : counted}</span>
            <DeltaPill delta={delta} />
          </>
        )}
      </div>
    </div>
  );
}
