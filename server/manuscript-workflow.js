/**
 * Moteur du workflow éditorial.
 * Machine à états pour les manuscrits, de la soumission à la parution
 * (impression puis relais commercial : in_communication → published).
 *
 * Exports :
 *  - MANUSCRIPT_STAGES     : liste canonique des stages (ordre d'affichage)
 *  - STAGE_LABELS          : libellés français pour l'UI
 *  - STAGE_ACTORS          : acteur principal attendu à chaque stage
 *  - ALLOWED_TRANSITIONS   : transitions autorisées (from → [{to, roles}])
 *  - transition()          : fonction générique de transition (transaction SQLite)
 *  - generateManuscriptRef : réf unique MS-YYMM-NNNN
 *  - STAGE_KIND_MAP        : mapping stage → kind du dernier fichier attendu
 */

export const MANUSCRIPT_STAGES = [
  'submitted',
  'in_evaluation',
  'evaluation_rework',
  'evaluation_negative',
  'evaluation_positive',
  'contract_pending',
  'contract_signed',
  'payment_pending',
  'in_correction',
  'correction_author_review',
  'in_editorial',
  'editorial_validated',
  'cover_design',
  'bat_author_review',
  'print_preparation',
  'printing',
  'printed',
  'in_communication',
  'published',
];

export const STAGE_LABELS = {
  submitted: 'Reçu',
  in_evaluation: 'En évaluation',
  evaluation_rework: 'À retravailler',
  evaluation_negative: 'Rejeté',
  evaluation_positive: 'Évaluation favorable',
  contract_pending: 'Contrat à signer',
  contract_signed: 'Contrat signé',
  payment_pending: 'Paiement en attente',
  in_correction: 'En correction',
  correction_author_review: "Corrections à valider par l'auteur",
  in_editorial: 'En validation éditoriale',
  editorial_validated: 'Validé par l\'éditeur',
  cover_design: 'Conception de la couverture',
  bat_author_review: "BAT à valider par l'auteur",
  print_preparation: 'Préparation impression',
  printing: 'En impression',
  printed: 'Imprimé',
  in_communication: 'En communication',
  published: 'Paru',
};

/**
 * Évènements « informatifs » de la frise. Contrairement aux stages (machine à
 * états), un évènement S'AJOUTE à l'historique sans faire avancer current_stage.
 * Sert à tracer des actions transverses au workflow : envoi de devis,
 * transmission du contrat à l'auteur, etc. La clé est stockée dans la colonne
 * manuscript_stages.event ; from_stage = to_stage = stage courant.
 *   authorVisible : visible dans l'espace auteur (sinon réservé à l'admin).
 */
export const MANUSCRIPT_EVENTS = {
  quote_created:     { label: 'Devis généré',                   authorVisible: false },
  quote_revised:     { label: 'Devis révisé (négociation)',     authorVisible: false },
  quote_sent:        { label: "Devis envoyé à l'auteur",        authorVisible: true },
  quote_paid:        { label: 'Devis encaissé',                 authorVisible: false },
  quote_deleted:     { label: 'Devis supprimé',                 authorVisible: false },
  // Action interne : un admin récupère le PDF/ODT du contrat (route GET /document).
  contract_doc_sent: { label: 'Document de contrat téléchargé', authorVisible: false },
  // Vrai envoi à l'auteur : e-mail du lien de signature (route POST /send-signature).
  contract_sent:     { label: "Contrat envoyé à l'auteur",      authorVisible: true },
  contract_deleted:  { label: 'Contrat supprimé',               authorVisible: false },
  contract_validated:{ label: 'Contrat validé',                 authorVisible: false },
  contract_linked:   { label: 'Contrat rattaché',               authorVisible: false },
  isbn_assigned:     { label: 'ISBN attribué',                  authorVisible: false },
  // Interventions humaines & documents — traçabilité complète demandée par la
  // direction (qui/quand). Réservés à l'admin (authorVisible:false).
  // Micro-correction de la fiche (titre, sous-titre, genre, synopsis) par un
  // admin/éditeur — ex. faute de frappe de l'auteur. Ne touche ni au fichier du
  // manuscrit ni au stage ; l'ancienne et la nouvelle valeur sont dans la note.
  details_updated:   { label: 'Fiche corrigée',                 authorVisible: false },
  intervenant_assigned:   { label: 'Intervenant affecté', authorVisible: false },
  intervenant_unassigned: { label: 'Intervenant retiré',  authorVisible: false },
  file_uploaded:          { label: 'Document déposé',     authorVisible: false },
  email_sent:             { label: 'E-mail envoyé',       authorVisible: false },
  // Versionnage du fichier manuscrit : demande de révision envoyée à l'auteur
  // (lien de dépôt tokenisé), marquage/déverrouillage de la version définitive,
  // marquage jalon (version protégée de la purge de rétention).
  revision_requested:     { label: "Révision demandée à l'auteur", authorVisible: true },
  file_final_marked:      { label: 'Version définitive arrêtée',   authorVisible: false },
  file_final_unlocked:    { label: 'Version définitive déverrouillée', authorVisible: false },
  file_milestone:         { label: 'Version jalon',                authorVisible: false },
  // Relais commercial (module Parutions) : chaque case cochée/décochée de la
  // checklist de lancement + jalons quand le brief puis la checklist sont complets.
  comm_checklist:         { label: 'Checklist parution',  authorVisible: false },
  communication_brief_ready: { label: 'Brief communication prêt', authorVisible: false },
  launch_prepared:        { label: 'Lancement commercial préparé', authorVisible: false },
};

export const STAGE_ACTORS = {
  submitted: 'admin',
  in_evaluation: 'evaluateur',
  evaluation_positive: 'admin',
  evaluation_rework: 'author',
  evaluation_negative: 'terminal',
  contract_pending: 'author',
  contract_signed: 'system',
  payment_pending: 'comptable',
  in_correction: 'correcteur',
  correction_author_review: 'author',
  in_editorial: 'editor',
  editorial_validated: 'admin',
  // Fusion Éditeur + Infographiste : la couverture est désormais conçue en
  // interne par la Production éditoriale (compte assigned_editor_id).
  cover_design: 'editor',
  bat_author_review: 'author',
  print_preparation: 'imprimeur',
  printing: 'imprimeur',
  // Prolongement demandé par la direction (23/07/2026) : la frise ne s'arrête
  // plus à l'impression — elle couvre le relais commercial (module Parutions)
  // jusqu'à la parution effective.
  printed: 'librarian',
  in_communication: 'librarian',
  published: 'terminal',
};

export const ALLOWED_TRANSITIONS = {
  submitted: [
    { to: 'in_evaluation', roles: ['super_admin', 'admin', 'editor'] },
  ],
  in_evaluation: [
    { to: 'evaluation_positive', roles: ['evaluateur', 'editor', 'super_admin', 'admin'] },
    { to: 'evaluation_rework', roles: ['evaluateur', 'editor', 'super_admin', 'admin'] },
    { to: 'evaluation_negative', roles: ['evaluateur', 'editor', 'super_admin', 'admin'] },
  ],
  // « À retravailler » n'est pas terminal : quand l'auteur renvoie une version
  // retravaillée, on relance l'évaluation ; l'équipe peut aussi trancher
  // directement (accepter ou rejeter) sans nouveau cycle.
  evaluation_rework: [
    // L'auteur peut relancer le cycle en déposant une version retravaillée
    // (POST /api/author/manuscripts/:id/submit-rework).
    { to: 'in_evaluation', roles: ['author', 'evaluateur', 'editor', 'super_admin', 'admin'] },
    { to: 'evaluation_positive', roles: ['editor', 'super_admin', 'admin'] },
    { to: 'evaluation_negative', roles: ['editor', 'super_admin', 'admin'] },
  ],
  evaluation_negative: [],
  evaluation_positive: [
    { to: 'contract_pending', roles: ['super_admin', 'admin', 'editor', 'system'] },
  ],
  contract_pending: [
    { to: 'contract_signed', roles: ['system', 'super_admin', 'admin'] },
  ],
  contract_signed: [
    { to: 'payment_pending', roles: ['system', 'super_admin', 'admin'] },
    // Démarrage anticipé de la correction, dès la signature, sans passer par
    // l'étape paiement (le paiement du devis n'est pas une obligation).
    { to: 'in_correction', roles: ['super_admin', 'admin', 'editor', 'production'] },
  ],
  payment_pending: [
    // Le paiement du devis n'est PAS une obligation pour démarrer la correction :
    // l'équipe éditoriale (editor/production) peut lancer la correction sans
    // attendre l'encaissement ; comptable/admin peuvent aussi confirmer le paiement.
    { to: 'in_correction', roles: ['super_admin', 'admin', 'comptable', 'editor', 'production', 'system'] },
  ],
  in_correction: [
    { to: 'correction_author_review', roles: ['correcteur', 'editor', 'super_admin', 'admin'] },
    // Chemin direct : l'admin charge le document corrigé (renvoyé par email par le
    // correcteur) et le transmet à la Production éditoriale, sans relecture auteur.
    { to: 'in_editorial', roles: ['editor', 'production', 'super_admin', 'admin'] },
  ],
  correction_author_review: [
    { to: 'in_correction', roles: ['author', 'super_admin', 'admin'] },
    { to: 'in_editorial', roles: ['author', 'super_admin', 'admin'] },
  ],
  in_editorial: [
    { to: 'editorial_validated', roles: ['editor', 'production', 'super_admin', 'admin'] },
    { to: 'in_correction', roles: ['editor', 'production', 'super_admin', 'admin'] },
  ],
  editorial_validated: [
    { to: 'cover_design', roles: ['editor', 'production', 'super_admin', 'admin'] },
  ],
  cover_design: [
    // Couverture = Production éditoriale (fusion Éditeur + Infographiste : un
    // seul service interne s'occupe de l'éditorial ET de l'infographie).
    // Le rôle externe `infographiste` est déprécié et VOLONTAIREMENT absent :
    // ses comptes sont non connectables, il ne doit pas réapparaître ici.
    { to: 'bat_author_review', roles: ['editor', 'production', 'super_admin', 'admin'] },
  ],
  bat_author_review: [
    { to: 'cover_design', roles: ['author', 'super_admin', 'admin'] },
    { to: 'print_preparation', roles: ['author', 'super_admin', 'admin'] },
  ],
  print_preparation: [
    { to: 'printing', roles: ['imprimeur', 'editor', 'super_admin', 'admin'] },
  ],
  printing: [
    { to: 'printed', roles: ['imprimeur', 'editor', 'super_admin', 'admin'] },
  ],
  // Relais commercial : passage manuel (équipe éditoriale/comm) ou automatique
  // ('system') via la checklist du module Parutions — première action de
  // lancement cochée → in_communication ; checklist 17/17 → published.
  printed: [
    { to: 'in_communication', roles: ['librarian', 'editor', 'production', 'super_admin', 'admin', 'system'] },
  ],
  in_communication: [
    { to: 'published', roles: ['librarian', 'editor', 'production', 'super_admin', 'admin', 'system'] },
  ],
  published: [],
};

export const STAGE_KIND_MAP = {
  submitted: 'original',
  in_evaluation: 'original',
  evaluation_positive: 'evaluation_report',
  evaluation_rework: 'evaluation_report',
  evaluation_negative: 'evaluation_report',
  in_correction: 'correction',
  correction_author_review: 'correction',
  in_editorial: 'author_final',
  cover_design: 'cover_artwork',
  bat_author_review: 'bat_cover',
  print_preparation: 'print_ready',
  printing: 'print_ready',
  printed: 'print_ready',
  in_communication: 'print_ready',
  published: 'print_ready',
};

/**
 * Génère une référence unique MS-YYMM-NNNN.
 * @param {*} db better-sqlite3 instance
 */
export function generateManuscriptRef(db) {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const like = `MS-${yymm}-%`;
  const last = db.prepare('SELECT ref FROM manuscripts WHERE ref LIKE ? ORDER BY id DESC LIMIT 1').get(like);
  let seq = 1;
  if (last?.ref) {
    const m = last.ref.match(/-(\d{4})$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `MS-${yymm}-${String(seq).padStart(4, '0')}`;
}

function isTransitionAllowed(fromStage, toStage, actorRole) {
  const candidates = ALLOWED_TRANSITIONS[fromStage] || [];
  return candidates.some((t) => t.to === toStage && t.roles.includes(actorRole));
}

/**
 * Exécute une transition sur un manuscrit, en transaction :
 * 1. vérifie la légalité,
 * 2. met à jour current_stage,
 * 3. insère la trace dans manuscript_stages,
 * 4. applique les mises à jour supplémentaires optionnelles (payload.updates),
 * 5. renvoie l'état final.
 *
 * @param {*} db better-sqlite3
 * @param {number} manuscriptId
 * @param {string} toStage
 * @param {{ role: string, id?: number, label?: string }} actor
 * @param {{ note?: string, updates?: Record<string, any>, force?: boolean }} payload
 */
export function transition(db, manuscriptId, toStage, actor, payload = {}) {
  const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(manuscriptId);
  if (!manuscript) {
    throw new Error('Manuscrit introuvable');
  }
  if (manuscript.current_stage === toStage) {
    return manuscript; // idempotent
  }
  const actorRole = actor?.role || 'system';
  if (!payload.force && !isTransitionAllowed(manuscript.current_stage, toStage, actorRole)) {
    throw new Error(
      `Transition non autorisée : ${manuscript.current_stage} → ${toStage} pour ${actorRole}`
    );
  }

  const extraUpdates = payload.updates || {};
  const updateCols = ['current_stage = ?', "updated_at = datetime('now')"];
  const updateValues = [toStage];
  for (const [col, val] of Object.entries(extraUpdates)) {
    updateCols.push(`${col} = ?`);
    updateValues.push(val);
  }
  updateValues.push(manuscriptId);

  const updateSql = `UPDATE manuscripts SET ${updateCols.join(', ')} WHERE id = ?`;
  const insertStageSql = `INSERT INTO manuscript_stages
    (manuscript_id, from_stage, to_stage, actor_role, actor_id, actor_label, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;

  const tx = db.transaction(() => {
    db.prepare(updateSql).run(...updateValues);
    db.prepare(insertStageSql).run(
      manuscriptId,
      manuscript.current_stage,
      toStage,
      actorRole,
      actor?.id || null,
      actor?.label || null,
      payload.note || null
    );
  });
  tx();

  return db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(manuscriptId);
}

/**
 * Journalise un évènement informatif sur la frise d'un manuscrit, SANS
 * transition d'état. Insère une ligne manuscript_stages avec `event` renseigné
 * et from_stage = to_stage = current_stage (pour ne pas perturber les lecteurs
 * de to_stage : la ligne est neutre du point de vue de la machine à états).
 * No-op silencieux si l'évènement est inconnu ou le manuscrit introuvable —
 * la journalisation ne doit jamais faire échouer l'action métier appelante.
 *
 * @param {*} db better-sqlite3
 * @param {number} manuscriptId
 * @param {string} eventKey   clé dans MANUSCRIPT_EVENTS
 * @param {{ role?: string, id?: number, label?: string }} actor
 * @param {string} [note]
 * @returns {boolean} true si une ligne a été insérée
 */
export function logManuscriptEvent(db, manuscriptId, eventKey, actor = {}, note = null) {
  if (!manuscriptId || !MANUSCRIPT_EVENTS[eventKey]) return false;
  const manuscript = db.prepare('SELECT current_stage FROM manuscripts WHERE id = ?').get(manuscriptId);
  if (!manuscript) return false;
  const stage = manuscript.current_stage;
  db.prepare(`INSERT INTO manuscript_stages
    (manuscript_id, from_stage, to_stage, actor_role, actor_id, actor_label, note, event)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    manuscriptId, stage, stage,
    actor.role || 'system', actor.id || null, actor.label || null,
    note, eventKey,
  );
  return true;
}

/**
 * Promouvoir le dernier fichier `correction` en `author_final` (même chemin disque,
 * nouvelle ligne manuscript_files). Appelé à l'entrée en production éditoriale
 * pour que STAGE_KIND_MAP / tokens intervenants trouvent le kind attendu.
 * Idempotent si le même fichier est déjà promu.
 * @returns {number|null} id du fichier author_final
 */
export function promoteLatestCorrectionAsAuthorFinal(db, manuscriptId, actor = {}) {
  if (!manuscriptId) return null;
  const src = db.prepare(
    `SELECT * FROM manuscript_files WHERE manuscript_id = ? AND kind = 'correction'
     ORDER BY version DESC, uploaded_at DESC LIMIT 1`
  ).get(manuscriptId);
  if (!src) return null;
  const already = db.prepare(
    `SELECT id FROM manuscript_files
     WHERE manuscript_id = ? AND kind = 'author_final'
       AND ((file_path IS NOT NULL AND file_path = ?) OR (external_url IS NOT NULL AND external_url = ?))
     LIMIT 1`
  ).get(manuscriptId, src.file_path || '', src.external_url || '');
  if (already) return already.id;

  const last = db.prepare(
    `SELECT MAX(version) AS v FROM manuscript_files WHERE manuscript_id = ? AND kind = 'author_final'`
  ).get(manuscriptId);
  const version = (last?.v || 0) + 1;
  const info = db.prepare(
    `INSERT INTO manuscript_files
       (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id, external_url)
     VALUES (?, 'author_final', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    manuscriptId,
    version,
    src.file_path || null,
    src.file_name || null,
    src.file_size || null,
    src.mime_type || null,
    actor.role || 'system',
    actor.id || null,
    src.external_url || null,
  );
  logManuscriptEvent(
    db,
    manuscriptId,
    'file_uploaded',
    actor,
    `Version finale auteur (promue depuis correction v${src.version})`,
  );
  return info.lastInsertRowid;
}
