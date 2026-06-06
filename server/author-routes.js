import { Router } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync, renameSync } from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { generateManuscriptRef, transition, STAGE_LABELS, MANUSCRIPT_EVENTS } from './manuscript-workflow.js';
import { notifyTransition, sendTransitionEmail, getAuthorPreferences } from './manuscript-emails.js';

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

export function createAuthorRouter({ db, csrfProtection, sanitizeBody, authLimiter, transporter, cookieSecure, siteUrl, dolibarrPool }) {
  const router = Router();

  // Hache un token avant stockage/lookup — le token brut ne vit que dans le
  // cookie HttpOnly de l'auteur, jamais en base.
  function hashSessionToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  // Middleware d'auth pour l'auteur connecté
  function requireAuthorAuth(req, res, next) {
    const token = req.cookies?.[AUTHOR_SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Non authentifié' });
    const session = db.prepare(
      "SELECT a.* FROM author_sessions s JOIN authors a ON a.id = s.author_id WHERE s.token = ? AND s.expires_at > datetime('now')"
    ).get(hashSessionToken(token));
    if (!session) return res.status(401).json({ error: 'Session expirée' });
    req.author = session;
    next();
  }

  function createSession(authorId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO author_sessions (token, author_id, expires_at) VALUES (?, ?, ?)').run(hashSessionToken(token), authorId, expiresAt);
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
    if (token) db.prepare('DELETE FROM author_sessions WHERE token = ?').run(hashSessionToken(token));
    res.clearCookie(AUTHOR_SESSION_COOKIE);
    res.json({ success: true });
  });

  router.get('/me', requireAuthorAuth, (req, res) => {
    const { id, email, firstname, lastname, phone, bio, slug, photo_url, website,
      social_twitter, social_instagram, social_linkedin, social_facebook, public_listed } = req.author;
    res.json({
      id, email, firstname, lastname,
      phone: phone || '',
      bio: bio || '',
      slug: slug || null,
      photo_url: photo_url || null,
      website: website || null,
      socials: {
        twitter: social_twitter || null,
        instagram: social_instagram || null,
        linkedin: social_linkedin || null,
        facebook: social_facebook || null,
      },
      public_listed: !!public_listed,
    });
  });

  // PUT /api/author/profile-public — édition par l'auteur de son profil public
  router.put('/profile-public', requireAuthorAuth, csrfProtection, sanitizeBody(['bio', 'website', 'social_twitter', 'social_instagram', 'social_linkedin', 'social_facebook', 'photo_url']), (req, res) => {
    const { bio, photo_url, website, social_twitter, social_instagram, social_linkedin, social_facebook, public_listed } = req.body;
    db.prepare(
      `UPDATE authors SET
         bio = ?, photo_url = ?, website = ?,
         social_twitter = ?, social_instagram = ?, social_linkedin = ?, social_facebook = ?,
         public_listed = ?
       WHERE id = ?`
    ).run(
      bio || null,
      photo_url || null,
      website || null,
      social_twitter || null,
      social_instagram || null,
      social_linkedin || null,
      social_facebook || null,
      public_listed ? 1 : 0,
      req.author.id,
    );
    res.json({ success: true });
  });

  // GET /api/author/dashboard — synthèse manuscrits + contrats + royalties + ventes
  router.get('/dashboard', requireAuthorAuth, async (req, res) => {
    try {
      const author = req.author;
      const displayName = ((author.display_name || `${author.firstname} ${author.lastname}`) || '').trim();

      // 1. Manuscrits (toutes étapes)
      const manuscripts = db.prepare(
        `SELECT id, ref, title, genre, current_stage, created_at, updated_at
         FROM manuscripts WHERE author_id = ? ORDER BY created_at DESC`
      ).all(author.id).map((r) => ({ ...r, stage_label: STAGE_LABELS[r.current_stage] || r.current_stage }));

      const manuscriptStats = {
        total: manuscripts.length,
        in_progress: manuscripts.filter((m) => !['printed', 'evaluation_negative'].includes(m.current_stage)).length,
        action_required: manuscripts.filter((m) => ['correction_author_review', 'bat_author_review'].includes(m.current_stage)).length,
        printed: manuscripts.filter((m) => m.current_stage === 'printed').length,
      };

      // 2. Contrats Dolibarr liés à l'auteur (par dolibarr_thirdparty_id ou par nom)
      let contracts = [];
      let books = [];
      let salesStats = { total_units: 0, total_revenue_ht: 0, last_12_months_units: 0, last_12_months_revenue_ht: 0 };
      let royalties = { total_due: 0, by_book: [], year: new Date().getFullYear() };

      if (dolibarrPool && (author.dolibarr_thirdparty_id || displayName)) {
        // Recherche des contrats : prio dolibarr_thirdparty_id, fallback nom de société
        let contractWhere = '';
        let contractParams = [];
        if (author.dolibarr_thirdparty_id) {
          contractWhere = 'c.fk_soc = ?';
          contractParams = [author.dolibarr_thirdparty_id];
        } else {
          contractWhere = 's.nom LIKE ?';
          contractParams = [`%${displayName.replace(/[%_]/g, '')}%`];
        }
        try {
          const [rows] = await dolibarrPool.query(
            `SELECT c.rowid AS id, c.ref, c.statut, c.date_contrat,
                    ce.book_title, ce.book_isbn, ce.contract_type,
                    ce.royalty_rate_print, ce.royalty_rate_digital, ce.royalty_threshold, ce.free_author_copies
             FROM llx_contrat c
             JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
             JOIN llx_societe s ON s.rowid = c.fk_soc
             WHERE ${contractWhere}
             ORDER BY c.date_contrat DESC, c.rowid DESC
             LIMIT 100`,
            contractParams,
          );
          contracts = rows.map((r) => ({
            id: r.id,
            ref: r.ref,
            statut: r.statut,
            statut_label: r.statut === 0 ? 'Brouillon' : r.statut === 1 ? 'Actif' : r.statut === 2 ? 'Fermé' : `Statut ${r.statut}`,
            date: r.date_contrat,
            book_title: r.book_title,
            book_isbn: r.book_isbn,
            contract_type: r.contract_type,
            royalty_rate: r.royalty_rate_print || 0,
            threshold: r.royalty_threshold || 0,
            free_copies: r.free_author_copies || 0,
          }));
        } catch (e) {
          console.warn('[AUTHOR/DASHBOARD] contracts:', e.message);
        }

        // Bibliographie publiée (livres dont l'auteur match)
        if (displayName) {
          const pat = `%${displayName.replace(/[%_]/g, '')}%`;
          try {
            const [rows] = await dolibarrPool.query(
              `SELECT p.rowid AS id, p.ref, p.label, p.barcode, p.price_ttc,
                      pe.publication_year, pe.editeur
               FROM llx_product p
               LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
               WHERE p.tosell = 1 AND p.fk_product_type = 0
                 AND pe.auteur LIKE ?
               ORDER BY pe.publication_year DESC, p.label ASC
               LIMIT 100`,
              [pat],
            );
            books = rows;
          } catch (e) {
            console.warn('[AUTHOR/DASHBOARD] books:', e.message);
          }
        }

        // Stats ventes globales sur l'ensemble des ISBN de l'auteur (via book_isbn dans contrats)
        // Et calcul royalties simplifié (mode cumulatif sur l'année en cours)
        const isbns = contracts
          .map((c) => (c.book_isbn || '').replace(/[-\s]/g, ''))
          .filter(Boolean);

        if (isbns.length) {
          // Total cumulé + revenu HT
          try {
            const placeholders = isbns.map(() => '?').join(',');
            const [[total]] = await dolibarrPool.query(
              `SELECT COALESCE(SUM(fd.qty), 0) AS units, COALESCE(SUM(fd.total_ht), 0) AS revenue
               FROM llx_facturedet fd
               JOIN llx_facture f ON f.rowid = fd.fk_facture
               JOIN llx_product p ON p.rowid = fd.fk_product
               WHERE f.fk_statut >= 1 AND fd.qty > 0
                 AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') IN (${placeholders})`,
              isbns,
            );
            salesStats.total_units = Number(total.units);
            salesStats.total_revenue_ht = Math.round(Number(total.revenue));
          } catch (e) {
            console.warn('[AUTHOR/DASHBOARD] sales total:', e.message);
          }

          // Dernier 12 mois
          try {
            const placeholders = isbns.map(() => '?').join(',');
            const [[recent]] = await dolibarrPool.query(
              `SELECT COALESCE(SUM(fd.qty), 0) AS units, COALESCE(SUM(fd.total_ht), 0) AS revenue
               FROM llx_facturedet fd
               JOIN llx_facture f ON f.rowid = fd.fk_facture
               JOIN llx_product p ON p.rowid = fd.fk_product
               WHERE f.fk_statut >= 1 AND fd.qty > 0
                 AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') IN (${placeholders})
                 AND f.datef >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)`,
              isbns,
            );
            salesStats.last_12_months_units = Number(recent.units);
            salesStats.last_12_months_revenue_ht = Math.round(Number(recent.revenue));
          } catch (e) {
            console.warn('[AUTHOR/DASHBOARD] sales 12m:', e.message);
          }

          // Royalties par livre, sur l'année en cours, mode cumulatif
          const year = new Date().getFullYear();
          royalties.year = year;
          const dateTo = `${year}-12-31`;
          const dateFrom = `${year}-01-01`;
          for (const c of contracts) {
            const isbn = (c.book_isbn || '').replace(/[-\s]/g, '');
            if (!isbn) continue;
            try {
              const [[cumRow]] = await dolibarrPool.query(
                `SELECT COALESCE(SUM(fd.qty), 0) AS units
                 FROM llx_facturedet fd
                 JOIN llx_facture f ON f.rowid = fd.fk_facture
                 JOIN llx_product p ON p.rowid = fd.fk_product
                 WHERE f.fk_statut >= 1 AND fd.qty > 0
                   AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
                   AND f.datef <= ?`,
                [isbn, dateTo],
              );
              const cumulative = Number(cumRow.units);

              const [[periodRow]] = await dolibarrPool.query(
                `SELECT COALESCE(SUM(fd.qty), 0) AS units, COALESCE(SUM(fd.total_ht), 0) AS gross
                 FROM llx_facturedet fd
                 JOIN llx_facture f ON f.rowid = fd.fk_facture
                 JOIN llx_product p ON p.rowid = fd.fk_product
                 WHERE f.fk_statut >= 1 AND fd.qty > 0
                   AND REPLACE(REPLACE(p.barcode, '-', ''), ' ', '') = ?
                   AND f.datef BETWEEN ? AND ?`,
                [isbn, dateFrom, dateTo],
              );
              const unitsPeriod = Number(periodRow.units);
              const grossPeriod = Number(periodRow.gross);
              if (unitsPeriod === 0) continue;

              const threshold = Number(c.threshold) || 0;
              const freeCopies = Number(c.free_copies) || 0;
              const rate = Number(c.royalty_rate) || 0;
              const cumBefore = cumulative - unitsPeriod;
              const thresholdPlusFree = threshold + freeCopies;
              let unitsOver = 0;
              if (cumulative > thresholdPlusFree) {
                unitsOver = cumBefore >= thresholdPlusFree ? unitsPeriod : (cumulative - thresholdPlusFree);
              }
              const avgHt = unitsPeriod > 0 ? grossPeriod / unitsPeriod : 0;
              const dueAmount = unitsOver * avgHt * (rate / 100);
              if (dueAmount > 0) {
                royalties.by_book.push({
                  contract_id: c.id,
                  contract_ref: c.ref,
                  book_title: c.book_title,
                  units_period: unitsPeriod,
                  units_over_threshold: Math.round(unitsOver * 100) / 100,
                  rate,
                  royalty_due: Math.round(dueAmount),
                });
                royalties.total_due += dueAmount;
              }
            } catch (e) {
              console.warn('[AUTHOR/DASHBOARD] royalty calc:', e.message);
            }
          }
          royalties.total_due = Math.round(royalties.total_due);
        }
      }

      res.json({
        author: {
          id: author.id,
          firstname: author.firstname,
          lastname: author.lastname,
          email: author.email,
          slug: author.slug || null,
          public_listed: !!author.public_listed,
        },
        manuscripts,
        manuscript_stats: manuscriptStats,
        contracts,
        books: books.map((b) => ({
          id: b.id,
          ref: b.ref,
          label: b.label,
          price: Number(b.price_ttc || 0),
          year: b.publication_year || null,
          editor: b.editeur || null,
        })),
        sales: salesStats,
        royalties,
      });
    } catch (err) {
      console.error('[AUTHOR/DASHBOARD] error:', err.message);
      res.status(500).json({ error: 'Erreur chargement dashboard' });
    }
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
      const { title, genre, synopsis, biography, message } = req.body;
      if (!title) return res.status(400).json({ error: 'Titre requis' });
      if (!req.file) return res.status(400).json({ error: 'Fichier manuscrit requis' });

      const ref = generateManuscriptRef(db);
      const tx = db.transaction(() => {
        const result = db.prepare(
          `INSERT INTO manuscripts (ref, author_id, title, genre, synopsis, biography, message, current_stage)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')`
        ).run(ref, req.author.id, title.trim(), genre?.trim() || null, synopsis || null, biography || null, message || null);
        const manuscriptId = result.lastInsertRowid;
        // Mettre à jour la bio sur le profil auteur si fournie (réutilisable pour les prochains manuscrits)
        if (biography && String(biography).trim()) {
          db.prepare('UPDATE authors SET bio = ? WHERE id = ?').run(String(biography).trim(), req.author.id);
        }
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
      stages: stages
        // L'auteur ne voit que les transitions de stage + les évènements qui le concernent
        // (devis envoyé, contrat transmis) — pas les actions internes (devis généré/supprimé).
        .filter((s) => !s.event || MANUSCRIPT_EVENTS[s.event]?.authorVisible)
        .map((s) => ({
          ...s,
          stage_label: s.event
            ? (MANUSCRIPT_EVENTS[s.event]?.label || s.event)
            : (STAGE_LABELS[s.to_stage] || s.to_stage),
        })),
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

  // ─── NOTIFICATIONS IN-APP (cloche) ──────────────────────────
  router.get('/notifications', requireAuthorAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
      const rows = db.prepare(
        `SELECT * FROM author_notifications
         WHERE author_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      ).all(req.author.id, limit);
      res.json(rows.map((n) => ({ ...n, is_read: !!n.is_read, action_required: !!n.action_required })));
    } catch (err) {
      console.error('GET /author/notifications error:', err.message);
      res.status(500).json({ error: 'Erreur chargement notifications' });
    }
  });

  router.get('/notifications/unread-count', requireAuthorAuth, (req, res) => {
    try {
      const row = db.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN action_required = 1 THEN 1 ELSE 0 END) AS action_required
         FROM author_notifications
         WHERE author_id = ? AND is_read = 0`
      ).get(req.author.id);
      res.json({ unread: row?.total || 0, action_required: row?.action_required || 0 });
    } catch (err) {
      console.error('GET /author/notifications/unread-count error:', err.message);
      res.json({ unread: 0, action_required: 0 });
    }
  });

  router.post('/notifications/:id/read', requireAuthorAuth, csrfProtection, (req, res) => {
    try {
      const result = db.prepare(
        `UPDATE author_notifications
         SET is_read = 1, read_at = CURRENT_TIMESTAMP
         WHERE id = ? AND author_id = ? AND is_read = 0`
      ).run(req.params.id, req.author.id);
      res.json({ updated: result.changes });
    } catch (err) {
      console.error('POST /author/notifications/:id/read error:', err.message);
      res.status(500).json({ error: 'Erreur' });
    }
  });

  router.post('/notifications/read-all', requireAuthorAuth, csrfProtection, (req, res) => {
    try {
      const result = db.prepare(
        `UPDATE author_notifications
         SET is_read = 1, read_at = CURRENT_TIMESTAMP
         WHERE author_id = ? AND is_read = 0`
      ).run(req.author.id);
      res.json({ updated: result.changes });
    } catch (err) {
      console.error('POST /author/notifications/read-all error:', err.message);
      res.status(500).json({ error: 'Erreur' });
    }
  });

  // ─── PRÉFÉRENCES NOTIFICATION ──────────────────────────────
  router.get('/preferences', requireAuthorAuth, (req, res) => {
    res.json(getAuthorPreferences(db, req.author.id));
  });

  router.put('/preferences', requireAuthorAuth, csrfProtection, (req, res) => {
    try {
      const { workflow, cover, print, reminders } = req.body || {};
      const prefs = {
        workflow: workflow !== false,
        cover: cover !== false,
        print: print !== false,
        reminders: reminders !== false,
      };
      db.prepare('UPDATE authors SET notification_prefs = ? WHERE id = ?')
        .run(JSON.stringify(prefs), req.author.id);
      res.json({ ...prefs, critical: true });
    } catch (err) {
      console.error('PUT /author/preferences error:', err.message);
      res.status(500).json({ error: 'Erreur' });
    }
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
        const manuscriptId = String(req.params.id || req.params.manuscriptId || '');
        // Anti path traversal : l'identifiant doit être strictement numérique,
        // sinon un id du type '..' permettrait d'écrire hors de MANUSCRIPTS_DIR.
        if (!/^\d+$/.test(manuscriptId)) {
          return cb(new Error('Identifiant de manuscrit invalide'));
        }
        const dir = join(MANUSCRIPTS_DIR, manuscriptId, kindName);
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

 
const _ref_buildMulterForKind = buildMulterForKind;
