import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FiArchive, FiSearch, FiPlus, FiX, FiDownload, FiCheckCircle, FiTrash2,
  FiAlertCircle, FiAlertTriangle, FiPackage, FiUsers, FiFileText, FiDollarSign,
  FiCornerUpLeft, FiEdit2,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import {
  getConsignmentStats, getConsignmentWarehouses, searchConsignmentProducts,
  listConsignors, createConsignor, updateConsignor, searchConsignorTiers,
  listDeposits, getDeposit, createDeposit, validateDeposit, deleteDeposit, returnDeposit,
  previewSettlement, listSettlements, getSettlement, createSettlement, paySettlement, deleteSettlement, openSettlementPdf,
} from '../../../api/consignments';
import './Consignment.css';

const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtFcfa = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} FCFA`;

// ════════════════════════════════════════════════════════════
// MODALE DÉPOSANT
// ════════════════════════════════════════════════════════════
function ConsignorModal({ consignor, onClose, onSaved }) {
  const editing = !!consignor;
  const [form, setForm] = useState({
    fk_soc: consignor?.fk_soc || null,
    name: consignor?.name || '',
    contact_email: consignor?.contact_email || '',
    contact_phone: consignor?.contact_phone || '',
    default_commission_rate: consignor?.default_commission_rate ?? 30,
    notes: consignor?.notes || '',
  });
  const [tierQuery, setTierQuery] = useState('');
  const [tierResults, setTierResults] = useState([]);
  const [saving, setSaving] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const searchTiers = (q) => {
    setTierQuery(q);
    if (q.length < 2) { setTierResults([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => searchConsignorTiers(q).then(r => setTierResults(r.data.results || [])).catch(() => {}), 300);
  };
  const pickTier = (t) => {
    setForm(f => ({ ...f, fk_soc: t.id, name: t.name, contact_email: t.email || f.contact_email, contact_phone: t.phone || f.contact_phone }));
    setTierResults([]); setTierQuery('');
  };

  const submit = async () => {
    if (saving) return;
    if (!form.name.trim()) return toast.error('Nom du déposant requis');
    setSaving(true);
    try {
      if (editing) await updateConsignor(consignor.id, form);
      else await createConsignor(form);
      toast.success(editing ? 'Déposant mis à jour' : 'Déposant créé');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur enregistrement');
    } finally { setSaving(false); }
  };

  return (
    <div className="cv-overlay" onClick={() => !saving && onClose()}>
      <div className="cv-modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="cv-modal-head">
          <h3><FiUsers size={20} /> {editing ? 'Modifier le déposant' : 'Nouveau déposant'}</h3>
          <button className="cv-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
        </div>

        {!editing && (
          <div className="cv-field">
            <label>Rattacher un tiers Dolibarr (facultatif)</label>
            <div className="cv-search">
              <FiSearch size={15} className="cv-search-ic" />
              <input value={tierQuery} onChange={e => searchTiers(e.target.value)} placeholder="Rechercher un tiers existant…" />
            </div>
            {tierResults.length > 0 && (
              <div className="cv-search-results">
                {tierResults.map(t => (
                  <div key={t.id} className={`cv-search-item${t.already_consignor ? ' disabled' : ''}`} onClick={() => !t.already_consignor && pickTier(t)}>
                    <strong>{t.name}</strong>{t.town ? ` · ${t.town}` : ''}{t.email ? ` · ${t.email}` : ''}
                    {t.already_consignor && <span className="cv-line-sub"> — déjà déposant</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="cv-field"><label>Nom du déposant *</label>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} maxLength={200} /></div>
        <div className="cv-grid-2">
          <div className="cv-field"><label>Email</label>
            <input value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} maxLength={200} /></div>
          <div className="cv-field"><label>Téléphone</label>
            <input value={form.contact_phone} onChange={e => setForm(f => ({ ...f, contact_phone: e.target.value }))} maxLength={50} /></div>
        </div>
        <div className="cv-field"><label>Commission L'Harmattan par défaut (%)</label>
          <input type="number" min={0} max={100} step={0.5} value={form.default_commission_rate}
            onChange={e => setForm(f => ({ ...f, default_commission_rate: e.target.value }))} />
          <span className="cv-line-sub">Part retenue par L'Harmattan ; le reste est reversé au déposant.</span>
        </div>
        <div className="cv-field"><label>Notes</label>
          <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} maxLength={1000} /></div>

        <div className="cv-modal-actions">
          <button className="cv-btn cv-btn-outline" onClick={onClose} disabled={saving}>Annuler</button>
          <button className="cv-btn cv-btn-primary" onClick={submit} disabled={saving}>{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODALE CRÉATION DÉPÔT
// ════════════════════════════════════════════════════════════
function DepositModal({ consignors, warehouses, onClose, onCreated }) {
  const [consignorId, setConsignorId] = useState(consignors[0]?.id || '');
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id || '');
  const [depositDate, setDepositDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([]);
  const [productQuery, setProductQuery] = useState('');
  const [productResults, setProductResults] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const consignor = consignors.find(c => String(c.id) === String(consignorId));
  const defaultRate = consignor?.default_commission_rate ?? 30;

  const onProductSearch = (q) => {
    setProductQuery(q);
    if (q.length < 2) { setProductResults([]); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => searchConsignmentProducts(q).then(r => setProductResults(r.data.products || [])).catch(() => {}), 300);
  };
  const addProduct = (p) => {
    setLines(prev => [...prev, {
      product_id: p.id, isbn: p.isbn || '', label: p.label, author: '',
      qty: 1, sale_price_ttc: p.price_ttc || 0, commission_rate: defaultRate,
      _k: `p${p.id}-${prev.length}`, _consigned: p.consigned_by,
    }]);
    setProductResults([]); setProductQuery('');
  };
  const addManual = () => setLines(prev => [...prev, {
    product_id: null, isbn: '', label: '', author: '', qty: 1, sale_price_ttc: 0, commission_rate: defaultRate,
    _k: `m${prev.length}-${Date.now()}`,
  }]);
  const updateLine = (idx, patch) => setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const removeLine = (idx) => setLines(prev => prev.filter((_, i) => i !== idx));

  const totalValue = lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0) * (parseFloat(l.sale_price_ttc) || 0), 0);

  const submit = async () => {
    if (submitting) return;
    if (!consignorId) return toast.error('Sélectionnez un déposant');
    const clean = lines.filter(l => l.label.trim() && (parseInt(l.qty, 10) || 0) > 0 && (l.product_id || /^(97[89]\d{10}|\d{10})$/.test(String(l.isbn).replace(/[-\s]/g, ''))));
    if (clean.length === 0) return toast.error('Au moins une ligne valide (ISBN/titre + quantité)');
    setSubmitting(true);
    try {
      const wh = warehouses.find(w => String(w.id) === String(warehouseId));
      const res = await createDeposit({
        consignor_id: consignorId,
        warehouse_id: warehouseId || null,
        warehouse_name: wh?.name || null,
        deposit_date: depositDate,
        note,
        lines: clean.map(l => ({ product_id: l.product_id, isbn: l.isbn, label: l.label, author: l.author, qty: l.qty, sale_price_ttc: l.sale_price_ttc, commission_rate: l.commission_rate })),
      });
      toast.success(`Dépôt ${res.data.ref} créé`);
      onCreated(res.data.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="cv-overlay" onClick={() => !submitting && onClose()}>
      <div className="cv-modal cv-modal-lg" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="cv-modal-head">
          <h3><FiArchive size={20} /> Nouveau dépôt</h3>
          <button className="cv-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
        </div>

        <div className="cv-grid-3">
          <div className="cv-field"><label>Déposant *</label>
            <select className="cv-select" style={{ width: '100%' }} value={consignorId} onChange={e => setConsignorId(e.target.value)}>
              <option value="">— Sélectionner —</option>
              {consignors.map(c => <option key={c.id} value={c.id}>{c.name} ({c.default_commission_rate}%)</option>)}
            </select>
          </div>
          <div className="cv-field"><label>Entrepôt d'entrée</label>
            <select className="cv-select" style={{ width: '100%' }} value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">— Sélectionner —</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="cv-field"><label>Date du dépôt</label>
            <input type="date" value={depositDate} onChange={e => setDepositDate(e.target.value)} /></div>
        </div>

        <div className="cv-field">
          <label>Ajouter un titre (recherche catalogue) ou saisir manuellement</label>
          <div className="cv-search">
            <FiSearch size={15} className="cv-search-ic" />
            <input value={productQuery} onChange={e => onProductSearch(e.target.value)} placeholder="ISBN, titre ou référence…" />
          </div>
          {productResults.length > 0 && (
            <div className="cv-search-results">
              {productResults.map(p => (
                <div key={p.id} className="cv-search-item" onClick={() => addProduct(p)}>
                  <strong>{p.label}</strong> <span className="cv-line-sub">{p.isbn}{p.price_ttc ? ` · ${fmtFcfa(p.price_ttc)}` : ''}{p.consigned_by ? ' · déjà consigné' : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {lines.length > 0 && (
          <div className="cv-line cv-line-head" style={{ marginBottom: 4 }}>
            <div>Titre · ISBN</div><div>Qté</div><div>Prix vente</div><div>Comm. %</div><div></div>
          </div>
        )}
        {lines.map((l, idx) => (
          <div key={l._k} className="cv-line">
            <div>
              <input value={l.label} onChange={e => updateLine(idx, { label: e.target.value })} placeholder="Titre" />
              <input value={l.isbn} onChange={e => updateLine(idx, { isbn: e.target.value })} placeholder="ISBN (10 ou 13 chiffres)" style={{ marginTop: 4 }} disabled={!!l.product_id} />
              {l._consigned && <span className="cv-line-sub">⚠ déjà consigné par un autre déposant</span>}
            </div>
            <input type="number" min={1} value={l.qty} onChange={e => updateLine(idx, { qty: e.target.value })} />
            <input type="number" min={0} value={l.sale_price_ttc} onChange={e => updateLine(idx, { sale_price_ttc: e.target.value })} />
            <input className="cv-line-rate" type="number" min={0} max={100} value={l.commission_rate} onChange={e => updateLine(idx, { commission_rate: e.target.value })} />
            <button className="cv-icon-btn cv-line-del" onClick={() => removeLine(idx)} aria-label="Retirer"><FiTrash2 size={16} /></button>
          </div>
        ))}
        <button className="cv-btn cv-btn-outline" onClick={addManual} style={{ marginTop: 4 }}><FiPlus size={14} /> Ligne manuelle</button>

        <div className="cv-field" style={{ marginTop: 14 }}><label>Note</label>
          <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={1000} /></div>

        <div className="cv-totals">
          <div className="cv-total-item"><div className="lbl">Exemplaires</div><div className="val">{lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0)}</div></div>
          <div className="cv-total-item"><div className="lbl">Valeur déposée</div><div className="val">{fmtFcfa(totalValue)}</div></div>
        </div>

        <div className="cv-callout"><FiAlertTriangle size={16} /> La validation créera les produits manquants (ISBN), fera l'entrée de stock réelle et attribuera les ventes au déposant.</div>

        <div className="cv-modal-actions">
          <button className="cv-btn cv-btn-outline" onClick={onClose} disabled={submitting}>Annuler</button>
          <button className="cv-btn cv-btn-primary" onClick={submit} disabled={submitting}>{submitting ? 'Création…' : 'Créer le dépôt'}</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODALE DÉTAIL DÉPÔT (+ validation + retours)
// ════════════════════════════════════════════════════════════
function DepositDetailModal({ id, onClose, onChanged }) {
  const [dto, setDto] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showReturns, setShowReturns] = useState(false);
  const [returnQty, setReturnQty] = useState({});

  const load = useCallback(() => {
    setLoading(true);
    getDeposit(id).then(r => setDto(r.data)).catch(() => toast.error('Introuvable')).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const doValidate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await validateDeposit(id);
      const s = data.stock;
      if (s.conflicts?.length) toast(`Validé. ${s.conflicts.length} titre(s) déjà attribué(s) à un autre déposant — ignoré(s).`, { icon: '⚠️' });
      else if (s.failed?.length) toast(`Validé. ${s.moved} OK, ${s.failed.length} échec(s).`, { icon: '⚠️' });
      else toast.success(`Dépôt validé. ${s.moved} titre(s) en stock.`);
      onChanged(); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur validation');
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteDeposit(id);
      toast.success('Dépôt supprimé');
      onChanged(); onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression'); setBusy(false);
    }
  };

  const doReturn = async () => {
    if (busy) return;
    const rlines = Object.entries(returnQty)
      .map(([pid, q]) => ({ product_id: parseInt(pid, 10), qty: parseInt(q, 10) || 0 }))
      .filter(l => l.product_id && l.qty > 0);
    if (rlines.length === 0) return toast.error('Saisissez au moins une quantité à retourner');
    setBusy(true);
    try {
      const { data } = await returnDeposit(id, rlines);
      if (data.failed?.length) toast(`Retours : ${data.returned.length} OK, ${data.failed.length} refusé(s).`, { icon: '⚠️' });
      else toast.success(`${data.returned.length} ligne(s) retournée(s)${data.closed ? ' — dépôt clôturé' : ''}`);
      setReturnQty({}); setShowReturns(false); onChanged(); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur retours');
    } finally { setBusy(false); }
  };

  return (
    <div className="cv-overlay" onClick={() => !busy && onClose()}>
      <div className="cv-modal cv-modal-lg" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        {loading || !dto ? <Loader /> : (
          <>
            <div className="cv-modal-head">
              <h3><FiArchive size={20} /> {dto.ref}
                <span className={`cv-badge cv-badge-${dto.status}`} style={{ marginLeft: 8 }}>{dto.statusLabel}</span>
              </h3>
              <button className="cv-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
            </div>

            <div className="cv-info-row"><span className="lbl">Déposant</span><span className="val">{dto.consignorName}</span></div>
            <div className="cv-info-row"><span className="lbl">Date du dépôt</span><span className="val">{fmtDate(dto.depositDate)}</span></div>
            {dto.warehouse?.name && <div className="cv-info-row"><span className="lbl">Entrepôt</span><span className="val">{dto.warehouse.name}</span></div>}
            <div className="cv-info-row"><span className="lbl">Créé le</span><span className="val">{fmtDate(dto.createdAt)} · {dto.createdBy}</span></div>
            {dto.status !== 'draft' && <div className="cv-info-row"><span className="lbl">Validé le</span><span className="val">{fmtDate(dto.validatedAt)} · {dto.validatedBy}</span></div>}
            <div className="cv-info-row"><span className="lbl">Stock</span><span className="val">{dto.status === 'draft' ? 'Sera ajouté à la validation' : (dto.stockMoved ? 'Entré ✓' : 'Partiel / à vérifier')}</span></div>

            <h4 style={{ margin: '16px 0 6px', fontSize: '0.85rem', color: '#64748b' }}>TITRES DÉPOSÉS ({dto.totalQty})</h4>
            <div className="cv-table-wrap">
              <table className="cv-table" style={{ minWidth: 0 }}>
                <thead><tr><th>ISBN</th><th>Titre</th><th className="cv-num">Déposé</th><th className="cv-num">Retourné</th><th className="cv-num">Prix</th><th className="cv-num">Comm.</th>{showReturns && <th className="cv-num">Retour</th>}</tr></thead>
                <tbody>
                  {dto.lines.map((l, i) => {
                    const remaining = (parseInt(l.qty, 10) || 0) - (parseInt(l.qty_returned, 10) || 0);
                    return (
                      <tr key={i}>
                        <td>{l.isbn || '—'}</td><td>{l.label}</td>
                        <td className="cv-num">{l.qty}</td>
                        <td className="cv-num">{l.qty_returned || 0}</td>
                        <td className="cv-num">{fmtFcfa(l.sale_price_ttc)}</td>
                        <td className="cv-num">{l.commission_rate}%</td>
                        {showReturns && (
                          <td className="cv-num">
                            {l.product_id && remaining > 0 ? (
                              <input type="number" min={0} max={remaining} style={{ width: 64 }}
                                value={returnQty[l.product_id] || ''} placeholder={`≤${remaining}`}
                                onChange={e => setReturnQty(q => ({ ...q, [l.product_id]: e.target.value }))} />
                            ) : '—'}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {dto.note && <p style={{ marginTop: 10, fontSize: '0.88rem', color: '#475569' }}>Note : {dto.note}</p>}

            <div className="cv-modal-actions">
              {dto.status === 'draft' && !confirmDelete && (
                <button className="cv-btn cv-btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}><FiTrash2 size={14} /> Supprimer</button>
              )}
              {confirmDelete && (
                <button className="cv-btn cv-btn-danger" onClick={doDelete} disabled={busy}>{busy ? '…' : 'Confirmer la suppression'}</button>
              )}
              {dto.status === 'validated' && !showReturns && (
                <button className="cv-btn cv-btn-outline" onClick={() => setShowReturns(true)} disabled={busy}><FiCornerUpLeft size={14} /> Retour d'invendus</button>
              )}
              {showReturns && (
                <button className="cv-btn cv-btn-primary" onClick={doReturn} disabled={busy}>{busy ? '…' : 'Enregistrer les retours'}</button>
              )}
              {dto.status === 'draft' && (
                <button className="cv-btn cv-btn-success" onClick={doValidate} disabled={busy}><FiCheckCircle size={14} /> {busy ? 'Validation…' : 'Valider le dépôt'}</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODALE NOUVEAU REVERSEMENT (aperçu + création)
// ════════════════════════════════════════════════════════════
function SettlementCreateModal({ consignors, onClose, onCreated }) {
  const [consignorId, setConsignorId] = useState(consignors[0]?.id || '');
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState(new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const runPreview = useCallback(() => {
    if (!consignorId) return;
    setLoading(true);
    previewSettlement({ consignor_id: consignorId, period_from: periodFrom || undefined, period_to: periodTo })
      .then(r => { setPreview(r.data); if (!periodFrom) setPeriodFrom(r.data.periodFrom); })
      .catch(err => toast.error(err.response?.data?.error || 'Erreur calcul'))
      .finally(() => setLoading(false));
  }, [consignorId, periodFrom, periodTo]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { runPreview(); }, [consignorId]);

  const submit = async () => {
    if (saving) return;
    if (!preview || preview.lines.length === 0) return toast.error('Aucune vente à reverser sur cette période');
    setSaving(true);
    try {
      const res = await createSettlement({ consignor_id: consignorId, period_from: preview.periodFrom, period_to: preview.periodTo });
      toast.success(`Reversement ${res.data.ref} créé`);
      onCreated(res.data.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création');
    } finally { setSaving(false); }
  };

  return (
    <div className="cv-overlay" onClick={() => !saving && onClose()}>
      <div className="cv-modal cv-modal-lg" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="cv-modal-head">
          <h3><FiDollarSign size={20} /> Nouveau reversement</h3>
          <button className="cv-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
        </div>

        <div className="cv-grid-3">
          <div className="cv-field"><label>Déposant *</label>
            <select className="cv-select" style={{ width: '100%' }} value={consignorId} onChange={e => { setPeriodFrom(''); setConsignorId(e.target.value); }}>
              <option value="">— Sélectionner —</option>
              {consignors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="cv-field"><label>Du</label>
            <input type="date" value={periodFrom} onChange={e => setPeriodFrom(e.target.value)} onBlur={runPreview} /></div>
          <div className="cv-field"><label>Au</label>
            <input type="date" value={periodTo} onChange={e => setPeriodTo(e.target.value)} onBlur={runPreview} /></div>
        </div>
        {preview?.lastSettlementTo && (
          <div className="cv-callout cv-callout-green"><FiCheckCircle size={16} /> Dernier reversement payé jusqu'au {fmtDate(preview.lastSettlementTo)}. La période démarre le lendemain pour éviter tout double comptage.</div>
        )}

        {loading ? <Loader /> : preview && (
          <>
            <div className="cv-table-wrap" style={{ marginTop: 8 }}>
              <table className="cv-table" style={{ minWidth: 0 }}>
                <thead><tr><th>ISBN</th><th>Titre</th><th className="cv-num">Vendus</th><th className="cv-num">Ventes</th><th className="cv-num">Comm.</th><th className="cv-num">Net dû</th></tr></thead>
                <tbody>
                  {preview.lines.length === 0 ? (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: '#94a3b8' }}>Aucune vente sur la période</td></tr>
                  ) : preview.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.isbn}</td><td>{l.label}</td>
                      <td className="cv-num">{l.qty_sold}</td>
                      <td className="cv-num">{fmtFcfa(l.sale_total_ttc)}</td>
                      <td className="cv-num">{l.commission_rate}% · {fmtFcfa(l.commission_amount)}</td>
                      <td className="cv-num"><strong>{fmtFcfa(l.net_due)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cv-totals">
              <div className="cv-total-item"><div className="lbl">Total ventes</div><div className="val">{fmtFcfa(preview.totals.sales)}</div></div>
              <div className="cv-total-item"><div className="lbl">Commission</div><div className="val">{fmtFcfa(preview.totals.commission)}</div></div>
              <div className="cv-total-item net"><div className="lbl">Net à reverser</div><div className="val">{fmtFcfa(preview.totals.net)}</div></div>
            </div>
          </>
        )}

        <div className="cv-modal-actions">
          <button className="cv-btn cv-btn-outline" onClick={onClose} disabled={saving}>Annuler</button>
          <button className="cv-btn cv-btn-primary" onClick={submit} disabled={saving || loading || !preview || preview.lines.length === 0}>{saving ? 'Création…' : 'Créer le reversement'}</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// MODALE DÉTAIL REVERSEMENT
// ════════════════════════════════════════════════════════════
function SettlementDetailModal({ id, onClose, onChanged }) {
  const [dto, setDto] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [payRef, setPayRef] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getSettlement(id).then(r => setDto(r.data)).catch(() => toast.error('Introuvable')).finally(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const doPay = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await paySettlement(id, payRef);
      toast.success('Reversement marqué payé');
      onChanged(); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await deleteSettlement(id);
      toast.success('Reversement supprimé');
      onChanged(); onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur'); setBusy(false);
    }
  };

  return (
    <div className="cv-overlay" onClick={() => !busy && onClose()}>
      <div className="cv-modal cv-modal-lg" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        {loading || !dto ? <Loader /> : (
          <>
            <div className="cv-modal-head">
              <h3><FiDollarSign size={20} /> {dto.ref}
                <span className={`cv-badge cv-badge-${dto.status}`} style={{ marginLeft: 8 }}>{dto.statusLabel}</span>
              </h3>
              <button className="cv-icon-btn" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
            </div>

            <div className="cv-info-row"><span className="lbl">Déposant</span><span className="val">{dto.consignorName}</span></div>
            <div className="cv-info-row"><span className="lbl">Période</span><span className="val">{fmtDate(dto.periodFrom)} → {fmtDate(dto.periodTo)}</span></div>
            <div className="cv-info-row"><span className="lbl">Créé le</span><span className="val">{fmtDate(dto.createdAt)} · {dto.createdBy}</span></div>
            {dto.status === 'paid' && <div className="cv-info-row"><span className="lbl">Payé le</span><span className="val">{fmtDate(dto.paidAt)} · {dto.paidBy}{dto.paymentRef ? ` · ${dto.paymentRef}` : ''}</span></div>}

            <div className="cv-table-wrap" style={{ marginTop: 12 }}>
              <table className="cv-table" style={{ minWidth: 0 }}>
                <thead><tr><th>ISBN</th><th>Titre</th><th className="cv-num">Vendus</th><th className="cv-num">Ventes</th><th className="cv-num">Comm.</th><th className="cv-num">Net dû</th></tr></thead>
                <tbody>
                  {dto.lines.map((l, i) => (
                    <tr key={i}>
                      <td>{l.isbn}</td><td>{l.label}</td>
                      <td className="cv-num">{l.qty_sold}</td>
                      <td className="cv-num">{fmtFcfa(l.sale_total_ttc)}</td>
                      <td className="cv-num">{l.commission_rate}% · {fmtFcfa(l.commission_amount)}</td>
                      <td className="cv-num"><strong>{fmtFcfa(l.net_due)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cv-totals">
              <div className="cv-total-item"><div className="lbl">Total ventes</div><div className="val">{fmtFcfa(dto.totalSales)}</div></div>
              <div className="cv-total-item"><div className="lbl">Commission</div><div className="val">{fmtFcfa(dto.totalCommission)}</div></div>
              <div className="cv-total-item net"><div className="lbl">Net à reverser</div><div className="val">{fmtFcfa(dto.totalNetDue)}</div></div>
            </div>

            {dto.status === 'draft' && (
              <div className="cv-field" style={{ marginTop: 12 }}>
                <label>Référence du paiement (facultatif)</label>
                <input value={payRef} onChange={e => setPayRef(e.target.value)} placeholder="Wave, OM, virement, espèces…" maxLength={120} />
              </div>
            )}

            <div className="cv-modal-actions">
              {dto.status === 'draft' && !confirmDelete && (
                <button className="cv-btn cv-btn-danger" onClick={() => setConfirmDelete(true)} disabled={busy}><FiTrash2 size={14} /> Supprimer</button>
              )}
              {confirmDelete && (
                <button className="cv-btn cv-btn-danger" onClick={doDelete} disabled={busy}>{busy ? '…' : 'Confirmer'}</button>
              )}
              <button className="cv-btn cv-btn-outline" onClick={() => openSettlementPdf(dto.id)}><FiDownload size={14} /> Relevé PDF</button>
              {dto.status === 'draft' && (
                <button className="cv-btn cv-btn-success" onClick={doPay} disabled={busy}><FiCheckCircle size={14} /> {busy ? '…' : 'Marquer payé'}</button>
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
export default function ConsignmentPanel() {
  const [tab, setTab] = useState('deposits');
  const [stats, setStats] = useState(null);
  const [consignors, setConsignors] = useState([]);
  const [warehouses, setWarehouses] = useState([]);

  const [deposits, setDeposits] = useState({ deposits: [], total: 0, pages: 1 });
  const [settlements, setSettlements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({ status: '', search: '', page: 1 });

  const [showConsignor, setShowConsignor] = useState(false);
  const [editConsignor, setEditConsignor] = useState(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositId, setDepositId] = useState(null);
  const [showSettle, setShowSettle] = useState(false);
  const [settleId, setSettleId] = useState(null);

  const loadStats = useCallback(() => { getConsignmentStats().then(r => setStats(r.data)).catch(() => {}); }, []);
  const loadConsignors = useCallback(() => { listConsignors().then(r => setConsignors(r.data.consignors || [])).catch(() => {}); }, []);

  useEffect(() => { loadStats(); loadConsignors(); getConsignmentWarehouses().then(r => setWarehouses(r.data.warehouses || [])).catch(() => {}); }, [loadStats, loadConsignors]);

  const reload = useCallback(() => {
    setLoading(true); setError(false);
    if (tab === 'deposits') {
      listDeposits(filters).then(r => setDeposits(r.data)).catch(() => setError(true)).finally(() => setLoading(false));
    } else if (tab === 'settlements') {
      listSettlements().then(r => setSettlements(r.data.settlements || [])).catch(() => setError(true)).finally(() => setLoading(false));
    } else {
      loadConsignors(); setLoading(false);
    }
  }, [tab, filters, loadConsignors]);
  useEffect(() => { reload(); }, [reload]);

  const refreshAll = () => { loadStats(); loadConsignors(); reload(); };
  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiArchive /> Dépôt-vente</h3>
        {tab === 'consignors' && <button className="cv-btn cv-btn-primary" onClick={() => { setEditConsignor(null); setShowConsignor(true); }}><FiPlus size={16} /> Nouveau déposant</button>}
        {tab === 'deposits' && <button className="cv-btn cv-btn-primary" onClick={() => setShowDeposit(true)} disabled={consignors.length === 0}><FiPlus size={16} /> Nouveau dépôt</button>}
        {tab === 'settlements' && <button className="cv-btn cv-btn-primary" onClick={() => setShowSettle(true)} disabled={consignors.length === 0}><FiPlus size={16} /> Nouveau reversement</button>}
      </div>

      <div className="cv-kpis">
        <div className="cv-kpi"><div className="cv-kpi-val">{stats?.consignors ?? 0}</div><div className="cv-kpi-lbl">Déposants actifs</div></div>
        <div className="cv-kpi"><div className="cv-kpi-val">{stats?.deposits?.validated ?? 0}</div><div className="cv-kpi-lbl">Dépôts validés</div></div>
        <div className="cv-kpi"><div className="cv-kpi-val" style={{ color: '#92400e' }}>{stats?.deposits?.draft ?? 0}</div><div className="cv-kpi-lbl">Dépôts en brouillon</div></div>
        <div className="cv-kpi"><div className="cv-kpi-val" style={{ color: '#10531a' }}>{fmtFcfa(stats?.settlements?.pendingAmount ?? 0)}</div><div className="cv-kpi-lbl">Reversements à payer</div></div>
      </div>

      <div className="cv-tabs">
        <button className={`cv-tab${tab === 'deposits' ? ' active' : ''}`} onClick={() => setTab('deposits')}><FiArchive size={14} /> Dépôts</button>
        <button className={`cv-tab${tab === 'consignors' ? ' active' : ''}`} onClick={() => setTab('consignors')}><FiUsers size={14} /> Déposants</button>
        <button className={`cv-tab${tab === 'settlements' ? ' active' : ''}`} onClick={() => setTab('settlements')}><FiDollarSign size={14} /> Reversements</button>
      </div>

      {tab === 'deposits' && (
        <div className="cv-toolbar">
          <div className="cv-search">
            <FiSearch size={15} className="cv-search-ic" />
            <input value={filters.search} onChange={e => update('search', e.target.value)} placeholder="Rechercher par n° ou déposant…" />
          </div>
          <select className="cv-select" value={filters.status} onChange={e => update('status', e.target.value)}>
            <option value="">Tous statuts</option>
            <option value="draft">Brouillons</option>
            <option value="validated">Validés</option>
            <option value="closed">Clôturés</option>
          </select>
        </div>
      )}

      {loading ? <Loader /> : error ? (
        <div className="cv-empty">
          <FiAlertCircle size={44} className="cv-empty-ic" style={{ color: '#ef4444' }} />
          <h3>Erreur de chargement</h3>
          <button className="cv-btn cv-btn-primary" onClick={reload} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : (
        <>
          {/* ───────── DÉPÔTS ───────── */}
          {tab === 'deposits' && (deposits.deposits.length === 0 ? (
            <div className="cv-empty"><FiPackage size={44} className="cv-empty-ic" /><h3>Aucun dépôt</h3><p>{consignors.length === 0 ? "Créez d'abord un déposant." : 'Créez-en un avec « Nouveau dépôt ».'}</p></div>
          ) : (
            <div className="cv-table-wrap">
              <table className="cv-table">
                <thead><tr><th>N°</th><th>Déposant</th><th className="cv-num">Exempl.</th><th className="cv-num">Valeur</th><th>Statut</th><th>Date</th></tr></thead>
                <tbody>
                  {deposits.deposits.map(d => (
                    <tr key={d.id} className="cv-row" onClick={() => setDepositId(d.id)}>
                      <td><span className="cv-ref">{d.ref}</span></td>
                      <td>{d.consignorName}</td>
                      <td className="cv-num">{d.totalQty}</td>
                      <td className="cv-num">{fmtFcfa(d.totalValue)}</td>
                      <td><span className={`cv-badge cv-badge-${d.status}`}>{d.statusLabel}</span></td>
                      <td>{fmtDate(d.depositDate || d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {/* ───────── DÉPOSANTS ───────── */}
          {tab === 'consignors' && (consignors.length === 0 ? (
            <div className="cv-empty"><FiUsers size={44} className="cv-empty-ic" /><h3>Aucun déposant</h3><p>Ajoutez un fournisseur en dépôt-vente.</p></div>
          ) : (
            <div className="cv-table-wrap">
              <table className="cv-table">
                <thead><tr><th>Déposant</th><th>Contact</th><th className="cv-num">Commission</th><th className="cv-num">Titres</th><th className="cv-num">Dépôts</th><th></th></tr></thead>
                <tbody>
                  {consignors.map(c => (
                    <tr key={c.id} className="cv-row" onClick={() => { setEditConsignor(c); setShowConsignor(true); }}>
                      <td><strong>{c.name}</strong></td>
                      <td>{c.contact_email || c.contact_phone || '—'}</td>
                      <td className="cv-num">{c.default_commission_rate}%</td>
                      <td className="cv-num">{c.titles_count}</td>
                      <td className="cv-num">{c.deposits_count}</td>
                      <td onClick={e => e.stopPropagation()}><button className="cv-icon-btn" onClick={() => { setEditConsignor(c); setShowConsignor(true); }} title="Modifier"><FiEdit2 size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {/* ───────── REVERSEMENTS ───────── */}
          {tab === 'settlements' && (settlements.length === 0 ? (
            <div className="cv-empty"><FiFileText size={44} className="cv-empty-ic" /><h3>Aucun reversement</h3><p>{consignors.length === 0 ? "Créez d'abord un déposant." : 'Calculez-en un avec « Nouveau reversement ».'}</p></div>
          ) : (
            <div className="cv-table-wrap">
              <table className="cv-table">
                <thead><tr><th>N°</th><th>Déposant</th><th>Période</th><th className="cv-num">Net dû</th><th>Statut</th><th></th></tr></thead>
                <tbody>
                  {settlements.map(s => (
                    <tr key={s.id} className="cv-row" onClick={() => setSettleId(s.id)}>
                      <td><span className="cv-ref">{s.ref}</span></td>
                      <td>{s.consignorName}</td>
                      <td>{fmtDate(s.periodFrom)} → {fmtDate(s.periodTo)}</td>
                      <td className="cv-num"><strong>{fmtFcfa(s.totalNetDue)}</strong></td>
                      <td><span className={`cv-badge cv-badge-${s.status}`}>{s.statusLabel}</span></td>
                      <td onClick={e => e.stopPropagation()}><button className="cv-icon-btn" onClick={() => openSettlementPdf(s.id)} title="PDF"><FiDownload size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {showConsignor && (
        <ConsignorModal consignor={editConsignor} onClose={() => setShowConsignor(false)} onSaved={() => { setShowConsignor(false); refreshAll(); }} />
      )}
      {showDeposit && (
        <DepositModal consignors={consignors} warehouses={warehouses} onClose={() => setShowDeposit(false)} onCreated={(id) => { setShowDeposit(false); refreshAll(); setDepositId(id); }} />
      )}
      {depositId && (
        <DepositDetailModal id={depositId} onClose={() => setDepositId(null)} onChanged={refreshAll} />
      )}
      {showSettle && (
        <SettlementCreateModal consignors={consignors} onClose={() => setShowSettle(false)} onCreated={(id) => { setShowSettle(false); refreshAll(); setSettleId(id); }} />
      )}
      {settleId && (
        <SettlementDetailModal id={settleId} onClose={() => setSettleId(null)} onChanged={refreshAll} />
      )}
    </div>
  );
}
