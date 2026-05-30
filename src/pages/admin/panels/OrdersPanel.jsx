import { useState, useEffect, useCallback } from 'react';
import {
  FiShoppingCart, FiSearch, FiX, FiMail, FiPhone, FiMapPin, FiPackage,
  FiFileText, FiDollarSign, FiClock, FiAlertCircle, FiChevronLeft, FiChevronRight,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import { formatPrice } from '../../../utils/formatters';
import { listWebOrders, getWebOrder } from '../../../api/ordersAdmin';
import './Contracts.css';

const PAY_BADGE = {
  pending: { label: 'Paiement en attente', bg: '#fffbeb', color: '#92400e', border: '#fde68a' },
  confirmed: { label: 'Payé', bg: '#f0fdf4', color: '#166534', border: '#bbf7d0' },
  rejected: { label: 'Rejeté', bg: '#fef2f2', color: '#991b1b', border: '#fecaca' },
};
const ORDER_BADGE = {
  '-1': { label: 'Annulée', bg: '#fef2f2', color: '#991b1b' },
  0: { label: 'Brouillon', bg: '#f1f5f9', color: '#475569' },
  1: { label: 'Validée', bg: '#eff6ff', color: '#1e40af' },
  2: { label: 'En cours', bg: '#fef9c3', color: '#854d0e' },
  3: { label: 'Livrée', bg: '#f0fdf4', color: '#166534' },
};
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function OrderDetailModal({ orderId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getWebOrder(orderId)
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

  const day = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

  return (
    <div className="ct-modal-overlay" onClick={onClose}>
      <div className="ct-modal" style={{ maxWidth: 660, width: '100%' }} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        {loading || !data ? <Loader /> : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                <FiPackage size={18} /> {data.order.ref}
                <span style={{ padding: '2px 10px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, background: (ORDER_BADGE[String(data.order.status)] || ORDER_BADGE['0']).bg, color: (ORDER_BADGE[String(data.order.status)] || ORDER_BADGE['0']).color }}>
                  {data.order.statusLabel}
                </span>
              </h3>
              <button onClick={onClose} className="ct-btn-ghost" aria-label="Fermer"><FiX size={20} /></button>
            </div>

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
              <div style={{ fontSize: '0.82rem', color: '#94a3b8', marginTop: 4 }}>Commande du {day(data.order.date)}</div>
            </div>

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

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, fontSize: '0.88rem', marginBottom: 12 }}>
              <div style={{ textAlign: 'right', color: '#64748b' }}><div>Total HT</div><div>TVA</div><div style={{ fontWeight: 800, color: '#0f172a', fontSize: '1rem' }}>Total TTC</div></div>
              <div style={{ textAlign: 'right' }}>
                <div>{formatPrice(data.order.total_ht)}</div>
                <div>{formatPrice(data.order.total_tva)}</div>
                <div style={{ fontWeight: 800, color: '#10531a', fontSize: '1rem' }}>{formatPrice(data.order.total_ttc)}</div>
              </div>
            </div>

            {data.payment && (
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 12, fontSize: '0.85rem', color: '#1e40af' }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}><FiDollarSign size={13} style={{ verticalAlign: -2 }} /> Paiement — {data.payment.statusLabel}</div>
                <div>Méthode : <strong>{data.payment.method || '—'}</strong> · Attendu : <strong>{formatPrice(data.payment.amount_expected)}</strong></div>
                {data.payment.transaction_ref && <div>Réf. transaction client : <strong>{data.payment.transaction_ref}</strong>{data.payment.payer_phone ? ` · ${data.payment.payer_phone}` : ''}</div>}
                {data.payment.invoice_ref && <div><FiFileText size={12} style={{ verticalAlign: -1 }} /> Facture : <strong>{data.payment.invoice_ref}</strong></div>}
                {data.payment.confirmed_by && <div style={{ color: '#166534' }}>Confirmé par {data.payment.confirmed_by} le {fmtDate(data.payment.confirmed_at)}</div>}
                {data.payment.reject_reason && <div style={{ color: '#991b1b' }}>Rejeté par {data.payment.rejected_by} — {data.payment.reject_reason}</div>}
              </div>
            )}

            {data.order.note_public && (
              <div style={{ marginTop: 10, fontSize: '0.85rem', color: '#475569' }}><strong>Note :</strong> {data.order.note_public}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function OrdersPanel() {
  const [data, setData] = useState({ orders: [], total: 0, pages: 1, kpis: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({ payment_status: '', search: '', page: 1 });
  const [detailId, setDetailId] = useState(null);

  const reload = useCallback(() => {
    setLoading(true); setError(false);
    listWebOrders(filters)
      .then(r => setData(r.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiShoppingCart /> Commandes web</h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { v: data.total, l: 'Commandes', c: '#0f172a' },
          { v: data.kpis?.pending ?? 0, l: 'Paiement en attente', c: '#92400e' },
          { v: data.kpis?.confirmed ?? 0, l: 'Payées', c: '#166534' },
          { v: data.kpis?.rejected ?? 0, l: 'Rejetées', c: '#991b1b' },
        ].map((k, i) => (
          <div key={i} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: k.c }}>{k.v}</div>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>{k.l}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <FiSearch size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input value={filters.search} onChange={e => update('search', e.target.value)} placeholder="N° commande, client, email, téléphone..."
            style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '0.9rem' }} />
        </div>
        <select value={filters.payment_status} onChange={e => update('payment_status', e.target.value)}
          style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', fontSize: '0.9rem' }}>
          <option value="">Tous paiements</option>
          <option value="pending">En attente</option>
          <option value="confirmed">Payées</option>
          <option value="rejected">Rejetées</option>
        </select>
      </div>

      {loading ? <Loader /> : error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : data.orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiShoppingCart size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucune commande</p>
        </div>
      ) : (
        <>
          <div className="admin-table-container">
            <table className="admin-table">
              <thead><tr><th>N°</th><th>Client</th><th style={{ textAlign: 'right' }}>Montant</th><th>Paiement</th><th>Commande</th><th>Facture</th><th>Date</th></tr></thead>
              <tbody>
                {data.orders.map(o => {
                  const pb = PAY_BADGE[o.paymentStatus] || PAY_BADGE.pending;
                  const ob = ORDER_BADGE[String(o.orderStatus)] || { label: o.orderStatusLabel, bg: '#f1f5f9', color: '#475569' };
                  return (
                    <tr key={o.payment_id} style={{ cursor: 'pointer' }} onClick={() => o.id && setDetailId(o.id)}>
                      <td><strong style={{ color: '#10531a', textDecoration: 'underline', textUnderlineOffset: 3 }}>{o.ref}</strong></td>
                      <td>{o.customer.name || o.customer.email || '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatPrice(o.amount)}</td>
                      <td><span style={{ padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, background: pb.bg, color: pb.color, border: `1px solid ${pb.border}` }}>{pb.label}</span></td>
                      <td><span style={{ padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, background: ob.bg, color: ob.color }}>{ob.label}</span></td>
                      <td>{o.invoiceRef ? <span style={{ fontSize: '0.82rem' }}>{o.invoiceRef}</span> : <span style={{ color: '#cbd5e1' }}>—</span>}</td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}><FiClock size={11} style={{ verticalAlign: -1, marginRight: 3 }} />{fmtDate(o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <button className="btn btn-outline btn-sm" disabled={filters.page <= 1} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}><FiChevronLeft size={16} /></button>
              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Page {filters.page} / {data.pages}</span>
              <button className="btn btn-outline btn-sm" disabled={filters.page >= data.pages} onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}><FiChevronRight size={16} /></button>
            </div>
          )}
        </>
      )}

      {detailId && <OrderDetailModal orderId={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
