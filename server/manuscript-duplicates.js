// ─── DÉTECTION DES MANUSCRITS EN DOUBLE ─────────────────────────────────────
// Un même ouvrage arrivait plusieurs fois sans que rien ne le signale :
// l'auteur renvoie son texte parce qu'il n'a pas eu de réponse, double-clique
// sur « Envoyer », ou se ressoumet avec une faute de frappe dans son e-mail
// (walyadadiack0@glail.com vs @gmail.com) — ce qui crée en prime un second
// compte auteur. Résultat au 03/09/2026 : 8 groupes de doublons en base, dont
// deux déjà engagés dans des workflows séparés (évaluation, contrat).
//
// Deux étages, volontairement distincts :
//   1. BARRAGE à la soumission publique — refuse ce qui est certain
//      (même fichier au bit près, ou même auteur + même titre sur un dossier
//      encore actif) en renvoyant la référence déjà enregistrée.
//   2. DÉTECTION a posteriori pour l'administration — regroupe les suspects
//      restants (e-mails voisins, titres identiques) que seul un humain peut
//      trancher, et permet de marquer le doublon.
//
// Rien n'est fusionné ni supprimé automatiquement : un doublon marqué reste en
// base, relié à l'original, et le marquage est réversible.

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sha256File } from './manuscript-versions.js';

// Étapes où le dossier est clos : une nouvelle soumission du même titre y est
// légitime (texte retravaillé après refus, réédition d'un ouvrage paru).
const TERMINAL_STAGES = ['evaluation_negative', 'published'];
// Étape « À retravailler » : l'auteur a été explicitement invité à revenir avec
// une nouvelle version — on ne lui claque pas la porte au nez.
const REWORK_STAGES = ['evaluation_rework'];

export const DUPLICATE_REASONS = {
  same_file:        { label: 'Fichier identique',            confidence: 'certain' },
  same_author_title:{ label: 'Même auteur, même titre',      confidence: 'certain' },
  same_name_title:  { label: 'Même nom d’auteur (e-mail différent), même titre', confidence: 'probable' },
  same_title:       { label: 'Même titre, auteur différent', confidence: 'possible' },
};

/** Titre comparable : sans accents, sans ponctuation, sans casse ni espaces multiples. */
export function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Identité comparable : « Ndeye Fatou KONATE » et « ndeye fatou konate » = même personne. */
export function normalizePerson(firstname, lastname) {
  return normalizeTitle(`${firstname || ''} ${lastname || ''}`);
}

export function ensureDuplicateSchema(db) {
  // duplicate_of : doublon CONFIRMÉ par un humain (jamais posé automatiquement).
  for (const sql of [
    'ALTER TABLE manuscripts ADD COLUMN duplicate_of INTEGER',
    'ALTER TABLE manuscripts ADD COLUMN duplicate_marked_at TEXT',
    'ALTER TABLE manuscripts ADD COLUMN duplicate_marked_by TEXT',
  ]) {
    try { db.exec(sql); } catch (e) { void e; /* colonne déjà présente */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_duplicate ON manuscripts(duplicate_of)'); } catch (e) { void e; }
}

/**
 * Empreintes SHA-256 des fichiers reçus, dans l'ORDRE des tomes : `null` pour
 * un tome déposé par lien externe. L'alignement compte — c'est ce tableau qui
 * renseigne le sha256 de chaque ligne manuscript_files.
 */
export function hashUploads(files = []) {
  return files.map((f) => (f ? sha256File(f.path) : null));
}

// Toutes les lignes utiles à la comparaison, en une requête.
function comparableRows(db) {
  return db.prepare(
    `SELECT m.id, m.ref, m.title, m.current_stage, m.created_at, m.author_id,
            m.duplicate_of, m.tome_number, m.series_ref, m.series_title,
            a.email AS author_email, a.firstname, a.lastname
       FROM manuscripts m JOIN authors a ON a.id = m.author_id`
  ).all();
}

/**
 * Cherche, AVANT insertion, ce qui existe déjà pour cette soumission.
 * @returns {{ blocking: object|null, matches: Array }} — `blocking` porte le
 *   manuscrit à opposer à l'auteur ; `matches` liste tout ce qui a été trouvé
 *   (y compris non bloquant) pour la trace serveur.
 */
export function findSubmissionDuplicates(db, { email, firstname, lastname, title, hashes = [] }) {
  const wantedTitle = normalizeTitle(title);
  const wantedPerson = normalizePerson(firstname, lastname);
  const cleanEmail = String(email || '').trim().toLowerCase();
  const matches = [];

  // 1. Même fichier, au bit près — la preuve la plus forte, indépendante du titre.
  if (hashes.length) {
    const placeholders = hashes.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT m.id, m.ref, m.title, m.current_stage, m.created_at, m.duplicate_of
         FROM manuscript_files f JOIN manuscripts m ON m.id = f.manuscript_id
        WHERE f.kind = 'original' AND f.sha256 IN (${placeholders})`
    ).all(...hashes);
    for (const r of rows) matches.push({ ...r, reason: 'same_file' });
  }

  // 2. Même titre : on décide ensuite si l'auteur est le même. Un ouvrage
  // multi-tomes se compare sur le titre de l'œuvre (series_title), le titre du
  // tome portant en plus « — Tome N ».
  if (wantedTitle) {
    for (const row of comparableRows(db)) {
      const titles = [normalizeTitle(row.title), normalizeTitle(row.series_title)];
      if (!titles.includes(wantedTitle)) continue;
      if (matches.some((m) => m.id === row.id)) continue;
      const sameEmail = cleanEmail && row.author_email?.toLowerCase() === cleanEmail;
      const samePerson = wantedPerson && normalizePerson(row.firstname, row.lastname) === wantedPerson;
      const reason = sameEmail ? 'same_author_title' : samePerson ? 'same_name_title' : 'same_title';
      matches.push({ ...row, reason });
    }
  }

  // Ne bloque que sur une certitude, et seulement si le dossier existant est
  // encore vivant : un refus ou une parution n'interdit pas une nouvelle version.
  const blocking = matches.find((m) => (
    (m.reason === 'same_file' || m.reason === 'same_author_title')
    && !m.duplicate_of
    && !TERMINAL_STAGES.includes(m.current_stage)
    && !REWORK_STAGES.includes(m.current_stage)
  )) || null;

  return { blocking, matches };
}

/**
 * Groupes de doublons présents en base, pour l'écran d'administration.
 * @param {object} opts.includeResolved  inclut les groupes déjà tranchés.
 */
export function listDuplicateGroups(db, { includeResolved = false } = {}) {
  const rows = comparableRows(db);

  // Empreintes connues : un même fichier sous deux références est un doublon
  // certain même si les titres ont été retapés différemment.
  const hashByManuscript = new Map();
  try {
    for (const f of db.prepare(
      "SELECT manuscript_id, sha256 FROM manuscript_files WHERE kind = 'original' AND sha256 IS NOT NULL AND sha256 <> ''"
    ).all()) {
      if (!hashByManuscript.has(f.manuscript_id)) hashByManuscript.set(f.manuscript_id, f.sha256);
    }
  } catch (e) { void e; }

  const groups = new Map();
  const push = (key, reason, row) => {
    if (!groups.has(key)) groups.set(key, { key, reason, members: [] });
    const g = groups.get(key);
    if (!g.members.some((m) => m.id === row.id)) g.members.push(row);
  };

  for (const row of rows) {
    // Les tomes d'une même série partagent volontairement le titre de l'œuvre :
    // ce ne sont pas des doublons.
    if (row.series_ref) continue;
    const t = normalizeTitle(row.title);
    if (t) {
      push(`title:${t}`, 'same_title', row);
      push(`author:${row.author_id}|${t}`, 'same_author_title', row);
      const person = normalizePerson(row.firstname, row.lastname);
      if (person) push(`person:${person}|${t}`, 'same_name_title', row);
    }
    const hash = hashByManuscript.get(row.id);
    if (hash) push(`file:${hash}`, 'same_file', row);
  }

  // Un groupe n'est retenu qu'à partir de deux membres ; on garde, pour chaque
  // manuscrit, le motif le plus fort (fichier > même auteur > même nom > titre).
  const strength = { same_file: 4, same_author_title: 3, same_name_title: 2, same_title: 1 };
  const kept = [...groups.values()].filter((g) => g.members.length > 1);
  const seen = new Map();                       // id manuscrit → groupe retenu
  const result = [];
  for (const g of kept.sort((a, b) => strength[b.reason] - strength[a.reason])) {
    // Un groupe entièrement recouvert par un groupe plus fort n'apporte rien
    // (« même titre » qui redit ce que « même auteur + titre » a déjà dit).
    if (g.members.every((m) => seen.has(m.id))) continue;
    for (const m of g.members) if (!seen.has(m.id)) seen.set(m.id, g);
    const members = g.members
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    // Groupe tranché : tous les membres sauf un pointent vers un original.
    const resolved = members.filter((m) => m.duplicate_of).length >= members.length - 1;
    if (resolved && !includeResolved) continue;
    result.push({
      key: g.key,
      reason: g.reason,
      reason_label: DUPLICATE_REASONS[g.reason]?.label || g.reason,
      confidence: DUPLICATE_REASONS[g.reason]?.confidence || 'possible',
      resolved,
      // L'original proposé = le plus ancien non marqué comme doublon.
      original_id: members.find((m) => !m.duplicate_of)?.id ?? members[0].id,
      members,
    });
  }
  // Les certitudes d'abord, puis les groupes les plus récents.
  return result.sort((a, b) => (strength[b.reason] - strength[a.reason])
    || String(b.members.at(-1).created_at).localeCompare(String(a.members.at(-1).created_at)));
}

// ─── SUPPRESSION D'UN DOUBLON ────────────────────────────────────────────────
// Le marquage laisse la copie en base : utile tant qu'on hésite, encombrant une
// fois la décision prise (fiche consultable, fichiers en double sur disque,
// groupe « traité » qui revient à chaque affichage). La suppression achève
// l'arbitrage, sous trois conditions :
//   - la copie est d'abord MARQUÉE comme doublon (l'original est donc désigné
//     et survit — on ne supprime jamais le seul exemplaire d'un ouvrage) ;
//   - elle ne porte rien qui vive hors de SQLite : contrat Dolibarr, ISBN,
//     produit ou ordre de fabrication. Supprimer la fiche laisserait ces objets
//     orphelins (et le devis/la facture du contrat avec eux) ;
//   - la trace survit : un événement dans la frise de l'original, et un
//     instantané JSON des lignes + les fichiers déplacés (pas effacés) dans
//     manuscripts/_supprimes/, de quoi reconstituer le dossier en cas d'erreur.

// Tables filles portant manuscript_id, vidées avec la fiche.
const CHILD_TABLES = [
  'manuscript_files', 'manuscript_stages', 'manuscript_evaluations', 'manuscript_validations',
  'manuscript_file_tokens', 'manuscript_deposit_tokens', 'parution_checklists', 'parution_newsletter_log',
  'contract_manuscript_links',
];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Raisons empêchant la suppression d'un manuscrit (liste vide = supprimable).
 * @returns {string[]}
 */
export function duplicateDeletionBlockers(db, m) {
  const blockers = [];
  if (!m.duplicate_of) {
    blockers.push("Marquez d'abord ce manuscrit comme doublon de l'original à conserver");
  }
  const attached = db.prepare('SELECT COUNT(*) AS n FROM manuscripts WHERE duplicate_of = ?').get(m.id).n;
  if (attached) blockers.push(`${m.ref} est l'original de ${attached} doublon(s)`);
  const links = tableExists(db, 'contract_manuscript_links')
    ? db.prepare('SELECT COUNT(*) AS n FROM contract_manuscript_links WHERE manuscript_id = ?').get(m.id).n
    : 0;
  if (m.contract_id || links) blockers.push('Un contrat est rattaché à ce manuscrit');
  if (m.isbn) blockers.push(`Un ISBN lui est attribué (${m.isbn})`);
  if (m.dolibarr_product_id || m.dolibarr_mo_id) blockers.push('Un produit ou un ordre de fabrication existe déjà');
  return blockers;
}

/**
 * Supprime un doublon marqué. Les lignes sont effacées dans une transaction ;
 * les fichiers et l'instantané sont mis de côté dans `trashRoot`.
 * @returns {{ original: {id:number, ref:string}, trashDir: string|null, files: number }}
 */
export function deleteDuplicateManuscript(db, m, { manuscriptsDir, actor = {}, reason = '', logEvent }) {
  const original = db.prepare('SELECT id, ref FROM manuscripts WHERE id = ?').get(m.duplicate_of);
  const tables = CHILD_TABLES.filter((t) => tableExists(db, t));
  const snapshot = { manuscript: m, deleted_at: new Date().toISOString(), deleted_by: actor.label || null, reason };
  for (const t of tables) snapshot[t] = db.prepare(`SELECT * FROM ${t} WHERE manuscript_id = ?`).all(m.id);

  // Instantané + fichiers mis de côté AVANT d'effacer : si le disque refuse,
  // rien n'est supprimé.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trashDir = join(manuscriptsDir, '_supprimes', `${m.ref}-${stamp}`);
  mkdirSync(trashDir, { recursive: true });
  writeFileSync(join(trashDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  const ownDir = join(manuscriptsDir, String(m.id));
  let moved = 0;
  if (existsSync(ownDir)) {
    renameSync(ownDir, join(trashDir, 'fichiers'));
    moved = (snapshot.manuscript_files || []).length;
  }

  db.transaction(() => {
    for (const t of tables) db.prepare(`DELETE FROM ${t} WHERE manuscript_id = ?`).run(m.id);
    // Notifications auteur : on garde l'historique (réf + titre dénormalisés),
    // seul le lien vers la fiche disparue est coupé.
    if (tableExists(db, 'author_notifications')) {
      db.prepare('UPDATE author_notifications SET manuscript_id = NULL WHERE manuscript_id = ?').run(m.id);
    }
    db.prepare('DELETE FROM manuscripts WHERE id = ?').run(m.id);
    if (original && logEvent) {
      logEvent(db, original.id, 'duplicate_deleted', actor,
        `Doublon ${m.ref} — « ${m.title} » supprimé${reason ? ` (${reason})` : ''}. Archive : _supprimes/${m.ref}-${stamp}`);
    }
  })();

  return { original, trashDir, files: moved };
}
