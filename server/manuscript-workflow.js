/**
 * Moteur du workflow éditorial.
 * Machine à états pour les manuscrits, de la soumission à l'impression.
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
];

export const STAGE_LABELS = {
  submitted: 'Reçu',
  in_evaluation: 'En évaluation',
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
};

export const STAGE_ACTORS = {
  submitted: 'admin',
  in_evaluation: 'evaluateur',
  evaluation_positive: 'admin',
  evaluation_negative: 'terminal',
  contract_pending: 'author',
  contract_signed: 'system',
  payment_pending: 'comptable',
  in_correction: 'correcteur',
  correction_author_review: 'author',
  in_editorial: 'editor',
  editorial_validated: 'admin',
  cover_design: 'infographiste',
  bat_author_review: 'author',
  print_preparation: 'imprimeur',
  printing: 'imprimeur',
  printed: 'terminal',
};

export const ALLOWED_TRANSITIONS = {
  submitted: [
    { to: 'in_evaluation', roles: ['super_admin', 'admin', 'editor'] },
  ],
  in_evaluation: [
    { to: 'evaluation_positive', roles: ['evaluateur', 'super_admin', 'admin'] },
    { to: 'evaluation_negative', roles: ['evaluateur', 'super_admin', 'admin'] },
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
  ],
  payment_pending: [
    { to: 'in_correction', roles: ['super_admin', 'admin', 'comptable', 'system'] },
  ],
  in_correction: [
    { to: 'correction_author_review', roles: ['correcteur', 'super_admin', 'admin'] },
  ],
  correction_author_review: [
    { to: 'in_correction', roles: ['author', 'super_admin', 'admin'] },
    { to: 'in_editorial', roles: ['author', 'super_admin', 'admin'] },
  ],
  in_editorial: [
    { to: 'editorial_validated', roles: ['editor', 'super_admin', 'admin'] },
    { to: 'in_correction', roles: ['editor', 'super_admin', 'admin'] },
  ],
  editorial_validated: [
    { to: 'cover_design', roles: ['editor', 'super_admin', 'admin'] },
  ],
  cover_design: [
    { to: 'bat_author_review', roles: ['infographiste', 'super_admin', 'admin'] },
  ],
  bat_author_review: [
    { to: 'cover_design', roles: ['author', 'super_admin', 'admin'] },
    { to: 'print_preparation', roles: ['author', 'super_admin', 'admin'] },
  ],
  print_preparation: [
    { to: 'printing', roles: ['imprimeur', 'super_admin', 'admin'] },
  ],
  printing: [
    { to: 'printed', roles: ['imprimeur', 'super_admin', 'admin'] },
  ],
  printed: [],
};

export const STAGE_KIND_MAP = {
  submitted: 'original',
  in_evaluation: 'original',
  evaluation_positive: 'evaluation_report',
  evaluation_negative: 'evaluation_report',
  in_correction: 'correction',
  correction_author_review: 'correction',
  in_editorial: 'author_final',
  cover_design: 'cover_artwork',
  bat_author_review: 'bat_cover',
  print_preparation: 'print_ready',
  printing: 'print_ready',
  printed: 'print_ready',
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
