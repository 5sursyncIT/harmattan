import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getStockProducts } from '../../../api/admin';
import { FiArrowLeft, FiSearch, FiRepeat, FiPackage, FiAlertCircle, FiClock } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import StockNav from './StockNav';
import StockTransferModal from './StockTransferModal';
import StockTransferHistory from './StockTransferHistory';
import './Stock.css';

/**
 * Transfert de stock entre entrepôts — écran de recherche rapide.
 * On cherche un titre, on clique « Transférer », on choisit dépôt source →
 * destination + quantité. Pour la circulation de livres réserve ↔ rayon ↔ dépôts.
 */
export default function StockTransferPanel() {
  const [view, setView] = useState('transfer'); // 'transfer' | 'history'
  const [refreshKey, setRefreshKey] = useState(0);
  const [q, setQ] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [transfer, setTransfer] = useState(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setProducts([]); setError(false); return; }
    let cancelled = false;
    setLoading(true); setError(false);
    const t = setTimeout(() => {
      getStockProducts({ q: term, page: 1, sort: 'label', order: 'ASC', limit: 20 })
        .then(r => { if (!cancelled) setProducts(r.data.products || []); })
        .catch(() => { if (!cancelled) setError(true); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 300); // debounce
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiRepeat size={18} style={{ color: '#1e40af' }} /> Transfert entre entrepôts</h3>
        </div>
      </div>

      <StockNav />

      {/* Bascule : effectuer un transfert / consulter l'historique */}
      <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 10, padding: 4, gap: 4, marginBottom: 16 }}>
        {[
          { k: 'transfer', label: 'Nouveau transfert', icon: <FiRepeat size={14} /> },
          { k: 'history', label: 'Historique', icon: <FiClock size={14} /> },
        ].map(t => (
          <button key={t.k} onClick={() => setView(t.k)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8,
              border: 'none', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 700,
              background: view === t.k ? '#fff' : 'transparent',
              color: view === t.k ? '#10531a' : '#64748b',
              boxShadow: view === t.k ? '0 1px 3px rgba(0,0,0,.1)' : 'none',
            }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {view === 'history' ? (
        <StockTransferHistory refreshKey={refreshKey} />
      ) : (
      <>
      <p style={{ color: '#64748b', fontSize: '0.88rem', marginTop: 0 }}>
        Cherchez un titre, puis déplacez des exemplaires d'un <strong>entrepôt</strong> à un autre (réserve, rayon, dépôt…). Le stock total reste inchangé.
      </p>

      {/* Recherche */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <FiSearch size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
        <input type="text" placeholder="Titre, ISBN ou référence…" value={q} autoFocus
          onChange={e => setQ(e.target.value)}
          style={{ width: '100%', padding: '12px 14px 12px 42px', borderRadius: 10, border: '2px solid #e2e8f0', fontSize: '0.95rem' }} />
      </div>

      {q.trim().length < 2 ? (
        <div className="sk-empty">
          <FiSearch size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Tapez au moins 2 caractères pour chercher un titre</p>
        </div>
      ) : loading ? <Loader /> : error ? (
        <div className="sk-empty">
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de recherche</p>
        </div>
      ) : products.length === 0 ? (
        <div className="sk-empty">
          <FiPackage size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucun produit pour « {q} »</p>
        </div>
      ) : (
        <>
          <div style={{ fontSize: '0.82rem', color: '#64748b', margin: '0 0 8px' }}>
            {products.length} titre{products.length > 1 ? 's' : ''} · cliquez une ligne pour transférer
          </div>
          <div className="sk-table-wrap">
            <table className="sk-table">
              <thead>
                <tr>
                  <th>Réf.</th>
                  <th>Titre</th>
                  <th style={{ textAlign: 'center' }}>Stock total</th>
                  <th style={{ width: 130 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {products.map(p => {
                  const noStock = p.stock <= 0;
                  const badge = noStock ? 'zero' : p.stock < 5 ? 'low' : 'ok';
                  return (
                    <tr key={p.product_id}
                      className={noStock ? '' : 'sk-trf-clickable'}
                      onClick={noStock ? undefined : () => setTransfer(p)}>
                      <td className="mono">{p.ref}</td>
                      <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span className={`sk-trf-stock-badge ${badge}`}>{p.stock}</span>
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <button onClick={() => setTransfer(p)} disabled={noStock} className="sk-alert-btn"
                          title={noStock ? 'Aucun exemplaire à déplacer' : 'Transférer entre entrepôts'}
                          style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.78rem',
                            color: noStock ? '#94a3b8' : '#1e40af', borderColor: noStock ? '#e2e8f0' : '#bfdbfe',
                            background: noStock ? '#f8fafc' : '#eff6ff', cursor: noStock ? 'not-allowed' : 'pointer' }}>
                          <FiRepeat size={12} /> Transférer
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      </>
      )}

      {transfer && (
        <StockTransferModal
          product={transfer}
          onClose={() => setTransfer(null)}
          onDone={() => setRefreshKey(k => k + 1)}
        />
      )}
    </div>
  );
}
