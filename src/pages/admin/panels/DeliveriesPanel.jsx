import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FiTruck, FiSearch, FiPlus, FiX, FiDownload, FiCheckCircle, FiTrash2,
  FiAlertCircle, FiAlertTriangle, FiPackage, FiFileText, FiChevronLeft, FiChevronRight,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import {
  listDeliveries, getDelivery, createDelivery, validateDelivery, deleteDelivery,
  getDeliveryWarehouses, searchDeliveryClients, searchDeliveryProducts,
  searchDeliveryInvoices, deliveryFromInvoice, openDeliveryPdf,
} from '../../../api/deliveries';
import './Deliveries.css';

const fmtDate = (s) => (s ? new Date(s.replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// ════════════════════════════════════════════════════════════
// MODALE DE CRÉATION
// ════════════════════════════════════════════════════════════
function CreateModal({ warehouses, onClose, onCreated }) {
  const [mode, setMode] = useState('blank'); // 'blank' | 'invoice'
  const [submitting, setSubmitting] = useState(false);

  // Client
  const [client, setClient] = useState({ fk_soc: null, client_name: '', client_address: '', client_zip: '', client_town: '' });
  const [clientQuery, setClientQuery] = useState('');
  const [clientResults, setClientResults] = useState([]);

  // Source facture
  const [invoiceQuery, setInvoiceQuery] = useState('');
  const [invoiceResults, setInvoiceResults] = useState([]);
  const [source, setSource] = useState(null); // { type:'invoice', id, ref }

  // Lignes
  const [lines, setLines] = useState([]);
  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState([]);

  // Options
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id || '');
  const [decrementStock, setDecrementStock] = useState(true);
  const [note, setNote] = useState('');

  const timers = useRef({});
  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const debounced = (key, fn) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(fn, 300);
  };

  // Quand on passe en mode facture, le défaut sûr est : NE PAS décrémenter
  // (la facture a déjà décrémenté le stock — anti double-décrément).
  const switchMode = (m) => {
    setMode(m);
    setDecrementStock(m === 'blank');
    setSource(null);
    setLines([]);
  };

  const onClientSearch = (q) => {
    setClientQuery(q);
    if (q.length < 2) { setClientResults([]); return; }
    debounced('client', () => searchDeliveryClients(q).then(r => setClientResults(r.data.clients || [])).catch(() => {}));
  };
  const pickClient = (c) => {
    setClient({ fk_soc: c.id, client_name: c.name, client_address: c.address || '', client_zip: c.zip || '', client_town: c.town || '' });
    setClientResults([]); setClientQuery('');
  };

  const onInvoiceSearch = (q) => {
    setInvoiceQuery(q);
    debounced('inv', () => searchDeliveryInvoices(q).then(r => setInvoiceResults(r.data.invoices || [])).catch(() => {}));
  };
  const pickInvoice = async (inv) => {
    try {
      const { data } = await deliveryFromInvoice(inv.id);
      setSource(data.source);
      setClient({
        fk_soc: data.client.id, client_name: data.client.name,
        client_address: data.client.address, client_zip: data.client.zip, client_town: data.client.town,
      });
      setLines(data.lines.map((l, i) => ({ ...l, _k: `inv${i}` })));
      setInvoiceResults([]); setInvoiceQuery('');
      setDecrementStock(false); // facture déjà décrémentée
    } catch {
      toast.error('Erreur chargement de la facture');
    }
  };

  const onProductSearch = (q) => {
    setProductQuery(q);
    if (q.length < 2) { setProductResults([]); return; }
    debounced('prod', () => searchDeliveryProducts(q).then(r => setProductResults(r.data.products || [])).catch(() => {}));
  };
  const addProduct = (p) => {
    setLines(prev => [...prev, { product_id: p.id, ref: p.ref, label: p.label, qty: 1, _k: `p${p.id}-${prev.length}` }]);
    setProductResults([]); setProductQuery('');
  };
  const addFreeLine = () => setLines(prev => [...prev, { product_id: null, ref: '', label: '', qty: 1, _k: `f${prev.length}-${Date.now()}` }]);
  const updateLine = (idx, patch) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));

  const submit = async () => {
    if (submitting) return;
    if (!client.client_name.trim()) return toast.error('Destinataire requis');
    const clean = lines.filter(l => l.label.trim() && (parseInt(l.qty, 10) || 0) > 0);
    if (clean.length === 0) return toast.error('Au moins une ligne avec une quantité > 0');
    if (decrementStock && !warehouseId) return toast.error('Sélectionnez un entrepôt pour le décrément de stock');

    setSubmitting(true);
    try {
      const wh = warehouses.find(w => String(w.id) === String(warehouseId));
      const res = await createDelivery({
        ...client,
        source_type: mode,
        source_id: source?.id || null,
        source_ref: source?.ref || null,
        warehouse_id: decrementStock ? warehouseId : null,
        warehouse_name: decrementStock ? (wh?.name || null) : null,
        decrement_stock: decrementStock,
        note_public: note,
        lines: clean.map(l => ({ product_id: l.product_id, ref: l.ref, label: l.label, qty: l.qty })),
      });
      toast.success(`Bon de livraison ${res.data.ref} créé`);
      onCreated(res.data.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="dl-overlay" onClick={() => !submitting && onClose()}>
      <div className="dl-modal dl-modal-lg" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="dl-modal-head">
          <h3><FiTruck size={20} /> Nouveau bon de livraison</h3>
          <button className="dl-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
        </div>

        <div className="dl-mode">
          <button className={mode === 'blank' ? 'active' : ''} onClick={() => switchMode('blank')}>BL libre</button>
          <button className={mode === 'invoice' ? 'active' : ''} onClick={() => switchMode('invoice')}>Depuis une facture</button>
        </div>

        {mode === 'invoice' && !source && (
          <div className="dl-field">
            <label>Rechercher la facture source</label>
            <div className="dl-search">
              <FiSearch size={15} className="dl-search-ic" />
              <input value={invoiceQuery} onChange={e => onInvoiceSearch(e.target.value)} placeholder="N° facture ou client..." />
            </div>
            {invoiceResults.length > 0 && (
              <div className="dl-search-results">
                {invoiceResults.map(inv => (
                  <div key={inv.id} className="dl-search-item" onClick={() => pickInvoice(inv)}>
                    <strong>{inv.ref}</strong> · {inv.customer_name} · {fmtDate(inv.date)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {source && (
          <div className="dl-callout"><FiFileText size={16} /> Source : facture <strong>{source.ref}</strong> — le stock a déjà été décrémenté par la facture.</div>
        )}

        {/* Destinataire */}
        <div className="dl-field">
          <label>Destinataire *</label>
          {mode === 'blank' && (
            <div className="dl-search">
              <FiSearch size={15} className="dl-search-ic" />
              <input value={clientQuery} onChange={e => onClientSearch(e.target.value)} placeholder="Rechercher un client Dolibarr (ou saisir librement ci-dessous)..." />
            </div>
          )}
          {clientResults.length > 0 && (
            <div className="dl-search-results">
              {clientResults.map(c => (
                <div key={c.id} className="dl-search-item" onClick={() => pickClient(c)}>
                  <strong>{c.name}</strong>{c.town ? ` · ${c.town}` : ''}{c.email ? ` · ${c.email}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="dl-grid-2">
          <div className="dl-field"><label>Nom du destinataire</label>
            <input value={client.client_name} onChange={e => setClient(c => ({ ...c, client_name: e.target.value }))} maxLength={200} /></div>
          <div className="dl-field"><label>Ville</label>
            <input value={client.client_town} onChange={e => setClient(c => ({ ...c, client_town: e.target.value }))} maxLength={120} /></div>
        </div>
        <div className="dl-grid-2">
          <div className="dl-field"><label>Adresse</label>
            <input value={client.client_address} onChange={e => setClient(c => ({ ...c, client_address: e.target.value }))} maxLength={300} /></div>
          <div className="dl-field"><label>Code postal</label>
            <input value={client.client_zip} onChange={e => setClient(c => ({ ...c, client_zip: e.target.value }))} maxLength={30} /></div>
        </div>

        {/* Lignes */}
        <div className="dl-field">
          <label>Articles livrés *</label>
          <div className="dl-search">
            <FiSearch size={15} className="dl-search-ic" />
            <input value={productQuery} onChange={e => onProductSearch(e.target.value)} placeholder="Rechercher un livre (réf, titre, ISBN)..." />
          </div>
          {productResults.length > 0 && (
            <div className="dl-search-results">
              {productResults.map(p => (
                <div key={p.id} className="dl-search-item" onClick={() => addProduct(p)}>
                  <strong>{p.label}</strong> <span className="dl-line-sub">{p.ref}{p.isbn ? ` · ${p.isbn}` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          {lines.length > 0 && (
            <div className="dl-line dl-line-head">
              <span>Désignation</span>
              <span style={{ textAlign: 'center' }}>Qté</span>
              <span />
            </div>
          )}
          {lines.map((l, idx) => (
            <div key={l._k} className="dl-line">
              <div>
                <input value={l.label} onChange={e => updateLine(idx, { label: e.target.value })} placeholder="Désignation" style={{ width: '100%' }} />
                {(l.ref || l.product_id) && <span className="dl-line-sub">{l.ref}{l.product_id ? ' · stock suivi' : ''}</span>}
              </div>
              <input
                type="number" min={1} step={1} value={l.qty}
                aria-label="Quantité" title="Quantité" placeholder="Qté"
                onChange={e => updateLine(idx, { qty: e.target.value })}
                style={{ textAlign: 'center' }}
              />
              <button className="dl-icon-btn" onClick={() => removeLine(idx)} aria-label="Retirer"><FiTrash2 size={16} /></button>
            </div>
          ))}
          <button className="dl-btn dl-btn-outline" onClick={addFreeLine} style={{ marginTop: 4 }}><FiPlus size={14} /> Ligne libre</button>
        </div>

        {/* Stock */}
        <div className="dl-field" style={{ marginTop: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={decrementStock} onChange={e => setDecrementStock(e.target.checked)} style={{ width: 'auto' }} />
            Décrémenter le stock Dolibarr à la validation
          </label>
          {mode === 'invoice' && decrementStock && (
            <div className="dl-callout"><FiAlertTriangle size={16} /> Attention : la facture source décrémente déjà le stock. Cocher cette case risque un <strong>double décrément</strong>.</div>
          )}
        </div>
        {decrementStock && (
          <div className="dl-field">
            <label>Entrepôt de départ</label>
            <select className="dl-select" style={{ width: '100%' }} value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">— Sélectionner —</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}{w.location ? ` (${w.location})` : ''}</option>)}
            </select>
          </div>
        )}

        <div className="dl-field"><label>Note (visible sur le BL)</label>
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></div>

        <div className="dl-modal-actions">
          <button className="dl-btn dl-btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button className="dl-btn dl-btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Création…' : 'Créer le bon de livraison'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODALE DE DÉTAIL
// ════════════════════════════════════════════════════════════
function DetailModal({ id, onClose, onChanged }) {
  const [dto, setDto] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getDelivery(id).then(r => setDto(r.data)).catch(() => toast.error('Introuvable')).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const doValidate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await validateDelivery(id);
      const s = data.stock;
      if (!s.decremented) toast.success(`BL validé. ${s.skipped_reason || 'Stock non modifié.'}`);
      else if (s.failed?.length) toast(`BL validé. Stock : ${s.moved} OK, ${s.failed.length} échec(s).`, { icon: '⚠️' });
      else toast.success(`BL validé. Stock décrémenté (${s.moved} ligne(s)).`);
      onChanged(); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur validation');
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteDelivery(id);
      toast.success('Bon de livraison supprimé');
      onChanged(); onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression');
      setBusy(false);
    }
  };

  return (
    <div className="dl-overlay" onClick={() => !busy && onClose()}>
      <div className="dl-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        {loading || !dto ? <Loader /> : (
          <>
            <div className="dl-modal-head">
              <h3><FiTruck size={20} /> {dto.ref}
                <span className={`dl-badge dl-badge-${dto.status}`} style={{ marginLeft: 8 }}>{dto.statusLabel}</span>
              </h3>
              <button className="dl-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
            </div>

            <div className="dl-info-row"><span className="lbl">Destinataire</span><span className="val">{dto.client.name}</span></div>
            {(dto.client.address || dto.client.town) && (
              <div className="dl-info-row"><span className="lbl">Adresse</span><span className="val">{[dto.client.address, [dto.client.zip, dto.client.town].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</span></div>
            )}
            {dto.source?.type === 'invoice' && dto.source.ref && (
              <div className="dl-info-row"><span className="lbl">Facture source</span><span className="val">{dto.source.ref}</span></div>
            )}
            <div className="dl-info-row"><span className="lbl">Créé le</span><span className="val">{fmtDate(dto.createdAt)} · {dto.createdBy}</span></div>
            {dto.status === 'validated' && (
              <div className="dl-info-row"><span className="lbl">Validé le</span><span className="val">{fmtDate(dto.validatedAt)} · {dto.validatedBy}</span></div>
            )}
            <div className="dl-info-row"><span className="lbl">Stock</span><span className="val">
              {dto.status !== 'validated'
                ? (dto.decrementStock ? 'Sera décrémenté à la validation' : 'Non décrémenté (déjà fait par la facture)')
                : (dto.stockMoved ? 'Décrémenté ✓' : 'Non décrémenté')}
            </span></div>

            <h4 style={{ margin: '16px 0 6px', fontSize: '0.85rem', color: '#64748b' }}>ARTICLES ({dto.totalQty})</h4>
            <div className="dl-table-wrap">
              <table className="dl-table" style={{ minWidth: 0 }}>
                <thead><tr><th>Réf.</th><th>Désignation</th><th style={{ textAlign: 'center' }}>Qté</th></tr></thead>
                <tbody>
                  {dto.lines.map((l, i) => (
                    <tr key={i}><td>{l.ref || '—'}</td><td>{l.label}</td><td style={{ textAlign: 'center' }}>{l.qty}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {dto.notePublic && <p style={{ marginTop: 10, fontSize: '0.88rem', color: '#475569' }}>Note : {dto.notePublic}</p>}

            <div className="dl-modal-actions">
              {dto.status === 'draft' && !confirmDelete && (
                <button className="dl-btn dl-btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}><FiTrash2 size={14} /> Supprimer</button>
              )}
              {confirmDelete && (
                <button className="dl-btn dl-btn-danger" onClick={doDelete} disabled={busy}>{busy ? '…' : 'Confirmer la suppression'}</button>
              )}
              <button className="dl-btn dl-btn-outline" onClick={() => openDeliveryPdf(dto.id)}><FiDownload size={14} /> PDF</button>
              {dto.status === 'draft' && (
                <button className="dl-btn dl-btn-success" onClick={doValidate} disabled={busy}><FiCheckCircle size={14} /> {busy ? 'Validation…' : 'Valider'}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// PANNEAU PRINCIPAL
// ════════════════════════════════════════════════════════════
export default function DeliveriesPanel() {
  const [data, setData] = useState({ deliveries: [], total: 0, pages: 1, kpis: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({ status: '', search: '', page: 1 });
  const [warehouses, setWarehouses] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const reload = useCallback(() => {
    setLoading(true); setError(false);
    listDeliveries(filters)
      .then(r => setData(r.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => { getDeliveryWarehouses().then(r => setWarehouses(r.data.warehouses || [])).catch(() => {}); }, []);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiTruck /> Bons de livraison</h3>
        <button className="dl-btn dl-btn-primary" onClick={() => setShowCreate(true)}><FiPlus size={16} /> Nouveau BL</button>
      </div>

      <div className="dl-kpis">
        <div className="dl-kpi"><div className="dl-kpi-val">{data.total}</div><div className="dl-kpi-lbl">Bons de livraison</div></div>
        <div className="dl-kpi"><div className="dl-kpi-val" style={{ color: '#92400e' }}>{data.kpis?.nb_draft ?? 0}</div><div className="dl-kpi-lbl">Brouillons</div></div>
        <div className="dl-kpi"><div className="dl-kpi-val" style={{ color: '#166534' }}>{data.kpis?.nb_validated ?? 0}</div><div className="dl-kpi-lbl">Validés</div></div>
      </div>

      <div className="dl-toolbar">
        <div className="dl-search">
          <FiSearch size={15} className="dl-search-ic" />
          <input value={filters.search} onChange={e => update('search', e.target.value)} placeholder="Rechercher par n° ou destinataire..." />
        </div>
        <select className="dl-select" value={filters.status} onChange={e => update('status', e.target.value)}>
          <option value="">Tous statuts</option>
          <option value="draft">Brouillons</option>
          <option value="validated">Validés</option>
        </select>
      </div>

      {loading ? <Loader /> : error ? (
        <div className="dl-empty">
          <FiAlertCircle size={44} className="dl-empty-ic" style={{ color: '#ef4444' }} />
          <h3>Erreur de chargement</h3>
          <button className="dl-btn dl-btn-primary" onClick={reload} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : data.deliveries.length === 0 ? (
        <div className="dl-empty">
          <FiPackage size={44} className="dl-empty-ic" />
          <h3>Aucun bon de livraison</h3>
          <p>Créez-en un avec « Nouveau BL ».</p>
        </div>
      ) : (
        <>
          <div className="dl-table-wrap">
            <table className="dl-table">
              <thead><tr><th>N°</th><th>Destinataire</th><th style={{ textAlign: 'center' }}>Articles</th><th>Statut</th><th>Date</th><th></th></tr></thead>
              <tbody>
                {data.deliveries.map(d => (
                  <tr key={d.id} className="dl-row" onClick={() => setDetailId(d.id)}>
                    <td><span className="dl-ref">{d.ref}</span></td>
                    <td>{d.client.name}</td>
                    <td style={{ textAlign: 'center' }}>{d.totalQty}</td>
                    <td><span className={`dl-badge dl-badge-${d.status}`}>{d.statusLabel}</span></td>
                    <td>{fmtDate(d.createdAt)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button className="dl-icon-btn" onClick={() => openDeliveryPdf(d.id)} title="PDF"><FiDownload size={16} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <button className="dl-icon-btn" disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}><FiChevronLeft size={18} /></button>
              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Page {filters.page} / {data.pages}</span>
              <button className="dl-icon-btn" disabled={filters.page >= data.pages} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}><FiChevronRight size={18} /></button>
            </div>
          )}
        </>
      )}

      {showCreate && (
        <CreateModal
          warehouses={warehouses}
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); reload(); setDetailId(id); }}
        />
      )}
      {detailId && (
        <DetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={reload} />
      )}
    </div>
  );
}
