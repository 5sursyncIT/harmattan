import { useState, useEffect, useCallback } from 'react';
import {
  FiFileText, FiSearch, FiX, FiMail, FiPhone, FiMapPin, FiDownload,
  FiClock, FiAlertCircle, FiChevronLeft, FiChevronRight,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import { formatPrice } from '../../../utils/formatters';
import { listPropals, getPropal, openPropalPdf } from '../../../api/propals';
import './Contracts.css';

const STATUS_BADGE = {
  0: { label: 'Brouillon', bg: '#f1f5f9', color: '#475569' },
  1: { label: 'Validé', bg: '#eff6ff', color: '#1e40af' },
  2: { label: 'Signé', bg: '#f0fdf4', color: '#166534' },
  3: { label: 'Non signé', bg: '#fef2f2', color: '#991b1b' },
  4: { label: 'Facturé', bg: '#faf5ff', color: '#7c3aed' },
};
const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

function PropalDetailModal({ id, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPropal(id)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) toast.error('Devis introuvable'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

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
                <FiFileText size={18} /> {data.propal.ref}
                <span style={{ padding: '2px 10px', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700, background: (STATUS_BADGE[data.propal.status] || STATUS_BADGE[0]).bg, color: (STATUS_BADGE[data.propal.status] || STATUS_BADGE[0]).color }}>
                  {data.propal.statusLabel}
                </span>
              </h3>
              <button onClick={onClose} className="ct-btn-ghost" aria-label="Fermer"><FiX size={20} /></button>
            </div>

            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 14, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: '#0f172a' }}>{data.propal.customer.name || '—'}</div>
              <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 16px' }}>
                {data.propal.customer.email && <span><FiMail size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.propal.customer.email}</span>}
                {data.propal.customer.phone && <span><FiPhone size={12} style={{ verticalAlign: -1, marginRight: 4 }} />{data.propal.customer.phone}</span>}
              </div>
              {(data.propal.customer.address || data.propal.customer.town) && (
                <div style={{ fontSize: '0.85rem', color: '#475569', marginTop: 4 }}>
                  <FiMapPin size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                  {[data.propal.customer.address, [data.propal.customer.zip, data.propal.customer.town].filter(Boolean).join(' ')].filter(Boolean).join(', ')}
                </div>
              )}
              <div style={{ fontSize: '0.82rem', color: '#94a3b8', marginTop: 4 }}>
                Devis du {day(data.propal.date)}{data.propal.expiry ? ` · valable jusqu'au ${day(data.propal.expiry)}` : ''}
              </div>
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
                <div>{formatPrice(data.propal.total_ht)}</div>
                <div>{formatPrice(data.propal.total_tva)}</div>
                <div style={{ fontWeight: 800, color: '#10531a', fontSize: '1rem' }}>{formatPrice(data.propal.total_ttc)}</div>
              </div>
            </div>

            {data.propal.note_public && (
              <div style={{ marginBottom: 10, fontSize: '0.85rem', color: '#475569' }}><strong>Note :</strong> {data.propal.note_public}</div>
            )}

            <div className="ct-modal-actions">
              <button className="ct-btn ct-btn-outline" onClick={() => openPropalPdf(data.propal.id)}><FiDownload size={14} /> PDF</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default function DevisPanel() {
  const [data, setData] = useState({ propals: [], total: 0, pages: 1, kpis: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({ status: '', search: '', page: 1 });
  const [detailId, setDetailId] = useState(null);

  const reload = useCallback(() => {
    setLoading(true); setError(false);
    listPropals(filters)
      .then(r => setData(r.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  const update = (k, v) => setFilters(f => ({ ...f, [k]: v, page: 1 }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiFileText /> Devis</h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { v: data.total, l: 'Devis', c: '#0f172a' },
          { v: data.kpis?.open ?? 0, l: 'En cours', c: '#1e40af' },
          { v: data.kpis?.signed ?? 0, l: 'Signés', c: '#166534' },
          { v: data.kpis?.billed ?? 0, l: 'Facturés', c: '#7c3aed' },
          { v: formatPrice(data.kpis?.open_amount ?? 0), l: 'Montant en cours', c: '#0f172a', small: true },
        ].map((k, i) => (
          <div key={i} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: k.small ? '1.05rem' : '1.5rem', fontWeight: 800, color: k.c }}>{k.v}</div>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 2 }}>{k.l}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <FiSearch size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input value={filters.search} onChange={e => update('search', e.target.value)} placeholder="N° devis, réf. client, nom du client..."
            style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '0.9rem' }} />
        </div>
        <select value={filters.status} onChange={e => update('status', e.target.value)}
          style={{ padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', fontSize: '0.9rem' }}>
          <option value="">Tous statuts</option>
          <option value="0">Brouillon</option>
          <option value="1">Validé</option>
          <option value="2">Signé</option>
          <option value="3">Non signé</option>
          <option value="4">Facturé</option>
        </select>
      </div>

      {loading ? <Loader /> : error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : data.propals.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiFileText size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucun devis</p>
        </div>
      ) : (
        <>
          <div className="admin-table-container">
            <table className="admin-table">
              <thead><tr><th>N°</th><th>Client</th><th style={{ textAlign: 'right' }}>Montant TTC</th><th>Statut</th><th>Date</th><th>Validité</th><th></th></tr></thead>
              <tbody>
                {data.propals.map(p => {
                  const b = STATUS_BADGE[p.status] || { label: p.statusLabel, bg: '#f1f5f9', color: '#475569' };
                  return (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(p.id)}>
                      <td><strong style={{ color: '#10531a', textDecoration: 'underline', textUnderlineOffset: 3 }}>{p.ref}</strong></td>
                      <td>{p.customer_name}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatPrice(p.total_ttc)}</td>
                      <td><span style={{ padding: '2px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 700, background: b.bg, color: b.color }}>{b.label}</span></td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{fmtDate(p.date)}</td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{p.expiry ? <><FiClock size={11} style={{ verticalAlign: -1, marginRight: 3 }} />{fmtDate(p.expiry)}</> : '—'}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <button className="ct-btn-ghost" onClick={() => openPropalPdf(p.id)} title="PDF"><FiDownload size={16} /></button>
                      </td>
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

      {detailId && <PropalDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}
