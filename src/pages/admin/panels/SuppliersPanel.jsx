import { useState, useEffect } from 'react';
import { getSuppliers, createSupplier, updateSupplier, deleteSupplier } from '../../../api/admin';
import { FiTruck, FiPlus, FiEdit2, FiTrash2, FiSave, FiX, FiStar } from 'react-icons/fi';
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
        <button className="btn btn-primary" onClick={() => { setShowForm(!showForm); setEditId(null); setForm(EMPTY); }}>
          <FiPlus /> {showForm ? 'Fermer' : 'Nouveau fournisseur'}
        </button>
      </div>

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
              <div>
                <div className="sk-supplier-name">{s.supplier_name}</div>
                <div className="sk-supplier-meta">
                  <span><FiStar size={12} /> Priorité {s.priority_rank}</span>
                  <span>Délai {s.lead_time_avg_days}-{s.lead_time_max_days}j</span>
                </div>
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
