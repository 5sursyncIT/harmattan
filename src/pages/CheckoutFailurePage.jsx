import { Link, useSearchParams } from 'react-router-dom';
import { FiXCircle, FiArrowLeft } from 'react-icons/fi';
import { FaWhatsapp } from 'react-icons/fa';
import useSiteConfig from '../hooks/useSiteConfig.jsx';
import { buildWhatsAppOrderUrl } from '../utils/whatsappOrder';
import './CheckoutCallback.css';

export default function CheckoutFailurePage() {
  const [searchParams] = useSearchParams();
  const orderRef = searchParams.get('ref') || searchParams.get('order_ref');
  const config = useSiteConfig();
  const phone = config?.whatsapp_phone || '221709530240';

  const helpUrl = buildWhatsAppOrderUrl(
    phone,
    `Bonjour, j'ai eu un problème de paiement pour la commande ${orderRef || ''}. Pouvez-vous m'aider ?`
  );

  return (
    <div className="checkout-callback container">
      <div className="cb-card cb-fail">
        <FiXCircle size={64} />
        <h1>Paiement annulé ou échoué</h1>
        <p>
          Votre paiement n'a pas été finalisé. {orderRef && <>Référence : <strong>{orderRef}</strong>.</>} Vous n'avez pas été débité.
        </p>
        <div className="cb-actions">
          <Link to="/panier" className="btn btn-primary">
            <FiArrowLeft /> Retour au panier
          </Link>
          <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="btn btn-whatsapp">
            <FaWhatsapp /> Nous contacter sur WhatsApp
          </a>
        </div>
      </div>
    </div>
  );
}
