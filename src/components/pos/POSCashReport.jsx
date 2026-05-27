import { useEffect, useState } from 'react';
import { FiX, FiPrinter, FiRefreshCw, FiTrendingUp, FiTrendingDown, FiAlertTriangle } from 'react-icons/fi';
import { posGetSessionReport } from '../../api/pos';
import './POSCashReport.css';

function f(n) {
  return Math.round(n || 0).toLocaleString('fr-FR');
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function POSCashReport({ onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true); setError('');
    posGetSessionReport()
      .then((res) => setReport(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Erreur chargement rapport'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="pos-cr-overlay" onClick={onClose}>
      <div className="pos-cash-report" onClick={(e) => e.stopPropagation()} id="pos-cash-report-printable">
        <div className="pos-cr-header no-print">
          <h3>Rapport de caisse</h3>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="pos-cr-icon-btn" onClick={load} title="Actualiser"><FiRefreshCw size={16} /></button>
            <button className="pos-cr-icon-btn" onClick={handlePrint} title="Imprimer"><FiPrinter size={16} /></button>
            <button className="pos-cr-icon-btn" onClick={onClose} title="Fermer"><FiX size={18} /></button>
          </div>
        </div>

        {loading && <div className="pos-cr-loading">Chargement…</div>}
        {error && <div className="pos-cr-error">{error}</div>}

        {report && (
          <div className="pos-cr-body">
            <div className="pos-cr-print-header print-only">
              <h2>L'HARMATTAN SÉNÉGAL — Rapport de caisse</h2>
            </div>

            <section className="pos-cr-meta">
              <div><span>Terminal</span><strong>T{report.terminal}</strong></div>
              <div><span>Caissier</span><strong>{report.staff}</strong></div>
              <div><span>Début période</span><strong>{fmtDate(report.period_start)}</strong></div>
              <div><span>Édité le</span><strong>{fmtDate(report.generated_at)}</strong></div>
              <div>
                <span>Session</span>
                <strong>{report.session ? `#${report.session.id} (ouverte)` : 'Aucune (rapport journée)'}</strong>
              </div>
            </section>

            <section className="pos-cr-section">
              <h4>Synthèse</h4>
              <div className="pos-cr-kpi-grid">
                <div className="pos-cr-kpi">
                  <span>Tickets</span>
                  <strong>{report.totals.invoices}</strong>
                </div>
                <div className="pos-cr-kpi">
                  <span>Total TTC</span>
                  <strong>{f(report.totals.total_ttc)} F</strong>
                </div>
                <div className="pos-cr-kpi">
                  <span>Ticket moyen</span>
                  <strong>{f(report.totals.avg_ticket)} F</strong>
                </div>
                <div className="pos-cr-kpi">
                  <span>Remboursements</span>
                  <strong>{report.refunds.count} · {f(report.refunds.amount)} F</strong>
                </div>
              </div>
            </section>

            <section className="pos-cr-section">
              <h4>Encaissements par moyen de paiement</h4>
              <table className="pos-cr-table">
                <thead>
                  <tr><th>Moyen</th><th>Tickets</th><th className="num">Montant</th></tr>
                </thead>
                <tbody>
                  {Object.entries(report.methods).map(([code, m]) => (
                    <tr key={code} className={m.amount === 0 ? 'muted' : ''}>
                      <td>{m.label}</td>
                      <td>{m.invoices}</td>
                      <td className="num">{f(m.amount)} F</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Total</td>
                    <td>—</td>
                    <td className="num">{f(Object.values(report.methods).reduce((s, m) => s + m.amount, 0))} F</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="pos-cr-section">
              <h4>Caisse espèces</h4>
              <table className="pos-cr-table">
                <tbody>
                  <tr>
                    <td>Fond d'ouverture</td>
                    <td className="num">{f(report.cash.opening)} F</td>
                  </tr>
                  <tr>
                    <td>+ Ventes espèces</td>
                    <td className="num plus">{f(report.cash.sales)} F</td>
                  </tr>
                  {report.cash.in > 0 && (
                    <tr>
                      <td>+ Entrées caisse</td>
                      <td className="num plus">{f(report.cash.in)} F</td>
                    </tr>
                  )}
                  {report.cash.out > 0 && (
                    <tr>
                      <td>− Sorties caisse</td>
                      <td className="num minus">{f(report.cash.out)} F</td>
                    </tr>
                  )}
                  {report.cash.refunds > 0 && (
                    <tr>
                      <td>− Remboursements espèces</td>
                      <td className="num minus">{f(report.cash.refunds)} F</td>
                    </tr>
                  )}
                  <tr className="total">
                    <td>Encaisse attendue</td>
                    <td className="num">{f(report.cash.expected)} F</td>
                  </tr>
                </tbody>
              </table>
            </section>

            {report.cash_movements?.length > 0 && (
              <section className="pos-cr-section">
                <h4>Mouvements de caisse</h4>
                <table className="pos-cr-table">
                  <thead>
                    <tr><th>Heure</th><th>Type</th><th>Motif</th><th className="num">Montant</th></tr>
                  </thead>
                  <tbody>
                    {report.cash_movements.map((m) => (
                      <tr key={m.id}>
                        <td>{fmtDate(m.created_at)}</td>
                        <td>{m.type === 'in' ? <span className="badge in"><FiTrendingUp size={10} /> Entrée</span> : <span className="badge out"><FiTrendingDown size={10} /> Sortie</span>}</td>
                        <td>{m.reason || '—'}</td>
                        <td className={'num ' + (m.type === 'in' ? 'plus' : 'minus')}>{f(m.amount)} F</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {report.top_items?.length > 0 && (
              <section className="pos-cr-section">
                <h4>Top 5 articles</h4>
                <table className="pos-cr-table">
                  <thead>
                    <tr><th>Article</th><th>Qté</th><th className="num">CA TTC</th></tr>
                  </thead>
                  <tbody>
                    {report.top_items.map((it, idx) => (
                      <tr key={idx}>
                        <td>{it.label}</td>
                        <td>{it.qty}</td>
                        <td className="num">{f(it.total_ttc)} F</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {report.price_overrides?.length > 0 && (
              <section className="pos-cr-section pos-cr-warning-section">
                <h4><FiAlertTriangle size={14} /> Prix modifiés ({report.price_overrides.length})</h4>
                <table className="pos-cr-table">
                  <thead>
                    <tr><th>Heure</th><th>Détail</th></tr>
                  </thead>
                  <tbody>
                    {report.price_overrides.map((o, idx) => (
                      <tr key={idx}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(o.created_at)}</td>
                        <td>{o.details.replace(/^T\d+ \| /, '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
