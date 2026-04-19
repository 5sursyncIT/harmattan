import { useState, useEffect } from 'react';
import { getAdminPayments, confirmOrderPayment, rejectPayment } from '../../../api/admin';
import { FiDollarSign, FiCheck, FiX, FiClock, FiPhone, FiMail, FiHash, FiAlertCircle } from 'react-icons/fi';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';

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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getAdminPayments({ status, page })
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, page]);

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
                      <span style={{ fontWeight: 800, fontSize: '1rem' }}>{p.order_ref}</span>
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
    </div>
  );
}
