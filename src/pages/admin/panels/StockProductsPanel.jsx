import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getStockProducts, updateStockPolicy, requestReprint, requestSupplierOrder } from '../../../api/admin';
import { FiArrowLeft, FiSearch, FiEdit2, FiSave, FiX, FiChevronLeft, FiChevronRight, FiPrinter, FiShoppingCart } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Stock.css';

function CoverageBar({ days }) {
  const pct = Math.min(100, (days / 90) * 100);
  const color = days <= 7 ? '#dc2626' : days <= 30 ? '#f59e0b' : '#10b981';
  return (
    <span>
      <span className="sk-cov-bar"><span className="sk-cov-fill" style={{ width: `${pct}%`, background: color }} /></span>
      <span style={{ fontSize: '0.8rem', color }}>{days > 365 ? '>365' : days}j</span>
    </span>
  );
}

export default function StockProductsPanel() {
  const [data, setData] = useState({ products: [], total: 0, pages: 1 });
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('coverage');
  const [order, setOrder] = useState('ASC');
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [replenish, setReplenish] = useState(null); // { product, qty }
  const [replenishing, setReplenishing] = useState(false);
  const [replenishResult, setReplenishResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStockProducts({ q, page, sort, order, limit: 30 })
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [q, page, sort, order]);

  const toggleSort = (col) => {
    if (sort === col) setOrder(o => o === 'ASC' ? 'DESC' : 'ASC');
    else { setSort(col); setOrder('ASC'); }
    setPage(1);
  };

  const startEdit = (p) => {
    setEditId(p.product_id);
    setEditForm({
      lead_time_days: p.lead_time_days || 14,
      safety_stock: p.safety_stock || 0,
      reorder_point: p.reorder_point || 0,
      max_stock_target: 0,
    });
  };

  const handleSave = async (productId) => {
    setSaving(true);
    try {
      await updateStockPolicy(productId, editForm);
      toast.success('Politique stock mise à jour');
      setEditId(null);
      // Refresh
      const r = await getStockProducts({ q, page, sort, order, limit: 30 });
      setData(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  const handleReplenish = async () => {
    if (!replenish) return;
    setReplenishing(true);
    try {
      const { product, qty } = replenish;
      if (product.supply_type === 'reimpression') {
        const r = await requestReprint(product.product_id, qty);
        setReplenishResult({ type: 'reimpression', ref: r.data.mo_ref, qty, product });
      } else {
        const r = await requestSupplierOrder(product.product_id, qty);
        setReplenishResult({ type: 'commande', ref: r.data.order_ref, qty, product });
      }
      setReplenish(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de la création');
    } finally {
      setReplenishing(false);
    }
  };

  const closeResult = () => {
    setReplenishResult(null);
    // Rafraîchir la liste
    setPage(p => p);
  };

  const SortHeader = ({ col, children }) => (
    <th onClick={() => toggleSort(col)} style={{ cursor: 'pointer', userSelect: 'none' }}>
      {children} {sort === col ? (order === 'ASC' ? '↑' : '↓') : ''}
    </th>
  );

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/stock" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0 }}>Gestion du stock ({data.total} produits)</h3>
        </div>
      </div>

      {/* Recherche */}
      <div style={{ position: 'relative', marginBottom: 16 }}>
        <FiSearch size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
        <input type="text" placeholder="Rechercher par titre ou référence..."
          value={q} onChange={e => { setQ(e.target.value); setPage(1); }}
          style={{ width: '100%', padding: '10px 14px 10px 42px', borderRadius: 10, border: '2px solid #e2e8f0', fontSize: '0.9rem' }} />
      </div>

      {loading ? <Loader /> : (
        <>
          <div className="sk-table-wrap">
            <table className="sk-table">
              <thead>
                <tr>
                  <th>Réf.</th>
                  <th>Titre</th>
                  <th>ABC</th>
                  <SortHeader col="stock">Stock</SortHeader>
                  <SortHeader col="sold">Ventes 30j</SortHeader>
                  <SortHeader col="coverage">Couverture</SortHeader>
                  <th>Sécurité</th>
                  <th>Point cmd.</th>
                  <th>Délai (j)</th>
                  <th>Réappro</th>
                  <th style={{ width: 100 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map(p => {
                  const isEditing = editId === p.product_id;

                  if (isEditing) {
                    return (
                      <tr key={p.product_id} style={{ background: '#fefce8' }}>
                        <td className="mono">{p.ref}</td>
                        <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</td>
                        <td>{p.abc_class && <span className={`sk-abc sk-abc-${p.abc_class}`}>{p.abc_class}</span>}</td>
                        <td style={{ fontWeight: 700 }}>{p.stock}</td>
                        <td>{p.sold_30d}</td>
                        <td><CoverageBar days={p.coverage_days} /></td>
                        <td><input type="number" value={editForm.safety_stock} onChange={e => setEditForm({ ...editForm, safety_stock: parseInt(e.target.value) || 0 })} min={0} style={{ width: 60, padding: '4px 6px', borderRadius: 4, border: '1px solid #f59e0b', fontSize: '0.85rem' }} /></td>
                        <td><input type="number" value={editForm.reorder_point} onChange={e => setEditForm({ ...editForm, reorder_point: parseInt(e.target.value) || 0 })} min={0} style={{ width: 60, padding: '4px 6px', borderRadius: 4, border: '1px solid #f59e0b', fontSize: '0.85rem' }} /></td>
                        <td><input type="number" value={editForm.lead_time_days} onChange={e => setEditForm({ ...editForm, lead_time_days: parseInt(e.target.value) || 1 })} min={1} style={{ width: 50, padding: '4px 6px', borderRadius: 4, border: '1px solid #f59e0b', fontSize: '0.85rem' }} /></td>
                        <td><span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{p.supply_type === 'reimpression' ? 'Réimpr.' : 'Cmd.'}</span></td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn-icon" style={{ color: '#10531a' }} onClick={() => handleSave(p.product_id)} disabled={saving} title="Enregistrer"><FiSave size={14} /></button>
                            <button className="btn-icon" onClick={() => setEditId(null)} title="Annuler"><FiX size={14} /></button>
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr key={p.product_id}>
                      <td className="mono">{p.ref}</td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.label}</td>
                      <td>{p.abc_class && <span className={`sk-abc sk-abc-${p.abc_class}`}>{p.abc_class}</span>}</td>
                      <td style={{ fontWeight: 700, color: p.stock <= 0 ? '#dc2626' : p.stock < 5 ? '#f59e0b' : '#0f172a' }}>{p.stock}</td>
                      <td>{p.sold_30d}</td>
                      <td><CoverageBar days={p.coverage_days} /></td>
                      <td style={{ color: '#64748b' }}>{p.safety_stock}</td>
                      <td style={{ color: '#64748b' }}>{p.reorder_point}</td>
                      <td style={{ color: '#64748b' }}>{p.lead_time_days}</td>
                      <td>
                        {p.supply_type === 'reimpression' ? (
                          <button onClick={() => setReplenish({ product: p, qty: Math.max(p.reorder_point - p.stock, 1) })} className="sk-alert-btn" style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 3, color: '#1e40af', borderColor: '#bfdbfe', background: '#eff6ff' }} title="Demander réimpression"><FiPrinter size={10} /> Réimpr.</button>
                        ) : (
                          <button onClick={() => setReplenish({ product: p, qty: Math.max(p.reorder_point - p.stock, 1) })} className="sk-alert-btn" style={{ fontSize: '0.7rem', display: 'flex', alignItems: 'center', gap: 3, color: '#92400e', borderColor: '#fde68a', background: '#fffbeb' }} title="Commander au fournisseur"><FiShoppingCart size={10} /> Cmd.</button>
                        )}
                      </td>
                      <td>
                        <button className="btn-icon" onClick={() => startEdit(p)} title="Modifier les seuils"><FiEdit2 size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {data.pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 16 }}>
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="sk-filter-btn"><FiChevronLeft size={14} /></button>
              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Page {page} / {data.pages}</span>
              <button disabled={page >= data.pages} onClick={() => setPage(p => p + 1)} className="sk-filter-btn"><FiChevronRight size={14} /></button>
            </div>
          )}
        </>
      )}

      {/* Modal de réapprovisionnement */}
      {replenish && (
        <div className="ct-modal-overlay" onClick={() => !replenishing && setReplenish(null)}>
          <div className="ct-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500, padding: 0, overflow: 'hidden' }}>

            {/* En-tête coloré */}
            <div style={{ padding: '20px 24px', background: replenish.product.supply_type === 'reimpression' ? '#eff6ff' : '#fffbeb', borderBottom: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                {replenish.product.supply_type === 'reimpression'
                  ? <FiPrinter size={20} style={{ color: '#1e40af' }} />
                  : <FiShoppingCart size={20} style={{ color: '#92400e' }} />}
                <h3 style={{ margin: 0, fontSize: '1.1rem' }}>
                  {replenish.product.supply_type === 'reimpression' ? 'Demander une réimpression' : 'Commander au fournisseur'}
                </h3>
              </div>
              <span style={{ fontSize: '0.8rem', padding: '2px 8px', borderRadius: 4, background: replenish.product.supply_type === 'reimpression' ? '#dbeafe' : '#fef3c7', color: replenish.product.supply_type === 'reimpression' ? '#1e40af' : '#92400e', fontWeight: 700 }}>
                {replenish.product.supply_type === 'reimpression' ? 'Titre interne — L\'Harmattan Sénégal' : replenish.product.editeur || 'Titre externe'}
              </span>
            </div>

            <div style={{ padding: '20px 24px' }}>
              {/* Infos produit */}
              <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16, marginBottom: 20, border: '1px solid #e2e8f0' }}>
                <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 6, color: '#0f172a' }}>{replenish.product.label}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: '0.85rem' }}>
                  <div><span style={{ color: '#94a3b8' }}>Réf. </span><span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{replenish.product.ref}</span></div>
                  <div><span style={{ color: '#94a3b8' }}>Catégorie </span><span>{replenish.product.category || '—'}</span></div>
                  <div><span style={{ color: '#94a3b8' }}>Stock actuel </span><span style={{ fontWeight: 700, color: replenish.product.stock <= 0 ? '#dc2626' : '#0f172a' }}>{replenish.product.stock} unités</span></div>
                  <div><span style={{ color: '#94a3b8' }}>Couverture </span><span style={{ fontWeight: 700, color: replenish.product.coverage_days <= 7 ? '#dc2626' : '#0f172a' }}>{replenish.product.coverage_days}j</span></div>
                  <div><span style={{ color: '#94a3b8' }}>Point de commande </span><span>{replenish.product.reorder_point}</span></div>
                  <div><span style={{ color: '#94a3b8' }}>Ventes 30j </span><span>{replenish.product.sold_30d}</span></div>
                </div>
              </div>

              {/* Quantité */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '0.9rem', marginBottom: 6, color: '#0f172a' }}>
                  Quantité à {replenish.product.supply_type === 'reimpression' ? 'réimprimer' : 'commander'}
                </label>
                <input type="number" value={replenish.qty}
                  onChange={e => setReplenish({ ...replenish, qty: Math.max(1, parseInt(e.target.value) || 1) })}
                  min={1} autoFocus
                  style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: '2px solid #10531a', fontSize: '1.2rem', fontWeight: 700, textAlign: 'center' }} />
                <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginTop: 4, textAlign: 'center' }}>
                  Recommandé : {Math.max(replenish.product.reorder_point - replenish.product.stock, 1)} unités
                </div>
              </div>

              {/* Boutons */}
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => setReplenish(null)} disabled={replenishing}
                  style={{ flex: 1, padding: '12px', borderRadius: 10, border: '1px solid #d1d5db', background: '#fff', fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>
                  Annuler
                </button>
                <button onClick={handleReplenish} disabled={replenishing}
                  style={{ flex: 2, padding: '12px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    background: replenish.product.supply_type === 'reimpression' ? '#1e40af' : '#10531a', color: '#fff' }}>
                  {replenishing ? 'Création en cours...' : (
                    <>{replenish.product.supply_type === 'reimpression' ? <><FiPrinter size={16} /> Lancer la réimpression</> : <><FiShoppingCart size={16} /> Créer la commande</>}</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de succès */}
      {replenishResult && (
        <div className="ct-modal-overlay" onClick={closeResult}>
          <div className="ct-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 440, padding: 0, overflow: 'hidden', textAlign: 'center' }}>
            <div style={{ padding: '32px 24px 20px', background: replenishResult.type === 'reimpression' ? '#eff6ff' : '#f0fdf4' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: replenishResult.type === 'reimpression' ? '#1e40af' : '#10531a', color: '#fff' }}>
                {replenishResult.type === 'reimpression' ? <FiPrinter size={24} /> : <FiShoppingCart size={24} />}
              </div>
              <h3 style={{ margin: '0 0 4px', fontSize: '1.2rem', color: '#0f172a' }}>
                {replenishResult.type === 'reimpression' ? 'Réimpression demandée' : 'Commande créée'}
              </h3>
              <div style={{ fontSize: '0.9rem', color: '#64748b' }}>dans Dolibarr</div>
            </div>
            <div style={{ padding: '20px 24px 24px' }}>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: 14, marginBottom: 16, border: '1px solid #e2e8f0', textAlign: 'left' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Référence</span>
                  <span style={{ fontWeight: 800, fontFamily: 'monospace', fontSize: '1rem', color: '#10531a' }}>{replenishResult.ref}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Produit</span>
                  <span style={{ fontWeight: 600, fontSize: '0.85rem', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replenishResult.product.label}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Quantité</span>
                  <span style={{ fontWeight: 700, fontSize: '1rem' }}>{replenishResult.qty} exemplaires</span>
                </div>
              </div>
              <button onClick={closeResult}
                style={{ width: '100%', padding: '12px', borderRadius: 10, border: 'none', fontWeight: 700, fontSize: '0.95rem', cursor: 'pointer', background: '#10531a', color: '#fff' }}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
