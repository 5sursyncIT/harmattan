import { useState, useEffect, useCallback } from 'react';
import { getStockTransfers } from '../../../api/admin';
import { FiSearch, FiRepeat, FiArrowRight, FiAlertCircle, FiClock, FiUser, FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';

const fmtDateTime = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(s);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' · ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
};

/**
 * Historique des transferts entre entrepôts.
 * Lecture seule, paginé + filtrable (titre, dépôt, code). `refreshKey` force
 * un rechargement après un nouveau transfert.
 */
export default function StockTransferHistory({ refreshKey }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ transfers: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => { setPage(1); }, [q]);

  const load = useCallback((signal) => {
    setLoading(true); setError(false);
    getStockTransfers({ q: q.trim(), page, limit: 20 })
      .then(r => { if (!signal?.cancelled) setData(r.data); })
      .catch(() => { if (!signal?.cancelled) setError(true); })
      .finally(() => { if (!signal?.cancelled) setLoading(false); });
  }, [q, page]);

  useEffect(() => {
    const signal = { cancelled: false };
    const t = setTimeout(() => load(signal), 250); // debounce filtre
    return () => { signal.cancelled = true; clearTimeout(t); };
  }, [load, refreshKey]);

  const srcChip = { background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', padding: '2px 8px', borderRadius: 6, fontWeight: 700, fontSize: '0.78rem' };
  const dstChip = { background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', padding: '2px 8px', borderRadius: 6, fontWeight: 700, fontSize: '0.78rem' };

  return (
    <>
      <div style={{ position: 'relative', marginBottom: 14 }}>
        <FiSearch size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
        <input type="text" placeholder="Filtrer par titre, dépôt ou code…" value={q}
          onChange={e => setQ(e.target.value)}
          style={{ width: '100%', padding: '12px 14px 12px 42px', borderRadius: 10, border: '2px solid #e2e8f0', fontSize: '0.95rem' }} />
      </div>

      {loading ? <Loader /> : error ? (
        <div className="sk-empty">
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
        </div>
      ) : data.transfers.length === 0 ? (
        <div className="sk-empty">
          <FiRepeat size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>{q ? 'Aucun transfert pour ce filtre' : 'Aucun transfert enregistré'}</p>
        </div>
      ) : (
        <>
          <div className="sk-table-wrap">
            <table className="sk-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Titre</th>
                  <th style={{ textAlign: 'center' }}>Qté</th>
                  <th>Mouvement</th>
                  <th>Motif</th>
                  <th>Par</th>
                </tr>
              </thead>
              <tbody>
                {data.transfers.map(t => (
                  <tr key={t.id || t.code}>
                    <td style={{ whiteSpace: 'nowrap', color: '#64748b', fontSize: '0.82rem' }}>
                      <FiClock size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{fmtDateTime(t.date)}
                    </td>
                    <td style={{ maxWidth: 280 }}>
                      <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.product_label}</div>
                      <div className="mono" style={{ fontSize: '0.74rem' }}>{t.product_ref}</div>
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 800, color: '#0f172a' }}>{t.qty}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <span style={srcChip}>{t.source_ref}</span>
                      <FiArrowRight size={13} style={{ color: '#94a3b8', margin: '0 6px', verticalAlign: -2 }} />
                      <span style={dstChip}>{t.dest_ref}</span>
                    </td>
                    <td style={{ color: '#64748b', fontSize: '0.82rem', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.reason || ''}>{t.reason || '—'}</td>
                    <td style={{ fontSize: '0.82rem', color: '#475569', whiteSpace: 'nowrap' }}>
                      {t.user ? <><FiUser size={11} style={{ verticalAlign: -1, marginRight: 4 }} />{t.user}</> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>{data.total} transfert{data.total > 1 ? 's' : ''}</span>
            {data.pages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="sk-btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><FiChevronLeft size={16} /></button>
                <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Page {page} / {data.pages}</span>
                <button className="sk-btn-ghost" disabled={page >= data.pages} onClick={() => setPage(p => p + 1)}><FiChevronRight size={16} /></button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
