import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { transition, STAGE_LABELS, MANUSCRIPT_STAGES } from './manuscript-workflow.js';
import { notifyTransition } from './manuscript-emails.js';
import { createManuscriptMulter } from './author-routes.js';

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
  const auth = adminAuth;

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
    const files = db.prepare('SELECT * FROM manuscript_files WHERE manuscript_id = ? ORDER BY uploaded_at ASC').all(manuscript.id);
    const stages = db.prepare('SELECT * FROM manuscript_stages WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    const evaluations = db.prepare('SELECT * FROM manuscript_evaluations WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    const validations = db.prepare('SELECT * FROM manuscript_validations WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    res.json({
      manuscript: describeManuscript(manuscript),
      files,
      stages: stages.map((s) => ({ ...s, stage_label: STAGE_LABELS[s.to_stage] || s.to_stage })),
      evaluations,
      validations,
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
      `SELECT m.id, m.ref, m.title, m.current_stage, m.created_at, m.updated_at,
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
    if (!existsSync(file.file_path)) return res.status(404).json({ error: 'Fichier introuvable sur le serveur' });
    res.download(file.file_path, file.file_name);
  });

  // ─── ASSIGNATION ─────────────────────────────────────────
  router.post('/manuscripts/v2/:id/assign', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Action réservée à l\'éditeur' });
    }
    const { role, user_id } = req.body;
    const colMap = {
      evaluateur: 'assigned_evaluator_id',
      correcteur: 'assigned_corrector_id',
      editor: 'assigned_editor_id',
      infographiste: 'assigned_infographist_id',
      imprimeur: 'assigned_printer_id',
    };
    const col = colMap[role];
    if (!col) return res.status(400).json({ error: 'Rôle invalide' });
    if (user_id) {
      const target = db.prepare('SELECT id, role FROM admin_users WHERE id = ?').get(user_id);
      if (!target) return res.status(404).json({ error: 'Utilisateur introuvable' });
      // Accepter que super_admin/admin soient assignables à tous rôles
      if (!['super_admin', 'admin', role, 'editor'].includes(target.role)) {
        return res.status(400).json({ error: `Utilisateur n'a pas le rôle ${role}` });
      }
    }
    db.prepare(`UPDATE manuscripts SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(user_id || null, req.params.id);

    // Si on assigne un évaluateur et que le stage est 'submitted', transition auto vers 'in_evaluation'
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(req.params.id);
    if (role === 'evaluateur' && user_id && manuscript.current_stage === 'submitted') {
      const updated = transition(db, manuscript.id, 'in_evaluation',
        { role: req.admin.role, id: req.admin.id, label: req.admin.username },
        { note: `Assignation évaluateur: admin user ${user_id}` });
      notifyTransition(db, transporter, updated, 'in_evaluation',
        { role: req.admin.role, id: req.admin.id, label: req.admin.username }, siteUrl);
      return res.json({ success: true, stage: 'in_evaluation' });
    }
    res.json({ success: true });
  });

  // Transition générique (admin/super_admin uniquement)
  router.post('/manuscripts/v2/:id/transition', auth, csrfProtection, (req, res) => {
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Réservé au super administrateur' });
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
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
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
      notifyTransition(db, transporter, updated, nextStage, actor, siteUrl);

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
    if (!['super_admin', 'admin'].includes(req.admin.role)) {
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
  router.get('/admin-users/by-role', auth, (req, res) => {
    if (!['super_admin', 'admin', 'editor'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const { role } = req.query;
    if (!role) return res.status(400).json({ error: 'Paramètre role requis' });
    const rows = db.prepare(`SELECT id, username, role FROM admin_users WHERE role = ? OR role IN ('super_admin','admin')`).all(role);
    res.json(rows);
  });

  return router;
}
