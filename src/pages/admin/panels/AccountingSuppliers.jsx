import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiPlus, FiTruck } from 'react-icons/fi';
import { getSupplierInvoices, getSuppliers, createSupplierInvoice } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function yearStart() { return `${new Date().getFullYear()}-01-01`; }
function today() { return new Date().toISOString().split('T')[0]; }

const STATUS_LABELS = { 0: 'Brouillon', 1: 'Validée', 2: 'Payée', 3: 'Abandonnée' };

export default function AccountingSuppliers() {
  const [data, setData] = useState({ invoices: [], totals: {} });
  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState({ date_from: yearStart(), date_to: today() });
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    supplier_id: '', date: today(), date_due: today(), ref_supplier: '', label: '', total_ht: '', vat_rate: '0',
  });

  const refresh = useCallback(() => {
    setLoading(true);
    getSupplierInvoices(period)
      .then(r => setData(r.data))
      .catch(() => toast.error('Erreur chargement'))
      .finally(() => setLoading(false));
  }, [period]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { getSuppliers().then(r => setSuppliers(r.data.suppliers || [])).catch(() => {}); }, []);

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const ht = Number(form.total_ht) || 0;
  const tva = Math.round(ht * (Number(form.vat_rate) || 0) / 100);
  const ttc = ht + tva;

  const handleSave = async () => {
    if (!form.supplier_id) { toast.error('Sélectionnez un fournisseur'); return; }
    if (ht <= 0) { toast.error('Montant HT invalide'); return; }
    setSaving(true);
    try {
      const r = await createSupplierInvoice({
        supplier_id: form.supplier_id, date: form.date, date_due: form.date_due,
        ref_supplier: form.ref_supplier, label: form.label,
        total_ht: ht, vat_rate: Number(form.vat_rate) || 0,
      });
      toast.success(`Facture fournisseur ${r.data.ref} créée`);
      setShowForm(false);
      setForm({ supplier_id: '', date: today(), date_due: today(), ref_supplier: '', label: '', total_ht: '', vat_rate: '0' });
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Erreur création');
    } finally { setSaving(false); }
  };

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';
  const t = data.totals || {};

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiTruck /> Factures fournisseurs ({t.nb || 0})
          </h3>
        </div>
        {!showForm && <button className="btn btn-primary" onClick={() => setShowForm(true)}><FiPlus size={14} /> Nouvelle facture</button>}
      </div>

      {showForm && (
        <div className="ac-entry-form">
          <h4 style={{ margin: '0 0 12px' }}>Saisir une facture fournisseur / charge</h4>
          <div className="ac-form-grid">
            <div className="ac-form-field">
              <label>Fournisseur</label>
              <select value={form.supplier_id} onChange={e => setF('supplier_id', e.target.value)}>
                <option value="">— Sélectionner —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="ac-form-field">
              <label>Date facture</label>
              <input type="date" value={form.date} onChange={e => setF('date', e.target.value)} />
            </div>
            <div className="ac-form-field">
              <label>Date échéance</label>
              <input type="date" value={form.date_due} onChange={e => setF('date_due', e.target.value)} />
            </div>
            <div className="ac-form-field">
              <label>Réf. fournisseur</label>
              <input type="text" value={form.ref_supplier} onChange={e => setF('ref_supplier', e.target.value)} placeholder="N° facture du fournisseur" />
            </div>
            <div className="ac-form-field" style={{ gridColumn: '1 / -1' }}>
              <label>Libellé / nature de la charge</label>
              <input type="text" value={form.label} onChange={e => setF('label', e.target.value)} placeholder="ex: Fournitures de bureau, transport..." />
            </div>
            <div className="ac-form-field">
              <label>Montant HT (XOF)</label>
              <input type="number" min="0" value={form.total_ht} onChange={e => setF('total_ht', e.target.value)} placeholder="0" />
            </div>
            <div className="ac-form-field">
              <label>Taux TVA (%)</label>
              <input type="number" min="0" step="0.1" value={form.vat_rate} onChange={e => setF('vat_rate', e.target.value)} />
            </div>
          </div>
          <div className="ac-breakdown" style={{ marginTop: 12, marginBottom: 12 }}>
            <div className="ac-breakdown-item"><strong>{formatPrice(ht)}</strong>HT</div>
            <div className="ac-breakdown-item"><strong>{formatPrice(tva)}</strong>TVA</div>
            <div className="ac-breakdown-item" style={{ background: '#f0fdf4' }}><strong style={{ color: '#10531a' }}>{formatPrice(ttc)}</strong>TTC</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Enregistrement...' : 'Enregistrer la facture'}
            </button>
            <button className="btn btn-outline" onClick={() => setShowForm(false)}>Annuler</button>
          </div>
        </div>
      )}

      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Du</label>
          <input type="date" className="ac-filter-input" value={period.date_from} onChange={e => setPeriod(p => ({ ...p, date_from: e.target.value }))} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Au</label>
          <input type="date" className="ac-filter-input" value={period.date_to} onChange={e => setPeriod(p => ({ ...p, date_to: e.target.value }))} />
        </div>
      </div>

      {!loading && t.nb > 0 && (
        <div className="ac-breakdown">
          <div className="ac-breakdown-item"><strong>{formatPrice(t.ht)}</strong>Total HT</div>
          <div className="ac-breakdown-item"><strong>{formatPrice(t.tva)}</strong>Total TVA</div>
          <div className="ac-breakdown-item" style={{ background: '#fef2f2' }}><strong style={{ color: '#dc2626' }}>{formatPrice(t.ttc)}</strong>Total TTC</div>
        </div>
      )}

      {loading ? <Loader /> : (
        <div className="ac-table-wrap">
          <table className="ac-table">
            <thead>
              <tr>
                <th>Date</th><th>Référence</th><th>Fournisseur</th><th>Libellé</th>
                <th className="ac-amount">HT</th><th className="ac-amount">TVA</th>
                <th className="ac-amount">TTC</th><th className="ac-amount">Reste dû</th><th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {data.invoices.map(inv => (
                <tr key={inv.id}>
                  <td className="ac-date">{fmtDate(inv.date)}</td>
                  <td className="ac-ref">{inv.ref}</td>
                  <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.supplier || '—'}</td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.83rem', color: '#64748b' }}>{inv.label || '—'}</td>
                  <td className="ac-amount">{formatPrice(inv.total_ht)}</td>
                  <td className="ac-amount">{formatPrice(inv.total_tva)}</td>
                  <td className="ac-amount" style={{ fontWeight: 700 }}>{formatPrice(inv.total_ttc)}</td>
                  <td className="ac-amount" style={{ color: inv.remaining > 0 ? '#dc2626' : '#94a3b8' }}>{formatPrice(inv.remaining)}</td>
                  <td><span className={`ac-badge ${inv.is_paid ? 'ac-badge-paid' : 'ac-badge-unpaid'}`}>{STATUS_LABELS[inv.status] || '—'}</span></td>
                </tr>
              ))}
              {data.invoices.length === 0 && (
                <tr><td colSpan={9} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucune facture fournisseur sur la période</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
