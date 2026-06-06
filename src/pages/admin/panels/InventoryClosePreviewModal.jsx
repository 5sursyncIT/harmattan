import { useState, useEffect } from 'react';
import { previewInventoryClose, closeInventorySession } from '../../../api/admin';
import { FiX, FiAlertTriangle, FiCheckCircle, FiLock } from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';

const fmtF = (n) => `${Math.round(n || 0).toLocaleString('fr-FR')} F`;

/**
 * Aperçu valorisé des écarts + clôture définitive.
 * À la clôture, le serveur recalcule l'écart contre le stock COURANT (l'aperçu
 * est basé sur le snapshot, à titre indicatif).
 *
 * Props : session, onClose(), onClosed(result)
 */
export default function InventoryClosePreviewModal({ session, onClose, onClosed }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    previewInventoryClose(session.id)
      .then(r => setData(r.data))
      .catch(() => toast.error('Erreur chargement de l\'aperçu'))
      .finally(() => setLoading(false));
  }, [session.id]);

  const uncounted = data?.session?.stats?.uncounted ?? session?.stats?.uncounted ?? 0;
  const sum = data?.summary;

  const doClose = async () => {
    setClosing(true);
    try {
      const r = await closeInventorySession(session.id);
      const res = r.data;
      if (res.success) {
        toast.success(`Inventaire clôturé : ${res.applied} ligne(s) appliquée(s), net ${res.net_delta > 0 ? '+' : ''}${res.net_delta}`);
      } else {
        toast.error(`Clôture partielle : ${res.failed?.length || 0} échec(s). Réessayez.`);
      }
      onClosed(res);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur de clôture');
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="inv-modal-overlay" onClick={() => !closing && onClose()}>
      <div className="inv-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiLock size={18} style={{ color: '#1e40af' }} /> Clôturer l'inventaire {session.ref}
          </h3>
          <button className="sk-btn-ghost" onClick={onClose} disabled={closing}><FiX size={18} /></button>
        </div>

        {loading ? <Loader /> : !sum ? (
          <p style={{ color: '#94a3b8' }}>Aperçu indisponible.</p>
        ) : (
          <>
            <div className="inv-stats" style={{ marginTop: 12 }}>
              <div className="inv-stat-pill"><span className="v">{sum.counted_lines}</span><span className="l">Comptés</span></div>
              <div className="inv-stat-pill variance"><span className="v">{sum.variance_lines}</span><span className="l">Écarts</span></div>
              <div className="inv-stat-pill"><span className="v" style={{ color: sum.qty_net < 0 ? '#b91c1c' : sum.qty_net > 0 ? '#15803d' : '#0f172a' }}>{sum.qty_net > 0 ? '+' : ''}{sum.qty_net}</span><span className="l">Net (ex.)</span></div>
              <div className="inv-stat-pill"><span className="v" style={{ color: sum.value_delta < 0 ? '#b91c1c' : '#15803d', fontSize: '0.95rem' }}>{sum.value_delta > 0 ? '+' : ''}{fmtF(sum.value_delta)}</span><span className="l">Valeur (PMP)</span></div>
            </div>

            {uncounted > 0 && (
              <div className="inv-warn">
                <FiAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                {session.treat_uncounted_as_zero
                  ? <span><strong>{uncounted} titre(s) non compté(s)</strong> seront mis à <strong>0</strong> (option « non-comptés = épuisés » activée).</span>
                  : <span><strong>{uncounted} titre(s) non compté(s)</strong> seront <strong>ignorés</strong> — leur stock reste inchangé.</span>}
              </div>
            )}

            {sum.variance_lines === 0 ? (
              <div className="sk-empty" style={{ padding: 24 }}>
                <FiCheckCircle size={36} style={{ color: '#16a34a', marginBottom: 8 }} />
                <p style={{ fontWeight: 600 }}>Aucun écart — le stock compté correspond au théorique.</p>
              </div>
            ) : (
              <div className="sk-table-wrap" style={{ maxHeight: 320, overflowY: 'auto', marginTop: 6 }}>
                <table className="sk-table">
                  <thead>
                    <tr>
                      <th>Réf.</th><th>Titre</th>
                      <th style={{ textAlign: 'center' }}>Théo.</th>
                      <th style={{ textAlign: 'center' }}>Compté</th>
                      <th style={{ textAlign: 'center' }}>Écart</th>
                      <th style={{ textAlign: 'right' }}>Valeur</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.variance_lines.map(l => (
                      <tr key={l.id}>
                        <td className="mono">{l.product_ref}</td>
                        <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.product_label}</td>
                        <td style={{ textAlign: 'center' }}>{l.qty_snapshot}</td>
                        <td style={{ textAlign: 'center', fontWeight: 700 }}>{l.qty_counted}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className={`inv-delta ${l.delta > 0 ? 'pos' : 'neg'}`}>{l.delta > 0 ? '+' : ''}{l.delta}</span>
                        </td>
                        <td style={{ textAlign: 'right', color: l.line_value_delta < 0 ? '#b91c1c' : '#15803d' }}>
                          {l.line_value_delta > 0 ? '+' : ''}{fmtF(l.line_value_delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="inv-warn" style={{ background: '#eff6ff', borderColor: '#bfdbfe', color: '#1e40af' }}>
              <FiAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>La clôture est <strong>définitive</strong> : elle crée les mouvements de stock d'ajustement. L'écart réel est recalculé contre le stock au moment de la clôture.</span>
            </div>

            <div className="inv-modal-actions">
              <button className="inv-btn inv-btn-outline" onClick={onClose} disabled={closing}>Annuler</button>
              <button className="inv-btn inv-btn-primary" onClick={doClose} disabled={closing}>
                {closing ? 'Application…' : 'Clôturer et appliquer'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
