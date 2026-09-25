import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync } from 'fs';
import { transition, STAGE_LABELS, MANUSCRIPT_STAGES, MANUSCRIPT_EVENTS, logManuscriptEvent, promoteLatestCorrectionAsAuthorFinal } from './manuscript-workflow.js';
import { notifyTransition, sendAssignmentEmail, sendAuthorRevisionRequestEmail, notifyIntervenantTask, METIER_TASK_STAGES } from './manuscript-emails.js';
import { revokeFileTokens } from './manuscript-file-tokens.js';
import { addManuscriptVersion, getFinalVersion, createDepositToken, getActiveDepositToken, revokeDepositTokens } from './manuscript-versions.js';
import { createManuscriptMulter } from './author-routes.js';
import { ensureIntervenantsSchema, seedIntervenants, INTERVENANT_METIERS, intervenantIdsForAdmin } from './intervenants.js';
import { listDuplicateGroups, ensureDuplicateSchema, normalizePerson, duplicateDeletionBlockers, deleteDuplicateManuscript } from './manuscript-duplicates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS_DIR = join(__dirname, '..', 'manuscripts');

const UPLOAD_CFG = {
  // Texte du manuscrit (chaîne de versions) : mêmes formats que le dépôt auteur.
  original: { sizeMB: 20, pattern: /\.(pdf|doc|docx|odt|rtf)$/i },
  evaluation_report: { sizeMB: 20, pattern: /\.(pdf|doc|docx|odt)$/i },
  correction: { sizeMB: 20, pattern: /\.(pdf|doc|docx|odt)$/i },
  cover_artwork: { sizeMB: 50, pattern: /\.(pdf|ai|psd|indd|jpg|jpeg|png)$/i },
  bat_cover: { sizeMB: 50, pattern: /\.(pdf)$/i },
  print_ready: { sizeMB: 100, pattern: /\.(pdf)$/i },
};

function multerFor(kind) {
  const cfg = UPLOAD_CFG[kind];
  return createManuscriptMulter(kind, cfg.sizeMB, cfg.pattern);
}

// ─── DOSSIER DE PRODUCTION ÉDITORIALE ─────────────────────────
// Une fois la correction terminée, l'administration constitue le dossier que
// l'équipe de production reprendra : texte définitif mis en page, éléments de
// couverture, illustrations intérieures, annexes. Le seul upload disponible
// jusqu'ici était le document corrigé (kind 'correction'), en un exemplaire et
// limité au traitement de texte — impossible d'y joindre une maquette InDesign
// ou des visuels HD.
const PRODUCTION_FILE_KINDS = {
  production_text: {
    label: 'Texte définitif / mise en page',
    sizeMB: 100,
    ext: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'indd', 'idml', 'zip'],
  },
  production_cover: {
    label: 'Éléments de couverture',
    sizeMB: 100,
    ext: ['pdf', 'ai', 'psd', 'indd', 'idml', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'svg', 'zip'],
  },
  production_illustration: {
    label: 'Illustrations & images intérieures',
    sizeMB: 100,
    ext: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'pdf', 'eps', 'svg', 'zip'],
  },
  production_annex: {
    label: 'Annexes (préface, 4e de couverture, biographie…)',
    sizeMB: 50,
    ext: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt'],
  },
  production_other: {
    label: 'Autre document de production',
    sizeMB: 100,
    ext: ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'jpg', 'jpeg', 'png', 'tif', 'tiff', 'zip'],
  },
};

// Nombre de fichiers acceptés en une fois (un dossier de production complet tient
// largement dedans ; au-delà, l'admin envoie une archive zip ou un second lot).
const PRODUCTION_UPLOAD_MAX_FILES = 15;

function extPattern(ext) {
  return new RegExp(`\\.(${ext.join('|')})$`, 'i');
}

// Libellé lisible d'un type de fichier, pour la frise et les listes.
function fileKindLabel(kind) {
  if (PRODUCTION_FILE_KINDS[kind]) return PRODUCTION_FILE_KINDS[kind].label;
  return {
    correction: 'Document corrigé',
    original: 'Manuscrit original',
    author_review: "Retour de l'auteur",
  }[kind] || kind;
}

function describeManuscript(row) {
  return row ? { ...row, stage_label: STAGE_LABELS[row.current_stage] || row.current_stage } : null;
}

// Familles d'étapes de la vue globale : 19 étapes dans un menu déroulant ne
// répondent pas à « où en est le pipeline ? ». Les puces de la liste s'appuient
// dessus ; le filtre étape par étape reste disponible.
export const MANUSCRIPT_STAGE_GROUPS = [
  { value: 'a_traiter',  label: 'À traiter',          stages: ['submitted'] },
  { value: 'evaluation', label: 'Évaluation',         stages: ['in_evaluation', 'evaluation_rework', 'evaluation_positive'] },
  { value: 'contrat',    label: 'Contrat & paiement', stages: ['contract_pending', 'contract_signed', 'payment_pending'] },
  { value: 'production', label: 'Production',         stages: ['in_correction', 'correction_author_review', 'in_editorial', 'editorial_validated', 'cover_design', 'bat_author_review', 'print_preparation', 'printing'] },
  { value: 'diffusion',  label: 'Diffusion',          stages: ['printed', 'in_communication', 'published'] },
  { value: 'rejete',     label: 'Rejetés',            stages: ['evaluation_negative'] },
];
// Garde-fou : une étape ajoutée au workflow sans être classée resterait
// invisible dans les familles. On la rattache à « Autres » plutôt que la perdre.
{
  const grouped = new Set(MANUSCRIPT_STAGE_GROUPS.flatMap((g) => g.stages));
  const orphans = MANUSCRIPT_STAGES.filter((s) => !grouped.has(s));
  if (orphans.length) MANUSCRIPT_STAGE_GROUPS.push({ value: 'autres', label: 'Autres étapes', stages: orphans });
}

// Colonnes d'affectation d'un métier : l'ancienne (compte `admin_users`) et
// celle du carnet d'intervenants, alimentée par /assign depuis la bascule
// « semi-automatique ». Les deux doivent être interrogées : les manuscrits
// historiques portent la première, les nouveaux la seconde.
const METIER_ASSIGN_COLUMNS = {
  evaluateur:   { adminCol: 'assigned_evaluator_id',    contactCol: 'assigned_evaluator_contact_id' },
  correcteur:   { adminCol: 'assigned_corrector_id',    contactCol: 'assigned_corrector_contact_id' },
  infographiste:{ adminCol: 'assigned_infographist_id', contactCol: 'assigned_infographist_contact_id' },
  imprimeur:    { adminCol: 'assigned_printer_id',      contactCol: 'assigned_printer_contact_id' },
};

function roleCanAccessManuscript(admin, manuscript, db = null) {
  if (!admin || !manuscript) return false;
  if (['super_admin', 'admin'].includes(admin.role)) return true;
  if (admin.role === 'editor') return true;
  if (admin.role === 'production') return true;   // pilote du pipeline éditorial + couvertures
  const cols = METIER_ASSIGN_COLUMNS[admin.role];
  if (!cols) return false;
  if (manuscript[cols.adminCol] === admin.id) return true;
  // Affectation par le carnet : la fiche d'intervenant et le compte connecté
  // sont la même personne (appariement par email).
  const contactId = manuscript[cols.contactCol];
  if (!db || !contactId) return false;
  return intervenantIdsForAdmin(db, admin).includes(contactId);
}

export function createManuscriptRouter({ db, csrfProtection, adminAuth, transporter, siteUrl, hooks = {} }) {
  const router = Router();

  // Carnet d'intervenants (workflow semi-automatique) : acteurs externes notifiés
  // par email, sans compte. Création du schéma + seed idempotent depuis les
  // données héritées (liste correcteurs + anciens admin_users métier).
  try {
    ensureIntervenantsSchema(db);
    seedIntervenants(db);
  } catch (err) { console.warn('[INTERVENANTS] init warning:', err.message); }
  // Colonnes de marquage des doublons (idempotent, également posé par admin-routes).
  try { ensureDuplicateSchema(db); } catch (err) { console.warn('[DOUBLONS] init warning:', err.message); }
  const auth = adminAuth;

  // Garde-fou : routes carnet/affectation réservées au pilote éditorial.
  const editorOnly = (req, res, next) => {
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée à l\'éditeur' });
    }
    next();
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // Clause SQL « mes dossiers » pour un acteur métier connecté. Son compte peut
  // être désigné par l'ancienne colonne (`assigned_*_id`) OU par la fiche du
  // carnet (`assigned_*_contact_id`) que /assign alimente désormais. Filtrer sur
  // la seule colonne compte vidait l'espace du correcteur : il était affecté
  // (carnet), notifié par email, mais son écran restait « Aucune correction ».
  const myAssignmentsClause = (admin, alias = 'm') => {
    const cols = METIER_ASSIGN_COLUMNS[admin.role];
    if (!cols) return { clause: '1 = 0', params: [] };   // rôle sans dossier propre
    const parts = [`${alias}.${cols.adminCol} = ?`];
    const params = [admin.id];
    const contactIds = intervenantIdsForAdmin(db, admin);
    if (contactIds.length) {
      parts.push(`${alias}.${cols.contactCol} IN (${contactIds.map(() => '?').join(',')})`);
      params.push(...contactIds);
    }
    return { clause: `(${parts.join(' OR ')})`, params };
  };

  // ─── CARNET D'INTERVENANTS ───────────────────────────────
  router.get('/intervenants', auth, editorOnly, (req, res) => {
    const { metier, active } = req.query || {};
    let sql = 'SELECT * FROM intervenants WHERE 1=1';
    const params = [];
    if (metier && INTERVENANT_METIERS.includes(metier)) { sql += ' AND metier = ?'; params.push(metier); }
    if (active === '1') sql += ' AND is_active = 1';
    else if (active === '0') sql += ' AND is_active = 0';
    sql += ' ORDER BY metier ASC, nom ASC';
    res.json(db.prepare(sql).all(...params));
  });

  router.get('/intervenants/:id', auth, editorOnly, (req, res) => {
    const row = db.prepare('SELECT * FROM intervenants WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Intervenant introuvable' });
    res.json(row);
  });

  router.post('/intervenants', auth, editorOnly, csrfProtection, (req, res) => {
    const nom = (req.body?.nom || '').trim();
    const email = (req.body?.email || '').trim();
    const metier = (req.body?.metier || '').trim();
    const notes = (req.body?.notes || '').trim() || null;
    if (!nom) return res.status(400).json({ error: 'Nom requis' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email invalide' });
    if (!INTERVENANT_METIERS.includes(metier)) return res.status(400).json({ error: 'Métier invalide' });
    const info = db.prepare(
      'INSERT INTO intervenants (nom, email, metier, notes) VALUES (?, ?, ?, ?)'
    ).run(nom, email, metier, notes);
    res.json(db.prepare('SELECT * FROM intervenants WHERE id = ?').get(info.lastInsertRowid));
  });

  router.put('/intervenants/:id', auth, editorOnly, csrfProtection, (req, res) => {
    const current = db.prepare('SELECT * FROM intervenants WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Intervenant introuvable' });
    const updates = [];
    const values = [];
    if (req.body?.nom !== undefined) {
      const nom = (req.body.nom || '').trim();
      if (!nom) return res.status(400).json({ error: 'Nom requis' });
      updates.push('nom = ?'); values.push(nom);
    }
    if (req.body?.email !== undefined) {
      const email = (req.body.email || '').trim();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Email invalide' });
      updates.push('email = ?'); values.push(email);
    }
    if (req.body?.metier !== undefined) {
      const metier = (req.body.metier || '').trim();
      if (!INTERVENANT_METIERS.includes(metier)) return res.status(400).json({ error: 'Métier invalide' });
      updates.push('metier = ?'); values.push(metier);
    }
    if (req.body?.notes !== undefined) { updates.push('notes = ?'); values.push((req.body.notes || '').trim() || null); }
    if (!updates.length) return res.json(current);
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    db.prepare(`UPDATE intervenants SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json(db.prepare('SELECT * FROM intervenants WHERE id = ?').get(req.params.id));
  });

  router.patch('/intervenants/:id/active', auth, editorOnly, csrfProtection, (req, res) => {
    const current = db.prepare('SELECT id FROM intervenants WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Intervenant introuvable' });
    const active = req.body?.is_active ? 1 : 0;
    db.prepare("UPDATE intervenants SET is_active = ?, updated_at = datetime('now') WHERE id = ?").run(active, req.params.id);
    res.json(db.prepare('SELECT * FROM intervenants WHERE id = ?').get(req.params.id));
  });

  router.delete('/intervenants/:id', auth, editorOnly, csrfProtection, (req, res) => {
    const current = db.prepare('SELECT id FROM intervenants WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Intervenant introuvable' });
    // Soft delete si référencé par un manuscrit (préserve l'affichage de l'historique).
    const refCols = ['assigned_evaluator_contact_id', 'assigned_corrector_contact_id', 'assigned_infographist_contact_id', 'assigned_printer_contact_id'];
    let referenced = false;
    try {
      const where = refCols.map((c) => `${c} = ?`).join(' OR ');
      const hit = db.prepare(`SELECT 1 FROM manuscripts WHERE ${where} LIMIT 1`).get(...refCols.map(() => req.params.id));
      referenced = !!hit;
    } catch (e) { void e; }
    if (referenced) {
      db.prepare("UPDATE intervenants SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
      return res.json({ success: true, softDeleted: true });
    }
    db.prepare('DELETE FROM intervenants WHERE id = ?').run(req.params.id);
    res.json({ success: true, softDeleted: false });
  });

  // ─── LISTE GLOBALE : recherche avancée, filtres, tri, pagination ───
  // La vue globale se limitait à `q` (5 colonnes) + une étape, avec un
  // LIMIT 200 muet : au-delà, les manuscrits les plus anciens disparaissaient
  // sans le dire, et aucune question de pilotage courante n'avait de réponse
  // (« que traîne-t-il en évaluation depuis un mois ? », « lesquels n'ont pas
  // d'évaluateur ? »). Paramètres acceptés :
  //   q            recherche multi-mots — chaque mot doit matcher un champ
  //                (titre, sous-titre, réf, série, genre, ISBN, auteur en
  //                « Prénom Nom » ou « Nom Prénom », email, téléphone)
  //   stage        une étape (rétro-compatible)  |  stages : plusieurs (CSV)
  //   group        famille d'étapes (a_traiter, evaluation, contrat, …)
  //   genre        genre exact
  //   intervenant  id du carnet, sur les 4 colonnes *_contact_id
  //   metier       restreint `intervenant` à un métier
  //   unassigned   evaluateur|correcteur|imprimeur|any — aucun acteur affecté
  //   contract     with|without — contrat d'édition rattaché ou non
  //   series       only|single — tomes d'une série ou ouvrages simples
  //   date_field   created|updated (défaut created) + date_from / date_to
  //   stale        entier : jours sans mouvement (>=)
  //   sort/order   voir MANUSCRIPT_SORTS ; page/limit (défaut 25, max 200)
  // Réponse : { rows, total, page, pages, limit, stage_counts }

  // Ancienneté dans l'étape COURANTE : une seule et même expression sert la
  // colonne affichée, le tri et le filtre d'immobilisation — sinon l'écran
  // trierait sur une grandeur différente de celle qu'il montre. Repli sur
  // updated_at/created_at pour les manuscrits antérieurs à la frise.
  const STAGE_SINCE_SQL = `COALESCE((SELECT MAX(s.created_at) FROM manuscript_stages s
      WHERE s.manuscript_id = m.id AND s.to_stage = m.current_stage
        AND (s.event IS NULL OR s.event = '')), m.updated_at, m.created_at)`;
  const DAYS_IN_STAGE_SQL = `julianday('now') - julianday(${STAGE_SINCE_SQL})`;

  // Une entrée = la liste des expressions SQL à ordonner (le sens ASC/DESC est
  // ajouté à chacune). Liste d'expressions, pas une chaîne à découper : une
  // virgule interne à COALESCE(...) casserait un split.
  const MANUSCRIPT_SORTS = {
    ref: ['m.ref'],
    title: ['m.title COLLATE NOCASE'],
    author: ['a.lastname COLLATE NOCASE', 'a.firstname COLLATE NOCASE'],
    genre: ['m.genre COLLATE NOCASE'],
    // Tri « étape » = progression dans le workflow, pas ordre alphabétique du
    // libellé : « Reçu » doit précéder « En évaluation », pas l'inverse.
    stage: [`CASE m.current_stage ${MANUSCRIPT_STAGES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE 999 END`],
    created: ['m.created_at'],
    updated: ['COALESCE(m.updated_at, m.created_at)'],
    stale: [DAYS_IN_STAGE_SQL],
  };

  // Sens naturel de chaque tri au premier clic : alphabétique croissant pour le
  // texte, workflow croissant pour l'étape, plus récent / plus immobilisé en
  // tête pour les dates.
  const MANUSCRIPT_SORT_DIR = {
    ref: 'ASC', title: 'ASC', author: 'ASC', genre: 'ASC', stage: 'ASC',
    created: 'DESC', updated: 'DESC', stale: 'DESC',
  };

  const CONTACT_COLUMNS = {
    evaluateur: 'assigned_evaluator_contact_id',
    correcteur: 'assigned_corrector_contact_id',
    infographiste: 'assigned_infographist_contact_id',
    imprimeur: 'assigned_printer_contact_id',
  };

  // Colonnes à tester pour « aucun acteur affecté » : le carnet ET l'ancienne
  // colonne compte, sinon un manuscrit historique remonterait à tort.
  const UNASSIGNED_COLUMNS = {
    evaluateur: ['assigned_evaluator_contact_id', 'assigned_evaluator_id'],
    correcteur: ['assigned_corrector_contact_id', 'assigned_corrector_id'],
    imprimeur: ['assigned_printer_contact_id', 'assigned_printer_id'],
    any: Object.values(CONTACT_COLUMNS),
  };

  // Étape → métier qui a la main : sert à n'afficher dans la liste que
  // l'intervenant réellement concerné (pas les quatre affectations).
  const STAGE_OWNER_METIER = {
    in_evaluation: 'evaluateur', evaluation_rework: 'evaluateur',
    evaluation_positive: 'evaluateur', evaluation_negative: 'evaluateur',
    in_correction: 'correcteur', correction_author_review: 'correcteur',
    in_editorial: 'editeur', editorial_validated: 'editeur',
    cover_design: 'editeur', bat_author_review: 'editeur',
    print_preparation: 'imprimeur', printing: 'imprimeur', printed: 'imprimeur',
  };
  const METIER_LABELS = {
    evaluateur: 'Évaluateur', correcteur: 'Correcteur',
    editeur: 'Éditeur', imprimeur: 'Imprimeur',
  };

  // → { stages, impossible } : `impossible` distingue « famille et étape se
  // contredisent » (résultat vide, littéral) d'« étape ou famille inconnue »
  // (paramètre ignoré) — sans quoi une faute de frappe dans l'URL viderait
  // silencieusement l'écran.
  function stagesFromQuery(query) {
    const asked = [];
    for (const raw of [query.stage, query.stages]) {
      if (!raw) continue;
      for (const s of String(raw).split(',')) {
        const v = s.trim();
        if (v && MANUSCRIPT_STAGES.includes(v)) asked.push(v);
      }
    }
    const group = MANUSCRIPT_STAGE_GROUPS.find((g) => g.value === query.group);
    if (!group) return { stages: asked, impossible: false };
    if (!asked.length) return { stages: group.stages, impossible: false };
    const inter = asked.filter((s) => group.stages.includes(s));
    return { stages: inter, impossible: inter.length === 0 };
  }

  // Construit le WHERE partagé par la liste, le compte et l'export.
  // skipStage : pour les compteurs par étape (chaque puce doit afficher son
  // volume sous les AUTRES filtres, pas sous le filtre d'étape courant).
  function buildManuscriptFilter(query = {}, { skipStage = false } = {}) {
    const clauses = [];
    const params = [];

    if (!skipStage) {
      const { stages, impossible } = stagesFromQuery(query);
      if (impossible) {
        clauses.push('1=0');              // famille ∩ étape : aucune étape commune
      } else if (stages.length === 1) {
        clauses.push('m.current_stage = ?'); params.push(stages[0]);
      } else if (stages.length > 1) {
        clauses.push(`m.current_stage IN (${stages.map(() => '?').join(',')})`); params.push(...stages);
      }
    }

    const q = (query.q || '').trim();
    if (q) {
      // Multi-mots : « konate roman » ou « Ndeye Fatou » doivent aboutir.
      // Chaque mot doit matcher un champ (ET entre mots, OU entre champs) ;
      // 6 mots suffisent largement et bornent la taille de la requête.
      const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
      for (const token of tokens) {
        const like = `%${token}%`;
        clauses.push(`(m.title LIKE ? OR m.subtitle LIKE ? OR m.ref LIKE ? OR m.series_title LIKE ?
          OR m.genre LIKE ? OR m.isbn LIKE ? OR a.firstname LIKE ? OR a.lastname LIKE ?
          OR a.email LIKE ? OR a.phone LIKE ?
          OR (a.firstname || ' ' || a.lastname) LIKE ? OR (a.lastname || ' ' || a.firstname) LIKE ?)`);
        params.push(...Array(12).fill(like));
      }
    }

    if (query.genre) { clauses.push('m.genre = ?'); params.push(String(query.genre)); }

    const intervenantId = parseInt(query.intervenant, 10);
    if (Number.isInteger(intervenantId) && intervenantId > 0) {
      const only = CONTACT_COLUMNS[query.metier];
      const cols = only ? [only] : Object.values(CONTACT_COLUMNS);
      clauses.push(`(${cols.map((c) => `m.${c} = ?`).join(' OR ')})`);
      params.push(...cols.map(() => intervenantId));
    }

    const unassigned = UNASSIGNED_COLUMNS[query.unassigned];
    if (unassigned) clauses.push(unassigned.map((c) => `m.${c} IS NULL`).join(' AND '));

    // Doublons confirmés : hors listes et hors compteurs par défaut — ils
    // fausseraient les volumes de pilotage (« 58 à traiter » dont 2 renvois du
    // même texte). `include` les remet, `only` ne montre qu'eux.
    if (query.duplicates === 'only') clauses.push('m.duplicate_of IS NOT NULL');
    else if (query.duplicates !== 'include') clauses.push('m.duplicate_of IS NULL');

    if (query.contract === 'with') clauses.push('m.contract_id IS NOT NULL');
    if (query.contract === 'without') clauses.push('m.contract_id IS NULL');
    if (query.series === 'only') clauses.push('m.series_ref IS NOT NULL');
    if (query.series === 'single') clauses.push('m.series_ref IS NULL');

    const dateCol = query.date_field === 'updated' ? "COALESCE(m.updated_at, m.created_at)" : 'm.created_at';
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.date_from || '')) { clauses.push(`date(${dateCol}) >= ?`); params.push(query.date_from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(query.date_to || ''))   { clauses.push(`date(${dateCol}) <= ?`); params.push(query.date_to); }

    const stale = parseInt(query.stale, 10);
    if (Number.isInteger(stale) && stale > 0) {
      clauses.push(`${DAYS_IN_STAGE_SQL} >= ?`);
      params.push(stale);
    }

    return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
  }

  const MANUSCRIPT_SELECT = `
    SELECT m.*, a.firstname || ' ' || a.lastname AS author_name, a.email AS author_email, a.phone AS author_phone,
           COALESCE(ie.nom, ue.username) AS evaluateur_name,
           COALESCE(ic.nom, uc.username) AS correcteur_name,
           ued.username                  AS editeur_name,
           COALESCE(ip.nom, up.username) AS imprimeur_name,
           dup.ref   AS duplicate_of_ref,
           dup.title AS duplicate_of_title,
           ${STAGE_SINCE_SQL} AS stage_since
      FROM manuscripts m
      JOIN authors a       ON a.id = m.author_id
      LEFT JOIN intervenants ie ON ie.id = m.assigned_evaluator_contact_id
      LEFT JOIN intervenants ic ON ic.id = m.assigned_corrector_contact_id
      LEFT JOIN intervenants ip ON ip.id = m.assigned_printer_contact_id
      LEFT JOIN admin_users  ue ON ue.id = m.assigned_evaluator_id
      LEFT JOIN admin_users  uc ON uc.id = m.assigned_corrector_id
      LEFT JOIN admin_users  up ON up.id = m.assigned_printer_id
      LEFT JOIN admin_users ued ON ued.id = m.assigned_editor_id
      LEFT JOIN manuscripts  dup ON dup.id = m.duplicate_of`;

  const daysSince = (value) => {
    if (!value) return null;
    const ts = Date.parse(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
    if (Number.isNaN(ts)) return null;
    return Math.max(0, Math.floor((Date.now() - ts) / 86400000));
  };

  // Enrichit une ligne pour la liste : ancienneté, acteur qui a la main.
  function describeManuscriptRow(row) {
    const metier = STAGE_OWNER_METIER[row.current_stage] || null;
    const assignee = metier ? row[`${metier}_name`] || null : null;
    return {
      ...describeManuscript(row),
      stage_since: row.stage_since || row.updated_at || row.created_at,
      days_in_stage: daysSince(row.stage_since || row.updated_at || row.created_at),
      days_since_update: daysSince(row.updated_at || row.created_at),
      owner_metier: metier,
      owner_metier_label: metier ? METIER_LABELS[metier] : null,
      assignee_name: assignee,
      has_contract: !!row.contract_id,
    };
  }

  function orderByFor(query) {
    const sort = MANUSCRIPT_SORTS[query.sort] ? query.sort : 'created';
    const asked = String(query.order || '').toUpperCase();
    const dir = asked === 'ASC' || asked === 'DESC' ? asked : MANUSCRIPT_SORT_DIR[sort];
    // m.id en second critère : ordre stable d'une page à l'autre quand deux
    // manuscrits partagent la même date (import du même jour).
    return `${MANUSCRIPT_SORTS[sort].map((c) => `${c} ${dir}`).join(', ')}, m.id DESC`;
  }

  router.get('/manuscripts/v2', auth, (req, res) => {
    const query = req.query || {};
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(200, Math.max(5, parseInt(query.limit, 10) || 25));
    const { where, params } = buildManuscriptFilter(query);

    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM manuscripts m JOIN authors a ON a.id = m.author_id WHERE ${where}`
    ).get(...params).n;
    const pages = Math.max(1, Math.ceil(total / limit));
    const offset = (Math.min(page, pages) - 1) * limit;

    const rows = db.prepare(
      `${MANUSCRIPT_SELECT} WHERE ${where} ORDER BY ${orderByFor(query)} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    // Compteurs par étape sous les autres filtres (puces de la barre d'étapes).
    const bare = buildManuscriptFilter(query, { skipStage: true });
    const counts = db.prepare(
      `SELECT m.current_stage AS stage, COUNT(*) AS n
         FROM manuscripts m JOIN authors a ON a.id = m.author_id
        WHERE ${bare.where} GROUP BY m.current_stage`
    ).all(...bare.params);
    const stageCounts = Object.fromEntries(counts.map((c) => [c.stage, c.n]));

    res.json({
      rows: rows.map(describeManuscriptRow),
      total,
      page: Math.min(page, pages),
      pages,
      limit,
      stage_counts: stageCounts,
      // Volume par famille, dérivé des compteurs d'étapes (aucune requête de plus).
      group_counts: Object.fromEntries(MANUSCRIPT_STAGE_GROUPS.map((g) => [
        g.value, g.stages.reduce((sum, s) => sum + (stageCounts[s] || 0), 0),
      ])),
    });
  });

  // Référentiel des filtres : étapes, familles, genres réellement présents et
  // intervenants affectés — évite au front de deviner ou de tout charger.
  router.get('/manuscripts/v2/filters', auth, (req, res) => {
    const genres = db.prepare(
      "SELECT genre, COUNT(*) AS n FROM manuscripts WHERE genre IS NOT NULL AND genre <> '' GROUP BY genre ORDER BY n DESC"
    ).all();
    let intervenants = [];
    try {
      intervenants = db.prepare(
        `SELECT id, nom, metier FROM intervenants
          WHERE id IN (SELECT assigned_evaluator_contact_id FROM manuscripts WHERE assigned_evaluator_contact_id IS NOT NULL
                       UNION SELECT assigned_corrector_contact_id FROM manuscripts WHERE assigned_corrector_contact_id IS NOT NULL
                       UNION SELECT assigned_infographist_contact_id FROM manuscripts WHERE assigned_infographist_contact_id IS NOT NULL
                       UNION SELECT assigned_printer_contact_id FROM manuscripts WHERE assigned_printer_contact_id IS NOT NULL)
          ORDER BY nom COLLATE NOCASE`
      ).all();
    } catch (e) { void e; }
    res.json({
      stages: MANUSCRIPT_STAGES,
      labels: STAGE_LABELS,
      groups: MANUSCRIPT_STAGE_GROUPS,
      genres,
      intervenants,
      sorts: Object.keys(MANUSCRIPT_SORTS),
    });
  });

  // Export CSV du résultat courant (mêmes filtres, sans pagination).
  // Déclaré avant /manuscripts/v2/:id, sinon « export.csv » serait pris pour un id.
  // editorOnly : le fichier sort de l'application avec les coordonnées des
  // auteurs — même périmètre que l'export des contrats.
  router.get('/manuscripts/v2/export.csv', auth, editorOnly, (req, res) => {
    const { where, params } = buildManuscriptFilter(req.query || {});
    const rows = db.prepare(`${MANUSCRIPT_SELECT} WHERE ${where} ORDER BY ${orderByFor(req.query || {})} LIMIT 5000`)
      .all(...params).map(describeManuscriptRow);
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmt = (d) => (d ? String(d).slice(0, 10) : '');
    const header = ['Réf.', 'Titre', 'Sous-titre', 'Série', 'Tome', 'Auteur', 'Email', 'Téléphone',
      'Genre', 'Étape', 'Acteur', 'Contrat', 'ISBN', 'Reçu le', 'Dernière MAJ', "Jours dans l'étape"];
    const lines = rows.map((m) => [
      m.ref, m.title, m.subtitle || '', m.series_title || '', m.tome_number || '',
      m.author_name, m.author_email || '', m.author_phone || '', m.genre || '', m.stage_label,
      m.assignee_name || '', m.has_contract ? 'oui' : 'non', m.isbn || '',
      fmt(m.created_at), fmt(m.updated_at), m.days_in_stage ?? '',
    ].map(esc).join(';'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manuscrits-${new Date().toISOString().slice(0, 10)}.csv"`);
    // BOM UTF-8 : sans lui Excel affiche « Réf. » en « RÃ©f. ».
    res.send('﻿' + [header.join(';'), ...lines].join('\n'));
  });

  // ─── DOUBLONS ─────────────────────────────────────────────
  // Le barrage de la soumission publique (manuscript-duplicates.js) arrête ce
  // qui est certain ; ce qui reste — e-mail retapé avec une typo, titre commun,
  // dossiers déjà engagés avant la mise en place du barrage — ne peut être
  // tranché que par un humain. Ces trois routes servent cet arbitrage. Rien
  // n'est supprimé : le doublon est relié à l'original et sort des listes.
  // Déclarées avant /manuscripts/v2/:id, sinon « duplicates » passerait pour un id.
  router.get('/manuscripts/v2/duplicates', auth, editorOnly, (req, res) => {
    const includeResolved = req.query?.resolved === '1' || req.query?.resolved === 'true';
    const groups = listDuplicateGroups(db, { includeResolved }).map((g) => ({
      ...g,
      members: g.members.map((m) => ({
        ...m,
        stage_label: STAGE_LABELS[m.current_stage] || m.current_stage,
        author_name: `${m.firstname || ''} ${m.lastname || ''}`.trim(),
      })),
    }));
    res.json({
      groups,
      total: groups.length,
      // Volume ouvert : ce que la pastille de l'écran doit afficher.
      unresolved: groups.filter((g) => !g.resolved).length,
    });
  });

  router.post('/manuscripts/v2/:id/duplicate', auth, editorOnly, csrfProtection, (req, res) => {
    const target = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Manuscrit introuvable' });
    const originalId = parseInt(req.body?.of, 10);
    if (!Number.isInteger(originalId)) return res.status(400).json({ error: 'Manuscrit original manquant' });
    if (originalId === target.id) return res.status(400).json({ error: 'Un manuscrit ne peut pas être son propre doublon' });
    const original = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(originalId);
    if (!original) return res.status(404).json({ error: 'Manuscrit original introuvable' });
    // Interdit la chaîne A→B→C : l'original doit être un vrai original, sinon
    // « doublon de » ne désigne plus rien de stable.
    if (original.duplicate_of) {
      const root = db.prepare('SELECT ref FROM manuscripts WHERE id = ?').get(original.duplicate_of);
      return res.status(409).json({
        error: `${original.ref} est lui-même marqué comme doublon${root ? ` de ${root.ref}` : ''} — désignez l'original.`,
      });
    }
    // Un manuscrit qui a déjà des doublons rattachés est un original : le
    // marquer à son tour laisserait ses copies orphelines.
    const attached = db.prepare('SELECT COUNT(*) AS n FROM manuscripts WHERE duplicate_of = ?').get(target.id).n;
    if (attached) {
      return res.status(409).json({ error: `${target.ref} est l'original de ${attached} doublon(s) — détachez-les d'abord.` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    db.transaction(() => {
      db.prepare("UPDATE manuscripts SET duplicate_of = ?, duplicate_marked_at = datetime('now'), duplicate_marked_by = ?, updated_at = datetime('now') WHERE id = ?")
        .run(original.id, req.admin.username || null, target.id);
      logManuscriptEvent(db, target.id, 'duplicate_marked', actor,
        `Doublon de ${original.ref} — « ${original.title} »${req.body?.reason ? ` (${String(req.body.reason).slice(0, 200)})` : ''}`);
      // Trace aussi sur l'original : sa frise doit dire qu'un renvoi a eu lieu.
      logManuscriptEvent(db, original.id, 'duplicate_marked', actor,
        `${target.ref} identifié comme doublon de ce manuscrit`);
    })();
    res.json({ success: true, duplicate_of: original.id, original_ref: original.ref });
  });

  router.delete('/manuscripts/v2/:id/duplicate', auth, editorOnly, csrfProtection, (req, res) => {
    const target = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!target.duplicate_of) return res.status(409).json({ error: "Ce manuscrit n'est pas marqué comme doublon" });
    const original = db.prepare('SELECT ref FROM manuscripts WHERE id = ?').get(target.duplicate_of);
    db.prepare("UPDATE manuscripts SET duplicate_of = NULL, duplicate_marked_at = NULL, duplicate_marked_by = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(target.id);
    logManuscriptEvent(db, target.id, 'duplicate_unmarked',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      original ? `N'est plus considéré comme doublon de ${original.ref}` : null);
    res.json({ success: true });
  });

  // Suppression définitive d'un doublon marqué (voir deleteDuplicateManuscript
  // pour les garde-fous). Motif facultatif, repris dans la frise de l'original.
  router.delete('/manuscripts/v2/:id', auth, editorOnly, csrfProtection, (req, res) => {
    const target = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Manuscrit introuvable' });
    const blockers = duplicateDeletionBlockers(db, target);
    if (blockers.length) {
      return res.status(409).json({ error: `Suppression impossible : ${blockers.join(' ; ')}.`, blockers });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    try {
      const result = deleteDuplicateManuscript(db, target, {
        manuscriptsDir: MANUSCRIPTS_DIR,
        actor,
        reason: String(req.body?.reason || '').trim().slice(0, 200),
        logEvent: logManuscriptEvent,
      });
      console.log(`[DOUBLONS] ${target.ref} supprimé par ${req.admin.username} (original ${result.original?.ref}) → ${result.trashDir}`);
      res.json({ success: true, ref: target.ref, original_id: result.original?.id, original_ref: result.original?.ref });
    } catch (err) {
      console.error('[DOUBLONS] suppression échouée:', err.message);
      res.status(500).json({ error: 'La suppression a échoué — rien n\'a été effacé en base' });
    }
  });

  router.get('/manuscripts/v2/stages', auth, (req, res) => {
    res.json({ stages: MANUSCRIPT_STAGES, labels: STAGE_LABELS, groups: MANUSCRIPT_STAGE_GROUPS });
  });

  router.get('/manuscripts/v2/:id', auth, async (req, res) => {
    const manuscript = db.prepare(
      `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name, a.email AS author_email, a.phone AS author_phone
       FROM manuscripts m JOIN authors a ON a.id = m.author_id WHERE m.id = ?`
    ).get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });

    // Résout les ids d'assignation en noms lisibles (pour l'affichage du panneau).
    //  - colonnes *_id          → admin_users (éditeur interne + historique)
    //  - colonnes *_contact_id  → carnet d'intervenants (acteurs externes)
    const adminCols = ['assigned_evaluator_id', 'assigned_corrector_id', 'assigned_editor_id', 'assigned_infographist_id', 'assigned_printer_id'];
    const adminIds = [...new Set(adminCols.map((c) => manuscript[c]).filter(Boolean))];
    if (adminIds.length) {
      const rows = db.prepare(`SELECT id, username FROM admin_users WHERE id IN (${adminIds.map(() => '?').join(',')})`).all(...adminIds);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.username]));
      for (const c of adminCols) {
        manuscript[`${c}_name`] = manuscript[c] ? (byId[manuscript[c]] || `#${manuscript[c]}`) : null;
      }
    }
    const contactCols = ['assigned_evaluator_contact_id', 'assigned_corrector_contact_id', 'assigned_infographist_contact_id', 'assigned_printer_contact_id'];
    const contactIds = [...new Set(contactCols.map((c) => manuscript[c]).filter(Boolean))];
    if (contactIds.length) {
      const rows = db.prepare(`SELECT id, nom FROM intervenants WHERE id IN (${contactIds.map(() => '?').join(',')})`).all(...contactIds);
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.nom]));
      for (const c of contactCols) {
        manuscript[`${c}_name`] = manuscript[c] ? (byId[manuscript[c]] || `#${manuscript[c]}`) : null;
      }
    }

    const files = db.prepare('SELECT * FROM manuscript_files WHERE manuscript_id = ? ORDER BY uploaded_at ASC').all(manuscript.id);
    const stages = db.prepare('SELECT * FROM manuscript_stages WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    const evaluations = db.prepare('SELECT * FROM manuscript_evaluations WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    const validations = db.prepare('SELECT * FROM manuscript_validations WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);

    // Doublons : l'original dont ce manuscrit est la copie, et les copies
    // rattachées à celui-ci — de quoi afficher le bandeau dans les deux sens.
    manuscript.duplicate_of_ref = null;
    manuscript.duplicate_of_title = null;
    if (manuscript.duplicate_of) {
      const orig = db.prepare('SELECT ref, title FROM manuscripts WHERE id = ?').get(manuscript.duplicate_of);
      if (orig) { manuscript.duplicate_of_ref = orig.ref; manuscript.duplicate_of_title = orig.title; }
    }
    const duplicates = db.prepare(
      "SELECT id, ref, title, current_stage, created_at, duplicate_marked_at FROM manuscripts WHERE duplicate_of = ? ORDER BY created_at"
    ).all(manuscript.id).map((d) => ({ ...d, stage_label: STAGE_LABELS[d.current_stage] || d.current_stage }));

    // ─── RÉSUMÉ AUTEUR ────────────────────────────────────────
    // La fiche ne montrait qu'un nom et un e-mail : impossible de savoir, sans
    // quitter l'écran, que l'auteur du manuscrit en cours a déjà deux autres
    // dossiers chez nous — dont un en attente de paiement. On assemble ici, en
    // SQLite seul (aucune dépendance à Dolibarr : la fiche doit rester
    // consultable même Dolibarr éteint), de quoi situer la personne.
    // Réservé aux pilotes du dossier : un évaluateur ou un correcteur affecté
    // n'a pas à connaître le reste du portefeuille de l'auteur ni l'état de son
    // compte. Les autres rôles reçoivent author:null et la carte ne s'affiche pas.
    let authorSummary = null;
    try {
      if (!['super_admin', 'admin', 'editor', 'production'].includes(req.admin?.role)) throw new Error('skip');
      const a = db.prepare(
        `SELECT id, firstname, lastname, display_name, email, phone, bio, photo_url, slug,
                public_listed, created_at, dolibarr_thirdparty_id,
                (password IS NOT NULL AND password <> '') AS has_account
           FROM authors WHERE id = ?`
      ).get(manuscript.author_id);
      if (a) {
        // Les autres dossiers de l'auteur, celui-ci exclu : c'est l'information
        // qui manquait le plus (antériorité, dossier déjà engagé, renvoi).
        const others = db.prepare(
          `SELECT m.id, m.ref, m.title, m.current_stage, m.created_at, m.duplicate_of,
                  m.contract_id, dup.ref AS duplicate_of_ref
             FROM manuscripts m
             LEFT JOIN manuscripts dup ON dup.id = m.duplicate_of
            WHERE m.author_id = ? AND m.id <> ?
            ORDER BY m.created_at DESC LIMIT 20`
        ).all(a.id, manuscript.id).map((m) => ({
          ...m,
          stage_label: STAGE_LABELS[m.current_stage] || m.current_stage,
          group: (MANUSCRIPT_STAGE_GROUPS.find((g) => g.stages.includes(m.current_stage)) || {}).value || null,
        }));

        // Volumes par famille d'étapes — mêmes familles que les puces de la vue
        // globale, pour que « Production 2 » veuille dire la même chose partout.
        const all = [...others, { current_stage: manuscript.current_stage, duplicate_of: manuscript.duplicate_of }];
        const byGroup = {};
        for (const g of MANUSCRIPT_STAGE_GROUPS) {
          byGroup[g.value] = all.filter((m) => !m.duplicate_of && g.stages.includes(m.current_stage)).length;
        }

        let booksCount = 0;
        try {
          booksCount = db.prepare('SELECT COUNT(*) AS n FROM book_authors WHERE author_id = ?').get(a.id).n;
        } catch (e) { void e; /* table absente sur d'anciennes bases */ }

        // Homonymes : une même personne revient parfois avec un e-mail retapé
        // (typo), ce qui crée une seconde fiche auteur et casse tout l'historique.
        // On les signale ici — c'est le pendant, côté auteur, de l'écran doublons.
        const wanted = normalizePerson(a.firstname, a.lastname);
        const namesakes = wanted
          ? db.prepare('SELECT id, firstname, lastname, email FROM authors WHERE id <> ?').all(a.id)
              .filter((o) => normalizePerson(o.firstname, o.lastname) === wanted)
              .slice(0, 5)
              .map((o) => ({ id: o.id, email: o.email, name: `${o.firstname || ''} ${o.lastname || ''}`.trim() }))
          : [];

        authorSummary = {
          ...a,
          has_account: !!a.has_account,
          // Biographie transmise AVEC ce manuscrit (champ obligatoire du
          // formulaire) : elle n'était affichée nulle part.
          submitted_biography: manuscript.biography || null,
          manuscripts_total: all.length,
          manuscripts_by_group: byGroup,
          contracts_count: others.filter((m) => m.contract_id).length + (manuscript.contract_id ? 1 : 0),
          books_count: booksCount,
          other_manuscripts: others,
          namesakes,
        };
      }
    } catch (err) {
      if (err.message !== 'skip') console.warn('[WORKFLOW] résumé auteur:', err.message);
    }

    // Tomes frères (même série) pour le bandeau de navigation entre tomes.
    let series = null;
    if (manuscript.series_ref) {
      series = db.prepare(
        `SELECT id, ref, title, tome_number, tome_total, current_stage
         FROM manuscripts WHERE series_ref = ? ORDER BY tome_number ASC, id ASC`
      ).all(manuscript.series_ref)
        .map((s) => ({ ...s, stage_label: STAGE_LABELS[s.current_stage] || s.current_stage }));
    }

    // Résumé du contrat lié (+ devis) pour la carte « Contrat & Devis ».
    let contract = null;
    if (manuscript.contract_id && hooks.getContractSummary) {
      try { contract = await hooks.getContractSummary(manuscript.contract_id); }
      catch (e) { console.warn('[WORKFLOW] contract summary error:', e.message); }
    }

    res.json({
      manuscript: describeManuscript(manuscript),
      // kind_label : la fiche affichait le code brut (« production_cover »).
      files: files.map((f) => ({ ...f, kind_label: fileKindLabel(f.kind) })),
      stages: stages.map((s) => ({
        ...s,
        stage_label: s.event
          ? (MANUSCRIPT_EVENTS[s.event]?.label || s.event)
          : (STAGE_LABELS[s.to_stage] || s.to_stage),
      })),
      evaluations,
      validations,
      series,
      contract,
      duplicates,
      author: authorSummary,
      // Lien de dépôt auteur encore actif (demande de révision en cours), pour
      // l'affichage sur la carte « Fichier manuscrit ».
      deposit_request: getActiveDepositToken(db, manuscript.id) || null,
    });
  });

  // ─── CONTRAT : créer / rattacher depuis la fiche manuscrit ───
  // Crée un contrat brouillon Dolibarr lié au manuscrit (auto-création réparée).
  router.post('/manuscripts/v2/:id/create-contract', auth, editorOnly, csrfProtection, async (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.contract_id) return res.status(409).json({ error: 'Un contrat est déjà rattaché à ce manuscrit' });
    if (!hooks.onCreateContract) return res.status(503).json({ error: 'Création de contrat indisponible' });
    try {
      const result = await hooks.onCreateContract(manuscript);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[WORKFLOW] create-contract error:', err.message);
      res.status(502).json({ error: err.message || 'Échec de la création du contrat' });
    }
  });

  // Rattache un contrat Dolibarr EXISTANT (créé à part) au manuscrit.
  router.post('/manuscripts/v2/:id/link-contract', auth, editorOnly, csrfProtection, async (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.contract_id) return res.status(409).json({ error: 'Un contrat est déjà rattaché à ce manuscrit' });
    const contractId = parseInt(req.body?.contract_id, 10);
    if (!contractId) return res.status(400).json({ error: 'Contrat à rattacher requis' });
    if (!hooks.onLinkContract) return res.status(503).json({ error: 'Rattachement indisponible' });
    try {
      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      const result = await hooks.onLinkContract(manuscript, contractId, actor);
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[WORKFLOW] link-contract error:', err.message);
      res.status(400).json({ error: err.message || 'Échec du rattachement' });
    }
  });

  // ─── MANUSCRITS ASSIGNÉS (dashboard par rôle) ────────────
  router.get('/manuscripts/assigned', auth, (req, res) => {
    // super_admin/admin/editor n'utilisent pas cet endpoint
    if (!METIER_ASSIGN_COLUMNS[req.admin.role]) return res.json([]);
    const scope = myAssignmentsClause(req.admin);
    const rows = db.prepare(
      `SELECT m.id, m.ref, m.title, m.subtitle, m.current_stage, m.created_at, m.updated_at,
              a.firstname || ' ' || a.lastname AS author_name
       FROM manuscripts m JOIN authors a ON a.id = m.author_id
       WHERE ${scope.clause} ORDER BY m.updated_at DESC`
    ).all(...scope.params);
    res.json(rows.map(describeManuscript));
  });

  router.get('/manuscripts/v2/:id/files/:fileId/download', auth, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript || !roleCanAccessManuscript(req.admin, manuscript, db)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const file = db.prepare('SELECT * FROM manuscript_files WHERE id = ? AND manuscript_id = ?').get(req.params.fileId, req.params.id);
    if (!file) return res.status(404).json({ error: 'Fichier introuvable' });
    // Dépôt par lien externe (> 20 Mo) : pas de fichier local, on redirige.
    if (file.external_url) return res.redirect(file.external_url);
    // Version intermédiaire dont le binaire a été purgé par la rétention :
    // la ligne (métadonnées + empreinte) reste, le fichier n'existe plus.
    if (file.binary_purged) {
      return res.status(410).json({ error: 'Version archivée : le fichier a été purgé par la rétention (seules la première version, les plus récentes et les jalons restent téléchargeables).' });
    }
    if (!existsSync(file.file_path)) return res.status(404).json({ error: 'Fichier introuvable sur le serveur' });
    res.download(file.file_path, file.file_name);
  });

  // ─── ASSIGNATION ─────────────────────────────────────────
  // Les 4 acteurs externes sont affectés depuis le carnet d'intervenants
  // (colonnes *_contact_id) ; l'éditeur interne reste un compte admin_users.
  router.post('/manuscripts/v2/:id/assign', auth, editorOnly, csrfProtection, (req, res) => {
    const { role, user_id, apply_to_series } = req.body;
    const contactColMap = {
      evaluateur: 'assigned_evaluator_contact_id',
      correcteur: 'assigned_corrector_contact_id',
      infographiste: 'assigned_infographist_contact_id',
      imprimeur: 'assigned_printer_contact_id',
    };
    const isContactRole = !!contactColMap[role];
    const col = isContactRole ? contactColMap[role] : (role === 'editor' ? 'assigned_editor_id' : null);
    if (!col) return res.status(400).json({ error: 'Rôle invalide' });

    // Validation de la cible selon la source (carnet d'intervenants ou comptes internes).
    if (user_id) {
      if (isContactRole) {
        const target = db.prepare('SELECT id, metier, is_active FROM intervenants WHERE id = ?').get(user_id);
        if (!target) return res.status(404).json({ error: 'Intervenant introuvable' });
        if (target.metier !== role) return res.status(400).json({ error: `Cet intervenant n'est pas un ${role}` });
        if (!target.is_active) return res.status(400).json({ error: 'Intervenant désactivé' });
      } else {
        const target = db.prepare('SELECT id, role FROM admin_users WHERE id = ?').get(user_id);
        if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
        // Production éditoriale = service fusionné Éditeur + Infographiste :
        // un compte `production` est un responsable valide (aligné sur le
        // dropdown by-role et la route to-editorial, qui l'acceptent déjà).
        if (!['super_admin', 'admin', 'editor', 'production'].includes(target.role)) {
          return res.status(400).json({ error: 'Utilisateur invalide pour piloter la production éditoriale' });
        }
      }
    }

    const baseManuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!baseManuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });

    // Cibles : le manuscrit seul, ou tous les tomes de la série si demandé.
    const targets = (apply_to_series && baseManuscript.series_ref)
      ? db.prepare('SELECT * FROM manuscripts WHERE series_ref = ? ORDER BY tome_number ASC, id ASC').all(baseManuscript.series_ref)
      : [baseManuscript];

    // Résout {email,label} d'un id selon la source (carnet ou admin_users).
    const resolveRecipient = (id) => {
      if (!id) return null;
      if (isContactRole) {
        const r = db.prepare('SELECT nom, email FROM intervenants WHERE id = ?').get(id);
        return r?.email ? { email: r.email, label: r.nom } : null;
      }
      const r = db.prepare('SELECT username, email FROM admin_users WHERE id = ?').get(id);
      return r?.email ? { email: r.email, label: r.username } : null;
    };

    const ROLE_LABELS = {
      evaluateur: 'Évaluateur', correcteur: 'Correcteur', infographiste: 'Infographiste',
      imprimeur: 'Imprimeur', editor: 'Éditeur de production',
    };
    const roleLabel = ROLE_LABELS[role] || role;
    const wfActor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };

    // Applique l'assignation à un manuscrit + ses effets de bord (notifications,
    // transition auto évaluateur). Renvoie true si auto-transition déclenchée.
    const assignOne = (msId) => {
      const before = db.prepare(`SELECT ${col} AS prev_id FROM manuscripts WHERE id = ?`).get(msId);
      db.prepare(`UPDATE manuscripts SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(user_id || null, msId);
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(msId);

      // Notifier l'ancien assigné de son retrait (si changement) + tracer la frise.
      if (before?.prev_id && before.prev_id !== user_id) {
        try {
          const prev = resolveRecipient(before.prev_id);
          if (prev) sendAssignmentEmail(transporter, manuscript, role, prev, siteUrl, 'unassigned');
          logManuscriptEvent(db, msId, 'intervenant_unassigned', wfActor,
            `${roleLabel} retiré : ${prev?.label || '#' + before.prev_id}`);
          // Révoque ses liens de téléchargement encore actifs : un intervenant
          // retiré du dossier ne doit plus pouvoir récupérer le manuscrit.
          if (isContactRole) {
            const revoked = revokeFileTokens(db, { manuscriptId: msId, intervenantId: before.prev_id });
            if (revoked > 0) console.log(`[FILES] ${revoked} lien(s) de téléchargement révoqué(s) (intervenant #${before.prev_id}, manuscrit #${msId})`);
          }
        } catch (err) { console.warn('[WORKFLOW] previous assignee notify error:', err.message); }
      }

      // L'évaluateur affecté sur un manuscrit « submitted » déclenche la transition
      // auto vers in_evaluation : l'email de tâche (avec lien) part alors via notifyTransition.
      const willAutoTransition = role === 'evaluateur' && user_id && manuscript.current_stage === 'submitted';
      // Le manuscrit est-il DÉJÀ à l'étape où ce métier travaille ? (remplacement
      // d'intervenant en cours d'étape, ou affectation tardive)
      const alreadyAtTaskStage = isContactRole
        && (METIER_TASK_STAGES[role] || []).includes(manuscript.current_stage);
      if (user_id && before?.prev_id !== user_id && !willAutoTransition) {
        try {
          if (alreadyAtTaskStage) {
            // Aucune transition ne sera rejouée : l'email d'affectation seul
            // laissait le nouvel intervenant sans fichier NI lien (et lui
            // annonçait un travail « dès que le manuscrit atteindra l'étape »
            // alors qu'il y est déjà). On lui envoie directement le dossier.
            const intervenant = db.prepare('SELECT id, nom, email, metier FROM intervenants WHERE id = ?').get(user_id);
            if (intervenant?.email) {
              notifyIntervenantTask(db, transporter, {
                manuscript, toStage: manuscript.current_stage, intervenant, siteUrl,
                actor: wfActor, noteSuffix: ' (affectation en cours d\'étape)',
              });
            }
          } else {
            const next = resolveRecipient(user_id);
            if (next) {
              // Trace l'annonce d'affectation dans la frise, APRÈS confirmation
              // SMTP (même règle que les emails auteur) : sans elle, un
              // intervenant qui dit « je n'ai rien reçu » était invérifiable —
              // seul le journal système en gardait la trace.
              const taskStage = (METIER_TASK_STAGES[role] || [])[0];
              const whenLabel = taskStage ? ` — dossier transmis à l'étape « ${STAGE_LABELS[taskStage] || taskStage} »` : '';
              sendAssignmentEmail(transporter, manuscript, role, next, siteUrl, 'assigned')
                .then((info) => {
                  if (!info) return;
                  try {
                    logManuscriptEvent(db, msId, 'email_sent', wfActor,
                      `Affectation ${roleLabel.toLowerCase()} → ${next.label} (${next.email})${whenLabel}`);
                  } catch (e) { console.warn('[WORKFLOW] log email_sent (affectation) warning:', e.message); }
                });
            }
          }
          // Cas auto-transition évaluateur exclu : la transition « En évaluation »
          // trace déjà l'affectation, inutile de la dédoubler.
          logManuscriptEvent(db, msId, 'intervenant_assigned', wfActor,
            `${roleLabel} : ${resolveRecipient(user_id)?.label || '#' + user_id}`);
        } catch (err) { console.warn('[WORKFLOW] new assignee notify error:', err.message); }
      }

      if (willAutoTransition) {
        const updated = transition(db, manuscript.id, 'in_evaluation',
          { role: req.admin.role, id: req.admin.id, label: req.admin.username },
          { note: `Assignation évaluateur (intervenant #${user_id})` });
        notifyTransition(db, transporter, updated, 'in_evaluation',
          { role: req.admin.role, id: req.admin.id, label: req.admin.username }, siteUrl);
        return true;
      }
      return false;
    };

    let autoTransitioned = 0;
    for (const ms of targets) {
      if (assignOne(ms.id)) autoTransitioned += 1;
    }

    res.json({
      success: true,
      count: targets.length,
      autoTransitioned,
      ...(targets.length === 1 && autoTransitioned ? { stage: 'in_evaluation' } : {}),
    });
  });

  // Transition générique (éditeur / admin / super_admin)
  // SANS bypass : le flag `force` du body n'est plus honoré ici — un editor
  // pouvait contourner toute la machine à états (sauter paiement, BAT, etc.)
  // sans motif ni trace spécifique. Le SEUL chemin de contournement est
  // /override-stage ci-dessous : admins uniquement + motif obligatoire.
  router.post('/manuscripts/v2/:id/transition', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Réservé à l\'éditeur ou l\'administrateur' });
    }
    const { to_stage, note } = req.body;
    try {
      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      const updated = transition(db, req.params.id, to_stage, actor, { note: note || null });
      notifyTransition(db, transporter, updated, to_stage, actor, siteUrl);
      res.json({ success: true, manuscript: describeManuscript(updated) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Correction manuelle de l'état (super_admin / admin uniquement).
  // Réservée aux ERREURS MATÉRIELLES : ex. un manuscrit rejeté par erreur qu'il
  // faut « débloquer », ou un mauvais état saisi. Contourne la machine à états
  // (force) pour atteindre N'IMPORTE quel état — y compris depuis un état terminal
  // (Rejeté / Imprimé). Contrairement à la transition normale :
  //   • un MOTIF est obligatoire (tracé dans la frise) ;
  //   • les emails ne partent QUE si la correction fait avancer le dossier
  //     (cf. `avance` plus bas) : remettre un manuscrit rejeté par erreur en
  //     « Évaluation favorable » doit saisir le comptable et l'auteur ; rectifier
  //     un état saisi trop loin ne doit relancer personne.
  router.post('/manuscripts/v2/:id/override-stage', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Correction de l\'état réservée aux administrateurs' });
    }
    const { to_stage } = req.body || {};
    const reason = String(req.body?.reason || '').trim();
    if (!MANUSCRIPT_STAGES.includes(to_stage)) {
      return res.status(400).json({ error: 'État cible invalide' });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Motif de la correction requis (erreur constatée)' });
    }
    const current = db.prepare('SELECT current_stage FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (current.current_stage === to_stage) {
      return res.status(400).json({ error: 'Le manuscrit est déjà à cet état' });
    }
    try {
      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      const fromLabel = STAGE_LABELS[current.current_stage] || current.current_stage;
      const toLabel = STAGE_LABELS[to_stage] || to_stage;
      const updated = transition(db, req.params.id, to_stage, actor, {
        force: true,
        note: `Correction manuelle de l'état : ${fromLabel} → ${toLabel}. Motif : ${reason}`,
      });
      // Une correction qui fait AVANCER le dossier n'est pas qu'un ajustement de
      // registre : l'étape est réellement atteinte pour la première fois et ceux
      // qui attendent doivent l'apprendre (cas typique : un manuscrit rejeté par
      // erreur remis en « Évaluation favorable » — sans cela le comptable n'est
      // jamais saisi et le devis ne part pas). Une correction en ARRIÈRE reste
      // muette : elle rectifie un état saisi à tort, personne n'a à être relancé.
      const avance = MANUSCRIPT_STAGES.indexOf(to_stage) > MANUSCRIPT_STAGES.indexOf(current.current_stage);
      if (avance) {
        try {
          notifyTransition(db, transporter, updated, to_stage, actor, siteUrl);
        } catch (err) {
          console.warn('[MANUSCRIPT] override-stage notify error:', err.message);
        }
      }
      res.json({ success: true, manuscript: describeManuscript(updated), notified: avance });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Micro-corrections de la fiche (titre, sous-titre, genre, synopsis) —
  // typiquement une faute de frappe de l'auteur. Ne touche PAS au fichier du
  // manuscrit ni au stage : on corrige la forme, pas le fond. Chaque champ
  // modifié est tracé dans la frise (ancienne → nouvelle valeur), aucun email.
  router.put('/manuscripts/v2/:id/details', auth, editorOnly, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });

    const EDITABLE = { title: 'Titre', subtitle: 'Sous-titre', genre: 'Genre', synopsis: 'Synopsis' };
    const clip = (v) => {
      const s = String(v ?? '').trim();
      return s.length > 120 ? s.slice(0, 117) + '…' : (s || '—');
    };
    const cols = [];
    const values = [];
    const changes = [];
    for (const [col, label] of Object.entries(EDITABLE)) {
      if (!(col in (req.body || {}))) continue; // champ non soumis = inchangé
      const next = String(req.body[col] ?? '').trim() || null;
      if (col === 'title' && !next) return res.status(400).json({ error: 'Le titre ne peut pas être vide' });
      if ((manuscript[col] || null) === next) continue;
      cols.push(`${col} = ?`);
      values.push(next);
      changes.push(`${label} : « ${clip(manuscript[col])} » → « ${clip(next)} »`);
    }
    if (!cols.length) return res.status(400).json({ error: 'Aucune modification' });

    db.prepare(`UPDATE manuscripts SET ${cols.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...values, manuscript.id);
    logManuscriptEvent(db, manuscript.id, 'details_updated',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      changes.join(' · '));

    const updated = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(manuscript.id);
    res.json({ success: true, manuscript: describeManuscript(updated) });
  });

  // ─── VERSIONNAGE DU FICHIER MANUSCRIT ─────────────────────
  // Dépôt d'une nouvelle version du texte par l'administration — possible à
  // N'IMPORTE QUELLE étape du workflow : les allers-retours direction ↔ auteur
  // ne sont pas alignés sur la machine à états (une version révisée peut
  // arriver par email pendant l'évaluation comme pendant la correction).
  // Seul verrou : la version définitive arrêtée (à déverrouiller d'abord).
  router.post('/manuscripts/v2/:id/manuscript-version',
    auth, editorOnly, csrfProtection,
    multerFor('original').single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Fichier requis (PDF, DOC, DOCX, ODT ou RTF — max 20 Mo)' });
      const cleanup = () => { try { unlinkSync(req.file.path); } catch (e) { void e; } };
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
      if (!manuscript) { cleanup(); return res.status(404).json({ error: 'Manuscrit introuvable' }); }
      const final = getFinalVersion(db, manuscript.id, 'original');
      if (final) {
        cleanup();
        return res.status(409).json({ error: `La version définitive (v${final.version}) est arrêtée : déverrouillez-la avant de déposer une nouvelle version.` });
      }
      const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
      try {
        const result = addManuscriptVersion(db, {
          manuscriptId: manuscript.id,
          file: req.file,
          actor: { role: req.admin.role, id: req.admin.id, label: req.admin.username },
          uploadedByRole: req.admin.role,
          uploadedById: req.admin.id,
          note,
          eventNote: (v) => `Manuscrit v${v} déposé par l'administration — ${req.file.originalname}${note ? ` · ${note}` : ''}`,
        });
        res.json({ success: true, version: result.version });
      } catch (err) {
        if (err.code === 'DUPLICATE_VERSION') return res.status(409).json({ error: err.message });
        console.error('[VERSIONS] admin upload error:', err.message);
        cleanup();
        res.status(500).json({ error: 'Erreur lors du dépôt de la version' });
      }
    });

  // Demande de révision à l'auteur : envoie un lien de dépôt tokenisé (sans
  // connexion) où l'auteur télécharge la version courante et dépose la révisée.
  // Un seul lien vivant à la fois (le nouveau révoque l'ancien).
  router.post('/manuscripts/v2/:id/request-author-revision', auth, editorOnly, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    const final = getFinalVersion(db, manuscript.id, 'original');
    if (final) {
      return res.status(409).json({ error: `La version définitive (v${final.version}) est arrêtée : plus de révision possible sans déverrouillage.` });
    }
    const author = db.prepare('SELECT id, email, firstname, lastname FROM authors WHERE id = ?').get(manuscript.author_id);
    if (!author?.email) return res.status(400).json({ error: 'L\'auteur n\'a pas d\'adresse email' });
    const message = String(req.body?.message || '').trim().slice(0, 2000) || null;
    const ttlDays = 14;
    const token = createDepositToken(db, {
      manuscriptId: manuscript.id, createdById: req.admin.id, message, ttlDays,
    });
    const depositUrl = `${siteUrl || ''}/manuscrit/depot/${token}`;
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    logManuscriptEvent(db, manuscript.id, 'revision_requested', actor,
      message ? `Message à l'auteur : ${message.length > 180 ? message.slice(0, 177) + '…' : message}` : 'Lien de dépôt envoyé à l\'auteur');
    // Frise « e-mail envoyé » écrite après confirmation SMTP (même règle que
    // notifyTransition : pas de trace d'envoi si le SMTP a échoué).
    sendAuthorRevisionRequestEmail(transporter, manuscript, author, { depositUrl, message, ttlDays })
      .then((info) => {
        if (!info) return;
        try {
          logManuscriptEvent(db, manuscript.id, 'email_sent', actor,
            `Demande de révision → auteur (${author.email})`);
        } catch (e) { console.warn('[VERSIONS] log email_sent warning:', e.message); }
      });
    res.json({ success: true, expires_days: ttlDays, deposit_request: getActiveDepositToken(db, manuscript.id) });
  });

  // Marque une version du texte comme DÉFINITIVE : la chaîne est verrouillée
  // (plus aucun dépôt admin ou auteur), les liens de dépôt actifs sont révoqués.
  // C'est ce fichier qui part en production. Admins uniquement.
  router.post('/manuscripts/v2/:id/files/:fileId/final', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Marquage de la version définitive réservé aux administrateurs' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    const file = db.prepare('SELECT * FROM manuscript_files WHERE id = ? AND manuscript_id = ?')
      .get(req.params.fileId, manuscript.id);
    if (!file) return res.status(404).json({ error: 'Fichier introuvable' });
    if (file.kind !== 'original') {
      return res.status(400).json({ error: 'Seule une version du texte du manuscrit peut être marquée définitive' });
    }
    if (file.binary_purged) {
      return res.status(400).json({ error: 'Cette version a été purgée par la rétention : son fichier n\'existe plus' });
    }
    db.transaction(() => {
      db.prepare(`UPDATE manuscript_files SET is_final = 0 WHERE manuscript_id = ? AND kind = 'original'`).run(manuscript.id);
      db.prepare('UPDATE manuscript_files SET is_final = 1 WHERE id = ?').run(file.id);
    })();
    const revoked = revokeDepositTokens(db, manuscript.id);
    if (revoked) console.log(`[VERSIONS] ${revoked} lien(s) de dépôt révoqué(s) (version définitive, manuscrit #${manuscript.id})`);
    logManuscriptEvent(db, manuscript.id, 'file_final_marked',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      `v${file.version} — ${file.file_name}`);
    res.json({ success: true });
  });

  // Déverrouille la version définitive (motif obligatoire, tracé) pour rouvrir
  // les dépôts — ex. une coquille découverte après l'arrêt du texte.
  router.delete('/manuscripts/v2/:id/files/:fileId/final', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Déverrouillage réservé aux administrateurs' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'Motif du déverrouillage requis' });
    const file = db.prepare('SELECT * FROM manuscript_files WHERE id = ? AND manuscript_id = ? AND is_final = 1')
      .get(req.params.fileId, req.params.id);
    if (!file) return res.status(404).json({ error: 'Version définitive introuvable' });
    db.prepare('UPDATE manuscript_files SET is_final = 0 WHERE id = ?').run(file.id);
    logManuscriptEvent(db, file.manuscript_id, 'file_final_unlocked',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      `v${file.version} — motif : ${reason}`);
    res.json({ success: true });
  });

  // Marque/démarque une version comme JALON : protégée de la purge de rétention
  // (ex. la version évaluée par le comité, la version corrigée validée).
  router.post('/manuscripts/v2/:id/files/:fileId/milestone', auth, editorOnly, csrfProtection, (req, res) => {
    const file = db.prepare('SELECT * FROM manuscript_files WHERE id = ? AND manuscript_id = ?')
      .get(req.params.fileId, req.params.id);
    if (!file) return res.status(404).json({ error: 'Fichier introuvable' });
    const flag = req.body?.is_milestone ? 1 : 0;
    if (flag && file.binary_purged) {
      return res.status(400).json({ error: 'Cette version a déjà été purgée : impossible de la marquer jalon' });
    }
    db.prepare('UPDATE manuscript_files SET is_milestone = ? WHERE id = ?').run(flag, file.id);
    logManuscriptEvent(db, file.manuscript_id, 'file_milestone',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      `v${file.version} ${flag ? 'marquée jalon (protégée de la purge)' : 'retirée des jalons'} — ${file.file_name}`);
    res.json({ success: true });
  });

  // ─── ÉVALUATIONS ─────────────────────────────────────────
  router.get('/evaluations', auth, (req, res) => {
    let sql = `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
               FROM manuscripts m JOIN authors a ON a.id = m.author_id
               WHERE m.current_stage = 'in_evaluation'`;
    const params = [];
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      const scope = myAssignmentsClause(req.admin);
      sql += ` AND ${scope.clause}`;
      params.push(...scope.params);
    }
    sql += ' ORDER BY m.created_at ASC';
    res.json(db.prepare(sql).all(...params).map(describeManuscript));
  });

  router.post('/evaluations/:manuscriptId',
    auth,
    csrfProtection,
    multerFor('evaluation_report').single('report'),
    async (req, res) => {
      const { verdict, recommendation, strengths, weaknesses, note } = req.body;
      if (!['positive', 'rework', 'negative'].includes(verdict)) {
        return res.status(400).json({ error: 'Verdict invalide' });
      }
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
      if (manuscript.current_stage !== 'in_evaluation') {
        return res.status(400).json({ error: `Évaluation impossible au stade ${manuscript.current_stage}` });
      }

      db.prepare(
        `INSERT INTO manuscript_evaluations (manuscript_id, evaluator_id, verdict, recommendation, strengths, weaknesses, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(manuscript.id, req.admin.id, verdict, recommendation || null, strengths || null, weaknesses || null, note || null);

      if (req.file) {
        db.prepare(
          `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
           VALUES (?, 'evaluation_report', 1, ?, ?, ?, ?, ?, ?)`
        ).run(manuscript.id, req.file.path, req.file.originalname, req.file.size || null, req.file.mimetype || null, req.admin.role, req.admin.id);
        logManuscriptEvent(db, manuscript.id, 'file_uploaded',
          { role: req.admin.role, id: req.admin.id, label: req.admin.username },
          `Rapport de lecture — ${req.file.originalname}`);
      }

      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      const nextStage = { positive: 'evaluation_positive', rework: 'evaluation_rework', negative: 'evaluation_negative' }[verdict];
      const updated = transition(db, manuscript.id, nextStage, actor, {
        note: `Verdict : ${verdict}${recommendation ? ' — ' + recommendation : ''}`,
      });
      // Option : joindre le rapport de lecture qui vient d'être déposé à l'email
      // envoyé à l'auteur, quel que soit le verdict (favorable, à retravailler ou
      // défavorable) — dès lors qu'un fichier est fourni et la case cochée.
      const attachEvaluationReport = !!req.file
        && ['1', 'true', 'on', 'yes'].includes(String(req.body.attach_report || '').toLowerCase());
      notifyTransition(db, transporter, updated, nextStage, actor, siteUrl, { attachEvaluationReport });

      // Hook contrat auto si positive et disponible
      if (verdict === 'positive' && hooks.onEvaluationPositive) {
        try {
          await hooks.onEvaluationPositive(updated, req);
        } catch (err) {
          console.error('[WORKFLOW] onEvaluationPositive error:', err.message);
        }
      }
      res.json({ success: true, stage: nextStage });
    });

  // ─── CORRECTIONS ─────────────────────────────────────────
  // Étapes situées AVANT la correction : un correcteur y est souvent affecté
  // très tôt (dès le contrat), bien avant que le manuscrit ne lui parvienne.
  const PRE_CORRECTION_STAGES = MANUSCRIPT_STAGES
    .slice(0, MANUSCRIPT_STAGES.indexOf('in_correction'))
    .filter((s) => s !== 'evaluation_negative');   // rejeté : ne viendra jamais

  router.get('/corrections', auth, (req, res) => {
    const isPilot = ['super_admin', 'admin', 'editor'].includes(req.admin.role);
    let sql = `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
               FROM manuscripts m JOIN authors a ON a.id = m.author_id
               WHERE m.current_stage IN ('in_correction', 'correction_author_review')`;
    const params = [];
    if (!isPilot) {
      const scope = myAssignmentsClause(req.admin);
      sql += ` AND ${scope.clause}`;
      params.push(...scope.params);
    }
    sql += ' ORDER BY m.updated_at DESC';
    const rows = db.prepare(sql).all(...params).map(describeManuscript);

    // Dossiers déjà confiés au correcteur mais pas encore parvenus à son étape :
    // sans eux, son espace affiche « Aucune correction en cours » alors qu'il a
    // reçu un e-mail d'affectation — il n'a aucun moyen de savoir ce qui l'attend.
    // Lecture seule : le travail ne commence qu'à l'étape « En correction ».
    let upcoming = [];
    if (!isPilot && METIER_ASSIGN_COLUMNS[req.admin.role]) {
      const scope = myAssignmentsClause(req.admin);
      upcoming = db.prepare(
        `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
         FROM manuscripts m JOIN authors a ON a.id = m.author_id
         WHERE ${scope.clause}
           AND m.current_stage IN (${PRE_CORRECTION_STAGES.map(() => '?').join(',')})
         ORDER BY m.updated_at DESC`
      ).all(...scope.params, ...PRE_CORRECTION_STAGES)
        .map((row) => ({ ...describeManuscript(row), upcoming: true }));
    }
    res.json([...rows, ...upcoming]);
  });

  router.post('/corrections/:manuscriptId/upload',
    auth,
    csrfProtection,
    multerFor('correction').single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
      const last = db.prepare(`SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = 'correction'`).get(manuscript.id);
      const version = (last?.v || 0) + 1;
      db.prepare(
        `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
         VALUES (?, 'correction', ?, ?, ?, ?, ?, ?, ?)`
      ).run(manuscript.id, version, req.file.path, req.file.originalname, req.file.size || null, req.file.mimetype || null, req.admin.role, req.admin.id);
      logManuscriptEvent(db, manuscript.id, 'file_uploaded',
        { role: req.admin.role, id: req.admin.id, label: req.admin.username },
        `Document corrigé v${version} — ${req.file.originalname}`);
      res.json({ success: true, version });
    });

  // Types de documents acceptés dans le dossier de production — servis au front
  // pour que la liste ne soit jamais dupliquée des deux côtés.
  router.get('/corrections/production-file-kinds', auth, (req, res) => {
    res.json(Object.entries(PRODUCTION_FILE_KINDS).map(([value, cfg]) => ({
      value,
      label: cfg.label,
      max_mb: cfg.sizeMB,
      accept: cfg.ext.map(e => `.${e}`).join(','),
    })));
  });

  // Fichiers déjà déposés sur le manuscrit (dossier en cours de constitution).
  router.get('/corrections/:manuscriptId/files', auth, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    const files = db.prepare(
      `SELECT id, kind, version, file_name, file_size, external_url, uploaded_at, uploaded_by_role
       FROM manuscript_files WHERE manuscript_id = ? ORDER BY uploaded_at DESC, id DESC`
    ).all(manuscript.id);
    res.json(files.map(f => ({ ...f, kind_label: fileKindLabel(f.kind) })));
  });

  // Dépôt de plusieurs fichiers d'un même type. Le type voyage dans l'URL et non
  // dans le corps : multer doit connaître ses limites AVANT de parser le
  // multipart, or req.body n'existe pas encore à ce moment-là.
  router.post('/corrections/:manuscriptId/production-files/:kind',
    auth,
    csrfProtection,
    (req, res, next) => {
      const cfg = PRODUCTION_FILE_KINDS[req.params.kind];
      if (!cfg) return res.status(400).json({ error: 'Type de document inconnu' });
      const upload = createManuscriptMulter(req.params.kind, cfg.sizeMB, extPattern(cfg.ext))
        .array('files', PRODUCTION_UPLOAD_MAX_FILES);
      upload(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `Fichier trop volumineux (max ${cfg.sizeMB} Mo)` });
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: `Maximum ${PRODUCTION_UPLOAD_MAX_FILES} fichiers par envoi` });
        }
        return res.status(400).json({ error: err.message || 'Fichier invalide' });
      });
    },
    (req, res) => {
      const cfg = PRODUCTION_FILE_KINDS[req.params.kind];
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu' });
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });

      const last = db.prepare(
        'SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = ?'
      ).get(manuscript.id, req.params.kind);
      let version = last?.v || 0;

      const insert = db.prepare(
        `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const saved = db.transaction(() => files.map((f) => {
        version += 1;
        insert.run(manuscript.id, req.params.kind, version, f.path, f.originalname,
          f.size || null, f.mimetype || null, req.admin.role, req.admin.id);
        return { file_name: f.originalname, version };
      }))();

      logManuscriptEvent(db, manuscript.id, 'file_uploaded',
        { role: req.admin.role, id: req.admin.id, label: req.admin.username },
        `Dossier de production — ${cfg.label} : ${saved.map(s => s.file_name).join(', ')}`);
      res.json({ success: true, uploaded: saved.length, files: saved });
    });

  // Dépôt par lien externe : une maquette InDesign packagée ou un lot d'images HD
  // dépasse vite la limite d'upload. Même mécanisme que les manuscrits > 20 Mo —
  // file_path porte l'URL, external_url signale au téléchargement de rediriger.
  router.post('/corrections/:manuscriptId/production-link', auth, csrfProtection, (req, res) => {
    const kind = String(req.body?.kind || '');
    const url = String(req.body?.url || '').trim();
    const label = String(req.body?.label || '').trim();
    if (!PRODUCTION_FILE_KINDS[kind]) return res.status(400).json({ error: 'Type de document inconnu' });
    if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: 'Lien invalide (http:// ou https://)' });
    if (url.length > 2000) return res.status(400).json({ error: 'Lien trop long' });

    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });

    const last = db.prepare(
      'SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = ?'
    ).get(manuscript.id, kind);
    const version = (last?.v || 0) + 1;
    const name = label || `Lien externe — ${PRODUCTION_FILE_KINDS[kind].label}`;
    db.prepare(
      `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, uploaded_by_role, uploaded_by_id, external_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(manuscript.id, kind, version, url, name, req.admin.role, req.admin.id, url);

    logManuscriptEvent(db, manuscript.id, 'file_uploaded',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      `Dossier de production — ${PRODUCTION_FILE_KINDS[kind].label} (lien externe) : ${name}`);
    res.json({ success: true });
  });

  // Retrait d'une pièce déposée par erreur. Le fichier corrigé validé
  // (kind 'correction'/'author_final') n'est pas concerné : il conditionne le
  // passage en production et se remplace par une nouvelle version.
  router.delete('/corrections/:manuscriptId/production-files/:fileId', auth, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    const file = db.prepare('SELECT * FROM manuscript_files WHERE id = ? AND manuscript_id = ?')
      .get(req.params.fileId, manuscript.id);
    if (!file) return res.status(404).json({ error: 'Fichier introuvable' });
    if (!PRODUCTION_FILE_KINDS[file.kind]) {
      return res.status(400).json({ error: 'Seules les pièces du dossier de production peuvent être retirées' });
    }
    db.prepare('DELETE FROM manuscript_files WHERE id = ?').run(file.id);
    // Le fichier sur disque est conservé : la frise référence le dépôt, et une
    // suppression physique rendrait l'historique inexploitable.
    logManuscriptEvent(db, manuscript.id, 'file_uploaded',
      { role: req.admin.role, id: req.admin.id, label: req.admin.username },
      `Dossier de production — pièce retirée : ${file.file_name}`);
    res.json({ success: true });
  });

  router.post('/corrections/:manuscriptId/submit-to-author', auth, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    if (manuscript.current_stage !== 'in_correction') {
      return res.status(400).json({ error: `Envoi impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'correction_author_review', actor, { note: 'Envoi à l\'auteur pour validation' });
    notifyTransition(db, transporter, updated, 'correction_author_review', actor, siteUrl);
    res.json({ success: true });
  });

  // Validation de la correction par l'administration. Réservé aux admin /
  // super_admin (cf. table des transitions). Deux cas couverts :
  //  • depuis « En correction » (in_correction) : l'admin approuve directement la
  //    correction → Production éditoriale, sans relecture auteur.
  //  • depuis « en attente de validation auteur » (correction_author_review) :
  //    l'admin débloque à la place de l'auteur (approuve → éditorial, ou renvoie
  //    en correction).
  router.post('/corrections/:manuscriptId/validate', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée aux administrateurs' });
    }
    const { decision, comment } = req.body || {};
    if (!['approved', 'changes_requested'].includes(decision)) {
      return res.status(400).json({ error: 'Décision invalide' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!['in_correction', 'correction_author_review'].includes(manuscript.current_stage)) {
      return res.status(400).json({ error: `Validation impossible au stade ${manuscript.current_stage}` });
    }
    // « Renvoyer en correction » n'a de sens que depuis l'attente de validation auteur.
    if (decision === 'changes_requested' && manuscript.current_stage !== 'correction_author_review') {
      return res.status(400).json({ error: 'Le manuscrit est déjà en correction.' });
    }
    // Pour transmettre en production, le document corrigé doit avoir été chargé.
    if (decision === 'approved') {
      const hasCorrection = db.prepare(
        `SELECT 1 FROM manuscript_files WHERE manuscript_id = ? AND kind = 'correction' LIMIT 1`
      ).get(manuscript.id);
      if (!hasCorrection) {
        return res.status(400).json({ error: 'Aucun document corrigé n\'a été chargé. Uploadez-le d\'abord.' });
      }
    }
    // Trace la validation au nom de l'auteur (author_id obligatoire), en précisant
    // qu'elle a été effectuée par l'administration.
    db.prepare(
      `INSERT INTO manuscript_validations (manuscript_id, kind, decision, comment, author_id)
       VALUES (?, 'correction', ?, ?, ?)`
    ).run(
      manuscript.id,
      decision,
      `[Validé par l'administration — ${req.admin.username}]${comment ? ' ' + comment : ''}`,
      manuscript.author_id,
    );
    const nextStage = decision === 'approved' ? 'in_editorial' : 'in_correction';
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    if (decision === 'approved') {
      promoteLatestCorrectionAsAuthorFinal(db, manuscript.id, actor);
    }
    const note = `Validation correction par l'administration : ${decision}${comment ? ' — ' + comment : ''}`;
    const updated = transition(db, manuscript.id, nextStage, actor, { note });
    // Quand la correction est validée (→ Production éditoriale), l'auteur n'est PAS
    // prévenu automatiquement : la Direction veut qu'il le soit uniquement sur sa
    // demande (bouton « Notifier l'auteur » sur la fiche manuscrit). Un retour en
    // correction (changes_requested) garde la notification habituelle.
    notifyTransition(db, transporter, updated, nextStage, actor, siteUrl,
      decision === 'approved' ? { skipAuthorNotification: true } : {});
    res.json({ success: true, stage: nextStage });
  });

  // Transmission directe à la Production éditoriale : un admin charge le document
  // corrigé (renvoyé par email par le correcteur) via /upload, puis l'envoie à
  // l'équipe de production éditoriale sans passer par la relecture auteur. On peut
  // au passage assigner le responsable de la production (assigned_editor_id).
  router.post('/corrections/:manuscriptId/to-editorial', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'editor', 'production'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée à l\'équipe éditoriale' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    if (manuscript.current_stage !== 'in_correction') {
      return res.status(400).json({ error: `Transmission impossible au stade ${manuscript.current_stage}` });
    }
    // Garde-fou : le document corrigé doit avoir été chargé au préalable.
    const hasCorrection = db.prepare(
      `SELECT 1 FROM manuscript_files WHERE manuscript_id = ? AND kind = 'correction' LIMIT 1`
    ).get(manuscript.id);
    if (!hasCorrection) {
      return res.status(400).json({ error: 'Aucun document corrigé n\'a été chargé. Uploadez-le d\'abord.' });
    }

    // Assignation optionnelle du responsable de la production éditoriale.
    const updates = {};
    let assignedEditor = null;
    const editorId = req.body?.editor_id ? parseInt(req.body.editor_id, 10) : null;
    if (editorId) {
      const target = db.prepare('SELECT id, username, role FROM admin_users WHERE id = ? AND is_active = 1').get(editorId);
      if (!target) return res.status(404).json({ error: 'Responsable éditorial introuvable' });
      if (!['editor', 'production', 'super_admin', 'admin'].includes(target.role)) {
        return res.status(400).json({ error: 'Cet utilisateur ne peut pas piloter la production éditoriale' });
      }
      updates.assigned_editor_id = editorId;
      assignedEditor = target;
    }

    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    promoteLatestCorrectionAsAuthorFinal(db, manuscript.id, actor);
    const updated = transition(db, manuscript.id, 'in_editorial', actor, {
      note: 'Document corrigé transmis à la Production éditoriale',
      updates,
    });
    // Correction validée → l'auteur n'est pas prévenu automatiquement (notification
    // « sur demande » uniquement, cf. bouton « Notifier l'auteur »).
    notifyTransition(db, transporter, updated, 'in_editorial', actor, siteUrl, { skipAuthorNotification: true });
    res.json({
      success: true,
      stage: 'in_editorial',
      assignedEditor: assignedEditor ? { id: assignedEditor.id, username: assignedEditor.username } : null,
    });
  });

  // Notification « sur demande de l'auteur » : la Direction ne veut pas que l'auteur
  // soit prévenu automatiquement de la validation de ses corrections. Ce bouton (fiche
  // manuscrit) envoie le message « corrections validées / Production éditoriale »
  // (email + cloche) UNIQUEMENT lorsque l'auteur en fait la demande.
  const CORRECTION_VALIDATED_STAGES = [
    'in_editorial', 'editorial_validated', 'cover_design',
    'bat_author_review', 'print_preparation', 'printing', 'printed',
    'in_communication', 'published',
  ];
  router.post('/corrections/:manuscriptId/notify-author', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'editor', 'production'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée à l\'équipe éditoriale' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    // La correction doit avoir été validée (manuscrit en production éditoriale ou au-delà).
    if (!CORRECTION_VALIDATED_STAGES.includes(manuscript.current_stage)) {
      return res.status(400).json({ error: 'La correction n\'a pas encore été validée pour ce manuscrit.' });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    // On informe l'auteur seul (email forcé + cloche) ; les acteurs métier ne sont
    // pas re-notifiés. La frise « email_sent » est écrite par notifyTransition
    // APRÈS confirmation SMTP — plus de double trace inconditionnelle ici.
    notifyTransition(db, transporter, describeManuscript(manuscript), 'in_editorial', actor, siteUrl,
      { authorOnly: true, forceAuthorEmail: true });
    res.json({ success: true });
  });

  // ─── ÉDITORIAL ───────────────────────────────────────────
  router.get('/editorial', auth, (req, res) => {
    // production_files : nombre de pièces du dossier de production constitué en
    // amont par l'administration. Sans ce compteur, l'équipe ne sait pas, depuis
    // la liste, si la maquette et les visuels ont été joints.
    const rows = db.prepare(
      `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name,
              (SELECT COUNT(*) FROM manuscript_files f
                WHERE f.manuscript_id = m.id AND f.kind LIKE 'production_%') AS production_files
       FROM manuscripts m JOIN authors a ON a.id = m.author_id
       WHERE m.current_stage IN ('in_editorial', 'editorial_validated')
       ORDER BY m.updated_at DESC`
    ).all();
    res.json(rows.map(describeManuscript));
  });

  router.post('/editorial/:manuscriptId/validate', auth, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.current_stage !== 'in_editorial') {
      return res.status(400).json({ error: `Validation éditoriale impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'editorial_validated', actor, { note: req.body?.note || null });
    notifyTransition(db, transporter, updated, 'editorial_validated', actor, siteUrl);
    res.json({ success: true });
  });

  router.post('/editorial/:manuscriptId/return-to-correction', auth, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.current_stage !== 'in_editorial') {
      return res.status(400).json({ error: `Retour correction impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'in_correction', actor, { note: req.body?.note || 'Retour pour nouvelles corrections' });
    notifyTransition(db, transporter, updated, 'in_correction', actor, siteUrl);
    res.json({ success: true });
  });

  router.post('/editorial/:manuscriptId/advance-to-cover', auth, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.current_stage !== 'editorial_validated') {
      return res.status(400).json({ error: `Passage en couverture impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'cover_design', actor, { note: 'Lancement conception couverture' });
    notifyTransition(db, transporter, updated, 'cover_design', actor, siteUrl);
    res.json({ success: true });
  });

  // ─── COUVERTURES ─────────────────────────────────────────
  router.get('/covers', auth, (req, res) => {
    let sql = `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
               FROM manuscripts m JOIN authors a ON a.id = m.author_id
               WHERE m.current_stage IN ('cover_design', 'bat_author_review')`;
    const params = [];
    if (req.admin.role === 'infographiste') {
      const scope = myAssignmentsClause(req.admin);
      sql += ` AND ${scope.clause}`;
      params.push(...scope.params);
    }
    sql += ' ORDER BY m.updated_at DESC';
    res.json(db.prepare(sql).all(...params).map(describeManuscript));
  });

  router.post('/covers/:manuscriptId/artwork',
    auth, csrfProtection, multerFor('cover_artwork').single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
      const last = db.prepare(`SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = 'cover_artwork'`).get(manuscript.id);
      const version = (last?.v || 0) + 1;
      db.prepare(
        `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
         VALUES (?, 'cover_artwork', ?, ?, ?, ?, ?, ?, ?)`
      ).run(manuscript.id, version, req.file.path, req.file.originalname, req.file.size || null, req.file.mimetype || null, req.admin.role, req.admin.id);
      logManuscriptEvent(db, manuscript.id, 'file_uploaded',
        { role: req.admin.role, id: req.admin.id, label: req.admin.username },
        `Visuel couverture v${version} — ${req.file.originalname}`);
      res.json({ success: true, version });
    });

  router.post('/covers/:manuscriptId/submit-bat',
    auth, csrfProtection, multerFor('bat_cover').single('bat'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'BAT PDF requis' });
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
      if (manuscript.current_stage !== 'cover_design') {
        return res.status(400).json({ error: `BAT impossible au stade ${manuscript.current_stage}` });
      }
      const last = db.prepare(`SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = 'bat_cover'`).get(manuscript.id);
      const version = (last?.v || 0) + 1;
      db.prepare(
        `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
         VALUES (?, 'bat_cover', ?, ?, ?, ?, ?, ?, ?)`
      ).run(manuscript.id, version, req.file.path, req.file.originalname, req.file.size || null, req.file.mimetype || null, req.admin.role, req.admin.id);

      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      logManuscriptEvent(db, manuscript.id, 'file_uploaded', actor,
        `BAT couverture v${version} — ${req.file.originalname}`);
      const updated = transition(db, manuscript.id, 'bat_author_review', actor, { note: 'BAT couverture soumis' });
      notifyTransition(db, transporter, updated, 'bat_author_review', actor, siteUrl);
      res.json({ success: true, version });
    });

  // ─── IMPRESSION ──────────────────────────────────────────
  router.get('/printing', auth, (req, res) => {
    let sql = `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
               FROM manuscripts m JOIN authors a ON a.id = m.author_id
               WHERE m.current_stage IN ('print_preparation', 'printing', 'printed')`;
    const params = [];
    if (req.admin.role === 'imprimeur') {
      const scope = myAssignmentsClause(req.admin);
      sql += ` AND ${scope.clause}`;
      params.push(...scope.params);
    }
    sql += ' ORDER BY m.updated_at DESC';
    res.json(db.prepare(sql).all(...params).map(describeManuscript));
  });

  // Upload du PDF prêt à imprimer (kind print_ready) — avant ou pendant la
  // préparation MO. Sans ce dépôt, l'imprimeur ne reçoit que le BAT/couverture.
  router.post(
    '/printing/:manuscriptId/upload-print-ready',
    auth,
    csrfProtection,
    multerFor('print_ready').single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Fichier PDF prêt à imprimer requis' });
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
      if (!['print_preparation', 'printing'].includes(manuscript.current_stage)) {
        return res.status(400).json({
          error: `Upload impossible au stade ${STAGE_LABELS[manuscript.current_stage] || manuscript.current_stage}`,
        });
      }
      const last = db.prepare(
        `SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = 'print_ready'`
      ).get(manuscript.id);
      const version = (last?.v || 0) + 1;
      db.prepare(
        `INSERT INTO manuscript_files
           (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
         VALUES (?, 'print_ready', ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        manuscript.id,
        version,
        req.file.path,
        req.file.originalname || req.file.filename,
        req.file.size || null,
        req.file.mimetype || null,
        req.admin.role,
        req.admin.id,
      );
      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      logManuscriptEvent(
        db,
        manuscript.id,
        'file_uploaded',
        actor,
        `PDF prêt à imprimer v${version} — ${req.file.originalname || req.file.filename}`,
      );
      res.json({ success: true, version });
    },
  );

  router.post('/printing/:manuscriptId/prepare', auth, csrfProtection, async (req, res) => {
    const { print_qty, isbn } = req.body;
    const qty = parseInt(print_qty, 10);
    if (!qty || qty < 1) return res.status(400).json({ error: 'Quantité invalide' });
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    if (manuscript.current_stage !== 'print_preparation') {
      return res.status(400).json({ error: `Préparation impossible au stade ${manuscript.current_stage}` });
    }
    // Garde-fou ISBN : impression = point de non-retour (code-barres produit,
    // dépôt légal, royalties). Sans ISBN ici, l'ouvrage partait à l'impression
    // introuvable en recherche et incalculable en droits (cf. file d'attente
    // ISBN côté compta). Format : 13 chiffres (tirets/espaces tolérés).
    const effectiveIsbn = String(isbn || manuscript.isbn || '').trim();
    if (!effectiveIsbn) {
      return res.status(400).json({ error: 'ISBN obligatoire avant l\'impression — attribuez-le sur le contrat ou saisissez-le ici' });
    }
    if (!/^\d{13}$/.test(effectiveIsbn.replace(/[\s-]/g, ''))) {
      return res.status(400).json({ error: 'ISBN invalide — 13 chiffres attendus (tirets acceptés)' });
    }
    // Garde-fou BAT : on ne lance pas la fabrication sans un BAT approuvé
    // (l'étape bat_author_review peut avoir été sautée par une correction
    // manuelle d'état — override-stage — qui ne vérifie rien).
    const batOk = db.prepare(
      "SELECT id FROM manuscript_validations WHERE manuscript_id = ? AND kind = 'bat' AND decision = 'approved' ORDER BY id DESC LIMIT 1"
    ).get(manuscript.id);
    if (!batOk) {
      return res.status(400).json({ error: 'Aucun BAT approuvé pour ce manuscrit — faites valider le BAT (auteur ou admin) avant de lancer l\'impression' });
    }

    let moResult = { dolibarr_mo_id: null, dolibarr_mo_ref: null, dolibarr_product_id: manuscript.dolibarr_product_id };
    if (hooks.onPrintPrepare) {
      try {
        moResult = await hooks.onPrintPrepare({ manuscript, qty, isbn, admin: req.admin });
      } catch (err) {
        console.error('[PRINTING] MO hook error:', err.message);
        return res.status(500).json({ error: `Erreur MO Dolibarr : ${err.message}` });
      }
    }

    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'printing', actor, {
      note: `MO ${moResult.dolibarr_mo_ref || ''} — qty ${qty}`,
      updates: {
        print_qty: qty,
        isbn: effectiveIsbn,
        dolibarr_mo_id: moResult.dolibarr_mo_id,
        dolibarr_mo_ref: moResult.dolibarr_mo_ref,
        dolibarr_product_id: moResult.dolibarr_product_id,
      },
    });
    // Frise : un ISBN saisi À L'IMPRESSION doit être tracé comme l'est celui
    // saisi sur le contrat (l'audit direction exige de savoir qui/quand).
    if (!manuscript.isbn && effectiveIsbn) {
      logManuscriptEvent(db, manuscript.id, 'isbn_assigned', actor, `ISBN ${effectiveIsbn} (saisi à la préparation d'impression)`);
    }
    notifyTransition(db, transporter, updated, 'printing', actor, siteUrl);
    res.json({ success: true, mo: moResult });
  });

  router.post('/printing/:manuscriptId/mark-printed', auth, csrfProtection, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript, db)) return res.status(403).json({ error: 'Accès refusé' });
    if (manuscript.current_stage !== 'printing') {
      return res.status(400).json({ error: `Marquage impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'printed', actor, { note: req.body?.note || 'Impression terminée' });
    notifyTransition(db, transporter, updated, 'printed', actor, siteUrl);
    res.json({ success: true });
  });

  // ─── MARK PAYMENT (transition contrat → paiement → correction) ────
  router.post('/manuscripts/v2/:id/mark-paid', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'comptable'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Réservé au comptable/admin' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.current_stage !== 'payment_pending') {
      return res.status(400).json({ error: `Marquage impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'in_correction', actor, { note: req.body?.note || 'Paiement confirmé' });
    notifyTransition(db, transporter, updated, 'in_correction', actor, siteUrl);
    res.json({ success: true });
  });

  // ─── DÉMARRER LA CORRECTION SANS ATTENDRE LE PAIEMENT ────
  // Le paiement du devis n'est pas une obligation pour passer en correction :
  // l'équipe éditoriale peut lancer la phase de correction directement, sans
  // que le devis ait été encaissé (l'encaissement reste un acte comptable distinct).
  router.post('/manuscripts/v2/:id/start-correction', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'editor', 'production'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée à l\'équipe éditoriale' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    // Lançable dès la signature (contract_signed) ou en attente de paiement
    // (payment_pending) : dans les deux cas le paiement n'est pas requis.
    if (!['contract_signed', 'payment_pending'].includes(manuscript.current_stage)) {
      return res.status(400).json({ error: `Action impossible au stade ${manuscript.current_stage}` });
    }
    const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
    const updated = transition(db, manuscript.id, 'in_correction', actor,
      { note: req.body?.note || 'Correction démarrée sans attendre le paiement du devis' });
    notifyTransition(db, transporter, updated, 'in_correction', actor, siteUrl);
    res.json({ success: true });
  });

  // ─── LISTE UTILISATEURS ASSIGNABLES (par rôle) ──────────
  router.get('/admin-users/by-role', auth, editorOnly, (req, res) => {
    const { role } = req.query;
    if (!role) return res.status(400).json({ error: 'Paramètre role requis' });
    // Acteurs externes → carnet d'intervenants (forme {id, username, role} attendue par le modal).
    if (INTERVENANT_METIERS.includes(role)) {
      const rows = db.prepare(
        'SELECT id, nom AS username, metier AS role FROM intervenants WHERE metier = ? AND is_active = 1 ORDER BY nom ASC'
      ).all(role);
      return res.json(rows);
    }
    // Production éditoriale interne → comptes admin_users actifs. La couverture
    // étant fusionnée avec l'éditorial, les rôles `editor` ET `production` sont
    // proposés (plus les administrateurs).
    const editorialRoles = role === 'editor' ? ['editor', 'production'] : [role];
    const placeholders = editorialRoles.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, username, role FROM admin_users WHERE (role IN (${placeholders}) OR role IN ('super_admin','admin')) AND is_active = 1 ORDER BY username ASC`
    ).all(...editorialRoles);
    res.json(rows);
  });

  return router;
}
