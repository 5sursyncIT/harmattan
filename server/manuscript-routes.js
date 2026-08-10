import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, unlinkSync } from 'fs';
import { transition, STAGE_LABELS, MANUSCRIPT_STAGES, MANUSCRIPT_EVENTS, logManuscriptEvent, promoteLatestCorrectionAsAuthorFinal } from './manuscript-workflow.js';
import { notifyTransition, sendAssignmentEmail, sendAuthorRevisionRequestEmail, notifyIntervenantTask, METIER_TASK_STAGES } from './manuscript-emails.js';
import { revokeFileTokens } from './manuscript-file-tokens.js';
import { addManuscriptVersion, getFinalVersion, createDepositToken, getActiveDepositToken, revokeDepositTokens } from './manuscript-versions.js';
import { createManuscriptMulter } from './author-routes.js';
import { ensureIntervenantsSchema, seedIntervenants, INTERVENANT_METIERS } from './intervenants.js';

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
  return { correction: 'Document corrigé', original: 'Manuscrit original' }[kind] || kind;
}

function describeManuscript(row) {
  return row ? { ...row, stage_label: STAGE_LABELS[row.current_stage] || row.current_stage } : null;
}

function roleCanAccessManuscript(admin, manuscript) {
  if (!admin || !manuscript) return false;
  if (['super_admin', 'admin'].includes(admin.role)) return true;
  if (admin.role === 'editor') return true;
  if (admin.role === 'production') return true;   // pilote du pipeline éditorial + couvertures
  const mapping = {
    evaluateur: 'assigned_evaluator_id',
    correcteur: 'assigned_corrector_id',
    infographiste: 'assigned_infographist_id',
    imprimeur: 'assigned_printer_id',
  };
  const col = mapping[admin.role];
  return col ? manuscript[col] === admin.id : false;
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
  const auth = adminAuth;

  // Garde-fou : routes carnet/affectation réservées au pilote éditorial.
  const editorOnly = (req, res, next) => {
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée à l\'éditeur' });
    }
    next();
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  // ─── LISTE GLOBALE ────────────────────────────────────────
  router.get('/manuscripts/v2', auth, (req, res) => {
    const { stage, q } = req.query || {};
    let sql = `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name, a.email AS author_email
               FROM manuscripts m JOIN authors a ON a.id = m.author_id WHERE 1=1`;
    const params = [];
    if (stage) { sql += ' AND m.current_stage = ?'; params.push(stage); }
    if (q) {
      sql += ' AND (m.title LIKE ? OR m.ref LIKE ? OR a.firstname LIKE ? OR a.lastname LIKE ? OR a.email LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like, like);
    }
    sql += ' ORDER BY m.created_at DESC LIMIT 200';
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(describeManuscript));
  });

  router.get('/manuscripts/v2/stages', auth, (req, res) => {
    res.json({ stages: MANUSCRIPT_STAGES, labels: STAGE_LABELS });
  });

  router.get('/manuscripts/v2/:id', auth, async (req, res) => {
    const manuscript = db.prepare(
      `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name, a.email AS author_email, a.phone AS author_phone
       FROM manuscripts m JOIN authors a ON a.id = m.author_id WHERE m.id = ?`
    ).get(req.params.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });

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
    const roleColumns = {
      evaluateur: 'assigned_evaluator_id',
      correcteur: 'assigned_corrector_id',
      infographiste: 'assigned_infographist_id',
      imprimeur: 'assigned_printer_id',
    };
    const col = roleColumns[req.admin.role];
    if (!col) return res.json([]); // super_admin/admin/editor n'utilisent pas cet endpoint
    const rows = db.prepare(
      `SELECT m.id, m.ref, m.title, m.subtitle, m.current_stage, m.created_at, m.updated_at,
              a.firstname || ' ' || a.lastname AS author_name
       FROM manuscripts m JOIN authors a ON a.id = m.author_id
       WHERE m.${col} = ? ORDER BY m.updated_at DESC`
    ).all(req.admin.id);
    res.json(rows.map(describeManuscript));
  });

  router.get('/manuscripts/v2/:id/files/:fileId/download', auth, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (!manuscript || !roleCanAccessManuscript(req.admin, manuscript)) {
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
            if (next) sendAssignmentEmail(transporter, manuscript, role, next, siteUrl, 'assigned');
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
  //   • AUCUN email n'est envoyé (correction interne, pas un vrai franchissement).
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
      res.json({ success: true, manuscript: describeManuscript(updated) });
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
      sql += ' AND m.assigned_evaluator_id = ?';
      params.push(req.admin.id);
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
      if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
  router.get('/corrections', auth, (req, res) => {
    let sql = `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
               FROM manuscripts m JOIN authors a ON a.id = m.author_id
               WHERE m.current_stage IN ('in_correction', 'correction_author_review')`;
    const params = [];
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      sql += ' AND m.assigned_corrector_id = ?';
      params.push(req.admin.id);
    }
    sql += ' ORDER BY m.updated_at DESC';
    res.json(db.prepare(sql).all(...params).map(describeManuscript));
  });

  router.post('/corrections/:manuscriptId/upload',
    auth,
    csrfProtection,
    multerFor('correction').single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.manuscriptId);
      if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
      if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
      if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });

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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });

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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
      sql += ' AND m.assigned_infographist_id = ?';
      params.push(req.admin.id);
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
      if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
      if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
      sql += ' AND m.assigned_printer_id = ?';
      params.push(req.admin.id);
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
      if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
    if (!roleCanAccessManuscript(req.admin, manuscript)) return res.status(403).json({ error: 'Accès refusé' });
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
