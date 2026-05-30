import { useState, useEffect } from 'react';
import { getAdminPayments, getPaymentOrphans, confirmOrderPayment, rejectPayment, getAdminOrderDetail } from '../../../api/admin';
import { FiDollarSign, FiCheck, FiX, FiClock, FiPhone, FiMail, FiHash, FiAlertCircle, FiMapPin, FiPackage, FiFileText } from 'react-icons/fi';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Contracts.css';

// Fiche détaillée d'une commande web (ouverte au clic sur le n° de commande).
function OrderDetailModal({ orderId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAdminOrderDetail(orderId)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) toast.error('Commande introuvable'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orderId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const fmtDate = (d) => d ? new Date(d.replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—';

  return (
    <div className="ct-modal-overlay" onClick={onClose}>
      <div className="ct-modal" style={{ maxWidth: 640, width: '100%' }} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        {loading || !data ? <Loader /> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <FiPackage size={18} /> Commande {data.order.ref}
                <span style={{ padding: '2px 10px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, background: '#f1f5f9', color: '#475569' }}>{data.order.statusLabel}</span>
              </h3>
              <button onClick={onClose} className="ct-btn-ghost" aria-label="Fermer"><FiX size={20} /></button>
            </div>

            {/* Client */}
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 14, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#0f172a' }}>{data.order.customer.name || '—'}</div>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
                {data.order.customer.email && <span><FiMail size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.order.customer.email}</span>}
                {data.order.customer.phone && <span><FiPhone size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.order.customer.phone}</span>}
              </div>
              {(data.order.customer.address || data.order.customer.town) && (
                <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4 }}>
                  <FiMapPin size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                  {[data.order.customer.address, [data.order.customer.zip, data.order.customer.town].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                </div>
              )}
              <div style={{ fontSize: '0.82rem', color: '#94a3b8', marginTop: 4 }}>Commande du {fmtDate(data.order.date)}</div>
            </div>

            {/* Lignes */}
            <div className="admin-table-container" style={{ marginBottom: 12 }}>
              <table className="admin-table" style={{ fontSize: '0.85rem' }}>
                <thead><tr><th>Article</th><th style={{ textAlign: 'center' }}>Qté</th><th style={{ textAlign: 'right' }}>P.U.</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
                <tbody>
                  {data.lines.map(l => (
                    <tr key={l.id}>
                      <td>{l.label}{l.ref ? <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}> · {l.ref}</span> : ''}</td>
                      <td style={{ textAlign: 'center' }}>{l.qty}</td>
                      <td style={{ textAlign: 'right' }}>{formatPrice(l.subprice)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatPrice(l.total_ttc)}</td>
                    </tr>
                  ))}
                  {data.lines.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: '#94a3b8' }}>Aucune ligne</td></tr>}
                </tbody>
              </table>
            </div>

            {/* Totaux */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: '0.88rem', marginBottom: 12 }}>
              <div style={{ textAlign: 'right', color: '#64748b' }}>
                <div>Total HT</div><div>TVA</div><div style={{ fontWeight: 800, color: '#0f172a', fontSize: '1rem' }}>Total TTC</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div>{formatPrice(data.order.total_ht)}</div>
                <div>{formatPrice(data.order.total_tva)}</div>
                <div style={{ fontWeight: 800, color: '#10531a', fontSize: '1rem' }}>{formatPrice(data.order.total_ttc)}</div>
              </div>
            </div>

            {/* Paiement */}
            {data.payment && (
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 12, fontSize: '0.85rem', color: '#1e40af' }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}><FiDollarSign size={13} style={{ verticalAlign: -2 }} /> Paiement</div>
                <div>Méthode : <strong>{data.payment.method || '—'}</strong> · Attendu : <strong>{formatPrice(data.payment.amount_expected)}</strong></div>
                {data.payment.transaction_ref && <div>Réf. transaction client : <strong>{data.payment.transaction_ref}</strong>{data.payment.payer_phone ? ` · ${data.payment.payer_phone}` : ''}</div>}
                {data.payment.invoice_ref && <div><FiFileText size={12} style={{ verticalAlign: -1 }} /> Facture : <strong>{data.payment.invoice_ref}</strong></div>}
              </div>
            )}

            {data.order.note_public && (
              <div style={{ marginTop: 10, fontSize: '0.85rem', color: '#475569' }}>
                <strong>Note :</strong> {data.order.note_public}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const METHOD_LABELS = { wave: 'Wave', orange_money: 'Orange Money', virement: 'Virement', cb: 'Carte bancaire' };
const METHOD_COLORS = { wave: '#1e40af', orange_money: '#ea580c', virement: '#0891b2', cb: '#7c3aed' };
const STATUS_CONFIG = {
  pending: { label: 'En attente', color: '#f59e0b', bg: '#fffbeb', border: '#fde68a' },
  confirmed: { label: 'Confirmé', color: '#10b981', bg: '#f0fdf4', border: '#bbf7d0' },
  rejected: { label: 'Rejeté', color: '#ef4444', bg: '#fef2f2', border: '#fecaca' },
};

export default function PaymentsPanel() {
  const [data, setData] = useState({ payments: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [actionId, setActionId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [orphans, setOrphans] = useState(0);
  const [detailOrderId, setDetailOrderId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAdminPayments({ status, page })
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, page]);

  // Compteur des paiements confirmés sans facture — incident à arbitrer.
  useEffect(() => {
    let cancelled = false;
    getPaymentOrphans()
      .then(r => { if (!cancelled) setOrphans(r.data?.total || 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [status]);

  const handleConfirm = async (payment) => {
    setProcessing(true);
    setActionId(payment.id);
    try {
      const r = await confirmOrderPayment(payment.dolibarr_order_id);
      toast.success(`Paiement confirmé — Facture ${r.data.invoice_ref} créée`);
      setData(d => ({ ...d, payments: d.payments.filter(p => p.id !== payment.id), total: d.total - 1 }));
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur confirmation');
    } finally {
      setProcessing(false);
      setActionId(null);
    }
  };

  const handleReject = async () => {
    if (!showReject) return;
    setProcessing(true);
    try {
      await rejectPayment(showReject.id, rejectReason);
      toast.success('Paiement rejeté');
      setData(d => ({ ...d, payments: d.payments.filter(p => p.id !== showReject.id), total: d.total - 1 }));
      setShowReject(null);
      setRejectReason('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setProcessing(false);
    }
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

  const pendingCount = status === 'pending' ? data.total : 0;

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiDollarSign /> Paiements web
          {pendingCount > 0 && <span style={{ background: '#f59e0b', color: '#fff', borderRadius: 10, padding: '2px 10px', fontSize: '0.8rem' }}>{pendingCount}</span>}
        </h3>
      </div>

      {orphans > 0 && (
        <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, color: '#991b1b', display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem' }}>
          <FiAlertCircle />
          <span><strong>{orphans} paiement{orphans > 1 ? 's' : ''} confirmé{orphans > 1 ? 's' : ''} sans facture</strong> — à arbitrer (création manuelle de facture ou remboursement). Visible dans l'onglet « Confirmé ».</span>
        </div>
      )}

      {/* Tabs statut */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <button key={key} onClick={() => { setStatus(key); setPage(1); }}
            style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${status === key ? cfg.border : '#e2e8f0'}`, background: status === key ? cfg.bg : '#fff', color: status === key ? cfg.color : '#64748b', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer' }}>
            {cfg.label}
          </button>
        ))}
      </div>

      {loading ? <Loader /> : data.payments.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiCheck size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucun paiement {STATUS_CONFIG[status]?.label.toLowerCase()}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {data.payments.map(p => {
            const methodColor = METHOD_COLORS[p.payment_method] || '#64748b';
            const stCfg = STATUS_CONFIG[p.payment_status] || STATUS_CONFIG.pending;
            return (
              <div key={p.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, padding: 20, borderLeft: `4px solid ${methodColor}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  {/* Infos principales */}
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <button
                        onClick={() => p.dolibarr_order_id && setDetailOrderId(p.dolibarr_order_id)}
                        title="Voir le détail de la commande"
                        style={{ fontWeight: 800, fontSize: '1rem', background: 'none', border: 'none', padding: 0, cursor: p.dolibarr_order_id ? 'pointer' : 'default', color: '#10531a', textDecoration: 'underline', textUnderlineOffset: 3 }}>
                        {p.order_ref}
                      </button>
                      <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, background: `${methodColor}15`, color: methodColor }}>
                        {METHOD_LABELS[p.payment_method] || p.payment_method}
                      </span>
                      <span style={{ padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, background: stCfg.bg, color: stCfg.color, border: `1px solid ${stCfg.border}` }}>
                        {stCfg.label}
                      </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px', fontSize: '0.85rem', color: '#475569' }}>
                      <div><FiMail size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{p.customer_name || p.customer_email}</div>
                      {p.customer_phone && <div><FiPhone size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{p.customer_phone}</div>}
                      <div><FiDollarSign size={12} style={{ verticalAlign: -1, marginRight: 4 }} /><strong>{formatPrice(p.amount_expected)}</strong></div>
                      <div><FiClock size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{formatDate(p.created_at)}</div>
                    </div>

                    {/* Référence transaction du client */}
                    {p.transaction_ref && (
                      <div style={{ marginTop: 8, padding: '6px 10px', background: '#eff6ff', borderRadius: 6, fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #bfdbfe' }}>
                        <FiHash size={12} style={{ color: '#3b82f6' }} />
                        <span style={{ color: '#1e40af' }}>Réf. client : <strong>{p.transaction_ref}</strong></span>
                        {p.payer_phone && <span style={{ color: '#64748b' }}> — Tél. payeur : {p.payer_phone}</span>}
                      </div>
                    )}

                    {/* Infos confirmation/rejet */}
                    {p.payment_status === 'confirmed' && p.invoice_ref && (
                      <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#10b981' }}>
                        Facture {p.invoice_ref} — confirmé par {p.confirmed_by} le {formatDate(p.confirmed_at)}
                      </div>
                    )}
                    {p.payment_status === 'confirmed' && !p.invoice_ref && (
                      <div style={{ marginTop: 6, padding: '6px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: '0.8rem', color: '#991b1b', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FiAlertCircle size={14} />
                        <span>Paiement encaissé mais <strong>aucune facture</strong> liée — créer la facture manuellement ou rembourser.</span>
                      </div>
                    )}
                    {p.payment_status === 'rejected' && (
                      <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#ef4444' }}>
                        Rejeté par {p.rejected_by} {p.reject_reason && `— ${p.reject_reason}`}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {p.payment_status === 'pending' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button onClick={() => handleConfirm(p)} disabled={processing && actionId === p.id}
                        style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#10b981', color: '#fff', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FiCheck size={14} /> {processing && actionId === p.id ? '...' : 'Confirmer'}
                      </button>
                      <button onClick={() => setShowReject(p)}
                        style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <FiX size={14} /> Rejeter
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Pagination */}
          {data.pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 12 }}>
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn btn-outline btn-sm">Précédent</button>
              <span style={{ padding: '6px 12px', fontSize: '0.85rem', color: '#64748b' }}>Page {page} / {data.pages}</span>
              <button disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="btn btn-outline btn-sm">Suivant</button>
            </div>
          )}
        </div>
      )}

      {/* Modal rejet */}
      {showReject && (
        <div className="ct-modal-overlay" onClick={() => setShowReject(null)}>
          <div className="ct-modal" onClick={e => e.stopPropagation()}>
            <h3><FiAlertCircle size={18} style={{ color: '#dc2626', verticalAlign: -3 }} /> Rejeter le paiement</h3>
            <p style={{ color: '#64748b' }}>Commande <strong>{showReject.order_ref}</strong> — {formatPrice(showReject.amount_expected)} via {METHOD_LABELS[showReject.payment_method]}</p>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: 4 }}>Motif du rejet</label>
              <textarea rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                placeholder="Ex: Montant incorrect, transaction non trouvée..."
                style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db', fontFamily: 'inherit', resize: 'vertical' }} />
            </div>
            <div className="ct-modal-actions">
              <button className="ct-btn ct-btn-outline" onClick={() => { setShowReject(null); setRejectReason(''); }}>Annuler</button>
              <button className="ct-btn ct-btn-danger" onClick={handleReject} disabled={processing}>
                {processing ? 'Rejet...' : 'Confirmer le rejet'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal détail commande */}
      {detailOrderId && (
        <OrderDetailModal orderId={detailOrderId} onClose={() => setDetailOrderId(null)} />
      )}
    </div>
  );
}
