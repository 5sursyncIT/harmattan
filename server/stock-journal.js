/**
 * Journal des manipulations de stock : classification et ATTRIBUTION.
 *
 * ── Le problème que ce module résout ─────────────────────
 * `llx_stock_mouvement` est le registre complet et fiable de TOUS les mouvements
 * (ventes, entrées, ajustements, transferts, réceptions, avoirs…). Ce qu'il ne
 * dit pas, c'est QUI a agi : Dolibarr y inscrit le porteur de la clé API, pas la
 * personne. Au 2026-08-10, deux comptes de service — `stocklibrairie` et
 * `caisselibrairie` — portaient 90 % des 103 215 mouvements. Lire ce champ comme
 * un nom d'utilisateur revient à afficher un responsable qui n'existe pas.
 *
 * L'acteur réel n'est connu que de l'application. On l'enregistre donc à la
 * source, au moment de l'écriture, dans `stock_movement_actors`, indexé sur
 * l'identifiant de mouvement RENVOYÉ PAR DOLIBARR — un lien exact, là où
 * l'historique des transferts devait jusqu'ici deviner par expression régulière
 * sur le libellé.
 *
 * ── Ce que le module ne prétend pas faire ────────────────
 * Il ne réécrit pas le passé. Un mouvement non attribué est présenté comme tel
 * (`actor_source: 'service'`), jamais recouvert d'un nom vraisemblable.
 */

// Comptes techniques : porteurs de clé API ou d'intégration, jamais des personnes.
//
// `ahmadoulo` est un compte NOMINATIF dont la clé d'API administrateur sert au
// système (décision de la direction, 2026-08-10) : les 4 223 mouvements qu'il
// porte sont des écritures automatiques, pas des gestes de cette personne. Le
// laisser s'afficher sous son nom désignerait un responsable à tort.
//
// Surchargeable par DOLIBARR_SERVICE_LOGINS si d'autres comptes servent d'API.
const SERVICE_LOGINS = new Set(
  (process.env.DOLIBARR_SERVICE_LOGINS || 'stocklibrairie,caisselibrairie,admin,ahmadoulo')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Libellé unique des écritures automatiques. « Système » plutôt que « non
// attribué » : le mouvement a bien une origine — le système — ce qui n'est pas
// la même chose qu'une information manquante.
export const SYSTEM_ACTOR = 'Système';

/**
 * Nature d'un mouvement, déduite dans cet ordre de fiabilité :
 *   1. l'attribution applicative (on sait ce qu'on a écrit) ;
 *   2. le document d'origine (origintype/fk_origin, posé par Dolibarr) ;
 *   3. le code d'inventaire, puis le libellé.
 *
 * `type_mouvement` seul ne suffit PAS : un ajustement négatif passé par l'API
 * ressort en type 2, exactement comme une vente.
 */
export const MOVEMENT_KINDS = {
  sale:        { label: 'Vente',                 tone: 'out'  },
  credit_note: { label: 'Avoir / retour client', tone: 'in'   },
  transfer_in: { label: 'Transfert — entrée',    tone: 'in'   },
  transfer_out:{ label: 'Transfert — sortie',    tone: 'out'  },
  entry:       { label: 'Entrée de stock',       tone: 'in'   },
  adjust_in:   { label: 'Ajustement — hausse',   tone: 'in'   },
  adjust_out:  { label: 'Ajustement — baisse',   tone: 'out'  },
  reception:   { label: 'Réception fournisseur', tone: 'in'   },
  delivery:    { label: 'Bon de livraison',      tone: 'out'  },
  inventory:   { label: 'Inventaire',            tone: 'both' },
  // Correction passée directement dans Dolibarr (hors application) : 20 630
  // mouvements au 2026-08-10. Les isoler est précieux — ce sont justement ceux
  // que l'application ne peut pas attribuer à une personne.
  correction:  { label: 'Correction (Dolibarr)', tone: 'both' },
  web:         { label: 'Site web (PrestaShop)', tone: 'both' },
  other_in:    { label: 'Entrée (autre)',        tone: 'in'   },
  other_out:   { label: 'Sortie (autre)',        tone: 'out'  },
};

// Libellés Dolibarr encodés en entités HTML (« Facture … valid&eacute;e »).
const HTML_ENTITIES = {
  '&eacute;': 'é', '&egrave;': 'è', '&ecirc;': 'ê', '&agrave;': 'à', '&ccedil;': 'ç',
  '&ugrave;': 'ù', '&ocirc;': 'ô', '&icirc;': 'î', '&acirc;': 'â', '&euml;': 'ë',
  '&iuml;': 'ï', '&ntilde;': 'ñ', '&amp;': '&', '&quot;': '"', '&#039;': '\'', '&nbsp;': ' ',
};
export function decodeDolibarrLabel(raw) {
  if (!raw) return '';
  return String(raw).replace(/&[a-z]+;|&#\d+;/gi, m => HTML_ENTITIES[m.toLowerCase()] ?? m);
}

/**
 * Classe un mouvement. `attribution` est la ligne stock_movement_actors si elle
 * existe — c'est la seule source qui distingue avec certitude un ajustement
 * d'une vente lorsque les deux ressortent en type 2.
 */
export function classifyMovement(row, attribution = null) {
  const value = Number(row.value) || 0;
  const incoming = value > 0;
  const label = decodeDolibarrLabel(row.label);
  const code = String(row.inventorycode || '');

  if (attribution?.source) {
    switch (attribution.source) {
      case 'transfer_out': return 'transfer_out';
      case 'transfer_in': return 'transfer_in';
      case 'entry': return 'entry';
      case 'adjust': return incoming ? 'adjust_in' : 'adjust_out';
      case 'receive': return 'reception';
      case 'delivery_note': return 'delivery';
      case 'inventory': return 'inventory';
      default: break;
    }
  }

  if (row.origintype === 'facture') return incoming ? 'credit_note' : 'sale';
  if (row.origintype === 'commande_fournisseur' || row.origintype === 'reception') return 'reception';
  if (row.origintype === 'expedition' || row.origintype === 'commande') return 'delivery';

  if (/^TRF-/i.test(code) || /^Transfert/i.test(label)) return incoming ? 'transfer_in' : 'transfer_out';
  if (/^Ajustement/i.test(label)) return incoming ? 'adjust_in' : 'adjust_out';
  if (/^Entr[ée]e stock/i.test(label)) return 'entry';
  if (/^Bon de livraison/i.test(label)) return 'delivery';
  if (/^R[ée]ception/i.test(label)) return 'reception';
  if (/^Correction du stock/i.test(label)) return 'correction';
  if (/prestashop/i.test(label)) return 'web';
  if (/inventaire/i.test(label) || /^INV/i.test(code)) return 'inventory';

  return incoming ? 'other_in' : 'other_out';
}

/**
 * Traduction d'une nature de mouvement en filtre SQL.
 *
 * Volontairement placé JUSTE SOUS classifyMovement : les deux décrivent la même
 * taxonomie et doivent évoluer ensemble. Filtrer en JS après chargement
 * obligerait à lire les 103 000 lignes pour en afficher 30.
 *
 * Le filtre SQL est un PRÉ-filtre : il travaille sans l'attribution applicative
 * (base séparée), donc il peut être un peu large. La classification finale
 * affichée reste celle de classifyMovement, qui, elle, connaît l'attribution.
 */
// Motif SQL par nature, hors distinction entrée/sortie. Défini une fois : la
// catégorie « autre » se construit par NÉGATION de cette liste, elle ne peut donc
// pas se désynchroniser d'elle.
// COALESCE obligatoire sur les colonnes NULLABLES (`inventorycode` l'est presque
// toujours) : `NULL LIKE 'TRF-%'` vaut NULL, pas FALSE, et un seul NULL suffit à
// rendre NULL toute la chaîne de OR — donc `NOT (…)` faux, donc la ligne absente
// de la catégorie « autre ». Trois mouvements réels (fusions de produits,
// restitution d'un doublon de facture) sortaient ainsi de tous les filtres.
const KIND_PATTERNS = {
  facture:   "m.origintype = 'facture'",
  transfer:  "(COALESCE(m.inventorycode,'') LIKE 'TRF-%' OR COALESCE(m.label,'') LIKE 'Transfert%')",
  adjust:    "COALESCE(m.label,'') LIKE 'Ajustement%'",
  entry:     "COALESCE(m.label,'') LIKE 'Entr%e stock%'",
  delivery:  "(COALESCE(m.label,'') LIKE 'Bon de livraison%' OR m.origintype IN ('expedition','commande'))",
  reception: "(COALESCE(m.label,'') LIKE 'R%ception %' OR m.origintype IN ('commande_fournisseur','reception'))",
  correction:"COALESCE(m.label,'') LIKE 'Correction du stock%'",
  web:       "COALESCE(m.label,'') LIKE '%PrestaShop%'",
  inventory: "(COALESCE(m.label,'') LIKE '%inventaire%' AND COALESCE(m.label,'') NOT LIKE 'Ajustement%')",
};

const NONE_OF_THE_ABOVE = `NOT (${Object.values(KIND_PATTERNS).join(' OR ')})`;

// Les variantes « sortie » retiennent `value <= 0`, pas `< 0`. Il existe en base
// des mouvements de quantité NULLE (lignes de facture à 0, anomalies anciennes) :
// avec deux bornes strictes ils n'apparaissaient dans aucun filtre et
// disparaissaient de l'historique sans un mot. Un journal d'audit qui escamote
// des lignes ne vaut rien ; ce choix aligne exactement le filtre SQL sur
// classifyMovement, où `incoming = value > 0` range déjà le zéro en sortie.

export function kindSqlPredicate(kind) {
  switch (kind) {
    case 'sale':         return { sql: `${KIND_PATTERNS.facture} AND m.value <= 0` };
    case 'credit_note':  return { sql: `${KIND_PATTERNS.facture} AND m.value > 0` };
    case 'transfer_in':  return { sql: `${KIND_PATTERNS.transfer} AND m.value > 0` };
    case 'transfer_out': return { sql: `${KIND_PATTERNS.transfer} AND m.value <= 0` };
    case 'adjust_in':    return { sql: `${KIND_PATTERNS.adjust} AND m.value > 0` };
    case 'adjust_out':   return { sql: `${KIND_PATTERNS.adjust} AND m.value <= 0` };
    case 'entry':        return { sql: KIND_PATTERNS.entry };
    case 'reception':    return { sql: KIND_PATTERNS.reception };
    case 'delivery':     return { sql: KIND_PATTERNS.delivery };
    case 'inventory':    return { sql: KIND_PATTERNS.inventory };
    case 'correction':   return { sql: KIND_PATTERNS.correction };
    case 'web':          return { sql: KIND_PATTERNS.web };
    // Sans ces deux cas, choisir « Entrée (autre) » dans le menu ne filtrait
    // RIEN et affichait la totalité de l'historique — un filtre muet est pire
    // qu'un filtre absent.
    case 'other_in':     return { sql: `${NONE_OF_THE_ABOVE} AND m.value > 0` };
    case 'other_out':    return { sql: `${NONE_OF_THE_ABOVE} AND m.value <= 0` };
    default:             return null;
  }
}

export function createStockJournal(db) {
  // Attribution des mouvements de stock aux utilisateurs de l'application.
  // Clé = identifiant du mouvement Dolibarr (llx_stock_mouvement.rowid), tel que
  // renvoyé par POST /stockmovements : lien exact, pas une correspondance devinée.
  db.exec(`CREATE TABLE IF NOT EXISTS stock_movement_actors (
    movement_id    INTEGER PRIMARY KEY,
    admin_username TEXT NOT NULL,
    admin_role     TEXT,
    source         TEXT NOT NULL,
    reason         TEXT,
    context        TEXT,
    attribution    TEXT NOT NULL DEFAULT 'direct',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sma_created ON stock_movement_actors(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sma_user ON stock_movement_actors(admin_username)');

  const insert = db.prepare(`INSERT OR REPLACE INTO stock_movement_actors
    (movement_id, admin_username, admin_role, source, reason, context, attribution)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  /**
   * Enregistre l'auteur d'un mouvement.
   *
   * `movementId` vient de la réponse de POST /stockmovements. Best-effort assumé :
   * le stock est DÉJÀ déplacé quand on arrive ici, un échec d'attribution ne doit
   * jamais faire échouer — ni annuler — l'opération métier. On perd alors la
   * traçabilité fine de ce mouvement, pas le mouvement lui-même.
   */
  function record(movementId, { username, role = null, source, reason = null, context = null, attribution = 'direct' }) {
    const id = parseInt(movementId, 10);
    if (!Number.isInteger(id) || id <= 0 || !username || !source) return false;
    try {
      insert.run(id, username, role, source, reason ? String(reason).slice(0, 300) : null,
        context ? JSON.stringify(context) : null, attribution);
      return true;
    } catch (e) {
      console.warn('[STOCK] attribution non enregistrée (mouvement', id, ') :', e.message);
      return false;
    }
  }

  /** Attribution de plusieurs mouvements d'une même opération (ex. les 2 jambes d'un transfert). */
  function recordMany(entries) {
    let n = 0;
    for (const { movementId, ...rest } of entries) if (record(movementId, rest)) n++;
    return n;
  }

  const selectByIds = (ids) => db.prepare(
    `SELECT * FROM stock_movement_actors WHERE movement_id IN (${ids.map(() => '?').join(',')})`
  ).all(ids);

  /** Attributions d'un lot de mouvements, indexées par identifiant. */
  function attributionsFor(movementIds) {
    const ids = movementIds.map(n => parseInt(n, 10)).filter(Number.isInteger);
    if (ids.length === 0) return new Map();
    const out = new Map();
    // SQLite plafonne le nombre de paramètres liés : on découpe par sécurité.
    for (let i = 0; i < ids.length; i += 500) {
      for (const row of selectByIds(ids.slice(i, i + 500))) out.set(row.movement_id, row);
    }
    return out;
  }

  return { record, recordMany, attributionsFor };
}

/**
 * Détermine l'acteur affiché et D'OÙ vient cette information.
 *
 * `actor_source` est délibérément exposé à l'interface : « Amadou (ajustement) »
 * et « compte de service » ne se valent pas, et l'écran ne doit jamais laisser
 * croire le contraire.
 *   app      → attribution applicative, l'acteur est certain
 *   inferred → rapproché après coup depuis le journal (rattrapage), plausible
 *   document → responsable du document d'origine (facture validée par…)
 *   dolibarr → utilisateur Dolibarr nominatif
 *   service  → compte technique : aucune personne identifiable
 */
export function resolveActor({ attribution, dolibarrUser, documentUser }) {
  if (attribution?.admin_username) {
    return {
      actor: attribution.admin_username,
      actor_source: attribution.attribution === 'inferred' ? 'inferred' : 'app',
    };
  }
  if (documentUser) return { actor: documentUser, actor_source: 'document' };
  if (dolibarrUser) {
    const isService = SERVICE_LOGINS.has(String(dolibarrUser.login || '').toLowerCase());
    const name = [dolibarrUser.firstname, dolibarrUser.lastname].filter(Boolean).join(' ').trim()
      || dolibarrUser.login || null;
    // Le compte technique reste visible en `actor_account` : l'écriture est
    // tracée, on affiche seulement qu'aucune personne n'en est responsable.
    if (isService) return { actor: SYSTEM_ACTOR, actor_source: 'service', actor_account: dolibarrUser.login };
    if (name) return { actor: name, actor_source: 'dolibarr' };
  }
  // Aucun utilisateur du tout : distinct d'une écriture système identifiée.
  return { actor: null, actor_source: 'unknown' };
}
