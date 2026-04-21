import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, renameSync } from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { generateManuscriptRef, transition, STAGE_LABELS } from './manuscript-workflow.js';
import { notifyTransition, sendTransitionEmail } from './manuscript-emails.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS_DIR = join(__dirname, '..', 'manuscripts');
if (!existsSync(MANUSCRIPTS_DIR)) mkdirSync(MANUSCRIPTS_DIR, { recursive: true });

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const AUTHOR_SESSION_COOKIE = 'author_session';
const SESSION_TTL_DAYS = 7;

function buildMulterForKind(req, kind, sizeMB, mimePattern) {
  return multer({
    storage: multer.diskStorage({
      destination: (innerReq, file, cb) => {
        const manuscriptId = innerReq.params.id || innerReq.manuscriptId || 'tmp';
        const dir = join(MANUSCRIPTS_DIR, String(manuscriptId), kind);
        try { mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
        cb(null, dir);
      },
      filename: (innerReq, file, cb) => {
        const safe = (file.originalname || 'fichier').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: sizeMB * 1024 * 1024 },
    fileFilter: (innerReq, file, cb) => cb(null, mimePattern.test(file.originalname || '')),
  });
}

const originalUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = join(MANUSCRIPTS_DIR, 'pending');
      try { mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'manuscrit').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(pdf|doc|docx|odt|rtf)$/i.test(file.originalname || '')),
});

export function createAuthorRouter({ db, csrfProtection, sanitizeBody, authLimiter, transporter, cookieSecure, siteUrl }) {
  const router = Router();

  // Middleware d'auth pour l'auteur connecté
  function requireAuthorAuth(req, res, next) {
    const token = req.cookies?.[AUTHOR_SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const session = db.prepare(
      "SELECT a.* FROM author_sessions s JOIN authors a ON a.id = s.author_id WHERE s.token = ? AND s.expires_at > datetime('now')"
    ).get(token);
    if (!session) return res.status(401).json({ error: 'Session expirée' });
    req.author = session;
    next();
  }

  function createSession(authorId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO author_sessions (token, author_id, expires_at) VALUES (?, ?, ?)').run(token, authorId, expiresAt);
    return { token, expiresAt };
  }

  function setSessionCookie(res, token) {
    res.cookie(AUTHOR_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure,
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    });
  }

  // ─── REGISTER ─────────────────────────────────────────────
  router.post('/register', authLimiter, csrfProtection, sanitizeBody(['email', 'firstname', 'lastname', 'phone']), async (req, res) => {
    try {
      const { email, password, firstname, lastname, phone } = req.body;
      if (!email || !password || !firstname || !lastname) {
        return res.status(400).json({ error: 'Tous les champs obligatoires doivent être remplis' });
      }
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
      }
      const existing = db.prepare('SELECT id, password FROM authors WHERE email = ?').get(email);
      if (existing && existing.password) {
        return res.status(400).json({ error: 'Un compte auteur existe déjà avec cet email' });
      }
      const hash = await bcrypt.hash(password, 12);
      let authorId;
      if (existing) {
        // compte orphelin créé par migration → on active
        db.prepare('UPDATE authors SET password = ?, firstname = ?, lastname = ?, phone = ? WHERE id = ?')
          .run(hash, firstname, lastname, phone || null, existing.id);
        authorId = existing.id;
      } else {
        const r = db.prepare('INSERT INTO authors (email, password, firstname, lastname, phone) VALUES (?, ?, ?, ?, ?)')
          .run(email, hash, firstname, lastname, phone || null);
        authorId = r.lastInsertRowid;
      }
      const { token } = createSession(authorId);
      setSessionCookie(res, token);
      res.json({ success: true, id: authorId, firstname, lastname, email });
    } catch (err) {
      console.error('[AUTHOR] register error:', err.message);
      res.status(500).json({ error: 'Erreur lors de la création du compte' });
    }
  });

  // ─── LOGIN ────────────────────────────────────────────────
  router.post('/login', authLimiter, csrfProtection, sanitizeBody(['email']), async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
      const author = db.prepare('SELECT * FROM authors WHERE email = ?').get(email);
      if (!author || !author.password) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      const valid = await bcrypt.compare(password, author.password);
      if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      const { token } = createSession(author.id);
      setSessionCookie(res, token);
      res.json({
        id: author.id,
        email: author.email,
        firstname: author.firstname,
        lastname: author.lastname,
        phone: author.phone || '',
      });
    } catch (err) {
      console.error('[AUTHOR] login error:', err.message);
      res.status(500).json({ error: 'Erreur de connexion' });
    }
  });

  // ─── LOGOUT ───────────────────────────────────────────────
  router.post('/logout', requireAuthorAuth, (req, res) => {
    const token = req.cookies?.[AUTHOR_SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM author_sessions WHERE token = ?').run(token);
    res.clearCookie(AUTHOR_SESSION_COOKIE);
    res.json({ success: true });
  });

  router.get('/me', requireAuthorAuth, (req, res) => {
    const { id, email, firstname, lastname, phone } = req.author;
    res.json({ id, email, firstname, lastname, phone: phone || '' });
  });

  router.put('/profile', requireAuthorAuth, csrfProtection, sanitizeBody(['firstname', 'lastname', 'phone']), (req, res) => {
    const { firstname, lastname, phone } = req.body;
    db.prepare('UPDATE authors SET firstname = ?, lastname = ?, phone = ? WHERE id = ?')
      .run(firstname, lastname, phone || null, req.author.id);
    res.json({ success: true });
  });

  router.put('/password', requireAuthorAuth, csrfProtection, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
    }
    const valid = await bcrypt.compare(currentPassword, req.author.password);
    if (!valid) return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE authors SET password = ? WHERE id = ?').run(hash, req.author.id);
    res.json({ success: true });
  });

  // ─── FORGOT / RESET PASSWORD ──────────────────────────────
  router.post('/forgot-password', authLimiter, csrfProtection, sanitizeBody(['email']), (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });
    const author = db.prepare('SELECT id, firstname FROM authors WHERE email = ?').get(email);
    if (!author) return res.json({ success: true }); // anti-enumeration
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO author_password_resets (email, token, expires_at) VALUES (?, ?, ?)').run(email, token, expiresAt);
    const resetUrl = `${siteUrl}/auteur/mot-de-passe-oublie?token=${token}&email=${encodeURIComponent(email)}`;
    transporter?.sendMail({
      from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
      to: email,
      subject: 'Réinitialisation de votre mot de passe auteur',
      html: `<p>Bonjour ${escapeHtml(author.firstname || '')},</p><p>Vous avez demandé la réinitialisation de votre mot de passe.</p><p><a href="${resetUrl}" style="background:#10531a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Réinitialiser mon mot de passe</a></p><p>Ce lien expire dans 1 heure.</p>`,
    }).catch((err) => console.error('[AUTHOR] reset email error:', err.message));
    res.json({ success: true });
  });

  router.post('/reset-password', authLimiter, csrfProtection, async (req, res) => {
    const { email, token, password } = req.body;
    if (!email || !token || !password) return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
    }
    const reset = db.prepare("SELECT * FROM author_password_resets WHERE email = ? AND token = ? AND expires_at > datetime('now')").get(email, token);
    if (!reset) return res.status(400).json({ error: 'Lien expiré ou invalide' });
    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE authors SET password = ? WHERE email = ?').run(hash, email);
    db.prepare('DELETE FROM author_password_resets WHERE email = ?').run(email);
    res.json({ success: true });
  });

  // ─── MANUSCRITS ───────────────────────────────────────────
  router.get('/manuscripts', requireAuthorAuth, (req, res) => {
    const rows = db.prepare(
      `SELECT id, ref, title, genre, current_stage, created_at, updated_at
       FROM manuscripts WHERE author_id = ? ORDER BY created_at DESC`
    ).all(req.author.id);
    res.json(rows.map((r) => ({ ...r, stage_label: STAGE_LABELS[r.current_stage] || r.current_stage })));
  });

  router.post('/manuscripts', requireAuthorAuth, originalUpload.single('original'), (req, res) => {
    try {
      const { title, genre, synopsis, message } = req.body;
      if (!title) return res.status(400).json({ error: 'Titre requis' });
      if (!req.file) return res.status(400).json({ error: 'Fichier manuscrit requis' });

      const ref = generateManuscriptRef(db);
      const tx = db.transaction(() => {
        const result = db.prepare(
          `INSERT INTO manuscripts (ref, author_id, title, genre, synopsis, message, current_stage)
           VALUES (?, ?, ?, ?, ?, ?, 'submitted')`
        ).run(ref, req.author.id, title.trim(), genre?.trim() || null, synopsis || null, message || null);
        const manuscriptId = result.lastInsertRowid;
        // Déplacement du fichier vers le bon dossier
        const finalDir = join(MANUSCRIPTS_DIR, String(manuscriptId), 'original');
        mkdirSync(finalDir, { recursive: true });
        const finalPath = join(finalDir, req.file.filename);
        try {
          renameSync(req.file.path, finalPath);
        } catch (err) {
          console.warn('[AUTHOR] renameSync fallback:', err.message);
        }
        db.prepare(
          `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id)
           VALUES (?, 'original', 1, ?, ?, ?, ?, 'author', ?)`
        ).run(manuscriptId, finalPath, req.file.originalname || req.file.filename, req.file.size || null, req.file.mimetype || null, req.author.id);
        db.prepare(
          `INSERT INTO manuscript_stages (manuscript_id, from_stage, to_stage, actor_role, actor_id, actor_label, note)
           VALUES (?, NULL, 'submitted', 'author', ?, ?, ?)`
        ).run(manuscriptId, req.author.id, `${req.author.firstname} ${req.author.lastname}`, 'Soumission initiale');
        return manuscriptId;
      });
      const manuscriptId = tx();

      // Notifications
      const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(manuscriptId);
      sendTransitionEmail(transporter, manuscript, 'submitted', {
        type: 'author',
        email: req.author.email,
        firstname: req.author.firstname,
      }, siteUrl);

      res.json({ success: true, id: manuscriptId, ref });
    } catch (err) {
      console.error('[AUTHOR] submit manuscript error:', err.message);
      res.status(500).json({ error: 'Erreur soumission manuscrit' });
    }
  });

  router.get('/manuscripts/:id', requireAuthorAuth, (req, res) => {
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ? AND author_id = ?').get(req.params.id, req.author.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    const stages = db.prepare('SELECT * FROM manuscript_stages WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    // L'auteur voit uniquement les fichiers qui lui sont destinés
    const visibleKinds = "('original','correction','author_final','bat_cover')";
    const files = db.prepare(`SELECT id, kind, version, file_name, file_size, uploaded_at FROM manuscript_files WHERE manuscript_id = ? AND kind IN ${visibleKinds} ORDER BY uploaded_at ASC`).all(manuscript.id);
    const validations = db.prepare('SELECT * FROM manuscript_validations WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    // L'auteur voit le verdict (positive/negative) mais pas les notes internes
    const evaluations = db.prepare('SELECT verdict, recommendation, created_at FROM manuscript_evaluations WHERE manuscript_id = ? ORDER BY created_at ASC').all(manuscript.id);
    res.json({
      manuscript: { ...manuscript, stage_label: STAGE_LABELS[manuscript.current_stage] || manuscript.current_stage },
      stages: stages.map((s) => ({ ...s, stage_label: STAGE_LABELS[s.to_stage] || s.to_stage })),
      files,
      validations,
      evaluations,
    });
  });

  router.get('/manuscripts/:id/files/:fileId/download', requireAuthorAuth, (req, res) => {
    const file = db.prepare(
      `SELECT f.* FROM manuscript_files f
       JOIN manuscripts m ON m.id = f.manuscript_id
       WHERE f.id = ? AND m.id = ? AND m.author_id = ?`
    ).get(req.params.fileId, req.params.id, req.author.id);
    if (!file) return res.status(404).json({ error: 'Fichier introuvable' });
    // L'auteur ne voit que certains kinds
    if (!['original', 'correction', 'author_final', 'bat_cover'].includes(file.kind)) {
      return res.status(403).json({ error: 'Fichier non accessible' });
    }
    if (!existsSync(file.file_path)) return res.status(404).json({ error: 'Fichier introuvable sur le serveur' });
    res.download(file.file_path, file.file_name);
  });

  // ─── VALIDATIONS AUTEUR ───────────────────────────────────
  router.post('/manuscripts/:id/validate-correction', requireAuthorAuth, csrfProtection, (req, res) => {
    const { decision, comment } = req.body;
    if (!['approved', 'changes_requested'].includes(decision)) {
      return res.status(400).json({ error: 'Décision invalide' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ? AND author_id = ?').get(req.params.id, req.author.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.current_stage !== 'correction_author_review') {
      return res.status(400).json({ error: `Validation impossible à ce stade (${manuscript.current_stage})` });
    }
    db.prepare(
      `INSERT INTO manuscript_validations (manuscript_id, kind, decision, comment, author_id)
       VALUES (?, 'correction', ?, ?, ?)`
    ).run(manuscript.id, decision, comment || null, req.author.id);
    const nextStage = decision === 'approved' ? 'in_editorial' : 'in_correction';
    const actor = { role: 'author', id: req.author.id, label: `${req.author.firstname} ${req.author.lastname}` };
    const updated = transition(db, manuscript.id, nextStage, actor, { note: `Validation correction : ${decision}${comment ? ' — ' + comment : ''}` });
    notifyTransition(db, transporter, updated, nextStage, actor, siteUrl);
    res.json({ success: true, stage: nextStage });
  });

  router.post('/manuscripts/:id/validate-bat', requireAuthorAuth, csrfProtection, (req, res) => {
    const { decision, comment } = req.body;
    if (!['approved', 'changes_requested'].includes(decision)) {
      return res.status(400).json({ error: 'Décision invalide' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscripts WHERE id = ? AND author_id = ?').get(req.params.id, req.author.id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    if (manuscript.current_stage !== 'bat_author_review') {
      return res.status(400).json({ error: `Validation BAT impossible à ce stade (${manuscript.current_stage})` });
    }
    db.prepare(
      `INSERT INTO manuscript_validations (manuscript_id, kind, decision, comment, author_id)
       VALUES (?, 'bat', ?, ?, ?)`
    ).run(manuscript.id, decision, comment || null, req.author.id);
    const nextStage = decision === 'approved' ? 'print_preparation' : 'cover_design';
    const actor = { role: 'author', id: req.author.id, label: `${req.author.firstname} ${req.author.lastname}` };
    const updated = transition(db, manuscript.id, nextStage, actor, { note: `Validation BAT : ${decision}${comment ? ' — ' + comment : ''}` });
    notifyTransition(db, transporter, updated, nextStage, actor, siteUrl);
    res.json({ success: true, stage: nextStage });
  });

  return { router, requireAuthorAuth };
}

// Helper exporté pour être réutilisé par manuscript-routes.js
export function createManuscriptMulter(kindName, sizeMB, mimePattern) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const manuscriptId = req.params.id || req.params.manuscriptId || 'tmp';
        const dir = join(MANUSCRIPTS_DIR, String(manuscriptId), kindName);
        try { mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const safe = (file.originalname || 'fichier').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: sizeMB * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, mimePattern.test(file.originalname || '')),
  });
}

// eslint-disable-next-line no-unused-vars
const _ref_buildMulterForKind = buildMulterForKind;
