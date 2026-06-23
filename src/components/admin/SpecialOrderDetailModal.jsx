import { useState, useEffect, useCallback } from 'react';
import {
  FiX, FiUser, FiMail, FiPhone, FiMapPin, FiClock, FiAlertTriangle, FiFileText,
  FiArrowRight, FiTrash2, FiSend, FiPlus, FiDownload, FiEdit2, FiCheckCircle,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../common/Loader';
import { formatPrice } from '../../utils/formatters';
import {
  getSpecialOrder, changeSpecialOrderStatus, addSpecialOrderPayment, deleteSpecialOrderPayment,
  notifySpecialOrder, updateSpecialOrder, deleteSpecialOrder, openSpecialOrderPdf,
} from '../../api/specialOrders';

const METHOD_LABELS = {
  cash: 'Espèces', wave: 'Wave', orange_money: 'Orange Money',
  virement: 'Virement', cb: 'Carte bancaire', cheque: 'Chèque',
};
const EVENT_LABELS = {
  order_confirmation: 'Confirmation de commande', validated: 'Commande validée',
  in_processing: 'En cours de traitement', available: 'Livre disponible',
  balance_reminder: 'Rappel de solde', pickup_confirmation: 'Confirmation de retrait',
};
const CHANNEL_LABELS = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

const fmtDateTime = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

export default function SpecialOrderDetailModal({ orderId, onClose, onChanged, paymentMethods = ['cash', 'wave', 'orange_money', 'virement', 'cb', 'cheque'], statuses = [] }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // contrôles
  const [nextStatus, setNextStatus] = useState('');
  const [statusComment, setStatusComment] = useState('');
  const [pay, setPay] = useState({ amount: '', method: 'cash', reference: '', note: '' });
  const [notifEvent, setNotifEvent] = useState('balance_reminder');
  const [notifChannels, setNotifChannels] = useState({ email: true, sms: false, whatsapp: false });
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({ expected_date: '', delay_estimate: '', notes: '', customer_phone: '', customer_email: '', customer_address: '' });

  const statusMap = {};
  statuses.forEach((s) => { statusMap[s.key] = s; });
  const STATUS_KEYS = statuses.filter((s) => s.key !== 'cancelled').map((s) => s.key);

  const load = useCallback(() => {
    setLoading(true);
    getSpecialOrder(orderId)
      .then((r) => {
        setData(r.data);
        setEdit({
          expected_date: r.data.expectedDate || '', delay_estimate: r.data.delayEstimate || '',
          notes: r.data.notes || '', customer_phone: r.data.customer.phone || '',
          customer_email: r.data.customer.email || '', customer_address: r.data.customer.address || '',
        });
      })
      .catch(() => toast.error('Commande introuvable'))
      .finally(() => setLoading(false));
  }, [orderId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const afterMutation = (resp) => {
    if (resp?.data) setData(resp.data);
    onChanged?.();
  };

  // Statut suivant naturel (séquence linéaire)
  const curIdx = STATUS_KEYS.indexOf(data?.status);
  const suggestedNext = curIdx >= 0 && curIdx < STATUS_KEYS.length - 1 ? STATUS_KEYS[curIdx + 1] : null;
  const isTerminal = data && ['closed', 'cancelled'].includes(data.status);

  const doStatus = async (status) => {
    if (!status) return;
    setBusy(true);
    try {
      const r = await changeSpecialOrderStatus(orderId, status, statusComment.trim() || undefined);
      afterMutation(r);
      setStatusComment(''); setNextStatus('');
      toast.success(`Statut : ${statusMap[status]?.label || status}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Transition impossible');
    } finally { setBusy(false); }
  };

  const doAddPayment = async () => {
    const amount = Number(pay.amount) || 0;
    if (amount <= 0) { toast.error('Montant invalide'); return; }
    setBusy(true);
    try {
      const r = await addSpecialOrderPayment(orderId, { amount, method: pay.method, reference: pay.reference.trim() || null, note: pay.note.trim() || null });
      afterMutation(r);
      setPay({ amount: '', method: pay.method, reference: '', note: '' });
      toast.success('Paiement enregistré');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur paiement');
    } finally { setBusy(false); }
  };

  const doDeletePayment = async (paymentId) => {
    if (!window.confirm('Supprimer ce paiement ?')) return;
    setBusy(true);
    try { afterMutation(await deleteSpecialOrderPayment(orderId, paymentId)); toast.success('Paiement supprimé'); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setBusy(false); }
  };

  const doNotify = async () => {
    const channels = Object.keys(notifChannels).filter((c) => notifChannels[c]);
    if (channels.length === 0) { toast.error('Sélectionnez au moins un canal'); return; }
    setBusy(true);
    try {
      afterMutation(await notifySpecialOrder(orderId, { event: notifEvent, channels }));
      toast.success('Notification envoyée');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur envoi'); }
    finally { setBusy(false); }
  };

  const doSaveEdit = async () => {
    setBusy(true);
    try {
      afterMutation(await updateSpecialOrder(orderId, {
        expected_date: edit.expected_date || null, delay_estimate: edit.delay_estimate.trim() || null,
        notes: edit.notes.trim() || null, customer_phone: edit.customer_phone.trim() || null,
        customer_email: edit.customer_email.trim() || null, customer_address: edit.customer_address.trim() || null,
      }));
      setEditing(false);
      toast.success('Commande mise à jour');
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setBusy(false); }
  };

  const doDeleteOrder = async () => {
    if (!window.confirm('Supprimer définitivement cette commande ? (uniquement si enregistrée sans paiement)')) return;
    setBusy(true);
    try { await deleteSpecialOrder(orderId); toast.success('Commande supprimée'); onChanged?.(); onClose(); }
    catch (err) { toast.error(err.response?.data?.error || 'Suppression impossible'); }
    finally { setBusy(false); }
  };

  const t = data?.totals || { total: 0, paid: 0, balance: 0 };
  const pct = t.total > 0 ? Math.min(100, Math.round((t.paid / t.total) * 100)) : 0;

  return (
    <div className="so-overlay" onClick={onClose}>
      <div className="so-modal lg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {loading || !data ? <Loader /> : (
          <>
            <div className="so-modal-head">
              <h3>
                <FiFileText /> {data.ref}
                <span className="so-badge" style={{ background: data.statusInfo.bg, color: data.statusInfo.color }}>{data.statusInfo.label}</span>
                {data.overdue && <span className="so-overdue"><FiAlertTriangle size={13} /> En retard</span>}
              </h3>
              <button className="so-x" onClick={onClose} aria-label="Fermer"><FiX size={20} /></button>
            </div>

            {/* CLIENT */}
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontWeight: 700, color: '#0f172a' }}><FiUser size={13} style={{ verticalAlign: -1, marginRight: 5 }} />{data.customer.name}</div>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
                {data.customer.email && <span><FiMail size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.customer.email}</span>}
                {data.customer.phone && <span><FiPhone size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.customer.phone}</span>}
                {data.customer.address && <span><FiMapPin size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.customer.address}</span>}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 6 }}>
                Créée le {fmtDateTime(data.createdAt)} par {data.createdBy || '—'}
                {(data.expectedDate || data.delayEstimate) && <> · Disponibilité prévue : <strong style={{ color: '#475569' }}>{data.expectedDate ? fmtDate(data.expectedDate) : data.delayEstimate}</strong></>}
              </div>
            </div>

            {/* LIGNES */}
            <div className="admin-table-container" style={{ marginBottom: 12 }}>
              <table className="admin-table" style={{ fontSize: '0.85rem' }}>
                <thead><tr><th>Ouvrage</th><th style={{ textAlign: 'center' }}>Qté</th><th style={{ textAlign: 'right' }}>P.U.</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.id}>
                      <td><strong>{l.title}</strong>{l.author ? <span style={{ color: '#64748b' }}> — {l.author}</span> : ''}{l.isbn ? <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}> · {l.isbn}</span> : ''}</td>
                      <td style={{ textAlign: 'center' }}>{l.quantity}</td>
                      <td style={{ textAlign: 'right' }}>{formatPrice(l.unit_price)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatPrice(l.line_total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* TOTAUX + PROGRESSION */}
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div className="so-money-line total"><span>Total</span><span>{formatPrice(t.total)}</span></div>
              <div className="so-progress"><span style={{ width: `${pct}%` }} /></div>
              <div className="so-money-line"><span style={{ color: '#166534' }}>Réglé ({pct}%)</span><span style={{ color: '#166534', fontWeight: 700 }}>{formatPrice(t.paid)}</span></div>
              <div className="so-money-line due"><span>Reste à payer</span><span>{formatPrice(t.balance)}</span></div>
            </div>

            {/* WORKFLOW */}
            {!isTerminal && (
              <div className="so-section">
                <p className="so-section-title">Faire avancer la commande</p>
                <div className="so-actions">
                  {suggestedNext && (
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => doStatus(suggestedNext)}>
                      <FiArrowRight size={14} /> Passer à : {statusMap[suggestedNext]?.label}
                    </button>
                  )}
                  {data.status !== 'cancelled' && (
                    <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => doStatus('cancelled')} style={{ color: '#991b1b', borderColor: '#fecaca' }}>
                      Annuler la commande
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <label style={{ fontSize: '0.76rem', color: '#64748b' }}>Aller à un statut précis</label>
                    <select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }}>
                      <option value="">— choisir —</option>
                      {statuses.filter((s) => s.key !== data.status).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                    </select>
                  </div>
                  <input value={statusComment} onChange={(e) => setStatusComment(e.target.value)} placeholder="Commentaire (optionnel)"
                    style={{ flex: 2, minWidth: 180, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }} />
                  <button className="btn btn-outline btn-sm" disabled={busy || !nextStatus} onClick={() => doStatus(nextStatus)}>Appliquer</button>
                </div>
              </div>
            )}

            {/* TIMELINE */}
            <div className="so-section">
              <p className="so-section-title">Journal des étapes</p>
              <ul className="so-timeline">
                {data.history.map((h) => (
                  <li key={h.id}>
                    <div className="so-tl-head">{h.fromInfo ? `${h.fromInfo.label} → ` : ''}{h.toInfo.label}</div>
                    <div className="so-tl-meta">{fmtDateTime(h.created_at)} · {h.actor_username || '—'}</div>
                    {h.comment && <div className="so-tl-comment">{h.comment}</div>}
                  </li>
                ))}
              </ul>
            </div>

            {/* PAIEMENTS */}
            <div className="so-section">
              <p className="so-section-title">Paiements</p>
              {data.payments.length === 0 ? (
                <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: '0 0 8px' }}>Aucun paiement enregistré.</p>
              ) : data.payments.map((p) => (
                <div key={p.id} className="so-row">
                  <span>
                    <strong>{formatPrice(p.amount)}</strong> · {METHOD_LABELS[p.method] || p.method}
                    {p.reference ? <span style={{ color: '#94a3b8' }}> · {p.reference}</span> : ''}
                    {p.note ? <span style={{ color: '#94a3b8' }}> · {p.note}</span> : ''}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: '0.76rem', color: '#94a3b8' }}>{fmtDateTime(p.created_at)} · {p.received_by || '—'}</span>
                    <button className="so-line-del" onClick={() => doDeletePayment(p.id)} disabled={busy} aria-label="Supprimer paiement"><FiTrash2 size={14} /></button>
                  </span>
                </div>
              ))}
              {t.balance > 0 && data.status !== 'cancelled' && (
                <>
                <div style={{ marginTop: 12, marginBottom: 4, fontSize: '0.8rem', fontWeight: 700, color: '#334155' }}>
                  Encaisser un acompte / une tranche
                </div>
                <div className="so-actions" style={{ marginBottom: 8 }}>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setPay((s) => ({ ...s, amount: String(Math.round(t.balance)) }))}>
                    Solde ({formatPrice(t.balance)})
                  </button>
                  {[0.25, 0.5, 0.75].map((fr) => {
                    const amt = Math.min(Math.round(t.total * fr), Math.round(t.balance));
                    return amt > 0 && amt < Math.round(t.balance)
                      ? <button type="button" key={fr} className="btn btn-outline btn-sm" onClick={() => setPay((s) => ({ ...s, amount: String(amt) }))}>{Math.round(fr * 100)} %</button>
                      : null;
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div style={{ width: 120 }}>
                    <label style={{ fontSize: '0.74rem', color: '#64748b' }}>Montant</label>
                    <input type="number" min="0" value={pay.amount} onChange={(e) => setPay((s) => ({ ...s, amount: e.target.value }))}
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }} placeholder={String(Math.round(t.balance))} />
                  </div>
                  <div style={{ width: 140 }}>
                    <label style={{ fontSize: '0.74rem', color: '#64748b' }}>Méthode</label>
                    <select value={pay.method} onChange={(e) => setPay((s) => ({ ...s, method: e.target.value }))} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }}>
                      {paymentMethods.map((m) => <option key={m} value={m}>{METHOD_LABELS[m] || m}</option>)}
                    </select>
                  </div>
                  <input value={pay.reference} onChange={(e) => setPay((s) => ({ ...s, reference: e.target.value }))} placeholder="Référence"
                    style={{ flex: 1, minWidth: 120, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }} />
                  <button className="btn btn-primary btn-sm" disabled={busy} onClick={doAddPayment}><FiPlus size={14} /> Encaisser</button>
                </div>
                </>
              )}
            </div>

            {/* NOTIFICATIONS */}
            <div className="so-section">
              <p className="so-section-title">Notifications client</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <label style={{ fontSize: '0.74rem', color: '#64748b' }}>Message à envoyer</label>
                  <select value={notifEvent} onChange={(e) => setNotifEvent(e.target.value)} style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8 }}>
                    {Object.keys(EVENT_LABELS).map((ev) => <option key={ev} value={ev}>{EVENT_LABELS[ev]}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 10, paddingBottom: 8 }}>
                  {Object.keys(CHANNEL_LABELS).map((c) => (
                    <label key={c} style={{ fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                      <input type="checkbox" checked={notifChannels[c]} onChange={(e) => setNotifChannels((s) => ({ ...s, [c]: e.target.checked }))} />
                      {CHANNEL_LABELS[c]}
                    </label>
                  ))}
                </div>
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={doNotify}><FiSend size={13} /> Envoyer</button>
              </div>
              {data.notifications.length === 0 ? (
                <p style={{ fontSize: '0.82rem', color: '#94a3b8', margin: 0 }}>Aucune notification envoyée.</p>
              ) : (
                <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                  {data.notifications.map((n) => (
                    <div key={n.id} className="so-row">
                      <span>{EVENT_LABELS[n.event] || n.event} · <span style={{ color: '#64748b' }}>{CHANNEL_LABELS[n.channel] || n.channel}</span> {n.recipient ? <span style={{ color: '#94a3b8' }}>→ {n.recipient}</span> : ''}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className={`so-pill ${n.status}`}>{n.status === 'sent' ? 'envoyé' : n.status === 'failed' ? 'échec' : 'ignoré'}</span>
                        <span style={{ fontSize: '0.74rem', color: '#94a3b8' }}>{fmtDateTime(n.created_at)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ÉDITION MÉTA */}
            {editing && (
              <div className="so-section" style={{ background: '#fffdf5', border: '1px solid #fde68a', borderRadius: 10, padding: 12 }}>
                <p className="so-section-title">Modifier la commande</p>
                <div className="so-grid2">
                  <div className="so-field"><label>Date de disponibilité</label><input type="date" value={edit.expected_date} onChange={(e) => setEdit((s) => ({ ...s, expected_date: e.target.value }))} /></div>
                  <div className="so-field"><label>Délai estimé</label><input value={edit.delay_estimate} onChange={(e) => setEdit((s) => ({ ...s, delay_estimate: e.target.value }))} /></div>
                  <div className="so-field"><label>Téléphone</label><input value={edit.customer_phone} onChange={(e) => setEdit((s) => ({ ...s, customer_phone: e.target.value }))} /></div>
                  <div className="so-field"><label>Email</label><input value={edit.customer_email} onChange={(e) => setEdit((s) => ({ ...s, customer_email: e.target.value }))} /></div>
                </div>
                <div className="so-field"><label>Adresse</label><input value={edit.customer_address} onChange={(e) => setEdit((s) => ({ ...s, customer_address: e.target.value }))} /></div>
                <div className="so-field"><label>Note interne</label><textarea value={edit.notes} onChange={(e) => setEdit((s) => ({ ...s, notes: e.target.value }))} /></div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-outline btn-sm" onClick={() => setEditing(false)} disabled={busy}>Annuler</button>
                  <button className="btn btn-primary btn-sm" onClick={doSaveEdit} disabled={busy}><FiCheckCircle size={14} /> Enregistrer</button>
                </div>
              </div>
            )}

            {data.notes && !editing && (
              <div style={{ fontSize: '0.85rem', color: '#475569', marginBottom: 12 }}><strong>Note :</strong> {data.notes}</div>
            )}

            {/* PIED — actions */}
            <div className="so-modal-foot" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {!isTerminal && <button className="btn btn-outline btn-sm" onClick={() => setEditing((v) => !v)} disabled={busy}><FiEdit2 size={13} /> Modifier</button>}
                {data.status === 'registered' && t.paid === 0 && (
                  <button className="btn btn-outline btn-sm" onClick={doDeleteOrder} disabled={busy} style={{ color: '#991b1b', borderColor: '#fecaca' }}><FiTrash2 size={13} /> Supprimer</button>
                )}
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => openSpecialOrderPdf(orderId)}><FiDownload size={14} /> Bon de commande PDF</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
