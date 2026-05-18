import { FiExternalLink } from 'react-icons/fi';

/**
 * Bouton standard pour ouvrir une page Dolibarr dans un nouvel onglet.
 * Évite la duplication des classes / icônes dans chaque panel comptable.
 *
 * Usage:
 *   <DolibarrLink href={dolibarrUrls.sellsJournal()}>Ouvrir le journal des ventes</DolibarrLink>
 *   <DolibarrLink href={dolibarrUrls.invoice(42)} variant="ghost">Voir la facture</DolibarrLink>
 */
export default function DolibarrLink({ href, children, variant = 'outline', size = 'sm', title }) {
  const cls = variant === 'ghost' ? 'btn btn-ghost' : 'btn btn-outline';
  const sizeCls = size === 'sm' ? 'btn-sm' : '';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${cls} ${sizeCls}`.trim()}
      title={title || 'Ouvre la page correspondante dans Dolibarr (nouvel onglet)'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      {children}
      <FiExternalLink size={14} />
    </a>
  );
}
