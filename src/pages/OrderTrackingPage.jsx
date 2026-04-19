import { useState } from 'react';
import { FiSearch, FiPackage, FiCheck, FiTruck, FiCheckCircle } from 'react-icons/fi';
import { getOrder } from '../api/dolibarr';
import { formatPrice } from '../utils/formatters';
import './OrderTrackingPage.css';

const STATUS_MAP = {
  '-1': { label: 'Annulée', step: 0 },
  '0': { label: 'Brouillon', step: 1 },
  '1': { label: 'Validée', step: 2 },
  '2': { label: 'En cours de traitement', step: 2 },
  '3': { label: 'Expédiée', step: 3 },
};

export default function OrderTrackingPage() {
  const [orderId, setOrderId] = useState('');
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!orderId.trim()) return;
    setLoading(true);
    setError('');
    setOrder(null);
    try {
      const res = await getOrder(orderId.trim());
      setOrder(res.data);
    } catch {
      setError('Commande introuvable. Vérifiez le numéro et réessayez.');
    } finally {
      setLoading(false);
    }
  };

  const status = order ? (STATUS_MAP[order.statut] || STATUS_MAP['0']) : null;

  return (
    <div className="tracking-page">
      <div className="container">
        <h1>Suivi de commande</h1>
        <p className="tracking-intro">
          Entrez votre numéro de commande pour suivre son état.
        </p>

        <form className="tracking-form" onSubmit={handleSearch}>
          <input
            type="text"
            placeholder="Numéro de commande (ex: CO2603-0001)"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={loading}>
            <FiSearch /> {loading ? 'Recherche...' : 'Rechercher'}
          </button>
        </form>

        {error && <p className="tracking-error">{error}</p>}

        {order && (
          <div className="tracking-result">
            <div className="tracking-header">
              <h2>Commande {order.ref}</h2>
              <span className={`tracking-status step-${status.step}`}>{status.label}</span>
            </div>

            <div className="tracking-progress">
              <div className={`progress-step ${status.step >= 1 ? 'done' : ''}`}>
                <div className="step-icon"><FiCheck /></div>
                <span>Commande reçue</span>
              </div>
              <div className="progress-line" />
              <div className={`progress-step ${status.step >= 2 ? 'done' : ''}`}>
                <div className="step-icon"><FiPackage /></div>
                <span>En préparation</span>
              </div>
              <div className="progress-line" />
              <div className={`progress-step ${status.step >= 3 ? 'done' : ''}`}>
                <div className="step-icon"><FiTruck /></div>
                <span>Expédiée</span>
              </div>
              <div className="progress-line" />
              <div className={`progress-step ${status.step >= 4 ? 'done' : ''}`}>
                <div className="step-icon"><FiCheckCircle /></div>
                <span>Livrée</span>
              </div>
            </div>

            {order.lines && order.lines.length > 0 && (
              <div className="tracking-details">
                <h3>Détails de la commande</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Produit</th>
                      <th>Qté</th>
                      <th>Prix</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.lines.map((line, idx) => (
                      <tr key={idx}>
                        <td>{line.product_label || line.description || `Produit #${line.fk_product}`}</td>
                        <td>{line.qty}</td>
                        <td>{formatPrice(line.total_ttc)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan="2"><strong>Total</strong></td>
                      <td><strong>{formatPrice(order.total_ttc)}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
