// Source unique de vérité pour la gestion des rôles admin.
// Frontend récupère cette config via GET /api/admin/roles.

// ─── Définition des rôles ──────────────────────────────────────
export const ROLES = {
  super_admin:   { label: 'Super Admin',   color: '#7c3aed', fullAccess: true,  manageUsers: true,  description: "Accès total + gestion des utilisateurs et des rôles." },
  admin:         { label: 'Admin',         color: '#10531a', fullAccess: true,  manageUsers: false, description: "Accès total à tous les modules (sauf gestion des utilisateurs)." },
  editor:        { label: 'Éditeur',       color: '#0284c7', description: "Catalogue, manuscrits, contrats, bannières, statistiques." },
  support:       { label: 'Support',       color: '#f59e0b', description: "Messages, FAQ, newsletter, clients, statistiques." },
  librarian:     { label: 'Libraire',      color: '#0891b2', description: "Livres, stock et régularisation des factures." },
  comptable:     { label: 'Comptable',     color: '#0d9488', description: "Comptabilité, paiements, statistiques." },
  vendeur:       { label: 'Vendeur POS',   color: '#dc2626', description: "Accès POS uniquement (via PIN dédié)." },
  evaluateur:    { label: 'Évaluateur',    color: '#9333ea', description: "Évaluation des manuscrits soumis." },
  correcteur:    { label: 'Correcteur',    color: '#14b8a6', description: "Correction des manuscrits validés." },
  infographiste: { label: 'Infographiste', color: '#c026d3', description: "Création et gestion des couvertures." },
  imprimeur:     { label: 'Imprimeur',     color: '#854d0e', description: "Suivi de l'impression et des bons à tirer." },
};

export const validRoles = Object.keys(ROLES);
export const FULL_ACCESS_ROLES = validRoles.filter((r) => ROLES[r].fullAccess);

// ─── RBAC : whitelist de paths par rôle restreint ──────────────
// super_admin / admin : aucune restriction (FULL_ACCESS_ROLES).
// Une entrée peut être une RegExp (toutes méthodes) ou { re, methods } pour
// restreindre à une liste de verbes HTTP.
const COMMON_PATHS = [
  /^\/api\/admin\/me$/,
  /^\/api\/admin\/password$/,
  /^\/api\/admin\/logout$/,
  /^\/api\/admin\/login$/,
  /^\/api\/admin\/2fa(\/.*)?$/,            // tous les utilisateurs peuvent gérer leur propre 2FA
  /^\/api\/admin\/roles$/,                  // visualisation matrice permissions
  { re: /^\/api\/admin\/config$/, methods: ['GET'] },
];

const WORKFLOW_READ_PATHS = [
  /^\/api\/admin\/manuscripts\/assigned(\/.*)?$/,
  /^\/api\/admin\/manuscripts\/v2\/\d+$/,
  /^\/api\/admin\/manuscripts\/v2\/\d+\/files(\/.*)?$/,
  /^\/api\/admin\/notifications(\/.*)?$/,
  /^\/api\/admin\/activity-log$/,
];

export const ROLE_ALLOWED_PATHS = {
  editor: [
    ...COMMON_PATHS,
    /^\/api\/admin\/books(\/.*)?$/,
    /^\/api\/admin\/tags(\/.*)?$/,
    /^\/api\/admin\/stats(\/.*)?$/,
    /^\/api\/admin\/slides(\/.*)?$/,
    /^\/api\/admin\/manuscripts(\/.*)?$/,
    /^\/api\/admin\/editorial(\/.*)?$/,
    /^\/api\/admin\/covers(\/.*)?$/,
    /^\/api\/admin\/authors(\/.*)?$/,
    /^\/api\/admin\/news(\/.*)?$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
  ],
  support: [
    ...COMMON_PATHS,
    /^\/api\/admin\/stats(\/.*)?$/,
    /^\/api\/admin\/contact(\/.*)?$/,
    /^\/api\/admin\/faq(\/.*)?$/,
    /^\/api\/admin\/newsletter(\/.*)?$/,
    /^\/api\/admin\/customers(\/.*)?$/,
    /^\/api\/admin\/authors(\/.*)?$/,
    /^\/api\/admin\/news(\/.*)?$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
  ],
  librarian: [
    ...COMMON_PATHS,
    /^\/api\/admin\/books(\/.*)?$/,
    /^\/api\/admin\/tags(\/.*)?$/,
    /^\/api\/admin\/stock(\/.*)?$/,
    /^\/api\/admin\/invoices(\/.*)?$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
  ],
  comptable: [
    ...COMMON_PATHS,
    /^\/api\/admin\/accounting(\/.*)?$/,
    /^\/api\/admin\/stats(\/.*)?$/,
    /^\/api\/admin\/payments(\/.*)?$/,
    /^\/api\/admin\/invoices(\/.*)?$/,
    /^\/api\/admin\/orders\/[^/]+\/confirm-payment$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
  ],
  vendeur: [
    ...COMMON_PATHS,
    // Le vendeur passe par /api/pos/* (auth PIN) — aucun accès admin direct.
  ],
  evaluateur: [
    ...COMMON_PATHS,
    ...WORKFLOW_READ_PATHS,
    /^\/api\/admin\/evaluations(\/.*)?$/,
  ],
  correcteur: [
    ...COMMON_PATHS,
    ...WORKFLOW_READ_PATHS,
    /^\/api\/admin\/corrections(\/.*)?$/,
  ],
  infographiste: [
    ...COMMON_PATHS,
    ...WORKFLOW_READ_PATHS,
    /^\/api\/admin\/covers(\/.*)?$/,
  ],
  imprimeur: [
    ...COMMON_PATHS,
    ...WORKFLOW_READ_PATHS,
    /^\/api\/admin\/printing(\/.*)?$/,
  ],
};

// ─── Matrice "modules × rôles" pour visualisation UI ──────────
// Niveaux : 'crud' (créer/modifier/supprimer), 'rw' (lecture+écriture sans suppression),
// 'r' (lecture seule), '-' (aucun accès).
const M = (modules) => {
  const empty = {
    dashboard: '-', books: '-', tags: '-', authors: '-', stock: '-', suppliers: '-',
    manuscripts: '-', evaluations: '-', corrections: '-', editorial: '-', covers: '-',
    printing: '-', contracts: '-', pos: '-', payments: '-', accounting: '-',
    invoices: '-',
    config: '-', slides: '-', news: '-', faq: '-', contacts: '-', newsletter: '-',
    customers: '-', users: '-', activity: '-', profile: 'rw',
  };
  return { ...empty, ...modules };
};

export const MODULE_PERMISSIONS = {
  super_admin: M({
    dashboard: 'crud', books: 'crud', tags: 'crud', authors: 'crud', stock: 'crud', suppliers: 'crud',
    manuscripts: 'crud', evaluations: 'crud', corrections: 'crud', editorial: 'crud', covers: 'crud',
    printing: 'crud', contracts: 'crud', pos: 'crud', payments: 'crud', accounting: 'crud',
    invoices: 'crud',
    config: 'crud', slides: 'crud', news: 'crud', faq: 'crud', contacts: 'crud', newsletter: 'crud',
    customers: 'crud', users: 'crud', activity: 'r', profile: 'rw',
  }),
  admin: M({
    dashboard: 'crud', books: 'crud', tags: 'crud', authors: 'crud', stock: 'crud', suppliers: 'crud',
    manuscripts: 'crud', evaluations: 'crud', corrections: 'crud', editorial: 'crud', covers: 'crud',
    printing: 'crud', contracts: 'crud', pos: 'crud', payments: 'crud', accounting: 'crud',
    invoices: 'crud',
    config: 'crud', slides: 'crud', news: 'crud', faq: 'crud', contacts: 'crud', newsletter: 'crud',
    customers: 'crud', users: '-', activity: 'r', profile: 'rw',
  }),
  editor: M({
    dashboard: 'r', books: 'crud', tags: 'crud', authors: 'crud', manuscripts: 'crud',
    editorial: 'crud', covers: 'crud', contracts: 'crud', slides: 'crud', news: 'crud',
    profile: 'rw',
  }),
  support: M({
    dashboard: 'r', authors: 'r', contacts: 'crud', faq: 'crud', newsletter: 'crud',
    customers: 'rw', news: 'crud', profile: 'rw',
  }),
  librarian: M({
    books: 'crud', tags: 'r', stock: 'r', invoices: 'crud', profile: 'rw',
  }),
  comptable: M({
    dashboard: 'r', payments: 'crud', accounting: 'crud', invoices: 'crud', profile: 'rw',
  }),
  vendeur: M({
    pos: 'crud', profile: 'rw',
  }),
  evaluateur: M({
    manuscripts: 'r', evaluations: 'crud', profile: 'rw',
  }),
  correcteur: M({
    manuscripts: 'r', corrections: 'crud', profile: 'rw',
  }),
  infographiste: M({
    manuscripts: 'r', covers: 'crud', profile: 'rw',
  }),
  imprimeur: M({
    manuscripts: 'r', printing: 'crud', profile: 'rw',
  }),
};

export const MODULE_LABELS = {
  dashboard: 'Tableau de bord',
  books: 'Livres',
  tags: 'Tags curation',
  authors: 'Auteurs',
  stock: 'Stock',
  suppliers: 'Fournisseurs',
  manuscripts: 'Manuscrits',
  evaluations: 'Évaluations',
  corrections: 'Corrections',
  editorial: 'Éditorial',
  covers: 'Couvertures',
  printing: 'Impression',
  contracts: 'Contrats',
  pos: 'Point de vente',
  payments: 'Paiements',
  accounting: 'Comptabilité',
  invoices: 'Factures',
  config: 'Configuration',
  slides: 'Bannières',
  news: 'Actualités',
  faq: 'FAQ',
  contacts: 'Messages',
  newsletter: 'Newsletter',
  customers: 'Clients',
  users: 'Équipe',
  activity: 'Journal d\'activité',
  profile: 'Mon profil',
};

// Pour le payload JSON envoyé au frontend (RegExp non sérialisable, on n'envoie
// que ce qui est utile à l'UI : labels, couleurs, descriptions, matrice).
export function serializeRolesForClient() {
  return {
    roles: Object.fromEntries(
      Object.entries(ROLES).map(([key, r]) => [key, {
        label: r.label,
        color: r.color,
        description: r.description,
        fullAccess: !!r.fullAccess,
        manageUsers: !!r.manageUsers,
      }])
    ),
    permissions: MODULE_PERMISSIONS,
    moduleLabels: MODULE_LABELS,
  };
}
