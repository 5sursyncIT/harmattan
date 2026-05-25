import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiBookOpen } from 'react-icons/fi';
import { getChartOfAccounts } from '../../../api/accounting';
import Loader from '../../../components/common/Loader';
import './Accounting.css';

export default function AccountingChart() {
  const [data, setData] = useState({ accounts: [], classes: [] });
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [accClass, setAccClass] = useState('');

  // Debounce de la recherche
  useEffect(() => {
    const t = setTimeout(() => setSearch(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getChartOfAccounts({ search, account_class: accClass })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [search, accClass]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiBookOpen /> Plan comptable SYSCOHADA ({data.accounts.length})
          </h3>
        </div>
      </div>

      <div className="ac-class-pills">
        <button className={`ac-class-pill ${accClass === '' ? 'active' : ''}`} onClick={() => setAccClass('')}>
          Toutes les classes
        </button>
        {data.classes.map(c => (
          <button key={c.id} className={`ac-class-pill ${accClass === c.id ? 'active' : ''}`}
                  onClick={() => setAccClass(accClass === c.id ? '' : c.id)} title={c.name}>
            Classe {c.id} ({c.count})
          </button>
        ))}
      </div>

      <div className="ac-filters">
        <div className="ac-filter-group" style={{ flex: 1, minWidth: 240 }}>
          <label className="ac-filter-label">Rechercher un compte</label>
          <input type="text" className="ac-filter-input" value={input}
                 onChange={e => setInput(e.target.value)}
                 placeholder="Numéro ou libellé (ex: 411, Clients, banque...)" />
        </div>
      </div>

      {loading ? <Loader /> : (
        <div className="ac-table-wrap">
          <table className="ac-table">
            <thead>
              <tr><th style={{ width: 140 }}>Numéro</th><th>Libellé du compte</th><th style={{ width: 90 }}>Classe</th></tr>
            </thead>
            <tbody>
              {data.accounts.map(a => (
                <tr key={a.number}>
                  <td className="ac-ref">{a.number}</td>
                  <td>{a.label}</td>
                  <td style={{ color: '#94a3b8', fontSize: '0.82rem' }}>Classe {a.class}</td>
                </tr>
              ))}
              {data.accounts.length === 0 && (
                <tr><td colSpan={3} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucun compte trouvé</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
