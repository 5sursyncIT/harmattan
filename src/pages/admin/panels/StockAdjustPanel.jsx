import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getStockProducts } from '../../../api/admin';
import { FiArrowLeft, FiSearch, FiClipboard, FiPackage, FiAlertCircle } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import StockNav from './StockNav';
import StockAdjustModal from './StockAdjustModal';
import './Stock.css';

/**
 * Ajustement d'inventaire — écran de recherche rapide.
 * On tape un titre / ISBN / référence, on clique « Ajuster », on saisit la
 * quantité physiquement présente. Pensé pour une correction immédiate au rayon.
 */
export default function StockAdjustPanel() {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [adjust, setAdjust] = useState(null);

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

  // Met à jour le stock affiché localement après un ajustement réussi.
  const handleDone = (res) => {
    if (!res || typeof res.counted !== 'number') return;
    setProducts(ps => ps.map(p => p.product_id === adjust?.product_id ? { ...p, stock: res.counted } : p));
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiClipboard size={18} style={{ color: '#1e40af' }} /> Ajustement d'inventaire</h3>
        </div>
      </div>

      <StockNav />

      <p style={{ color: '#64748b', fontSize: '0.88rem', marginTop: 0 }}>
        Cherchez un titre (titre, ISBN ou référence), puis saisissez la quantité <strong>physiquement présente</strong>. Le système calcule l'écart et corrige le stock.
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
        <div className="sk-table-wrap">
          <table className="sk-table">
            <thead>
              <tr>
                <th>Réf.</th>
                <th>Titre</th>
                <th style={{ textAlign: 'center' }}>Stock système</th>
                <th style={{ width: 120 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.product_id}>
                  <td className="mono">{p.ref}</td>
                  <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</td>
                  <td style={{ textAlign: 'center', fontWeight: 700, color: p.stock <= 0 ? '#dc2626' : p.stock < 5 ? '#f59e0b' : '#0f172a' }}>{p.stock}</td>
                  <td>
                    <button onClick={() => setAdjust(p)} className="sk-alert-btn"
                      style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#1e40af', borderColor: '#bfdbfe', background: '#eff6ff', fontSize: '0.78rem' }}>
                      <FiClipboard size={12} /> Ajuster
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adjust && (
        <StockAdjustModal
          product={adjust}
          onClose={() => setAdjust(null)}
          onDone={handleDone}
        />
      )}
    </div>
  );
}
