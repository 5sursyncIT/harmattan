import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { transition, STAGE_LABELS, MANUSCRIPT_STAGES, MANUSCRIPT_EVENTS } from './manuscript-workflow.js';
import { notifyTransition, sendAssignmentEmail } from './manuscript-emails.js';
import { createManuscriptMulter } from './author-routes.js';
import { ensureIntervenantsSchema, seedIntervenants, INTERVENANT_METIERS } from './intervenants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS_DIR = join(__dirname, '..', 'manuscripts');

const UPLOAD_CFG = {
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

  router.get('/manuscripts/v2/:id', auth, (req, res) => {
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

    res.json({
      manuscript: describeManuscript(manuscript),
      files,
      stages: stages.map((s) => ({
        ...s,
        stage_label: s.event
          ? (MANUSCRIPT_EVENTS[s.event]?.label || s.event)
          : (STAGE_LABELS[s.to_stage] || s.to_stage),
      })),
      evaluations,
      validations,
      series,
    });
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
        if (!['super_admin', 'admin', 'editor'].includes(target.role)) {
          return res.status(400).json({ error: 'Utilisateur invalide pour le rôle éditeur' });
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

    // Applique l'assignation à un manuscrit + ses effets de bord (notifications,
    // transition auto évaluateur). Renvoie true si auto-transition déclenchée.
    const assignOne = (msId) => {
      const before = db.prepare(`SELECT ${col} AS prev_id FROM manuscripts WHERE id = ?`).get(msId);
      db.prepare(`UPDATE manuscripts SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(user_id || null, msId);
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(msId);

      // Notifier l'ancien assigné de son retrait (si changement).
      if (before?.prev_id && before.prev_id !== user_id) {
        try {
          const prev = resolveRecipient(before.prev_id);
          if (prev) sendAssignmentEmail(transporter, manuscript, role, prev, siteUrl, 'unassigned');
        } catch (err) { console.warn('[WORKFLOW] previous assignee notify error:', err.message); }
      }

      // L'évaluateur affecté sur un manuscrit « submitted » déclenche la transition
      // auto vers in_evaluation : l'email de tâche (avec lien) part alors via notifyTransition.
      const willAutoTransition = role === 'evaluateur' && user_id && manuscript.current_stage === 'submitted';
      if (user_id && before?.prev_id !== user_id && !willAutoTransition) {
        try {
          const next = resolveRecipient(user_id);
          if (next) sendAssignmentEmail(transporter, manuscript, role, next, siteUrl, 'assigned');
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
  router.post('/manuscripts/v2/:id/transition', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Réservé à l\'éditeur ou l\'administrateur' });
    }
    const { to_stage, note, force } = req.body;
    try {
      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      const updated = transition(db, req.params.id, to_stage, actor, { note: note || null, force: !!force });
      notifyTransition(db, transporter, updated, to_stage, actor, siteUrl);
      res.json({ success: true, manuscript: describeManuscript(updated) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
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
      if (!['positive', 'negative'].includes(verdict)) {
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
      }

      const actor = { role: req.admin.role, id: req.admin.id, label: req.admin.username };
      const nextStage = verdict === 'positive' ? 'evaluation_positive' : 'evaluation_negative';
      const updated = transition(db, manuscript.id, nextStage, actor, {
        note: `Verdict : ${verdict}${recommendation ? ' — ' + recommendation : ''}`,
      });
      // Option : joindre le rapport de lecture qui vient d'être déposé à l'email
      // d'acceptation envoyé à l'auteur (uniquement si verdict favorable + fichier fourni).
      const attachEvaluationReport = verdict === 'positive'
        && !!req.file
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
      res.json({ success: true, version });
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
    const updated = transition(db, manuscript.id, 'in_editorial', actor, {
      note: 'Document corrigé transmis à la Production éditoriale',
      updates,
    });
    notifyTransition(db, transporter, updated, 'in_editorial', actor, siteUrl);
    res.json({
      success: true,
      stage: 'in_editorial',
      assignedEditor: assignedEditor ? { id: assignedEditor.id, username: assignedEditor.username } : null,
    });
  });

  // ─── ÉDITORIAL ───────────────────────────────────────────
  router.get('/editorial', auth, (req, res) => {
    const rows = db.prepare(
      `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name
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
        isbn: isbn || manuscript.isbn,
        dolibarr_mo_id: moResult.dolibarr_mo_id,
        dolibarr_mo_ref: moResult.dolibarr_mo_ref,
        dolibarr_product_id: moResult.dolibarr_product_id,
      },
    });
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
