import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiPercent } from 'react-icons/fi';
import { getVatReport } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function firstDayOfMonth() { const d = new Date(); d.setDate(1); return d.toISOString().split('T')[0]; }
function today() { return new Date().toISOString().split('T')[0]; }

function VatTable({ title, rows, total, totalLabel }) {
  return (
    <div className="ac-table-wrap" style={{ marginBottom: 16 }}>
      <table className="ac-table">
        <thead>
          <tr>
            <th colSpan={3} style={{ fontSize: '0.8rem', color: '#0f172a' }}>{title}</th>
          </tr>
          <tr>
            <th>Taux TVA</th>
            <th className="ac-amount">Base HT</th>
            <th className="ac-amount">Montant TVA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="ac-ref">{r.rate}%</td>
              <td className="ac-amount">{formatPrice(r.base)}</td>
              <td className="ac-amount" style={{ fontWeight: 600 }}>{formatPrice(r.tva)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} style={{ textAlign: 'center', padding: 24, color: '#94a3b8' }}>Aucune donnée</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>{totalLabel}</td>
            <td className="ac-amount">{formatPrice(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function AccountingVat() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState({ date_from: firstDayOfMonth(), date_to: today() });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getVatReport(period)
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [period]);

  const update = (k, v) => setPeriod(p => ({ ...p, [k]: v }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiPercent /> Déclaration de TVA
          </h3>
        </div>
      </div>

      <div className="ac-filters">
        <div className="ac-filter-group">
          <label className="ac-filter-label">Du</label>
          <input type="date" className="ac-filter-input" value={period.date_from} onChange={e => update('date_from', e.target.value)} />
        </div>
        <div className="ac-filter-group">
          <label className="ac-filter-label">Au</label>
          <input type="date" className="ac-filter-input" value={period.date_to} onChange={e => update('date_to', e.target.value)} />
        </div>
      </div>

      {loading ? <Loader /> : data && (
        <>
          <div className={`ac-result-banner ${data.net >= 0 ? 'loss' : 'profit'}`}>
            <span className="ac-result-label">
              {data.net >= 0 ? 'TVA nette à reverser à l\'État' : 'Crédit de TVA en faveur de l\'entreprise'}
            </span>
            <span className="ac-result-value">{formatPrice(Math.abs(data.net))}</span>
          </div>

          <VatTable title="TVA collectée sur les ventes" rows={data.collected}
                    total={data.total_collected} totalLabel="Total TVA collectée" />
          <VatTable title="TVA déductible sur les achats" rows={data.deductible}
                    total={data.total_deductible} totalLabel="Total TVA déductible" />

          <div className="ac-info-box">
            TVA nette = TVA collectée ({formatPrice(data.total_collected)}) − TVA déductible ({formatPrice(data.total_deductible)})
            = <strong>{formatPrice(data.net)}</strong>.
          </div>
        </>
      )}
    </div>
  );
}
