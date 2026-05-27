import { useState, useEffect } from 'react';
import { getSuppliers, createSupplier, updateSupplier, deleteSupplier, searchSupplierTiers, addSupplierFromTier } from '../../../api/admin';
import { FiTruck, FiPlus, FiEdit2, FiTrash2, FiSave, FiX, FiStar, FiMail, FiPhone, FiMapPin, FiHash, FiSearch, FiCheck } from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Stock.css';

const EMPTY = { supplier_name: '', priority_rank: 1, lead_time_avg_days: 14, lead_time_max_days: 30, minimum_order_amount: 0, minimum_order_qty: 0, freight_free_threshold: 0, notes: '' };

export default function SuppliersPanel() {
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [adding, setAdding] = useState(null);

  const load = () => {
    setLoading(true);
    getSuppliers().then(r => setSuppliers(r.data)).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.supplier_name.trim()) return toast.error('Nom requis');
    setSaving(true);
    try {
      if (editId) {
        await updateSupplier(editId, form);
        toast.success('Fournisseur mis à jour');
      } else {
        await createSupplier(form);
        toast.success('Fournisseur créé');
      }
      setShowForm(false); setEditId(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSaving(false); }
  };

  useEffect(() => {
    if (!showSearch || searchQ.trim().length < 2) { setSearchResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchSupplierTiers(searchQ.trim())
        .then((r) => setSearchResults(r.data.results || []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [searchQ, showSearch]);

  const handleAddFromTier = async (tier) => {
    setAdding(tier.id);
    try {
      await addSupplierFromTier(tier.id);
      toast.success(`${tier.nom} ajouté comme fournisseur`);
      setSearchResults((rs) => rs.map((r) => r.id === tier.id ? { ...r, already_supplier: true } : r));
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setAdding(null); }
  };

  const handleEdit = (s) => { setForm(s); setEditId(s.id); setShowForm(true); };
  const handleDelete = async (s) => {
    if (!confirm(`Désactiver le fournisseur "${s.supplier_name}" ?`)) return;
    try { await deleteSupplier(s.id); toast.success('Fournisseur désactivé'); load(); }
    catch { toast.error('Erreur'); }
  };

  const scoreColor = (v) => v >= 80 ? '#10b981' : v >= 50 ? '#f59e0b' : '#dc2626';

  if (loading) return <Loader />;

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiTruck /> Fournisseurs ({suppliers.length})</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setShowSearch(true)}>
            <FiSearch /> Ajouter depuis tiers
          </button>
          <button className="btn btn-outline" onClick={() => { setShowForm(!showForm); setEditId(null); setForm(EMPTY); }}>
            <FiPlus /> {showForm ? 'Fermer' : 'Saisie manuelle'}
          </button>
        </div>
      </div>

      {showSearch && (
        <div onClick={() => setShowSearch(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', zIndex: 1000 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0 }}>Rechercher un tiers Dolibarr</h4>
              <button className="btn-icon" onClick={() => { setShowSearch(false); setSearchQ(''); setSearchResults([]); }}><FiX /></button>
            </div>
            <div style={{ padding: '12px 20px', borderBottom: '1px solid #f1f5f9' }}>
              <div style={{ position: 'relative' }}>
                <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
                <input
                  autoFocus
                  type="text"
                  placeholder="Nom, code, email, téléphone… (≥ 2 caractères)"
                  value={searchQ}
                  onChange={(e) => setSearchQ(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px 10px 38px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 14 }}
                />
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 6 }}>
                La recherche couvre tous les tiers actifs (clients, prospects, fournisseurs). L'ajout pose le flag <code>fournisseur=1</code> dans Dolibarr et crée la fiche locale.
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {searching && <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>Recherche…</div>}
              {!searching && searchQ.trim().length >= 2 && searchResults.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8' }}>Aucun tiers trouvé.</div>
              )}
              {searchResults.map((t) => (
                <div key={t.id} style={{ padding: '10px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: '#0f172a' }}>{t.nom}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 3, fontSize: 12, color: '#64748b' }}>
                      {t.code_fournisseur && <span><FiHash size={10} /> {t.code_fournisseur}</span>}
                      {t.email && <span><FiMail size={10} /> {t.email}</span>}
                      {t.phone && <span><FiPhone size={10} /> {t.phone}</span>}
                      {t.town && <span><FiMapPin size={10} /> {t.town}</span>}
                    </div>
                    <div style={{ marginTop: 4, display: 'flex', gap: 4 }}>
                      {(t.client === 1 || t.client === 3) && <span style={{ background: '#dcfce7', color: '#15803d', padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 600 }}>Client</span>}
                      {t.client === 2 && <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 600 }}>Prospect</span>}
                      {t.fournisseur === 1 && <span style={{ background: '#ede9fe', color: '#7c3aed', padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 600 }}>Fourn.</span>}
                    </div>
                  </div>
                  {t.already_supplier ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#10b981', fontSize: 12, fontWeight: 600 }}>
                      <FiCheck /> Déjà ajouté
                    </span>
                  ) : (
                    <button className="btn btn-primary btn-sm" disabled={adding === t.id} onClick={() => handleAddFromTier(t)}>
                      <FiPlus size={12} /> {adding === t.id ? '…' : 'Ajouter'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <div className="admin-card" style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 12px' }}>{editId ? 'Modifier' : 'Nouveau'} fournisseur</h4>
          <form onSubmit={handleSubmit}>
            <div className="admin-form-grid">
              <div className="admin-field"><label>Nom *</label><input value={form.supplier_name} onChange={e => set('supplier_name', e.target.value)} required /></div>
              <div className="admin-field"><label>Priorité (1=haute)</label><input type="number" value={form.priority_rank} onChange={e => set('priority_rank', e.target.value)} min={1} /></div>
              <div className="admin-field"><label>Délai moyen (jours)</label><input type="number" value={form.lead_time_avg_days} onChange={e => set('lead_time_avg_days', e.target.value)} min={1} /></div>
              <div className="admin-field"><label>Délai max (jours)</label><input type="number" value={form.lead_time_max_days} onChange={e => set('lead_time_max_days', e.target.value)} min={1} /></div>
              <div className="admin-field"><label>Montant min. commande (FCFA)</label><input type="number" value={form.minimum_order_amount} onChange={e => set('minimum_order_amount', e.target.value)} min={0} /></div>
              <div className="admin-field"><label>Qté min. commande</label><input type="number" value={form.minimum_order_qty} onChange={e => set('minimum_order_qty', e.target.value)} min={0} /></div>
              <div className="admin-field"><label>Seuil franco de port (FCFA)</label><input type="number" value={form.freight_free_threshold} onChange={e => set('freight_free_threshold', e.target.value)} min={0} /></div>
            </div>
            <div className="admin-field" style={{ marginBottom: 16 }}><label>Notes</label><textarea rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} /></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving}><FiSave size={14} /> {saving ? 'Enregistrement...' : 'Enregistrer'}</button>
              <button type="button" className="btn btn-outline" onClick={() => { setShowForm(false); setEditId(null); }}><FiX size={14} /> Annuler</button>
            </div>
          </form>
        </div>
      )}

      <div className="sk-supplier-grid">
        {suppliers.map(s => (
          <div key={s.id} className="sk-supplier-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="sk-supplier-name">{s.supplier_name}</div>
                {s.dolibarr_code && (
                  <div style={{ fontSize: '0.75rem', color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <FiHash size={11} /> {s.dolibarr_code}
                  </div>
                )}
                <div className="sk-supplier-meta">
                  <span><FiStar size={12} /> Priorité {s.priority_rank}</span>
                  <span>Délai {s.lead_time_avg_days}-{s.lead_time_max_days}j</span>
                </div>
                {(s.dolibarr_email || s.dolibarr_phone || s.dolibarr_town) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6, fontSize: '0.78rem', color: '#475569' }}>
                    {s.dolibarr_email && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FiMail size={11} /> {s.dolibarr_email}</span>}
                    {s.dolibarr_phone && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FiPhone size={11} /> {s.dolibarr_phone}</span>}
                    {s.dolibarr_town && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><FiMapPin size={11} /> {s.dolibarr_town}</span>}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-icon" onClick={() => handleEdit(s)} title="Modifier"><FiEdit2 size={14} /></button>
                <button className="btn-icon danger" onClick={() => handleDelete(s)} title="Désactiver"><FiTrash2 size={14} /></button>
              </div>
            </div>

            {(s.reliability_score > 0 || s.quality_score > 0 || s.cost_score > 0) && (
              <div className="sk-supplier-scores">
                {s.reliability_score > 0 && <span className="sk-score" style={{ background: `${scoreColor(s.reliability_score)}15`, color: scoreColor(s.reliability_score) }}>Fiabilité {s.reliability_score}%</span>}
                {s.quality_score > 0 && <span className="sk-score" style={{ background: `${scoreColor(s.quality_score)}15`, color: scoreColor(s.quality_score) }}>Qualité {s.quality_score}%</span>}
                {s.cost_score > 0 && <span className="sk-score" style={{ background: `${scoreColor(s.cost_score)}15`, color: scoreColor(s.cost_score) }}>Coût {s.cost_score}%</span>}
              </div>
            )}

            {s.minimum_order_amount > 0 && (
              <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#94a3b8' }}>
                Min. commande : {s.minimum_order_amount.toLocaleString('fr-FR')} FCFA
                {s.freight_free_threshold > 0 && ` | Franco : ${s.freight_free_threshold.toLocaleString('fr-FR')} FCFA`}
              </div>
            )}
            {s.notes && <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#64748b', fontStyle: 'italic' }}>{s.notes}</div>}
          </div>
        ))}

        {suppliers.length === 0 && (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: 40, color: '#94a3b8' }}>
            <FiTruck size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
            <p>Aucun fournisseur. Cliquez sur "Nouveau fournisseur" pour commencer.</p>
          </div>
        )}
      </div>
    </div>
  );
}
