import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { existsSync } from 'fs';
import rateLimit from 'express-rate-limit';
import { generateManuscriptRef } from './manuscript-workflow.js';
import { notifyTransition, notifySeriesSubmission } from './manuscript-emails.js';
import {
  ROLES,
  validRoles,
  FULL_ACCESS_ROLES,
  ROLE_ALLOWED_PATHS,
  DEPRECATED_ACTOR_ROLES,
  serializeRolesForClient,
  OVERRIDABLE_MODULES,
  PERMISSION_LEVELS,
  moduleForPath,
  methodAllowedForLevel,
} from './roles-config.js';
import { generateBase32Secret, verifyTotp, buildOtpAuthUrl } from './totp.js';

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

// Supprime le fichier temporaire déposé par multer quand une soumission est
// rejetée avant d'être persistée. Sans ça, chaque envoi invalide (validation
// serveur en échec, erreur DB) laisse un orphelin « manuscrit-<ts>.ext » à la
// racine de manuscripts/.
function cleanupTmpUpload(file) {
  try {
    if (file?.path && existsSync(file.path)) unlinkSync(file.path);
  } catch (err) {
    console.warn('[MANUSCRIPT] cleanup tmp upload:', err.message);
  }
}

// ─── CONFIG HELPERS ─────────────────────────────────────────
function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// Hache un token de session admin — le token brut n'est jamais stocké en base.
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ─── ADMIN AUTH MIDDLEWARE ───────────────────────────────────
export function adminAuth(db) {
  return (req, res, next) => {
    const session = req.cookies?.admin_session;
    if (!session) return res.status(401).json({ error: 'Non authentifié' });

    const admin = db.prepare(
      "SELECT * FROM admin_users WHERE session_token = ? AND (session_expires_at IS NULL OR session_expires_at > datetime('now'))"
    ).get(hashSessionToken(session));
    if (!admin) return res.status(401).json({ error: 'Session invalide' });

    // Compte désactivé entre-temps → invalider la session et refuser.
    if (admin.is_active === 0) {
      try {
        db.prepare('UPDATE admin_users SET session_token = NULL, session_expires_at = NULL WHERE id = ?').run(admin.id);
      } catch (e) { void e; }
      res.clearCookie('admin_session');
      return res.status(403).json({ error: 'Compte désactivé' });
    }

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
function setupAdminRoutes(appRef, { app: appFromOpts, db, csrfProtection, sanitizeBody, transporter, cache, dolibarrPool, cookieSecure = false, authLimiter, manuscriptSubmitLimiter, siteUrl = '' }) {
  const app = appRef || appFromOpts;
  const auth = adminAuth(db);

  // ─── Role-based access control ─────────────────────────────
  // ROLE_ALLOWED_PATHS / FULL_ACCESS_ROLES sont importés depuis roles-config.js
  // (source unique de vérité, partagée avec l'UI via GET /api/admin/roles).
  app.use('/api/admin', (req, res, next) => {
    const path = req.originalUrl.split('?')[0];
    // Login/logout/me sont les « portes » de l'auth — elles ne peuvent jamais
    // être bloquées par la RBAC sinon un cookie périmé enferme l'utilisateur
    // (il ne peut plus se reconnecter sans pouvoir d'abord se déconnecter).
    if (/^\/api\/admin\/(login|logout|me)$/.test(path)) return next();

    const session = req.cookies?.admin_session;
    // Pas de session → l'auth par-route (adminAuth) s'en charge.
    if (!session) return next();
    const admin = db.prepare('SELECT role FROM admin_users WHERE session_token = ?').get(hashSessionToken(session));
    // Session périmée / introuvable → laisser passer, l'auth par-route refusera
    // proprement (et permettra à /login d'écraser le cookie mort).
    if (!admin) return next();

    const role = admin.role;
    // Le super_admin n'est jamais restreint (évite tout auto-verrouillage : c'est
    // lui qui pilote les surcharges).
    if (role === 'super_admin') return next();

    // Surcharge temporaire éventuelle pour le module de ce chemin : elle prime sur
    // la config de base (octroi OU restriction). N'affecte que les modules dont
    // l'accès transite par /api/admin/<x> (cf. MODULE_PATHS).
    const ovModule = moduleForPath(path);
    const ovLevel = ovModule ? overridesCache[role]?.[ovModule] : undefined;
    if (ovLevel !== undefined) {
      if (methodAllowedForLevel(ovLevel, req.method)) return next();
      return res.status(403).json({ error: 'Accès non autorisé (permission temporaire en vigueur)' });
    }

    // Pas de surcharge pour ce module → comportement de base inchangé.
    if (FULL_ACCESS_ROLES.includes(role)) {
      return next();
    }
    const allowedPaths = ROLE_ALLOWED_PATHS[role];
    if (allowedPaths) {
      const method = req.method.toUpperCase();
      const allowed = allowedPaths.some((entry) => {
        if (entry instanceof RegExp) return entry.test(path);
        if (!entry.re.test(path)) return false;
        return !entry.methods || entry.methods.includes(method);
      });
      if (!allowed) {
        return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
      }
      return next();
    }
    // Rôle non listé (et pas full-access) → refus.
    return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
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
  // Add email column if missing — utilisée par les notifications workflow auprès des acteurs métiers
  // (évaluateur, correcteur, infographiste, imprimeur)
  try { db.exec('ALTER TABLE admin_users ADD COLUMN email TEXT'); } catch (e) { void e; }
  // Add session_expires_at column if missing — expiration serveur des sessions admin.
  try { db.exec('ALTER TABLE admin_users ADD COLUMN session_expires_at TEXT'); } catch (e) { void e; }
  // Statut actif/désactivé : un compte désactivé ne peut plus se connecter.
  try { db.exec('ALTER TABLE admin_users ADD COLUMN is_active INTEGER DEFAULT 1'); } catch (e) { void e; }
  // Dernière connexion réussie (timestamp + IP).
  try { db.exec('ALTER TABLE admin_users ADD COLUMN last_login_at TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE admin_users ADD COLUMN last_login_ip TEXT'); } catch (e) { void e; }
  // Renouvellement de mot de passe forcé (flag posé par super_admin).
  try { db.exec('ALTER TABLE admin_users ADD COLUMN must_change_password INTEGER DEFAULT 0'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE admin_users ADD COLUMN password_changed_at TEXT'); } catch (e) { void e; }
  // 2FA (TOTP RFC 6238) — secret en Base32, drapeau d'activation.
  try { db.exec('ALTER TABLE admin_users ADD COLUMN totp_secret TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER DEFAULT 0'); } catch (e) { void e; }
  // Token éphémère utilisé entre l'étape 1 (mot de passe) et l'étape 2 (TOTP) du login.
  try { db.exec('ALTER TABLE admin_users ADD COLUMN totp_pending_token TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE admin_users ADD COLUMN totp_pending_expires_at TEXT'); } catch (e) { void e; }

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

  // ─── Surcharges temporaires de permissions (pilotées par le super-admin) ────
  // Permettent d'élargir OU de restreindre l'accès d'un rôle à un module, à chaud.
  // Manuel uniquement (pas d'expiration auto) : restauration explicite par cellule
  // ou globale. Prennent le pas sur la config de base (roles-config.js) par module.
  db.exec(`CREATE TABLE IF NOT EXISTS role_permission_overrides (
    role TEXT NOT NULL,
    module TEXT NOT NULL,
    level TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role, module)
  )`);

  // Cache mémoire : { [role]: { [module]: level } }. Rechargé au démarrage et
  // après chaque écriture (les surcharges sont rares → coût négligeable).
  let overridesCache = {};
  function reloadOverrides() {
    const rows = db.prepare('SELECT role, module, level FROM role_permission_overrides').all();
    const map = {};
    for (const r of rows) {
      (map[r.role] || (map[r.role] = {}))[r.module] = r.level;
    }
    overridesCache = map;
  }
  reloadOverrides();

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
    biography TEXT,
    message TEXT,
    file_path TEXT,
    file_name TEXT,
    status TEXT DEFAULT 'reçu',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('ALTER TABLE manuscript_submissions ADD COLUMN biography TEXT'); } catch (e) { void e; /* column exists */ }
  try { db.exec('ALTER TABLE manuscript_submissions ADD COLUMN subtitle TEXT'); } catch (e) { void e; /* column exists */ }

  // ─── WORKFLOW ÉDITORIAL ─────────────────────────────────────
  // Portail auteur
  db.exec(`CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    firstname TEXT NOT NULL,
    lastname TEXT NOT NULL,
    phone TEXT,
    dolibarr_thirdparty_id INTEGER,
    email_verified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS author_sessions (
    token TEXT PRIMARY KEY,
    author_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS author_password_resets (
    email TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at DATETIME NOT NULL
  )`);

  // Table canonique des manuscrits (machine à états)
  db.exec(`CREATE TABLE IF NOT EXISTS manuscripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    author_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    genre TEXT,
    synopsis TEXT,
    message TEXT,
    current_stage TEXT NOT NULL DEFAULT 'submitted',
    assigned_evaluator_id INTEGER,
    assigned_corrector_id INTEGER,
    assigned_editor_id INTEGER,
    assigned_infographist_id INTEGER,
    assigned_printer_id INTEGER,
    contract_id INTEGER,
    dolibarr_product_id INTEGER,
    dolibarr_mo_id INTEGER,
    dolibarr_mo_ref TEXT,
    isbn TEXT,
    print_qty INTEGER,
    rejection_reason TEXT,
    legacy_submission_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_stage ON manuscripts(current_stage)'); } catch (e) { /* exists */ void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_author ON manuscripts(author_id)'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_evaluator ON manuscripts(assigned_evaluator_id)'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_corrector ON manuscripts(assigned_corrector_id)'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_infographist ON manuscripts(assigned_infographist_id)'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_printer ON manuscripts(assigned_printer_id)'); } catch (e) { void e; }
  // Workflow « semi-automatique » : affectation des acteurs externes via le carnet
  // d'intervenants (colonnes *_contact_id). Les anciennes colonnes *_id (admin_users)
  // sont conservées pour l'historique. L'éditeur reste sur assigned_editor_id.
  for (const c of ['assigned_evaluator_contact_id', 'assigned_corrector_contact_id', 'assigned_infographist_contact_id', 'assigned_printer_contact_id']) {
    try { db.exec(`ALTER TABLE manuscripts ADD COLUMN ${c} INTEGER`); } catch (e) { void e; }
  }
  // Soumission multi-tomes : un ouvrage en plusieurs tomes crée N manuscrits
  // indépendants (chacun son ISBN, contrat, royalties, impression) reliés par
  // un identifiant de série commun. Colonnes nulles pour un livre unique.
  //  - series_ref   : identifiant de groupe partagé (= ref du 1ᵉʳ tome)
  //  - series_title : titre commun de l'œuvre
  //  - tome_number  : rang du tome (1, 2, 3…)
  //  - tome_total   : nombre de tomes soumis ensemble
  // Sous-titre de l'ouvrage (facultatif), saisi après le titre dans le formulaire public.
  try { db.exec('ALTER TABLE manuscripts ADD COLUMN subtitle TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE manuscripts ADD COLUMN series_ref TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE manuscripts ADD COLUMN series_title TEXT'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE manuscripts ADD COLUMN tome_number INTEGER'); } catch (e) { void e; }
  try { db.exec('ALTER TABLE manuscripts ADD COLUMN tome_total INTEGER'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscripts_series ON manuscripts(series_ref)'); } catch (e) { void e; }

  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manuscript_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_by_role TEXT NOT NULL,
    uploaded_by_id INTEGER NOT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_manuscript_files_ms ON manuscript_files(manuscript_id, kind)'); } catch (e) { void e; }
  // Lien de téléchargement externe (manuscrits > 20 Mo déposés via une URL
  // Google Drive / WeTransfer / Dropbox… au lieu d'un upload). Quand cette
  // colonne est renseignée, file_path contient l'URL et aucun fichier local
  // n'existe : le téléchargement admin redirige vers le lien.
  try { db.exec('ALTER TABLE manuscript_files ADD COLUMN external_url TEXT'); } catch (e) { void e; }

  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manuscript_id INTEGER NOT NULL,
    from_stage TEXT,
    to_stage TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    actor_id INTEGER,
    actor_label TEXT,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_stages_ms ON manuscript_stages(manuscript_id, created_at)'); } catch (e) { void e; }
  // Évènements informatifs (devis, contrat envoyé…) : colonne nullable, les
  // lignes existantes (transitions de stage) gardent event = NULL.
  try { db.exec('ALTER TABLE manuscript_stages ADD COLUMN event TEXT'); } catch (e) { void e; }

  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manuscript_id INTEGER NOT NULL,
    evaluator_id INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    recommendation TEXT,
    strengths TEXT,
    weaknesses TEXT,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_validations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manuscript_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    decision TEXT NOT NULL,
    comment TEXT,
    author_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Migration one-shot : copier manuscript_submissions → authors + manuscripts
  try {
    const already = db.prepare('SELECT COUNT(*) AS c FROM manuscripts').get()?.c || 0;
    if (already === 0) {
      const legacyRows = db.prepare('SELECT * FROM manuscript_submissions ORDER BY id ASC').all();
      const stageMap = {
        'reçu': 'submitted',
        'en lecture': 'in_evaluation',
        'accepté': 'evaluation_positive',
        'refusé': 'evaluation_negative',
      };
      const insertAuthor = db.prepare(`INSERT OR IGNORE INTO authors (email, firstname, lastname, phone) VALUES (?, ?, ?, ?)`);
      const findAuthor = db.prepare('SELECT id FROM authors WHERE email = ?');
      const insertManuscript = db.prepare(`INSERT INTO manuscripts
        (ref, author_id, title, genre, synopsis, message, current_stage, legacy_submission_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertFile = db.prepare(`INSERT INTO manuscript_files
        (manuscript_id, kind, version, file_path, file_name, uploaded_by_role, uploaded_by_id)
        VALUES (?, 'original', 1, ?, ?, 'author', ?)`);
      const insertStage = db.prepare(`INSERT INTO manuscript_stages
        (manuscript_id, from_stage, to_stage, actor_role, note, created_at)
        VALUES (?, NULL, 'submitted', 'system', 'Migration depuis manuscript_submissions', ?)`);

      const now = new Date();
      const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
      let seq = 1;
      const tx = db.transaction((rows) => {
        for (const row of rows) {
          insertAuthor.run(row.email, row.firstname, row.lastname, row.phone || null);
          const author = findAuthor.get(row.email);
          if (!author) continue;
          const ref = `MS-${yymm}-${String(seq++).padStart(4, '0')}`;
          const stage = stageMap[row.status] || 'submitted';
          const result = insertManuscript.run(
            ref, author.id, row.title, row.genre || null, row.synopsis || null,
            row.message || null, stage, row.id, row.created_at || new Date().toISOString()
          );
          if (row.file_path) {
            insertFile.run(result.lastInsertRowid, row.file_path, row.file_name || 'manuscrit', author.id);
          }
          insertStage.run(result.lastInsertRowid, row.created_at || new Date().toISOString());
        }
      });
      if (legacyRows.length) {
        tx(legacyRows);
        console.log(`[MIGRATION] ${legacyRows.length} manuscrit(s) historique(s) migré(s) vers la table canonique manuscripts.`);
      }
    }
  } catch (err) {
    console.error('[MIGRATION manuscripts] erreur:', err.message);
  }

  // Ensure default admin exists
  const existingAdmin = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
  if (!existingAdmin) {
    const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD || crypto.randomBytes(16).toString('hex');
    const hash = bcrypt.hashSync(defaultPwd, 12);
    db.prepare("INSERT INTO admin_users (username, password, role) VALUES (?, ?, 'super_admin')").run('admin', hash);
    console.warn('[ADMIN] Compte admin créé — mot de passe = valeur de la variable d\'environnement ADMIN_DEFAULT_PASSWORD. CHANGEZ-LE IMMÉDIATEMENT.');
  }

  // ─── AUTH ROUTES ────────────────────────────────────────────

  const adminLoginLimiter = authLimiter || rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Trop de tentatives, réessayez dans 15 minutes' }, validate: { xForwardedForHeader: false } });

  // Crée la session active pour `admin` et pose le cookie. Centralisé pour
  // partager le code entre login simple et étape 2 du 2FA.
  function openAdminSession(req, res, admin) {
    const token = crypto.randomBytes(32).toString('hex');
    const ip = (req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    db.prepare(
      "UPDATE admin_users SET session_token = ?, session_expires_at = datetime('now', '+24 hours'), last_login_at = datetime('now'), last_login_ip = ?, totp_pending_token = NULL, totp_pending_expires_at = NULL WHERE id = ?"
    ).run(hashSessionToken(token), ip || null, admin.id);
    res.cookie('admin_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: cookieSecure,
      maxAge: 24 * 60 * 60 * 1000,
    });
  }

  app.post('/api/admin/login', adminLoginLimiter, csrfProtection, (req, res) => {
    const { username, password } = req.body;
    const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!admin || !bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }
    if (admin.is_active === 0) {
      return res.status(403).json({ error: 'Compte désactivé. Contactez un administrateur.' });
    }

    // Si la 2FA est activée, ne pas ouvrir de session : émettre un token
    // intermédiaire valable 5 min pour la 2ᵉ étape.
    if (admin.totp_enabled === 1 && admin.totp_secret) {
      const pendingToken = crypto.randomBytes(24).toString('hex');
      db.prepare(
        "UPDATE admin_users SET totp_pending_token = ?, totp_pending_expires_at = datetime('now', '+5 minutes') WHERE id = ?"
      ).run(hashSessionToken(pendingToken), admin.id);
      return res.json({ requires2FA: true, pendingToken });
    }

    openAdminSession(req, res, admin);
    logActivity(admin.username, 'login', 'Connexion admin');
    res.json({
      success: true,
      username: admin.username,
      role: admin.role || 'admin',
      mustChangePassword: admin.must_change_password === 1,
    });
  });

  // Étape 2 du login quand la 2FA est activée.
  app.post('/api/admin/login/2fa', adminLoginLimiter, csrfProtection, (req, res) => {
    const { pendingToken, code } = req.body;
    if (!pendingToken || !code) {
      return res.status(400).json({ error: 'Token et code requis' });
    }
    const admin = db.prepare(
      "SELECT * FROM admin_users WHERE totp_pending_token = ? AND totp_pending_expires_at > datetime('now')"
    ).get(hashSessionToken(pendingToken));
    if (!admin || admin.is_active === 0 || !admin.totp_secret) {
      return res.status(401).json({ error: 'Étape de vérification expirée. Reconnectez-vous.' });
    }
    if (!verifyTotp(admin.totp_secret, code)) {
      return res.status(401).json({ error: 'Code à 6 chiffres invalide' });
    }
    openAdminSession(req, res, admin);
    logActivity(admin.username, 'login', 'Connexion admin (2FA)');
    res.json({
      success: true,
      username: admin.username,
      role: admin.role || 'admin',
      mustChangePassword: admin.must_change_password === 1,
    });
  });

  app.post('/api/admin/logout', auth, (req, res) => {
    db.prepare('UPDATE admin_users SET session_token = NULL, session_expires_at = NULL WHERE id = ?').run(req.admin.id);
    res.clearCookie('admin_session');
    res.json({ success: true });
  });

  app.get('/api/admin/me', auth, (req, res) => {
    res.json({
      username: req.admin.username,
      role: req.admin.role || 'admin',
      email: req.admin.email || null,
      mustChangePassword: req.admin.must_change_password === 1,
      totpEnabled: req.admin.totp_enabled === 1,
      // Surcharges actives pour CE rôle → la nav peut afficher/masquer en conséquence.
      permissionOverrides: overridesCache[req.admin.role] || {},
    });
  });

  app.put('/api/admin/password', auth, csrfProtection, (req, res) => {
    const { current, newPassword } = req.body;
    if (!bcrypt.compareSync(current, req.admin.password)) {
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    }
    if (!newPassword || newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
    }
    if (newPassword === current) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit être différent de l\'ancien' });
    }
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare("UPDATE admin_users SET password = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?").run(hash, req.admin.id);
    logActivity(req.admin.username, 'password_change', 'Mot de passe modifié');
    res.json({ success: true });
  });

  // ─── 2FA (TOTP) ─────────────────────────────────────────────
  // L'utilisateur gère sa propre 2FA. setup → verify pour activer.

  app.post('/api/admin/2fa/setup', auth, csrfProtection, (req, res) => {
    if (req.admin.totp_enabled === 1) {
      return res.status(400).json({ error: '2FA déjà activée. Désactivez-la avant de la reconfigurer.' });
    }
    const secret = generateBase32Secret(20);
    // On stocke le secret immédiatement mais sans activer ; activation = /verify.
    db.prepare('UPDATE admin_users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, req.admin.id);
    const otpauthUrl = buildOtpAuthUrl({
      issuer: "L'Harmattan Sénégal Admin",
      account: req.admin.username,
      secret,
    });
    res.json({ secret, otpauthUrl });
  });

  app.post('/api/admin/2fa/verify', auth, csrfProtection, (req, res) => {
    const { code } = req.body;
    if (!req.admin.totp_secret) {
      return res.status(400).json({ error: 'Aucun secret en attente. Relancez la configuration.' });
    }
    if (!verifyTotp(req.admin.totp_secret, code)) {
      return res.status(400).json({ error: 'Code invalide. Vérifiez l\'heure de votre appareil.' });
    }
    db.prepare('UPDATE admin_users SET totp_enabled = 1 WHERE id = ?').run(req.admin.id);
    logActivity(req.admin.username, '2fa_enable', '2FA activée');
    res.json({ success: true });
  });

  app.post('/api/admin/2fa/disable', auth, csrfProtection, (req, res) => {
    const { password, code } = req.body;
    if (!password || !bcrypt.compareSync(password, req.admin.password)) {
      return res.status(400).json({ error: 'Mot de passe incorrect' });
    }
    // Si 2FA active, demander aussi un code valide pour empêcher la désactivation
    // depuis une session volée.
    if (req.admin.totp_enabled === 1 && !verifyTotp(req.admin.totp_secret, code)) {
      return res.status(400).json({ error: 'Code 2FA requis et valide pour désactiver' });
    }
    db.prepare('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.admin.id);
    logActivity(req.admin.username, '2fa_disable', '2FA désactivée');
    res.json({ success: true });
  });

  // ─── SITE CONFIG ROUTES ─────────────────────────────────────

  // Nettoie le HTML d'une accroche/description pour l'affichage public.
  function stripHtmlServer(s) {
    return String(s || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Construit la section « Ouvrages à paraître » depuis le catalogue :
  // table SQLite book_upcoming (marqueur posé sur la fiche produit) jointe aux
  // produits Dolibarr réels. Une seule source de vérité, gérée depuis /admin/books.
  async function buildUpcomingBooksFromCatalogue() {
    if (!db || !dolibarrPool) return [];
    let rows;
    try {
      rows = db.prepare(
        `SELECT product_id, release_date, summary, preorder_discount_pct, sort_order
           FROM book_upcoming
          ORDER BY (release_date IS NULL) ASC, release_date ASC, sort_order ASC, product_id ASC`
      ).all();
    } catch { return []; }
    if (!rows.length) return [];

    const ids = rows.map((r) => r.product_id);
    const placeholders = ids.map(() => '?').join(',');
    let prods = [];
    try {
      const [queryRows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.label, p.description, p.price_ttc, pe.auteur, pe.longdescript
           FROM llx_product p
           LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
          WHERE p.rowid IN (${placeholders})`,
        ids
      );
      prods = queryRows;
    } catch (e) {
      console.error('[CONFIG] build upcoming_books failed:', e.message);
      return [];
    }
    const byId = new Map(prods.map((p) => [String(p.id), p]));

    return rows
      .filter((r) => byId.has(String(r.product_id)))
      .map((r) => {
        const p = byId.get(String(r.product_id));
        const summary = stripHtmlServer(r.summary || p.longdescript || p.description || '');
        return {
          product_id: String(r.product_id),
          title: p.label || '',
          author: p.auteur || '',
          release_date: r.release_date || '',
          summary,
          cover: `/api/image/${r.product_id}`,
          preorder_discount_pct: r.preorder_discount_pct || 0,
          link: `/produit/${r.product_id}`,
        };
      });
  }

  // Public: get config (for frontend)
  app.get('/api/admin/config', async (req, res) => {
    try {
      const config = readConfig();
      // Don't expose SMTP credentials to public
      const { smtp, ...publicConfig } = config;
      // Use smtp variable to avoid linter error
      if (smtp) { /* nothing */ }

      // « Ouvrages à paraître » : dérivé du catalogue (cache 120 s, invalidé à chaque
      // changement de flag dans book-routes via cache.del('upcoming_books:public')).
      let upcoming = cache?.get?.('upcoming_books:public');
      if (!upcoming) {
        upcoming = await buildUpcomingBooksFromCatalogue();
        cache?.set?.('upcoming_books:public', upcoming, 120);
      }
      publicConfig.upcoming_books = upcoming;

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

  // Liste blanche des sections de configuration modifiables via l'API.
  // Déduite des clés réellement présentes dans site-config.json.
  const ALLOWED_CONFIG_KEYS = new Set([
    'contact',
    'social',
    'youtube_channel_id',
    'hero_slides',
    'upcoming_books',
    'faq',
    'smtp',
    'manuscript_genres',
    'payment_methods',
    'admin_emails',
    'whatsapp_phone',
  ]);

  // Admin: update config section
  app.put('/api/admin/config', auth, csrfProtection, (req, res) => {
    try {
      const config = readConfig();
      const updates = req.body;

      // Merge updates into config — uniquement les clés autorisées (anti mass-assignment).
      for (const [key, value] of Object.entries(updates)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        if (!ALLOWED_CONFIG_KEYS.has(key)) {
          return res.status(400).json({ error: `Section de configuration non autorisée: ${key}` });
        }
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
  // Endpoint public consommé par le formulaire "Se faire éditer". Le chemin
  // historique /api/admin/manuscripts est conservé pour ne pas casser les
  // intégrations existantes, mais le chemin canonique est désormais
  // /api/manuscripts/submit (plus clair, et plus facile à reconnaître pour
  // les outils de sécurité qui scannent /admin).
  // Rate limit explicite : upload coûteux, surface de spam.
  // Valide une URL de dépôt externe (manuscrit > 20 Mo).
  const isValidExternalUrl = (url) => {
    if (!url || url.length > 2000) return false;
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch { return false; }
  };

  const submitManuscriptHandler = (req, res) => {
    // .fields() : on normalise les fichiers reçus (multi-tomes `files`, ou champ
    // unique `file` legacy) en un seul tableau ordonné.
    const uploaded = [
      ...((req.files && req.files.files) || []),
      ...((req.files && req.files.file) || []),
    ];
    const cleanupAll = () => uploaded.forEach((f) => cleanupTmpUpload(f));
    try {
      const { firstname, lastname, email, phone, title, subtitle, genre, synopsis, biography, message } = req.body;
      if (!firstname || !lastname || !email || !title) {
        cleanupAll();
        return res.status(400).json({ error: 'Champs requis manquants' });
      }
      if (subtitle && String(subtitle).length > 200) {
        cleanupAll();
        return res.status(400).json({
          error: 'Le sous-titre ne doit pas dépasser 200 caractères.',
          errors: { subtitle: 'Le sous-titre ne doit pas dépasser 200 caractères.' },
        });
      }
      if (!phone || !String(phone).trim()) {
        cleanupAll();
        return res.status(400).json({
          error: 'Le numéro de téléphone est obligatoire.',
          errors: { phone: 'Veuillez renseigner votre numéro de téléphone.' },
        });
      }
      if (synopsis && String(synopsis).length > 1200) {
        cleanupAll();
        return res.status(400).json({
          error: 'Le synopsis ne doit pas dépasser 1200 caractères.',
          errors: { synopsis: 'Le synopsis ne doit pas dépasser 1200 caractères.' },
        });
      }
      if (!biography || !String(biography).trim()) {
        cleanupAll();
        return res.status(400).json({
          error: 'La biographie de l’auteur est obligatoire.',
          errors: { biography: 'Veuillez renseigner une courte biographie de l’auteur.' },
        });
      }
      if (String(biography).length > 400) {
        cleanupAll();
        return res.status(400).json({
          error: 'La biographie ne doit pas dépasser 400 caractères.',
          errors: { biography: 'La biographie ne doit pas dépasser 400 caractères.' },
        });
      }

      // Construction de la liste normalisée des tomes à créer.
      //  - mode multi-tomes : champ JSON `tomes` = [{ subtitle, useLink, fileUrl }]
      //    (les fichiers arrivent dans `files`, dans l'ordre des tomes sans lien)
      //  - mode legacy (1 livre) : un fichier OU `file_url`
      let tomesMeta = null;
      if (req.body.tomes) {
        try { tomesMeta = JSON.parse(req.body.tomes); } catch { tomesMeta = null; }
        if (!Array.isArray(tomesMeta) || tomesMeta.length === 0) tomesMeta = null;
      }

      const tomeInputs = [];
      if (tomesMeta) {
        if (tomesMeta.length > 5) {
          cleanupAll();
          return res.status(400).json({ error: 'Un maximum de 5 tomes peut être soumis en une fois.' });
        }
        let fileIdx = 0;
        for (let i = 0; i < tomesMeta.length; i++) {
          const t = tomesMeta[i] || {};
          const subtitle = (t.subtitle || '').toString().trim() || null;
          if (t.useLink) {
            const url = (t.fileUrl || '').toString().trim();
            if (!isValidExternalUrl(url)) {
              cleanupAll();
              return res.status(400).json({
                error: `Le lien de téléchargement du tome ${i + 1} est invalide.`,
                errors: { file: 'Veuillez fournir un lien valide commençant par http:// ou https://.' },
              });
            }
            tomeInputs.push({ subtitle, file: null, externalUrl: url });
          } else {
            const f = uploaded[fileIdx++] || null;
            if (!f) {
              cleanupAll();
              return res.status(400).json({
                error: `Le fichier du tome ${i + 1} est manquant.`,
                errors: { file: 'Veuillez joindre le fichier de chaque tome (PDF, DOC ou DOCX).' },
              });
            }
            tomeInputs.push({ subtitle, file: f, externalUrl: null });
          }
        }
      } else {
        // Mode legacy : un seul manuscrit.
        const externalUrl = (req.body.file_url || '').trim() || null;
        const f = uploaded[0] || null;
        if (!f && !externalUrl) {
          return res.status(400).json({
            error: 'Le manuscrit (PDF, DOC ou DOCX) ou un lien de téléchargement est obligatoire.',
            errors: { file: 'Veuillez joindre votre manuscrit ou coller un lien de téléchargement.' },
          });
        }
        if (!f && !isValidExternalUrl(externalUrl)) {
          return res.status(400).json({
            error: 'Le lien de téléchargement est invalide.',
            errors: { file: 'Veuillez fournir un lien valide commençant par http:// ou https://.' },
          });
        }
        tomeInputs.push({ subtitle: null, file: f, externalUrl: f ? null : externalUrl });
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanFirstname = firstname.trim();
      const cleanLastname = lastname.trim();
      const cleanTitle = title.trim();
      const cleanSubtitle = subtitle ? String(subtitle).trim() || null : null;
      const cleanBio = biography ? String(biography).trim() : null;
      const isSeries = tomeInputs.length > 1;
      const tomeTotal = tomeInputs.length;

      // 1. Find or create author
      let author = db.prepare('SELECT * FROM authors WHERE email = ?').get(cleanEmail);
      let isNewAuthor = false;
      if (!author) {
        const ins = db.prepare(
          `INSERT INTO authors (email, firstname, lastname, phone, bio) VALUES (?, ?, ?, ?, ?)`
        ).run(cleanEmail, cleanFirstname, cleanLastname, phone || null, cleanBio);
        author = db.prepare('SELECT * FROM authors WHERE id = ?').get(ins.lastInsertRowid);
        isNewAuthor = true;
      } else if (cleanBio && !author.bio) {
        // Renseigne la bio sur le profil si absente
        db.prepare('UPDATE authors SET bio = ? WHERE id = ?').run(cleanBio, author.id);
      }
      const needsActivation = !author.password;

      // 2. Create manuscript(s) + move file(s) + traces (en transaction)
      let createdIds = [];
      try {
        const tx = db.transaction(() => {
          const ids = [];
          let seriesRef = null;
          for (let n = 0; n < tomeInputs.length; n++) {
            const tome = tomeInputs[n];
            const ref = generateManuscriptRef(db);
            // L'identifiant de série = ref du 1ᵉʳ tome (lisible et unique).
            if (isSeries && n === 0) seriesRef = ref;

            // Titre du manuscrit : inchangé pour un livre unique ; sinon
            // « <œuvre> — Tome N[ : sous-titre] ».
            const manuscriptTitle = isSeries
              ? `${cleanTitle} — Tome ${n + 1}${tome.subtitle ? ` : ${tome.subtitle}` : ''}`
              : cleanTitle;

            const result = db.prepare(
              `INSERT INTO manuscripts (ref, author_id, title, subtitle, genre, synopsis, biography, message, current_stage,
                 series_ref, series_title, tome_number, tome_total)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`
            ).run(ref, author.id, manuscriptTitle, cleanSubtitle, genre?.trim() || null, synopsis || null, cleanBio, message || null,
              isSeries ? seriesRef : null, isSeries ? cleanTitle : null,
              isSeries ? n + 1 : null, isSeries ? tomeTotal : null);
            const id = result.lastInsertRowid;

            let storedPath, storedName, storedSize, storedMime, storedExternal;
            if (tome.file) {
              const finalDir = join(MANUSCRIPTS_DIR, String(id), 'original');
              mkdirSync(finalDir, { recursive: true });
              const fp = join(finalDir, tome.file.filename || `manuscrit-${Date.now()}`);
              try { renameSync(tome.file.path, fp); }
              catch (err) { console.warn('[MANUSCRIPT] rename fallback:', err.message); }
              storedPath = fp;
              storedName = tome.file.originalname || tome.file.filename;
              storedSize = tome.file.size || null;
              storedMime = tome.file.mimetype || null;
              storedExternal = null;
            } else {
              // Dépôt par lien externe (fichier > 20 Mo) : on conserve l'URL.
              storedPath = tome.externalUrl;
              storedName = 'Manuscrit (lien de téléchargement externe)';
              storedSize = null;
              storedMime = 'text/uri-list';
              storedExternal = tome.externalUrl;
            }

            db.prepare(
              `INSERT INTO manuscript_files (manuscript_id, kind, version, file_path, file_name, file_size, mime_type, uploaded_by_role, uploaded_by_id, external_url)
               VALUES (?, 'original', 1, ?, ?, ?, ?, 'author', ?, ?)`
            ).run(id, storedPath, storedName, storedSize, storedMime, author.id, storedExternal);

            const stageNote = isSeries
              ? `Soumission formulaire public — Tome ${n + 1}/${tomeTotal}${isNewAuthor && n === 0 ? ' — compte créé' : ''}`
              : (isNewAuthor ? 'Soumission formulaire public — compte créé' : 'Soumission formulaire public');
            db.prepare(
              `INSERT INTO manuscript_stages (manuscript_id, from_stage, to_stage, actor_role, actor_id, actor_label, note)
               VALUES (?, NULL, 'submitted', 'author', ?, ?, ?)`
            ).run(id, author.id, `${cleanFirstname} ${cleanLastname}`, stageNote);

            // Conservation legacy (les anciennes vues admin pointent encore dessus)
            db.prepare(
              `INSERT INTO manuscript_submissions
               (firstname, lastname, email, phone, title, subtitle, genre, synopsis, biography, message, file_path, file_name)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(cleanFirstname, cleanLastname, cleanEmail, phone || null, manuscriptTitle, cleanSubtitle,
              genre || null, synopsis || null, cleanBio, message || null, storedPath, storedName);

            ids.push(id);
          }
          return ids;
        });
        createdIds = tx();
      } catch (err) {
        console.error('[MANUSCRIPT] DB error:', err.message);
        cleanupAll();
        return res.status(500).json({ error: 'Erreur enregistrement manuscrit' });
      }

      const manuscripts = createdIds.map((id) => db.prepare('SELECT * FROM manuscripts WHERE id = ?').get(id));
      const manuscript = manuscripts[0];

      // 3. Workflow notification (in-app + email + admin)
      try {
        if (isSeries) {
          // Une seule confirmation auteur (récap des tomes) + une seule notif admin.
          notifySeriesSubmission(db, transporter, manuscripts, author, cleanTitle, siteUrl);
        } else {
          notifyTransition(db, transporter, manuscript, 'submitted',
            { role: 'author', id: author.id, label: `${cleanFirstname} ${cleanLastname}` }, siteUrl);
        }
      } catch (err) { console.error('[MANUSCRIPT] notifyTransition error:', err.message); }

      // 4. Magic link d'activation pour les nouveaux auteurs (ou ceux sans mot de passe)
      if (needsActivation && transporter) {
        try {
          const token = crypto.randomBytes(32).toString('hex');
          // 90 jours d'expiration (vs 1h pour un vrai reset password)
          const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
          db.prepare('INSERT OR REPLACE INTO author_password_resets (email, token, expires_at) VALUES (?, ?, ?)')
            .run(cleanEmail, token, expiresAt);
          const activateUrl = `${siteUrl}/auteur/activer?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
          const arrivalLine = isSeries
            ? `<p>Votre ouvrage <strong>« ${escapeHtml(cleanTitle)} »</strong> est bien arrivé chez nous en <strong>${tomeTotal} tomes</strong> (références <strong>${manuscripts.map((m) => escapeHtml(m.ref)).join(', ')}</strong>).</p>`
            : `<p>Votre manuscrit <strong>« ${escapeHtml(cleanTitle)} »</strong> est bien arrivé chez nous (référence <strong>${manuscript.ref}</strong>).</p>`;
          transporter.sendMail({
            to: cleanEmail,
            subject: 'Activez votre espace auteur — L\'Harmattan Sénégal',
            html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
              <h2 style="color:#10531a">Bienvenue ${escapeHtml(cleanFirstname)} !</h2>
              ${arrivalLine}
              <p>Pour suivre l'avancement du projet, valider les corrections et le BAT, télécharger les fichiers et échanger avec notre équipe, activez votre espace auteur :</p>
              <p><a href="${activateUrl}" style="background:#10531a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Activer mon espace auteur</a></p>
              <p style="color:#666;font-size:0.85em">Ce lien est valable 90 jours. Vous pourrez ensuite vous connecter à tout moment sur ${siteUrl}/auteur/connexion.</p>
              <p style="color:#666;font-size:0.9em;margin-top:24px">L'équipe éditoriale — L'Harmattan Sénégal</p>
            </div>`,
          }).catch((err) => console.error('[MANUSCRIPT] Activation email error:', err.message));
        } catch (err) { console.error('[MANUSCRIPT] Activation setup error:', err.message); }
      }

      res.json({
        success: true,
        ref: manuscript.ref,
        id: manuscript.id,
        series: isSeries,
        count: manuscripts.length,
        refs: manuscripts.map((m) => m.ref),
      });
    } catch (err) {
      console.error('POST /manuscripts error:', err.message);
      cleanupAll();
      res.status(500).json({ error: 'Erreur soumission manuscrit' });
    }
  };
  // Le limiter est optionnel pour rester rétrocompatible si setupAdminRoutes
  // est appelé sans ce paramètre (tests, anciens montages).
  const submitMiddlewares = [csrfProtection];
  if (manuscriptSubmitLimiter) submitMiddlewares.push(manuscriptSubmitLimiter);
  // .fields : `files` = soumission multi-tomes (jusqu'à 5), `file` = ancien champ
  // unique (rétrocompatibilité formulaire/alias legacy). Une soumission = 1 requête,
  // donc le rate-limiter compte toujours 1 même pour plusieurs tomes.
  submitMiddlewares.push(manuscriptUpload.fields([{ name: 'files', maxCount: 5 }, { name: 'file', maxCount: 1 }]));
  app.post('/api/manuscripts/submit', ...submitMiddlewares, submitManuscriptHandler);
  // Alias legacy — déconseillé pour les nouvelles intégrations.
  app.post('/api/admin/manuscripts', ...submitMiddlewares, submitManuscriptHandler);

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
    // Dépôt par lien externe (> 20 Mo) : file_path contient l'URL, on redirige.
    if (/^https?:\/\//i.test(manuscript.file_path)) return res.redirect(manuscript.file_path);
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

  // Définition des rôles et matrice de permissions — accessible à tout admin
  // authentifié (la matrice est purement informative pour l'UI).
  app.get('/api/admin/roles', auth, (req, res) => {
    res.json({ ...serializeRolesForClient(), overrides: overridesCache });
  });

  // ── Surcharges de permissions : RÉSERVÉ AU SUPER-ADMIN ──────────────────────
  // Élargir ou restreindre l'accès d'un rôle à un module, à chaud. Le super_admin
  // n'est jamais modifiable (sécurité). Restauration = DELETE.
  app.put('/api/admin/roles/:role/permissions/:module', auth, csrfProtection, requireSuperAdmin, (req, res) => {
    const { role, module } = req.params;
    const level = String(req.body?.level || '');
    if (!validRoles.includes(role) || role === 'super_admin') {
      return res.status(400).json({ error: 'Rôle invalide ou non modifiable' });
    }
    if (!OVERRIDABLE_MODULES.includes(module)) {
      return res.status(400).json({ error: 'Ce module ne peut pas être surchargé ici' });
    }
    if (!PERMISSION_LEVELS.includes(level)) {
      return res.status(400).json({ error: 'Niveau de permission invalide' });
    }
    db.prepare(`INSERT INTO role_permission_overrides (role, module, level, created_by, created_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(role, module) DO UPDATE SET
                  level = excluded.level, created_by = excluded.created_by, created_at = datetime('now')`)
      .run(role, module, level, req.admin.username);
    reloadOverrides();
    logActivity(req.admin.username, 'permission_override', `${role} · ${module} → ${level}`);
    res.json({ role, module, level, overrides: overridesCache });
  });

  // Restaure TOUTES les surcharges (placé avant la route paramétrée pour la lisibilité).
  app.delete('/api/admin/roles/overrides', auth, csrfProtection, requireSuperAdmin, (req, res) => {
    db.prepare('DELETE FROM role_permission_overrides').run();
    reloadOverrides();
    logActivity(req.admin.username, 'permission_override_reset_all', 'Toutes les surcharges supprimées');
    res.json({ overrides: {} });
  });

  // Restaure une cellule (role × module) à sa valeur de base.
  app.delete('/api/admin/roles/:role/permissions/:module', auth, csrfProtection, requireSuperAdmin, (req, res) => {
    const { role, module } = req.params;
    db.prepare('DELETE FROM role_permission_overrides WHERE role = ? AND module = ?').run(role, module);
    reloadOverrides();
    logActivity(req.admin.username, 'permission_override_reset', `${role} · ${module}`);
    res.json({ role, module, overrides: overridesCache });
  });

  // Construit l'objet exposé au client à partir d'une ligne admin_users (sans
  // les champs sensibles password / session_token / totp_secret).
  function publicUser(u) {
    if (!u) return null;
    const isOnline = !!(u.session_token && (!u.session_expires_at || new Date(u.session_expires_at) > new Date()));
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      email: u.email || null,
      created_at: u.created_at,
      is_active: u.is_active !== 0,
      last_login_at: u.last_login_at || null,
      last_login_ip: u.last_login_ip || null,
      must_change_password: u.must_change_password === 1,
      totp_enabled: u.totp_enabled === 1,
      session_active: isOnline,
    };
  }

  app.get('/api/admin/users', auth, requireSuperAdmin, (req, res) => {
    const users = db.prepare(
      "SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users ORDER BY id ASC"
    ).all();
    res.json(users.map(publicUser));
  });

  app.post('/api/admin/users', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    try {
      const { username, password, role = 'admin', email, mustChangePassword } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'Nom d\'utilisateur et mot de passe requis' });
      if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
      }
      const safeRole = validRoles.includes(role) ? role : 'admin';
      if (DEPRECATED_ACTOR_ROLES.includes(safeRole)) {
        return res.status(400).json({ error: 'Ce rôle n\'est plus attribuable : les intervenants (évaluateur, correcteur, infographiste, imprimeur) se gèrent désormais via le carnet d\'intervenants.' });
      }
      const cleanEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? email.trim() : null;
      const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get(username);
      if (existing) return res.status(400).json({ error: 'Ce nom d\'utilisateur existe déjà' });

      const hash = bcrypt.hashSync(password, 12);
      const forceReset = mustChangePassword ? 1 : 0;
      const result = db.prepare(
        "INSERT INTO admin_users (username, password, role, email, must_change_password, password_changed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
      ).run(username, hash, safeRole, cleanEmail, forceReset);
      logActivity(req.admin.username, 'create_admin', `Création admin: ${username} (${safeRole})${cleanEmail ? ` <${cleanEmail}>` : ''}${forceReset ? ' [renouvellement forcé]' : ''}`);
      const fresh = db.prepare('SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users WHERE id = ?').get(result.lastInsertRowid);
      res.json(publicUser(fresh));
    } catch (err) {
      console.error('Create admin error:', err.message);
      res.status(500).json({ error: 'Erreur création administrateur' });
    }
  });

  app.put('/api/admin/users/:id', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { username, role, password, email } = req.body;

      const target = db.prepare('SELECT id, username, role, email FROM admin_users WHERE id = ?').get(id);
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
        if (!validRoles.includes(role)) {
          return res.status(400).json({ error: 'Rôle invalide' });
        }
        if (DEPRECATED_ACTOR_ROLES.includes(role)) {
          return res.status(400).json({ error: 'Ce rôle n\'est plus attribuable : les intervenants se gèrent désormais via le carnet d\'intervenants.' });
        }
        updates.push('role = ?');
        values.push(role);
      }

      // Changement d'email (optionnel ; on accepte vide pour effacer)
      if (email !== undefined) {
        const trimmed = (email || '').trim();
        if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          return res.status(400).json({ error: 'Adresse email invalide' });
        }
        updates.push('email = ?');
        values.push(trimmed || null);
      }

      // Changement de mot de passe (optionnel)
      if (password && password.length > 0) {
        if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
          return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule et un chiffre' });
        }
        const hash = bcrypt.hashSync(password, 12);
        updates.push('password = ?');
        values.push(hash);
        updates.push("password_changed_at = datetime('now')");
        // Invalider la session active pour forcer une reconnexion avec le nouveau mot de passe
        updates.push('session_token = NULL');
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: 'Aucune modification fournie' });
      }

      values.push(id);
      db.prepare(`UPDATE admin_users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      // Relire le user pour renvoyer l'état à jour
      const updated = db.prepare('SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users WHERE id = ?').get(id);

      const changes = [];
      if (username && username.trim() !== target.username) changes.push(`username→${username.trim()}`);
      if (role && role !== target.role) changes.push(`rôle→${role}`);
      if (email !== undefined && (email || '').trim() !== (target.email || '')) changes.push(`email→${(email || '').trim() || '∅'}`);
      if (password) changes.push('mdp réinitialisé');
      logActivity(req.admin.username, 'update_admin', `Modification admin ${target.username}: ${changes.join(', ')}`);

      res.json(publicUser(updated));
    } catch (err) {
      console.error('Update admin error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour administrateur' });
    }
  });

  // Activer / désactiver un compte
  app.patch('/api/admin/users/:id/active', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { is_active } = req.body;
      const target = db.prepare('SELECT id, username FROM admin_users WHERE id = ?').get(id);
      if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });
      if (target.username === req.admin.username) {
        return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte' });
      }
      const newActive = is_active ? 1 : 0;
      // Si on désactive, on coupe aussi la session active.
      if (newActive === 0) {
        db.prepare('UPDATE admin_users SET is_active = 0, session_token = NULL, session_expires_at = NULL WHERE id = ?').run(id);
      } else {
        db.prepare('UPDATE admin_users SET is_active = 1 WHERE id = ?').run(id);
      }
      logActivity(req.admin.username, newActive ? 'activate_admin' : 'deactivate_admin', `${newActive ? 'Activation' : 'Désactivation'} de ${target.username}`);
      const fresh = db.prepare('SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users WHERE id = ?').get(id);
      res.json(publicUser(fresh));
    } catch (err) {
      console.error('Toggle admin active error:', err.message);
      res.status(500).json({ error: 'Erreur changement statut' });
    }
  });

  // Forcer la déconnexion d'un utilisateur (révoque sa session)
  app.post('/api/admin/users/:id/force-logout', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    const id = parseInt(req.params.id);
    const target = db.prepare('SELECT id, username FROM admin_users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (target.username === req.admin.username) {
      return res.status(400).json({ error: 'Utilisez le bouton « Déconnexion » pour votre propre session' });
    }
    db.prepare('UPDATE admin_users SET session_token = NULL, session_expires_at = NULL WHERE id = ?').run(id);
    logActivity(req.admin.username, 'force_logout', `Déconnexion forcée de ${target.username}`);
    const fresh = db.prepare('SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users WHERE id = ?').get(id);
    res.json(publicUser(fresh));
  });

  // Forcer le renouvellement du mot de passe au prochain login
  app.post('/api/admin/users/:id/force-password-reset', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    const id = parseInt(req.params.id);
    const target = db.prepare('SELECT id, username FROM admin_users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (target.username === req.admin.username) {
      return res.status(400).json({ error: 'Changez votre propre mot de passe via votre profil' });
    }
    db.prepare('UPDATE admin_users SET must_change_password = 1 WHERE id = ?').run(id);
    logActivity(req.admin.username, 'force_password_reset', `Renouvellement de mot de passe imposé à ${target.username}`);
    const fresh = db.prepare('SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users WHERE id = ?').get(id);
    res.json(publicUser(fresh));
  });

  // Désactiver la 2FA d'un autre utilisateur (clé d'urgence pour super_admin)
  app.post('/api/admin/users/:id/reset-2fa', auth, requireSuperAdmin, csrfProtection, (req, res) => {
    const id = parseInt(req.params.id);
    const target = db.prepare('SELECT id, username, totp_enabled FROM admin_users WHERE id = ?').get(id);
    if (!target) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    if (target.username === req.admin.username) {
      return res.status(400).json({ error: 'Désactivez votre propre 2FA depuis votre profil' });
    }
    db.prepare('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(id);
    logActivity(req.admin.username, 'reset_2fa', `2FA réinitialisée pour ${target.username}`);
    const fresh = db.prepare('SELECT id, username, role, email, created_at, is_active, last_login_at, last_login_ip, must_change_password, totp_enabled, session_token, session_expires_at FROM admin_users WHERE id = ?').get(id);
    res.json(publicUser(fresh));
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

  // Build WHERE clause from filters (shared between list + export)
  function buildActivityFilters(q) {
    const clauses = [];
    const params = [];
    if (q.action) { clauses.push('action = ?'); params.push(String(q.action)); }
    if (q.username) { clauses.push('admin_username = ?'); params.push(String(q.username)); }
    if (q.search) {
      clauses.push('(details LIKE ? OR action LIKE ? OR admin_username LIKE ?)');
      const like = `%${String(q.search)}%`;
      params.push(like, like, like);
    }
    if (q.from) { clauses.push("created_at >= ?"); params.push(String(q.from)); }
    if (q.to) { clauses.push("created_at < datetime(?, '+1 day')"); params.push(String(q.to)); }
    return {
      where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  app.get('/api/admin/activity-log', auth, (req, res) => {
    try {
      const page = Math.max(0, parseInt(req.query.page) || 0);
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
      const { where, params } = buildActivityFilters(req.query);

      const total = db.prepare(`SELECT COUNT(*) AS c FROM admin_activity_log ${where}`).get(...params).c;
      const logs = db.prepare(`SELECT * FROM admin_activity_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, page * limit);

      // Options disponibles pour les filtres (rapides, pas de filter appliqué)
      const available_actions = db.prepare('SELECT DISTINCT action FROM admin_activity_log ORDER BY action').all().map((r) => r.action);
      const available_users = db.prepare('SELECT DISTINCT admin_username FROM admin_activity_log ORDER BY admin_username').all().map((r) => r.admin_username);

      res.json({ logs, total, page, limit, available_actions, available_users });
    } catch (err) {
      console.error('[ACTIVITY] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement du journal' });
    }
  });

  app.get('/api/admin/activity-log/stats', auth, (req, res) => {
    try {
      const total = db.prepare('SELECT COUNT(*) AS c FROM admin_activity_log').get().c;
      const today = db.prepare("SELECT COUNT(*) AS c FROM admin_activity_log WHERE date(created_at) = date('now', 'localtime')").get().c;
      const week = db.prepare("SELECT COUNT(*) AS c FROM admin_activity_log WHERE created_at >= datetime('now', '-7 days')").get().c;
      const byAction = db.prepare('SELECT action, COUNT(*) AS c FROM admin_activity_log GROUP BY action ORDER BY c DESC LIMIT 8').all();
      const byUser = db.prepare('SELECT admin_username AS user, COUNT(*) AS c FROM admin_activity_log GROUP BY admin_username ORDER BY c DESC LIMIT 5').all();
      const byDay = db.prepare(`SELECT date(created_at, 'localtime') AS day, COUNT(*) AS c
        FROM admin_activity_log
        WHERE created_at >= datetime('now', '-14 days')
        GROUP BY day ORDER BY day ASC`).all();
      res.json({ total, today, week, byAction, byUser, byDay });
    } catch (err) {
      console.error('[ACTIVITY] stats error:', err.message);
      res.status(500).json({ error: 'Erreur calcul statistiques' });
    }
  });

  app.get('/api/admin/activity-log/export', auth, (req, res) => {
    try {
      const { where, params } = buildActivityFilters(req.query);
      const logs = db.prepare(`SELECT id, admin_username, action, details, created_at
        FROM admin_activity_log ${where} ORDER BY created_at DESC LIMIT 10000`).all(...params);

      const esc = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return /[,;"\n\r]/.test(s) ? `"${s}"` : s;
      };
      const header = 'id;date;utilisateur;action;details\n';
      const body = logs.map((l) => [l.id, l.created_at, l.admin_username, l.action, l.details].map(esc).join(';')).join('\n');
      const csv = '﻿' + header + body; // BOM UTF-8 pour Excel

      const filename = `journal-activite-${new Date().toISOString().slice(0, 10)}.csv`;
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      console.error('[ACTIVITY] export error:', err.message);
      res.status(500).json({ error: 'Erreur export CSV' });
    }
  });

  // ─── NOTIFICATION BADGES (sidebar counters) ───────────────

  app.get('/api/admin/notifications/counts', auth, (req, res) => {
    try {
      const unreadMessages = db.prepare("SELECT COUNT(*) AS c FROM contact_messages WHERE read = 0").get()?.c || 0;

      let pendingPayments = 0;
      try { pendingPayments = db.prepare("SELECT COUNT(*) AS c FROM order_payments WHERE payment_status = 'pending'").get()?.c || 0; } catch { /* table may not exist */ }

      let openAlerts = 0;
      try { openAlerts = db.prepare("SELECT COUNT(*) AS c FROM stock_alerts WHERE status = 'open' AND severity IN ('critique', 'haute')").get()?.c || 0; } catch { /* table may not exist */ }

      // Sorties d'argent non acquittées (badge admin/comptable « nouveau retrait »)
      let unackExpenses = 0;
      try { unackExpenses = db.prepare("SELECT COUNT(*) AS c FROM expenses WHERE status = 'recorded' AND acknowledged = 0").get()?.c || 0; } catch { /* table may not exist */ }

      // Manuscrits : nouveaux à traiter (stage = submitted dans la nouvelle table) + fallback legacy
      let pendingManuscripts = 0;
      try { pendingManuscripts = db.prepare("SELECT COUNT(*) AS c FROM manuscripts WHERE current_stage = 'submitted'").get()?.c || 0; } catch { /* table may not exist */ }
      if (!pendingManuscripts) {
        try { pendingManuscripts = db.prepare("SELECT COUNT(*) AS c FROM manuscript_submissions WHERE status = 'reçu'").get()?.c || 0; } catch { /* table may not exist */ }
      }

      // Badges par rôle métier (filtrés sur l'utilisateur connecté)
      const adminId = req.admin.id;
      const role = req.admin.role;
      let evaluations = 0, corrections = 0, editorial = 0, covers = 0, printing = 0;
      try {
        if (role === 'evaluateur' || role === 'super_admin' || role === 'admin') {
          evaluations = db.prepare(
            `SELECT COUNT(*) AS c FROM manuscripts
             WHERE current_stage = 'in_evaluation' AND (? IN ('super_admin','admin') OR assigned_evaluator_id = ?)`
          ).get(role, adminId)?.c || 0;
        }
        if (role === 'correcteur' || role === 'super_admin' || role === 'admin') {
          corrections = db.prepare(
            `SELECT COUNT(*) AS c FROM manuscripts
             WHERE current_stage = 'in_correction' AND (? IN ('super_admin','admin') OR assigned_corrector_id = ?)`
          ).get(role, adminId)?.c || 0;
        }
        if (role === 'editor' || role === 'production' || role === 'super_admin' || role === 'admin') {
          editorial = db.prepare("SELECT COUNT(*) AS c FROM manuscripts WHERE current_stage = 'in_editorial'").get()?.c || 0;
        }
        if (role === 'infographiste' || role === 'production' || role === 'super_admin' || role === 'admin') {
          covers = db.prepare(
            `SELECT COUNT(*) AS c FROM manuscripts
             WHERE current_stage = 'cover_design' AND (? IN ('super_admin','admin','production') OR assigned_infographist_id = ?)`
          ).get(role, adminId)?.c || 0;
        }
        if (role === 'imprimeur' || role === 'super_admin' || role === 'admin') {
          printing = db.prepare(
            `SELECT COUNT(*) AS c FROM manuscripts
             WHERE current_stage IN ('print_preparation','printing') AND (? IN ('super_admin','admin') OR assigned_printer_id = ?)`
          ).get(role, adminId)?.c || 0;
        }
      } catch (err) { console.error('Workflow counts error:', err.message); }

      // Badge dépenses : visible pour admins + comptable uniquement.
      const expenses = ['super_admin', 'admin', 'comptable'].includes(role) ? unackExpenses : 0;

      res.json({
        messages: unreadMessages,
        payments: pendingPayments,
        stock_alerts: openAlerts,
        manuscripts: pendingManuscripts,
        evaluations,
        corrections,
        editorial,
        covers,
        printing,
        expenses,
      });
    } catch (err) {
      console.error('Notification counts error:', err.message);
      res.json({ messages: 0, payments: 0, stock_alerts: 0, manuscripts: 0, evaluations: 0, corrections: 0, editorial: 0, covers: 0, printing: 0, expenses: 0 });
    }
  });

}
