import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiArrowLeft, FiCreditCard, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { getTreasury } from '../../../api/accounting';
import { formatPrice } from '../../../utils/formatters';
import Loader from '../../../components/common/Loader';
import DolibarrLink from '../../../components/admin/DolibarrLink';
import { dolibarrUrls } from '../../../utils/dolibarrLinks';
import toast from 'react-hot-toast';
import './Accounting.css';

export default function AccountingTreasury() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState('');

  useEffect(() => {
    let cancelled = false;
    getTreasury({ account_id: selectedAccount })
      .then(r => { if (!cancelled) { setData(r.data); setLoading(false); } })
      .catch(() => { if (!cancelled) { toast.error('Erreur chargement'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedAccount]);

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—';

  if (loading && !data) return <Loader />;
  if (!data) return <p>Erreur</p>;

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/admin/accounting" style={{ color: '#666', display: 'flex' }}><FiArrowLeft size={18} /></Link>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiCreditCard /> Trésorerie ({data.accounts?.length || 0} comptes)
          </h3>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <DolibarrLink href={dolibarrUrls.bankList()} title="Liste des comptes bancaires">Comptes bancaires</DolibarrLink>
          {selectedAccount && (
            <DolibarrLink
              href={dolibarrUrls.reconciliation(selectedAccount)}
              title="Rapprochement bancaire pour ce compte"
            >
              Rapprocher ce compte
            </DolibarrLink>
          )}
        </div>
      </div>

      {/* Cartes par compte */}
      <div className="ac-bank-grid">
        {data.accounts?.map(acc => (
          <div key={acc.id} className="ac-bank-card" style={{ cursor: 'pointer', borderColor: selectedAccount === String(acc.id) ? '#10531a' : '#e2e8f0', position: 'relative' }}
               onClick={() => setSelectedAccount(selectedAccount === String(acc.id) ? '' : String(acc.id))}>
            <div className="ac-bank-name">{acc.label || acc.ref}</div>
            <div className="ac-bank-balance" style={{ color: acc.balance >= 0 ? '#10531a' : '#dc2626' }}>
              {formatPrice(acc.balance)}
            </div>
            <div className="ac-bank-meta">
              {acc.nb_movements} mvts · Dernier : {fmtDate(acc.last_movement)}
            </div>
            <a
              href={dolibarrUrls.bankAccount(acc.id)}
              target="_blank"
              rel="noopener noreferrer"
              title="Ouvrir ce compte dans Dolibarr"
              onClick={(e) => e.stopPropagation()}
              style={{ position: 'absolute', top: 8, right: 8, color: '#94a3b8', fontSize: 11 }}
            >↗</a>
          </div>
        ))}
        <div className="ac-bank-card total">
          <div className="ac-bank-name">Total consolidé</div>
          <div className="ac-bank-balance">{formatPrice(data.total_balance)}</div>
          <div className="ac-bank-meta">{data.accounts?.length || 0} comptes actifs</div>
        </div>
      </div>

      {/* Mouvements récents */}
      <div className="ac-section-header">
        <h4 className="ac-section-title">
          <FiTrendingUp size={16} /> Derniers mouvements
          {selectedAccount && <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 400, marginLeft: 8 }}>(filtrés sur compte sélectionné)</span>}
        </h4>
        {selectedAccount && (
          <button className="btn btn-outline btn-sm" onClick={() => setSelectedAccount('')}>Voir tous les comptes</button>
        )}
      </div>

      <div className="ac-table-wrap">
        <table className="ac-table">
          <thead>
            <tr>
              <th>Date</th><th>Compte</th><th>Libellé</th>
              <th className="ac-amount">Montant</th>
              <th>Référence</th>
            </tr>
          </thead>
          <tbody>
            {data.movements?.map(m => (
              <tr key={m.id}>
                <td className="ac-date">{fmtDate(m.date)}</td>
                <td style={{ fontSize: '0.82rem' }}>{m.bank_label}</td>
                <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.label || '—'}</td>
                <td className="ac-amount" style={{ fontWeight: 700, color: m.amount >= 0 ? '#10531a' : '#dc2626' }}>
                  {m.amount >= 0 ? <FiTrendingUp size={12} style={{ verticalAlign: -1, marginRight: 2 }} /> : <FiTrendingDown size={12} style={{ verticalAlign: -1, marginRight: 2 }} />}
                  {formatPrice(Math.abs(m.amount))}
                </td>
                <td style={{ fontSize: '0.78rem', fontFamily: 'monospace', color: '#64748b' }}>{m.num_payment || '—'}</td>
              </tr>
            ))}
            {(!data.movements || data.movements.length === 0) && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>Aucun mouvement</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
