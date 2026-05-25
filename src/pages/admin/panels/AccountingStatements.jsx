import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiTrendingUp } from 'react-icons/fi';
import { getIncomeStatement, getBalanceSheet } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Accounting.css';

function yearStart() { return `${new Date().getFullYear()}-01-01`; }
function today() { return new Date().toISOString().split('T')[0]; }

function StatementColumn({ variant, title, rows, total, totalLabel }) {
  return (
    <div className="ac-statement">
      <div className={`ac-statement-head ${variant}`}>{title}</div>
      {rows.length === 0 && <div className="ac-stmt-row" style={{ color: '#94a3b8' }}>Aucun mouvement</div>}
      {rows.map((r, i) => (
        <div className="ac-stmt-row" key={r.number + i}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span className="ac-stmt-num">{r.number}</span>{r.label}
          </span>
          <span className="ac-stmt-amt">{formatPrice(r.amount)}</span>
        </div>
      ))}
      <div className="ac-stmt-total">
        <span>{totalLabel}</span>
        <span>{formatPrice(total)}</span>
      </div>
    </div>
  );
}

export default function AccountingStatements() {
  const [tab, setTab] = useState('result');
  const [income, setIncome] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState({ date_from: yearStart(), date_to: today() });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const load = tab === 'result'
      ? getIncomeStatement(period).then(r => { if (!cancelled) setIncome(r.data); })
      : getBalanceSheet({ date_to: period.date_to }).then(r => { if (!cancelled) setSheet(r.data); });
    load.catch(() => { if (!cancelled) toast.error('Erreur chargement'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, period]);

  const update = (k, v) => setPeriod(p => ({ ...p, [k]: v }));

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiTrendingUp /> États financiers
          </h3>
        </div>
      </div>

      <div className="ac-tabs">
        <button className={`ac-tab ${tab === 'result' ? 'active' : ''}`} onClick={() => setTab('result')}>Compte de résultat</button>
        <button className={`ac-tab ${tab === 'sheet' ? 'active' : ''}`} onClick={() => setTab('sheet')}>Bilan</button>
      </div>

      <div className="ac-filters">
        {tab === 'result' && (
          <div className="ac-filter-group">
            <label className="ac-filter-label">Du</label>
            <input type="date" className="ac-filter-input" value={period.date_from} onChange={e => update('date_from', e.target.value)} />
          </div>
        )}
        <div className="ac-filter-group">
          <label className="ac-filter-label">{tab === 'result' ? 'Au' : 'Arrêté au'}</label>
          <input type="date" className="ac-filter-input" value={period.date_to} onChange={e => update('date_to', e.target.value)} />
        </div>
      </div>

      {loading ? <Loader /> : tab === 'result' ? (
        income && (
          <>
            <div className={`ac-result-banner ${income.result >= 0 ? 'profit' : 'loss'}`}>
              <span className="ac-result-label">{income.result >= 0 ? 'Bénéfice net de la période' : 'Perte nette de la période'}</span>
              <span className="ac-result-value">{formatPrice(Math.abs(income.result))}</span>
            </div>
            <div className="ac-statement-grid">
              <StatementColumn variant="charges" title="Charges (classe 6)" rows={income.charges}
                               total={income.total_charges} totalLabel="Total des charges" />
              <StatementColumn variant="produits" title="Produits (classe 7)" rows={income.produits}
                               total={income.total_produits} totalLabel="Total des produits" />
            </div>
          </>
        )
      ) : (
        sheet && (
          <>
            {sheet.ecart !== 0 && (
              <div className="ac-warning-box">
                Écart actif / passif : <strong>{formatPrice(Math.abs(sheet.ecart))}</strong>.
                Le bilan est construit à partir des écritures saisies — un écart est normal tant que les
                à-nouveaux (soldes d'ouverture) ne sont pas enregistrés.
              </div>
            )}
            <div className="ac-statement-grid">
              <StatementColumn variant="actif" title="Actif" rows={sheet.actif}
                               total={sheet.total_actif} totalLabel="Total actif" />
              <StatementColumn variant="passif" title="Passif" rows={sheet.passif}
                               total={sheet.total_passif} totalLabel="Total passif" />
            </div>
          </>
        )
      )}
    </div>
  );
}
