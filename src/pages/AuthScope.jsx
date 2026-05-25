import { Link } from 'react-router-dom';
import { FiShoppingBag, FiEdit3, FiArrowRight } from 'react-icons/fi';

// Bandeau contextuel pour les pages d'auth — distingue visuellement
// l'espace Client (e-commerce) de l'espace Auteur (portail éditorial).

const SCOPES = {
  client: {
    label: 'Espace Client',
    sublabel: 'Achats, commandes, abonnement',
    color: '#10531a',
    bg: '#ecfdf5',
    border: '#a7f3d0',
    Icon: FiShoppingBag,
    switchTo: { to: '/auteur/connexion', label: 'Vous êtes auteur ?', cta: 'Espace auteur' },
  },
  author: {
    label: 'Espace Auteur',
    sublabel: 'Soumission et suivi de manuscrits',
    color: '#c2410c',
    bg: '#fff7ed',
    border: '#fed7aa',
    Icon: FiEdit3,
    switchTo: { to: '/connexion', label: 'Vous êtes client ?', cta: 'Espace client' },
  },
};

export function AuthScopeBadge({ scope }) {
  const s = SCOPES[scope];
  if (!s) return null;
  return (
    <div
      role="note"
      aria-label={s.label}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderLeft: `4px solid ${s.color}`,
        borderRadius: 6,
        marginBottom: 20,
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 32, height: 32, borderRadius: '50%',
        background: s.color, color: '#fff', flexShrink: 0,
      }}>
        <s.Icon size={16} />
      </span>
      <div style={{ lineHeight: 1.3 }}>
        <div style={{ color: s.color, fontWeight: 800, fontSize: 14 }}>{s.label}</div>
        <div style={{ color: '#6b7280', fontSize: 12 }}>{s.sublabel}</div>
      </div>
    </div>
  );
}

export function AuthScopeSwitch({ scope }) {
  const s = SCOPES[scope];
  if (!s) return null;
  return (
    <p style={{
      textAlign: 'center', fontSize: 13, color: '#6b7280',
      marginTop: 16, paddingTop: 16, borderTop: '1px dashed #e5e7eb',
    }}>
      {s.switchTo.label}{' '}
      <Link
        to={s.switchTo.to}
        style={{
          color: s.color, fontWeight: 700, textDecoration: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >
        {s.switchTo.cta} <FiArrowRight size={12} />
      </Link>
    </p>
  );
}
