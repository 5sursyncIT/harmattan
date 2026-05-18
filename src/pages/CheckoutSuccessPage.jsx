import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiCheckCircle, FiClock, FiArrowRight, FiAlertCircle } from 'react-icons/fi';
import { getOrderPaymentStatus } from '../api/payments';
import useCartStore from '../store/cartStore';
import './CheckoutCallback.css';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 6; // 12s max

export default function CheckoutSuccessPage() {
  const [searchParams] = useSearchParams();
  const orderRef = searchParams.get('ref') || searchParams.get('order_ref');
  const [status, setStatus] = useState(null);
  const [polls, setPolls] = useState(0);
  const [error, setError] = useState(null);
  const clearCart = useCartStore((s) => s.clearCart);

  const fetchStatus = useCallback(async () => {
    if (!orderRef) return;
    try {
      const res = await getOrderPaymentStatus(orderRef);
      setStatus(res.data);
      // Si confirmé, on vide le panier
      if (res.data?.payment_status === 'confirmed') {
        clearCart();
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Impossible de récupérer le statut');
    }
  }, [orderRef, clearCart]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!orderRef) return;
    if (status?.payment_status === 'confirmed') return;
    if (polls >= MAX_POLLS) return;
    const t = setTimeout(() => {
      setPolls((p) => p + 1);
      fetchStatus();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [polls, status, fetchStatus, orderRef]);

  const isConfirmed = status?.payment_status === 'confirmed';
  const isPending = !isConfirmed && polls < MAX_POLLS;

  return (
    <div className="checkout-callback container">
      {!orderRef ? (
        <div className="cb-card cb-error">
          <FiAlertCircle size={56} />
          <h1>Référence de commande manquante</h1>
          <p>Nous n'avons pas pu identifier votre commande. Si vous avez été débité, contactez-nous.</p>
          <Link to="/" className="btn btn-primary">Retour à l'accueil</Link>
        </div>
      ) : isConfirmed ? (
        <div className="cb-card cb-success">
          <FiCheckCircle size={64} />
          <h1>Paiement confirmé</h1>
          <p>Merci pour votre commande. Un email de confirmation vous a été envoyé.</p>
          <div className="cb-meta">
            <div><span>Référence</span><strong>{status.order_ref || orderRef}</strong></div>
            {status.invoice_ref && (
              <div><span>Facture</span><strong>{status.invoice_ref}</strong></div>
            )}
          </div>
          <Link to="/compte/commandes" className="btn btn-primary">
            Suivre ma commande <FiArrowRight />
          </Link>
        </div>
      ) : isPending ? (
        <div className="cb-card cb-pending">
          <FiClock size={56} />
          <h1>Vérification du paiement…</h1>
          <p>Votre paiement est en cours de validation. Cela peut prendre quelques secondes.</p>
          <div className="cb-spinner" aria-hidden="true" />
          <p className="cb-help">Vous recevrez un email dès que votre commande sera confirmée.</p>
        </div>
      ) : (
        <div className="cb-card cb-warn">
          <FiAlertCircle size={56} />
          <h1>Statut en attente</h1>
          <p>
            Nous n'avons pas encore reçu de confirmation pour votre commande
            {orderRef && <strong> {orderRef}</strong>}. Vérifiez votre email dans quelques minutes —
            si vous avez été débité, le paiement sera confirmé automatiquement.
          </p>
          <Link to="/compte/commandes" className="btn btn-outline">Voir mes commandes</Link>
        </div>
      )}
      {error && <p className="cb-error-line">{error}</p>}
    </div>
  );
}
