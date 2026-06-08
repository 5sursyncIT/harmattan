// Source unique de vérité pour la gestion des rôles admin.
// Frontend récupère cette config via GET /api/admin/roles.

// ─── Définition des rôles ──────────────────────────────────────
export const ROLES = {
  super_admin:   { label: 'Super Admin',   color: '#7c3aed', fullAccess: true,  manageUsers: true,  description: "Accès total + gestion des utilisateurs et des rôles." },
  admin:         { label: 'Admin',         color: '#10531a', fullAccess: true,  manageUsers: false, description: "Accès total à tous les modules (sauf gestion des utilisateurs)." },
  editor:        { label: 'Éditeur',       color: '#0284c7', description: "Catalogue, manuscrits, contrats, bannières, statistiques." },
  production:    { label: 'Production éditoriale', color: '#c026d3', description: "Pilotage du pipeline de production : validation éditoriale et conception des couvertures (BAT)." },
  librarian:     { label: 'Libraire & Support', color: '#0891b2', description: "Librairie (livres, stock, factures, BL, dépôt-vente, commandes) + support (messages, FAQ, newsletter, clients, actualités)." },
  gestionnaire_stock: { label: 'Gestionnaire de stock', color: '#b45309', description: "Stock & réapprovisionnement, fournisseurs, catalogue livres, bons de livraison, dépôt-vente." },
  comptable:     { label: 'Comptable',     color: '#0d9488', description: "Comptabilité, paiements, statistiques, devis." },
  vendeur:       { label: 'Vendeur POS',   color: '#dc2626', description: "Accès POS uniquement (via PIN dédié)." },
  // ── Rôles d'acteurs DÉPRÉCIÉS (workflow « semi-automatique ») ──
  // Ces acteurs n'ont plus de compte connecté : ils sont gérés via le carnet
  // d'intervenants et notifiés par email. Les entrées sont conservées pour
  // afficher l'historique d'affectation des anciens manuscrits (badges), mais
  // on n'attribue plus ces rôles à de nouveaux comptes (voir DEPRECATED_ACTOR_ROLES).
  evaluateur:    { label: 'Évaluateur',    color: '#9333ea', deprecated: true, description: "Évaluation des manuscrits soumis (intervenant externe, sans compte)." },
  correcteur:    { label: 'Correcteur',    color: '#14b8a6', deprecated: true, description: "Correction des manuscrits validés (intervenant externe, sans compte)." },
  infographiste: { label: 'Infographiste', color: '#c026d3', deprecated: true, description: "Création des couvertures (intervenant externe, sans compte)." },
  imprimeur:     { label: 'Imprimeur',     color: '#854d0e', deprecated: true, description: "Suivi de l'impression (intervenant externe, sans compte)." },
};

export const validRoles = Object.keys(ROLES);
export const FULL_ACCESS_ROLES = validRoles.filter((r) => ROLES[r].fullAccess);

// Rôles d'acteurs métier dépréciés : plus attribuables à un compte connecté.
// Le pilotage du workflow est assuré par l'éditeur ; ces intervenants sont gérés
// via le carnet d'intervenants et notifiés par email.
export const DEPRECATED_ACTOR_ROLES = validRoles.filter((r) => ROLES[r].deprecated);

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
    /^\/api\/admin\/evaluations(\/.*)?$/,
    /^\/api\/admin\/corrections(\/.*)?$/,
    /^\/api\/admin\/editorial(\/.*)?$/,
    /^\/api\/admin\/covers(\/.*)?$/,
    /^\/api\/admin\/printing(\/.*)?$/,
    /^\/api\/admin\/intervenants(\/.*)?$/,
    /^\/api\/admin\/authors(\/.*)?$/,
    /^\/api\/admin\/news(\/.*)?$/,
    /^\/api\/admin\/legal-deposits(\/.*)?$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
  ],
  // Profil « Production éditoriale » : pilote le pipeline éditorial + couvertures.
  production: [
    ...COMMON_PATHS,
    ...WORKFLOW_READ_PATHS,
    /^\/api\/admin\/manuscripts\/v2(\/.*)?$/,   // consultation des fiches manuscrits (drill-down « Détail »)
    /^\/api\/admin\/editorial(\/.*)?$/,
    /^\/api\/admin\/covers(\/.*)?$/,
  ],
  // Profil fusionné « Libraire & Support » : union des accès librairie + support.
  librarian: [
    ...COMMON_PATHS,
    // ── Volet librairie ──
    /^\/api\/admin\/books(\/.*)?$/,
    /^\/api\/admin\/tags(\/.*)?$/,
    // Stock : lecture seule pour le libraire (méthodes d'écriture refusées par la
    // RBAC elle-même, en plus du garde-fou applicatif blockLibrarianWrite).
    { re: /^\/api\/admin\/stock(\/.*)?$/, methods: ['GET'] },
    // Inventaire : lecture + comptage simple (scan/saisie) autorisés ; création,
    // démarrage, import CSV et clôture refusés (réservés au gestionnaire de stock).
    { re: /^\/api\/admin\/inventory\/sessions\/\d+\/count$/, methods: ['POST'] },
    { re: /^\/api\/admin\/inventory\/sessions\/\d+\/lines\/\d+\/reset$/, methods: ['POST'] },
    { re: /^\/api\/admin\/inventory(\/.*)?$/, methods: ['GET'] },
    /^\/api\/admin\/invoices(\/.*)?$/,
    /^\/api\/admin\/deliveries(\/.*)?$/,
    // Dépôt-vente : lecture seule pour le libraire.
    { re: /^\/api\/admin\/consignments(\/.*)?$/, methods: ['GET'] },
    /^\/api\/admin\/societes(\/.*)?$/,
    /^\/api\/admin\/propals(\/.*)?$/,
    // Commandes web : lecture seule pour le libraire.
    { re: /^\/api\/admin\/orders(\/.*)?$/, methods: ['GET'] },
    // ── Volet support ──
    /^\/api\/admin\/stats(\/.*)?$/,
    /^\/api\/admin\/contact(\/.*)?$/,
    /^\/api\/admin\/faq(\/.*)?$/,
    /^\/api\/admin\/newsletter(\/.*)?$/,
    /^\/api\/admin\/customers(\/.*)?$/,
    /^\/api\/admin\/authors(\/.*)?$/,
    /^\/api\/admin\/news(\/.*)?$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
    // ── Volet « Site & contenu » : configuration + bannières (slides) ──
    /^\/api\/admin\/config(\/.*)?$/,
    /^\/api\/admin\/slides(\/.*)?$/,
  ],
  // Profil « Gestionnaire de stock » : gestion complète du stock/réappro, des
  // fournisseurs, du catalogue, des BL et du dépôt-vente.
  gestionnaire_stock: [
    ...COMMON_PATHS,
    /^\/api\/admin\/books(\/.*)?$/,
    /^\/api\/admin\/tags(\/.*)?$/,
    /^\/api\/admin\/authors(\/.*)?$/,
    /^\/api\/admin\/stock(\/.*)?$/,
    /^\/api\/admin\/inventory(\/.*)?$/,
    /^\/api\/admin\/suppliers(\/.*)?$/,
    /^\/api\/admin\/deliveries(\/.*)?$/,
    /^\/api\/admin\/consignments(\/.*)?$/,
    /^\/api\/admin\/societes(\/.*)?$/,
    /^\/api\/admin\/legal-deposits(\/.*)?$/,
    /^\/api\/admin\/stats(\/.*)?$/,
    /^\/api\/admin\/notifications(\/.*)?$/,
  ],
  comptable: [
    ...COMMON_PATHS,
    /^\/api\/admin\/accounting(\/.*)?$/,
    /^\/api\/admin\/stats(\/.*)?$/,
    /^\/api\/admin\/payments(\/.*)?$/,
    /^\/api\/admin\/expenses(\/.*)?$/,
    /^\/api\/admin\/invoices(\/.*)?$/,
    /^\/api\/admin\/deliveries(\/.*)?$/,
    /^\/api\/admin\/consignments(\/.*)?$/,
    /^\/api\/admin\/orders(\/.*)?$/,
    /^\/api\/admin\/societes(\/.*)?$/,
    /^\/api\/admin\/propals(\/.*)?$/,
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
    /^\/api\/admin\/legal-deposits(\/.*)?$/,
  ],
};

// ─── Matrice "modules × rôles" pour visualisation UI ──────────
// Niveaux : 'crud' (créer/modifier/supprimer), 'rw' (lecture+écriture sans suppression),
// 'r' (lecture seule), '-' (aucun accès).
const M = (modules) => {
  const empty = {
    dashboard: '-', books: '-', tags: '-', authors: '-', stock: '-', inventory: '-', suppliers: '-',
    manuscripts: '-', evaluations: '-', corrections: '-', editorial: '-', covers: '-',
    printing: '-', contracts: '-', pos: '-', payments: '-', accounting: '-',
    invoices: '-', deliveries: '-', consignments: '-', orders: '-', propals: '-',
    expenses: '-', legal_deposits: '-',
    config: '-', slides: '-', news: '-', faq: '-', contacts: '-', newsletter: '-',
    customers: '-', users: '-', activity: '-', profile: 'rw',
  };
  return { ...empty, ...modules };
};

export const MODULE_PERMISSIONS = {
  super_admin: M({
    dashboard: 'crud', books: 'crud', tags: 'crud', authors: 'crud', stock: 'crud', inventory: 'crud', suppliers: 'crud',
    manuscripts: 'crud', evaluations: 'crud', corrections: 'crud', editorial: 'crud', covers: 'crud',
    printing: 'crud', contracts: 'crud', pos: 'crud', payments: 'crud', accounting: 'crud',
    invoices: 'crud', deliveries: 'crud', consignments: 'crud', orders: 'r', propals: 'crud', expenses: 'crud', legal_deposits: 'crud',
    config: 'crud', slides: 'crud', news: 'crud', faq: 'crud', contacts: 'crud', newsletter: 'crud',
    customers: 'crud', users: 'crud', activity: 'r', profile: 'rw',
  }),
  admin: M({
    dashboard: 'crud', books: 'crud', tags: 'crud', authors: 'crud', stock: 'crud', inventory: 'crud', suppliers: 'crud',
    manuscripts: 'crud', evaluations: 'crud', corrections: 'crud', editorial: 'crud', covers: 'crud',
    printing: 'crud', contracts: 'crud', pos: 'crud', payments: 'crud', accounting: 'crud',
    invoices: 'crud', deliveries: 'crud', consignments: 'crud', orders: 'r', propals: 'crud', expenses: 'crud', legal_deposits: 'crud',
    config: 'crud', slides: 'crud', news: 'crud', faq: 'crud', contacts: 'crud', newsletter: 'crud',
    customers: 'crud', users: '-', activity: 'r', profile: 'rw',
  }),
  editor: M({
    dashboard: 'r', books: 'crud', tags: 'crud', authors: 'crud', manuscripts: 'crud',
    evaluations: 'crud', corrections: 'crud', editorial: 'crud', covers: 'crud', printing: 'crud',
    contracts: 'crud', slides: 'crud', news: 'crud',
    legal_deposits: 'crud', profile: 'rw',
  }),
  production: M({
    dashboard: 'r', manuscripts: 'r', editorial: 'crud', covers: 'crud', profile: 'rw',
  }),
  // Profil fusionné « Libraire & Support » : union des permissions des deux anciens rôles.
  librarian: M({
    dashboard: 'r',
    books: 'crud', tags: 'r', stock: 'r', inventory: 'rw', invoices: 'crud', deliveries: 'crud', consignments: 'r', propals: 'crud', orders: 'r',
    authors: 'r', contacts: 'crud', faq: 'crud', newsletter: 'crud', customers: 'rw', news: 'crud',
    // Rubrique « Site & contenu » : contrôle total config + bannières.
    config: 'crud', slides: 'crud',
    profile: 'rw',
  }),
  gestionnaire_stock: M({
    dashboard: 'r', books: 'crud', tags: 'crud', authors: 'rw', stock: 'crud', inventory: 'crud', suppliers: 'crud',
    deliveries: 'crud', consignments: 'crud', legal_deposits: 'crud', profile: 'rw',
  }),
  comptable: M({
    dashboard: 'r', payments: 'crud', accounting: 'crud', expenses: 'crud', invoices: 'crud', deliveries: 'crud', consignments: 'crud', orders: 'r', propals: 'crud', contracts: 'rw', profile: 'rw',
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
    manuscripts: 'r', printing: 'crud', legal_deposits: 'crud', profile: 'rw',
  }),
};

export const MODULE_LABELS = {
  dashboard: 'Tableau de bord',
  books: 'Livres',
  tags: 'Tags curation',
  authors: 'Auteurs',
  stock: 'Stock',
  inventory: 'Inventaire',
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
  deliveries: 'Bons de livraison',
  consignments: 'Dépôt-vente',
  expenses: "Sorties d'argent",
  orders: 'Commandes web',
  propals: 'Devis',
  legal_deposits: 'Dépôt légal',
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

// ─── Surcharges temporaires de permissions (pilotées par le super-admin) ──────
// Mapping module → chemins API permettant au middleware RBAC d'arbitrer une
// surcharge. SEULS ces modules sont « surchargeables » : leur accès transite par
// une route /api/admin/<x> gérable par la whitelist. Les autres modules de la
// matrice (contracts hors /api/admin, pos via PIN, users via requireSuperAdmin,
// profile personnel, faq/slides = sous-clés de config) ne sont PAS pilotables ici
// et restent verrouillés dans l'UI.
export const MODULE_PATHS = {
  dashboard:      [/^\/api\/admin\/stats(\/.*)?$/],
  books:          [/^\/api\/admin\/books(\/.*)?$/],
  tags:           [/^\/api\/admin\/tags(\/.*)?$/],
  authors:        [/^\/api\/admin\/authors(\/.*)?$/],
  stock:          [/^\/api\/admin\/stock(\/.*)?$/],
  inventory:      [/^\/api\/admin\/inventory(\/.*)?$/],
  suppliers:      [/^\/api\/admin\/suppliers(\/.*)?$/],
  manuscripts:    [/^\/api\/admin\/manuscripts(\/.*)?$/],
  evaluations:    [/^\/api\/admin\/evaluations(\/.*)?$/],
  corrections:    [/^\/api\/admin\/corrections(\/.*)?$/],
  editorial:      [/^\/api\/admin\/editorial(\/.*)?$/],
  covers:         [/^\/api\/admin\/covers(\/.*)?$/],
  printing:       [/^\/api\/admin\/printing(\/.*)?$/],
  payments:       [/^\/api\/admin\/payments(\/.*)?$/],
  accounting:     [/^\/api\/admin\/accounting(\/.*)?$/],
  invoices:       [/^\/api\/admin\/invoices(\/.*)?$/],
  deliveries:     [/^\/api\/admin\/deliveries(\/.*)?$/],
  consignments:   [/^\/api\/admin\/consignments(\/.*)?$/],
  expenses:       [/^\/api\/admin\/expenses(\/.*)?$/],
  orders:         [/^\/api\/admin\/orders(\/.*)?$/],
  propals:        [/^\/api\/admin\/propals(\/.*)?$/],
  legal_deposits: [/^\/api\/admin\/legal-deposits(\/.*)?$/],
  config:         [/^\/api\/admin\/config(\/.*)?$/],
  news:           [/^\/api\/admin\/news(\/.*)?$/],
  contacts:       [/^\/api\/admin\/contact(\/.*)?$/],
  newsletter:     [/^\/api\/admin\/newsletter(\/.*)?$/],
  customers:      [/^\/api\/admin\/customers(\/.*)?$/],
  activity:       [/^\/api\/admin\/activity-log(\/.*)?$/],
};

export const OVERRIDABLE_MODULES = Object.keys(MODULE_PATHS);
export const PERMISSION_LEVELS = ['crud', 'rw', 'r', '-'];

// Méthodes HTTP autorisées par niveau. 'crud' = tout (y compris DELETE).
const LEVEL_METHODS = {
  rw: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'],
  r:  ['GET', 'HEAD'],
};

export function methodAllowedForLevel(level, method) {
  if (level === 'crud') return true;
  if (level === 'r' || level === 'rw') {
    return LEVEL_METHODS[level].includes(String(method || '').toUpperCase());
  }
  return false; // '-' (aucun accès) ou niveau inconnu
}

// Retourne la clé de module surchargeable correspondant à un chemin, ou null.
export function moduleForPath(path) {
  for (const mod of OVERRIDABLE_MODULES) {
    if (MODULE_PATHS[mod].some((re) => re.test(path))) return mod;
  }
  return null;
}

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
        deprecated: !!r.deprecated,
      }])
    ),
    permissions: MODULE_PERMISSIONS,
    moduleLabels: MODULE_LABELS,
    overridableModules: OVERRIDABLE_MODULES,
  };
}
