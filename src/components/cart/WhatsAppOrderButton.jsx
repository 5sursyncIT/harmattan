import { FaWhatsapp } from 'react-icons/fa';
import useSiteConfig from '../../hooks/useSiteConfig.jsx';
import { buildWhatsAppOrderMessage, buildWhatsAppOrderUrl } from '../../utils/whatsappOrder';

/**
 * Bouton "Commander sur WhatsApp" : ouvre wa.me avec un message
 * pré-rempli contenant le récapitulatif du panier.
 *
 * Phase 1 : pas d'API officielle, juste un deep-link wa.me.
 *
 * @param {Array} items   - cart items {label, quantity, price_ttc}
 * @param {string} [phone] - override (sinon lu depuis site-config.whatsapp_phone)
 */
export default function WhatsAppOrderButton({ items = [], phone }) {
  const config = useSiteConfig();
  const targetPhone = phone || config?.whatsapp_phone || '221772422508';

  if (!items || items.length === 0) return null;

  const message = buildWhatsAppOrderMessage(items);
  const url = buildWhatsAppOrderUrl(targetPhone, message);

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="wa-order-btn"
      aria-label="Commander sur WhatsApp"
    >
      <FaWhatsapp size={20} aria-hidden="true" />
      <span>Commander sur WhatsApp</span>
    </a>
  );
}
