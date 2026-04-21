import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { existsSync } from 'fs';
import rateLimit from 'express-rate-limit';

const __dirname = dirname(fileURLToPath(import.meta.url));

// HTML escape for email templates
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const CONFIG_PATH = join(__dirname, 'site-config.json');
const UPLOADS_DIR = join(__dirname, '..', 'public', 'uploads');
const MANUSCRIPTS_DIR = join(__dirname, '..', 'manuscripts');

// Ensure dirs exist
[UPLOADS_DIR, MANUSCRIPTS_DIR].forEach((d) => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// Multer for slider images
const sliderUpload = multer({
  storage: multer.diskStorage({
    destination: join(__dirname, '..', 'public', 'images', 'slider'),
    filename: (req, file, cb) => {
      const ext = file.originalname.split('.').pop();
      cb(null, `slide-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(jpg|jpeg|png|webp)$/i.test(file.originalname));
  },
});

// Multer for upcoming book covers
const COVERS_DIR = join(__dirname, '..', 'public', 'images', 'couvertures');
if (!existsSync(COVERS_DIR)) mkdirSync(COVERS_DIR, { recursive: true });

const coverUpload = multer({
  storage: multer.diskStorage({
    destination: COVERS_DIR,
    filename: (req, file, cb) => {
      const ext = file.originalname.split('.').pop();
      cb(null, `cover-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(jpg|jpeg|png|webp)$/i.test(file.originalname));
  },
});

// Multer for manuscripts
const manuscriptUpload = multer({
  storage: multer.diskStorage({
    destination: MANUSCRIPTS_DIR,
    filename: (req, file, cb) => {
      const ext = file.originalname.split('.').pop();
      cb(null, `manuscrit-${Date.now()}.${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /\.(pdf|doc|docx)$/i.test(file.originalname));
  },
});

// ─── CONFIG HELPERS ─────────────────────────────────────────
function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// ─── ADMIN AUTH MIDDLEWARE ───────────────────────────────────
export function adminAuth(db) {
  return (req, res, next) => {
    const session = req.cookies?.admin_session;
    if (!session) return res.status(401).json({ error: 'Non authentifié' });

    const admin = db.prepare('SELECT * FROM admin_users WHERE session_token = ?').get(session);
    if (!admin) return res.status(401).json({ error: 'Session invalide' });

    req.admin = admin;
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== 'super_admin') return res.status(403).json({ error: 'Action réservée au super administrateur' });
  next();
}

// Middleware: bloque les librarians sur les routes non-books
// Les librarians ne peuvent que: /api/admin/books/*, /me, /password, /logout
export function blockLibrarian(req, res, next) {
  if (req.admin?.role === 'librarian') {
    return res.status(403).json({ error: 'Accès réservé au module Livres pour votre profil' });
  }
  next();
}

// ─── CREATE ROUTER ──────────────────────────────────────────
export { setupAdminRoutes };
export function createAdminRouter(opts) { return setupAdminRoutes(null, opts); }
function setupAdminRoutes(appRef, { app: appFromOpts, db, csrfProtection, sanitizeBody, transporter, cache, dolibarrPool, cookieSecure = false, authLimiter }) {
  const app = appRef || appFromOpts;
  const auth = adminAuth(db);

  // ─── Role-based access control ─────────────────────────────
  // Chaque rôle restreint a une whitelist de paths autorisés.
  // super_admin et admin ont accès à tout (null = aucune restriction).
  const COMMON_PATHS = [
    /^\/api\/admin\/me$/,
    /^\/api\/admin\/password$/,
    /^\/api\/admin\/logout$/,
    /^\/api\/admin\/login$/,
    /^\/api\/admin\/config$/, // GET lecture seule pour le front
  ];
  const ROLE_ALLOWED_PATHS = {
    editor: [
      ...COMMON_PATHS,
      /^\/api\/admin\/books(\/.*)?$/,
      /^\/api\/admin\/stats(\/.*)?$/,
      /^\/api\/admin\/slides(\/.*)?$/,
      /^\/api\/admin\/manuscripts(\/.*)?$/,
    ],
    support: [
      ...COMMON_PATHS,
      /^\/api\/admin\/stats(\/.*)?$/,
      /^\/api\/admin\/contact(\/.*)?$/,
      /^\/api\/admin\/faq(\/.*)?$/,
      /^\/api\/admin\/newsletter(\/.*)?$/,
    ],
    librarian: [
      ...COMMON_PATHS,
      /^\/api\/admin\/books(\/.*)?$/,
      /^\/api\/admin\/stock(\/.*)?$/,
    ],
  };
  app.use('/api/admin', (req, res, next) => {
    const session = req.cookies?.admin_session;
    if (!session) return next();
    const admin = db.prepare('SELECT role FROM admin_users WHERE session_token = ?').get(session);
    const allowedPaths = ROLE_ALLOWED_PATHS[admin?.role];
    if (allowedPaths) {
      const path = req.originalUrl.split('?')[0];
      const allowed = allowedPaths.some((re) => re.test(path));
      if (!allowed) {
        return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
      }
    }
    next();
  });

  // Create admin_users table
  db.exec(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    session_token TEXT,
    role TEXT DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Add role column if missing
  try { db.exec("ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'admin'"); } catch (err) { console.warn('Role column already exists or error:', err.message); }

  // Activity log table
  db.exec(`CREATE TABLE IF NOT EXISTS admin_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_username TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  function logActivity(username, action, details = '') {
    db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)').run(username, action, details);
  }

  // Create contact_messages table
  db.exec(`CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    department TEXT,
    subject TEXT,
    message TEXT NOT NULL,
    read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Create manuscript_submissions table
  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    firstname TEXT NOT NULL,
    lastname TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    title TEXT NOT NULL,
    genre TEXT,
    synopsis TEXT,
    message TEXT,
    file_path TEXT,
    file_name TEXT,
    status TEXT DEFAULT 'reçu',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Ensure default admin exists
  const existingAdmin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
  if (!existingAdmin) {
    const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD || crypto.randomBytes(16).toString('hex');
    const hash = bcrypt.hashSync(defaultPwd, 12);
    db.prepare("INSERT INTO admin_users (username, password, role) VALUES (?, ?, 'super_admin')").run('admin', hash);
    console.warn(`[ADMIN] Compte admin créé. Mot de passe: ${defaultPwd} — CHANGEZ-LE IMMÉDIATEMENT`);
  }

  // ─── AUTH ROUTES ────────────────────────────────────────────

  const adminLoginLimiter = authLimiter || rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Trop de tentatives, réessayez dans 15 minutes' }, validate: { xForwardedForHeader: false } });
  app.post('/api/admin/login', adminLoginLimiter, csrfProtection, (req, res) => {
    const { username, password } = req.body;
    const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE admin_users SET session_token = ? WHERE id = ?').run(token, admin.id);

    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure,
      maxAge: 24 * 60 * 60 * 1000, // 24h
    });
    logActivity(admin.username, 'login', 'Connexion admin');
    res.json({ success: true, username: admin.username, role: admin.role || 'admin' });
  });

  app.post('/api/admin/logout', auth, (req, res) => {
    db.prepare('UPDATE admin_users SET session_token = NULL WHERE id = ?').run(req.admin.id);
    res.clearCookie('admin_session');
    res.json({ success: true });
  });

  app.get('/api/admin/me', auth, (req, res) => {
    res.json({ username: req.admin.username, role: req.admin.role || 'admin' });
  });

  app.put('/api/admin/password', auth, csrfProtection, (req, res) => {
    const { current, newPassword } = req.body;
    if (!bcrypt.compareSync(current, req.admin.password)) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    }
    if (!newPassword || newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
    }
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE admin_users SET password = ? WHERE id = ?').run(hash, req.admin.id);
    res.json({ success: true });
  });

  // ─── SITE CONFIG ROUTES ─────────────────────────────────────

  // Public: get config (for frontend)
  app.get('/api/admin/config', (req, res) => {
    try {
      const config = readConfig();
      // Don't expose SMTP credentials to public
      const { smtp, ...publicConfig } = config;
      // Use smtp variable to avoid linter error
      if (smtp) { /* nothing */ }
      res.json(publicConfig);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erreur lecture config' });
    }
  });

  // Admin: get full config (including SMTP)
  app.get('/api/admin/config/full', auth, (req, res) => {
    try {
      res.json(readConfig());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Erreur lecture config' });
    }
  });

  // Admin: update config section
  app.put('/api/admin/config', auth, csrfProtection, (req, res) => {
    try {
      const config = readConfig();
      const updates = req.body;

      // Merge updates into config
      for (const [key, value] of Object.entries(updates)) {
        config[key] = value;
      }

      writeConfig(config);
      logActivity(req.admin.username, 'update_config', `Sections modifiées: ${Object.keys(updates).join(', ')}`);

      // Reload SMTP if changed
      if (updates.smtp && transporter) {
        try {
          const s = updates.smtp;
          const opts = { host: s.host, port: s.port, secure: s.secure };
          if (s.user && s.pass) {
            opts.auth = { user: s.user, pass: s.pass };
          } else {
            opts.ignoreTLS = true;
          }
          Object.assign(transporter.options, opts);
        } catch (err) {
          console.error('SMTP config apply error:', err);
        }
      }

      // Reload YouTube channel ID if changed
      if (updates.youtube_channel_id) {
        cache?.keys()
          .filter((k) => k.startsWith('youtube:'))
          .forEach((k) => cache.del(k));
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Config update error:', err);
      res.status(500).json({ error: 'Erreur sauvegarde config' });
    }
  });

  // Admin: upload slider image
  app.post('/api/admin/config/slider-image', auth, sliderUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucune image' });
    res.json({ path: `/images/slider/${req.file.filename}` });
  });

  // Admin: upload upcoming book cover
  app.post('/api/admin/config/cover-image', auth, coverUpload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucune image' });
    res.json({ path: `/images/couvertures/${req.file.filename}` });
  });

  // ─── CONTACT FORM (PUBLIC) ──────────────────────────────────

  app.post('/api/admin/contact', csrfProtection, sanitizeBody(['name', 'email', 'subject', 'message']), (req, res) => {
    try {
      const { name, email, department, subject, message } = req.body;
      if (!name || !email || !message) {
        return res.status(400).json({ error: 'Champs requis manquants' });
      }

      db.prepare(
        'INSERT INTO contact_messages (name, email, department, subject, message) VALUES (?, ?, ?, ?, ?)'
      ).run(name, email, department || null, subject || null, message);

      // Send notification email routed by department
      const config = readConfig();
      const dept = config.contact?.departments?.find((d) => d.value === department);
      const targetEmail = dept?.email || config.contact?.emails?.[0] || 'direction@senharmattan.com';

      transporter.sendMail({
        from: '"Sen Harmattan Site" <noreply@senharmattan.com>',
        to: targetEmail,
        replyTo: email,
        subject: `[Contact${dept ? ' - ' + dept.label : ''}] ${subject || 'Nouveau message'}`,
        html: `
          <h3>Nouveau message de contact</h3>
          <p><strong>De :</strong> ${escapeHtml(name)} (${escapeHtml(email)})</p>
          <p><strong>Service :</strong> ${escapeHtml(dept?.label || department || 'Non spécifié')}</p>
          <p><strong>Sujet :</strong> ${escapeHtml(subject || 'Non spécifié')}</p>
          <hr />
          <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
          <br /><small>Ce message a été envoyé depuis le formulaire de contact du site senharmattan.com</small>
        `,
      }).catch((err) => console.error('[CONTACT] Email error:', err.message));

      res.json({ success: true });
    } catch (err) {
      console.error('POST /contact error:', err.message);
      res.status(500).json({ error: 'Erreur envoi message' });
    }
  });

  // Admin: list contact messages
  app.get('/api/admin/contact/messages', auth, (req, res) => {
    const messages = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
    res.json(messages);
  });

  // Admin: mark message as read
  app.put('/api/admin/contact/messages/:id/read', auth, (req, res) => {
    db.prepare('UPDATE contact_messages SET read = 1 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Admin: delete message
  app.delete('/api/admin/contact/messages/:id', auth, csrfProtection, (req, res) => {
    const msg = db.prepare('SELECT name, email FROM contact_messages WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM contact_messages WHERE id = ?').run(req.params.id);
    logActivity(req.admin.username, 'delete_message', `Message de ${msg?.name || 'inconnu'} supprimé`);
    res.json({ success: true });
  });

  // ─── MANUSCRIPT SUBMISSION (PUBLIC) ─────────────────────────

  app.post('/api/admin/manuscripts', csrfProtection, manuscriptUpload.single('file'), (req, res) => {
    try {
      const { firstname, lastname, email, phone, title, genre, synopsis, message } = req.body;
      if (!firstname || !lastname || !email || !title) {
        return res.status(400).json({ error: 'Champs requis manquants' });
      }

      const filePath = req.file?.path || null;
      const fileName = req.file?.originalname || null;

      db.prepare(
        `INSERT INTO manuscript_submissions
         (firstname, lastname, email, phone, title, genre, synopsis, message, file_path, file_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(firstname, lastname, email, phone || null, title, genre || null, synopsis || null, message || null, filePath, fileName);

      // Notify admin
      const config = readConfig();
      const adminEmail = config.contact?.emails?.[0] || 'direction@senharmattan.com';

      transporter.sendMail({
        from: '"Sen Harmattan Site" <noreply@senharmattan.com>',
        to: adminEmail,
        subject: `[Manuscrit] Nouvelle soumission : ${title}`,
        html: `
          <h3>Nouvelle soumission de manuscrit</h3>
          <p><strong>Auteur :</strong> ${escapeHtml(firstname)} ${escapeHtml(lastname)}</p>
          <p><strong>Email :</strong> ${escapeHtml(email)}</p>
          <p><strong>Téléphone :</strong> ${escapeHtml(phone || 'Non renseigné')}</p>
          <p><strong>Titre :</strong> ${escapeHtml(title)}</p>
          <p><strong>Genre :</strong> ${escapeHtml(genre || 'Non spécifié')}</p>
          <p><strong>Fichier :</strong> ${escapeHtml(fileName || 'Non joint')}</p>
          <hr />
          <p><strong>Synopsis :</strong><br>${(synopsis || 'Non fourni').replace(/\n/g, '<br>')}</p>
          <p><strong>Message :</strong><br>${(message || '').replace(/\n/g, '<br>')}</p>
        `,
      }).catch((err) => console.error('[MANUSCRIPT] Email error:', err.message));

      // Confirmation to author
      transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
        to: email,
        subject: 'Confirmation de réception de votre manuscrit',
        html: `
          <p>Bonjour ${escapeHtml(firstname)},</p>
          <p>Nous avons bien reçu votre manuscrit <strong>« ${escapeHtml(title)} »</strong>.</p>
          <p>Notre comité éditorial l'examinera et vous répondra dans un délai maximum de 12 semaines.</p>
          <p>Cordialement,<br>L'équipe éditoriale de L'Harmattan Sénégal</p>
        `,
      }).catch((err) => console.error('[MANUSCRIPT] Confirmation email error:', err.message));

      res.json({ success: true });
    } catch (err) {
      console.error('POST /manuscripts error:', err.message);
      res.status(500).json({ error: 'Erreur soumission manuscrit' });
    }
  });

  // Admin: list manuscripts
  app.get('/api/admin/manuscripts', auth, (req, res) => {
    const submissions = db.prepare('SELECT * FROM manuscript_submissions ORDER BY created_at DESC').all();
    res.json(submissions);
  });

  // Admin: update manuscript status
  app.put('/api/admin/manuscripts/:id/status', auth, csrfProtection, (req, res) => {
    const { status } = req.body;
    const validStatuses = ['reçu', 'en lecture', 'accepté', 'refusé'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Statut invalide' });
    }
    const manuscript = db.prepare('SELECT * FROM manuscript_submissions WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE manuscript_submissions SET status = ? WHERE id = ?').run(status, req.params.id);
    logActivity(req.admin.username, 'update_manuscript', `Manuscrit "${manuscript?.title}" → ${status}`);

    // Notify author by email on status change
    if (manuscript?.email && (status === 'accepté' || status === 'refusé' || status === 'en lecture')) {
      const statusMessages = {
        'en lecture': `votre manuscrit <strong>« ${escapeHtml(manuscript.title)} »</strong> est actuellement en cours de lecture par notre comité éditorial.`,
        'accepté': `nous avons le plaisir de vous informer que votre manuscrit <strong>« ${escapeHtml(manuscript.title)} »</strong> a été accepté pour publication ! Notre équipe vous contactera prochainement pour les prochaines étapes.`,
        'refusé': `après examen attentif, notre comité éditorial a décidé de ne pas retenir votre manuscrit <strong>« ${escapeHtml(manuscript.title)} »</strong> pour publication. Nous vous remercions de votre confiance et vous encourageons à persévérer.`,
      };
      transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
        to: manuscript.email,
        subject: `Manuscrit "${manuscript.title}" — Mise à jour du statut`,
        html: `<p>Bonjour ${escapeHtml(manuscript.firstname)},</p><p>${statusMessages[status]}</p><p>Cordialement,<br>L'équipe éditoriale de L'Harmattan Sénégal</p>`,
      }).catch((err) => console.error('[MANUSCRIPT] Status email error:', err.message));
    }

    res.json({ success: true });
  });

  // Download manuscript file
  app.get('/api/admin/manuscripts/:id/download', auth, (req, res) => {
    const manuscript = db.prepare('SELECT file_path, file_name FROM manuscript_submissions WHERE id = ?').get(req.params.id);
    if (!manuscript?.file_path) return res.status(404).json({ error: 'Fichier non trouvé' });
    if (!existsSync(manuscript.file_path)) return res.status(404).json({ error: 'Fichier introuvable sur le serveur' });
    res.download(manuscript.file_path, manuscript.file_name || 'manuscrit');
  });

  // ─── NEWSLETTER ADMIN ───────────────────────────────────────

  app.get('/api/admin/newsletter/subscribers', auth, (req, res) => {
    const subscribers = db.prepare('SELECT id, email, confirmed, created_at FROM newsletter ORDER BY created_at DESC').all();
    res.json(subscribers);
  });

  app.get('/api/admin/newsletter/export', auth, (req, res) => {
    const subscribers = db.prepare("SELECT email, confirmed, created_at FROM newsletter WHERE confirmed = 1 ORDER BY created_at DESC").all();
    const csv = 'email,date_inscription\n' + subscribers.map((s) => `${s.email},${s.created_at}`).join('\n');
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename=newsletter-subscribers.csv');
    res.send(csv);
  });

  app.delete('/api/admin/newsletter/:id', auth, csrfProtection, (req, res) => {
    db.prepare('DELETE FROM newsletter WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // ─── DASHBOARD STATS ───────────────────────────────────────

  app.get('/api/admin/stats', auth, async (req, res) => {
    try {
      // Local stats (SQLite)
      const newsletter = db.prepare('SELECT COUNT(*) as total, SUM(confirmed) as confirmed FROM newsletter').get();
      const contacts = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as unread FROM contact_messages').get();
      const manuscripts = db.prepare('SELECT COUNT(*) as total, status, COUNT(*) as count FROM manuscript_submissions GROUP BY status').all();
      const recentActivity = db.prepare('SELECT * FROM admin_activity_log ORDER BY created_at DESC LIMIT 5').all();

      // Dolibarr stats (MySQL)
      let dolibarr = { products: 0, invoices_today: 0, revenue_today: 0, revenue_month: 0, recent_invoices: [], top_products: [] };
      if (dolibarrPool) {
        try {
          const today = new Date().toISOString().split('T')[0];
          const monthStart = today.slice(0, 8) + '01';

          const [[prodCount]] = await dolibarrPool.query('SELECT COUNT(*) as c FROM llx_product WHERE tosell = 1');
          dolibarr.products = prodCount.c;

          const [[todayStats]] = await dolibarrPool.query(
            `SELECT COUNT(*) as count, COALESCE(SUM(total_ttc), 0) as revenue
             FROM llx_facture WHERE fk_statut > 0 AND DATE(FROM_UNIXTIME(datef)) = ?`, [today]
          );
          dolibarr.invoices_today = todayStats.count;
          dolibarr.revenue_today = Math.round(todayStats.revenue);

          const [[monthStats]] = await dolibarrPool.query(
            `SELECT COALESCE(SUM(total_ttc), 0) as revenue
             FROM llx_facture WHERE fk_statut > 0 AND DATE(FROM_UNIXTIME(datef)) >= ?`, [monthStart]
          );
          dolibarr.revenue_month = Math.round(monthStats.revenue);

          const [recentInv] = await dolibarrPool.query(
            `SELECT f.ref, f.total_ttc, f.datef, s.nom as customer_name
             FROM llx_facture f LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
             WHERE f.fk_statut > 0 ORDER BY f.rowid DESC LIMIT 8`
          );
          dolibarr.recent_invoices = recentInv.map(i => ({
            ref: i.ref,
            total: Math.round(parseFloat(i.total_ttc)),
            date: i.datef,
            customer: i.customer_name,
          }));

          const [topProds] = await dolibarrPool.query(
            `SELECT p.label, SUM(fd.qty) as total_qty, SUM(fd.total_ttc) as total_revenue
             FROM llx_facturedet fd
             JOIN llx_product p ON p.rowid = fd.fk_product
             JOIN llx_facture f ON f.rowid = fd.fk_facture
             WHERE f.fk_statut > 0 AND DATE(FROM_UNIXTIME(f.datef)) >= ?
             GROUP BY fd.fk_product ORDER BY total_qty DESC LIMIT 5`, [monthStart]
          );
          dolibarr.top_products = topProds.map(p => ({
            label: p.label,
            qty: parseInt(p.total_qty),
            revenue: Math.round(parseFloat(p.total_revenue)),
          }));
        } catch (err) {
          console.error('[ADMIN] Dolibarr stats error:', err.message);
        }
      }

      res.json({
        newsletter: { total: newsletter.total, confirmed: newsletter.confirmed || 0 },
        contacts: { total: contacts.total, unread: contacts.unread || 0 },
        manuscripts: manuscripts.reduce((acc, m) => { acc[m.status] = m.count; acc.total = (acc.total || 0) + m.count; return acc; }, {}),
        dolibarr,
        recentActivity,
      });
    } catch (err) {
      console.error('[ADMIN] Stats error:', err.message);
      res.status(500).json({ error: 'Erreur chargement statistiques' });
    }
  });

  // ─── REPLY TO CONTACT MESSAGE ──────────────────────────────

  app.post('/api/admin/contact/messages/:id/reply', auth, csrfProtection, (req, res) => {
    try {
      const { message: replyText } = req.body;
      if (!replyText?.trim()) return res.status(400).json({ error: 'Message requis' });

      const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(req.params.id);
      if (!msg) return res.status(404).json({ error: 'Message non trouvé' });

      transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <direction@senharmattan.com>',
        to: msg.email,
        replyTo: 'direction@senharmattan.com',
        subject: `Re: ${msg.subject || 'Votre message'}`,
        html: `
          <p>Bonjour ${escapeHtml(msg.name)},</p>
          <p>${escapeHtml(replyText).replace(/\n/g, '<br>')}</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
          <p style="color:#888;font-size:0.85em">En réponse à votre message du ${new Date(msg.created_at).toLocaleDateString('fr-FR')} :</p>
          <blockquote style="border-left:3px solid #ddd;margin:10px 0;padding:8px 16px;color:#666">${escapeHtml(msg.message).replace(/\n/g, '<br>')}</blockquote>
          <p style="color:#888;font-size:0.85em">L'Harmattan Sénégal — 10 VDN, Sicap Karak 45034, Dakar</p>
        `,
      }).catch((err) => console.error('[CONTACT] Reply email error:', err.message));

      logActivity(req.admin.username, 'reply_message', `Réponse au message de ${msg.name} (${msg.email})`);
      res.json({ success: true });
    } catch (err) {
      console.error('Reply message error:', err.message);
      res.status(500).json({ error: 'Erreur envoi réponse' });
    }
  });

  // ─── ADMIN USERS MANAGEMENT ────────────────────────────────

  app.get('/api/admin/users', auth, requireSuperAdmin, (req, res) => {
    const users = db.prepare("SELECT id, username, role, created_at FROM admin_users").all();
    res.json(users);
  });

  app.post('/api/admin/users', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    try {
      const { username, password, role = 'admin' } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Nom d\'utilisateur et mot de passe requis' });
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
      }
      const validRoles = ['super_admin', 'admin', 'editor', 'support', 'librarian'];
      const safeRole = validRoles.includes(role) ? role : 'admin';
      const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
      if (existing) return res.status(400).json({ error: 'Ce nom d\'utilisateur existe déjà' });

      const hash = bcrypt.hashSync(password, 12);
      const result = db.prepare('INSERT INTO admin_users (username, password, role) VALUES (?, ?, ?)').run(username, hash, safeRole);
      logActivity(req.admin.username, 'create_admin', `Création admin: ${username} (${safeRole})`);
      res.json({ id: result.lastInsertRowid, username, role: safeRole });
    } catch (err) {
      console.error('Create admin error:', err.message);
      res.status(500).json({ error: 'Erreur création administrateur' });
    }
  });

  app.put('/api/admin/users/:id', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { username, role, password } = req.body;

      const target = db.prepare('SELECT id, username, role FROM admin_users WHERE id = ?').get(id);
      if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });

      // Empêcher un super_admin de se rétrograder lui-même (risque de perdre l'accès)
      if (target.username === req.admin.username && role && role !== 'super_admin') {
        return res.status(400).json({ error: 'Vous ne pouvez pas modifier votre propre rôle' });
      }

      const updates = [];
      const values = [];

      // Changement d'username
      if (username && username.trim() && username.trim() !== target.username) {
        const cleanUsername = username.trim();
        const exists = db.prepare('SELECT id FROM admin_users WHERE username = ? AND id != ?').get(cleanUsername, id);
        if (exists) return res.status(400).json({ error: 'Ce nom d\'utilisateur est déjà pris' });
        updates.push('username = ?');
        values.push(cleanUsername);
      }

      // Changement de rôle
      if (role) {
        const validRoles = ['super_admin', 'admin', 'editor', 'support', 'librarian'];
        if (!validRoles.includes(role)) {
          return res.status(400).json({ error: 'Rôle invalide' });
        }
        updates.push('role = ?');
        values.push(role);
      }

      // Changement de mot de passe (optionnel)
      if (password && password.length > 0) {
        if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
          return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
        }
        const hash = bcrypt.hashSync(password, 12);
        updates.push('password = ?');
        values.push(hash);
        // Invalider la session active pour forcer une reconnexion avec le nouveau mot de passe
        updates.push('session_token = NULL');
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'Aucune modification fournie' });
      }

      values.push(id);
      db.prepare(`UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      // Relire le user pour renvoyer l'état à jour
      const updated = db.prepare('SELECT id, username, role, created_at FROM admin_users WHERE id = ?').get(id);

      const changes = [];
      if (username && username.trim() !== target.username) changes.push(`username→${username.trim()}`);
      if (role && role !== target.role) changes.push(`rôle→${role}`);
      if (password) changes.push('mdp réinitialisé');
      logActivity(req.admin.username, 'update_admin', `Modification admin ${target.username}: ${changes.join(', ')}`);

      res.json(updated);
    } catch (err) {
      console.error('Update admin error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour administrateur' });
    }
  });

  app.delete('/api/admin/users/:id', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    const target = db.prepare('SELECT username FROM admin_users WHERE id = ?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (target.username === req.admin.username) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });

    db.prepare('DELETE FROM admin_users WHERE id = ?').run(req.params.id);
    logActivity(req.admin.username, 'delete_admin', `Suppression admin: ${target.username}`);
    res.json({ success: true });
  });

  // ─── ACTIVITY LOG ──────────────────────────────────────────

  app.get('/api/admin/activity-log', auth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const logs = db.prepare('SELECT * FROM admin_activity_log ORDER BY created_at DESC LIMIT ?').all(limit);
    res.json(logs);
  });

  // ─── NOTIFICATION BADGES (sidebar counters) ───────────────

  app.get('/api/admin/notifications/counts', auth, (req, res) => {
    try {
      const unreadMessages = db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE read = 0").get()?.c || 0;

      let pendingPayments = 0;
      try { pendingPayments = db.prepare("SELECT COUNT(*) AS c FROM order_payments WHERE payment_status = 'pending'").get()?.c || 0; } catch { /* table may not exist */ }

      let openAlerts = 0;
      try { openAlerts = db.prepare("SELECT COUNT(*) AS c FROM stock_alerts WHERE status = 'open' AND severity IN ('critique', 'haute')").get()?.c || 0; } catch { /* table may not exist */ }

      let pendingManuscripts = 0;
      try { pendingManuscripts = db.prepare("SELECT COUNT(*) AS c FROM manuscript_submissions WHERE status = 'reçu'").get()?.c || 0; } catch { /* table may not exist */ }

      res.json({ messages: unreadMessages, payments: pendingPayments, stock_alerts: openAlerts, manuscripts: pendingManuscripts });
    } catch (err) {
      console.error('Notification counts error:', err.message);
      res.json({ messages: 0, payments: 0, stock_alerts: 0, manuscripts: 0 });
    }
  });

}
