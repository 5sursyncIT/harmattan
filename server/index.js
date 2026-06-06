import 'dotenv/config';
import { Buffer } from 'buffer';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import cron from 'node-cron';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
// import bcrypt from 'bcryptjs'; // Extracted to auth-routes.js
import { readdirSync, readFileSync, statSync } from 'fs';
import mysql from 'mysql2/promise';
import sharp from 'sharp';
import axios from 'axios';
import { dolibarrApi } from './dolibarr-client.js';
import { findExistingTier } from './tier-dedup.js';
import { cache, getSyncStatus, syncProducts, syncCategories, syncStock } from './sync.js';
import { EXCLUDED_CATEGORIES_SET, excludedCategorySqlList } from '../src/utils/excludedCategories.js';
import {
  buildPreorderCancellationEmail,
  buildPreorderConfirmationEmail,
  buildPreorderReleaseEmail,
  buildCancellationUpdate,
  buildReleasedStatus,
  calculatePreorderPricing,
  isUpcomingRelease,
  parseReleaseDate,
  resolvePreorderPayment,
  validatePreorderPayload,
} from './preorder-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// Un seul proxy Apache local en amont — nécessaire pour que req.ip / rate-limit
// se basent sur le vrai client (X-Forwarded-For).
app.set('trust proxy', 1);
// Ne pas divulguer la techno serveur.
app.disable('x-powered-by');

// --- DOLIBARR MYSQL CONNECTION ---
const dolibarrPool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
});
const PORT = process.env.PORT || 3001;
const IS_PROD = process.env.NODE_ENV === 'production';
// Cookie secure flag — ne pas activer tant que HTTPS n'est pas configuré
// Passer COOKIE_SECURE=true dans .env une fois SSL en place
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

// --- NEWSLETTER DB SETUP ---
const db = new Database(join(__dirname, '..', 'newsletter.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS newsletter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  token TEXT,
  confirmed INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pos_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pin TEXT NOT NULL,
  role TEXT DEFAULT 'cashier',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pos_cash_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  staff_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pos_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_token TEXT UNIQUE NOT NULL,
  device_name TEXT NOT NULL,
  enrolled_by INTEGER,
  last_seen_at DATETIME,
  last_ip TEXT,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pos_enrollment_codes (
  code TEXT PRIMARY KEY,
  created_by INTEGER,
  device_name TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used INTEGER DEFAULT 0
)`);

db.exec(`CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dolibarr_id TEXT UNIQUE,
  email TEXT UNIQUE,
  password TEXT NOT NULL,
  firstname TEXT,
  lastname TEXT,
  phone TEXT,
  address TEXT,
  city TEXT DEFAULT 'Dakar',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS preorders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preorder_ref TEXT UNIQUE NOT NULL,
  product_id TEXT NOT NULL,
  product_ref TEXT,
  product_label TEXT NOT NULL,
  customer_id INTEGER,
  customer_dolibarr_id TEXT,
  firstname TEXT NOT NULL,
  lastname TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  address TEXT NOT NULL,
  city TEXT NOT NULL,
  country TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  original_unit_price_ttc REAL NOT NULL,
  preorder_unit_price_ttc REAL NOT NULL,
  discount_rate REAL DEFAULT 0,
  total_price_ttc REAL NOT NULL,
  payment_method TEXT NOT NULL,
  payment_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'preorder',
  estimated_release_date TEXT NOT NULL,
  cancel_reason TEXT,
  cancelled_at DATETIME,
  released_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS order_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dolibarr_order_id TEXT NOT NULL,
  order_ref TEXT,
  customer_name TEXT,
  customer_email TEXT,
  customer_phone TEXT,
  payment_method TEXT,
  payment_status TEXT DEFAULT 'pending',
  amount_expected REAL DEFAULT 0,
  amount_received REAL,
  payer_phone TEXT,
  transaction_ref TEXT,
  provider_status TEXT,
  proof_text TEXT,
  invoice_ref TEXT,
  confirmed_by TEXT,
  confirmed_at DATETIME,
  rejected_by TEXT,
  rejected_at DATETIME,
  reject_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
// Migration : ajouter les colonnes manquantes si la table existe déjà
for (const col of [
  'customer_name TEXT', 'customer_phone TEXT', 'amount_expected REAL DEFAULT 0',
  'amount_received REAL', 'payer_phone TEXT', 'transaction_ref TEXT',
  'provider_status TEXT', 'proof_text TEXT', 'rejected_by TEXT',
  'rejected_at DATETIME', 'reject_reason TEXT',
]) {
  try { db.exec(`ALTER TABLE order_payments ADD COLUMN ${col}`); } catch { /* already exists */ }
}

// Cleanup expired customer sessions on startup
db.prepare("DELETE FROM customer_sessions WHERE expires_at < datetime('now')").run();

// ─── EMAIL TRANSPORTER (SMTP) ─────────────────────────────
// Priorité : variables d'environnement > site-config.json > fallback localhost
function createMailTransporter() {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (smtpHost && smtpUser) {
    console.log(`[MAIL] SMTP configuré via .env : ${smtpHost}:${smtpPort || 587}`);
    return nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort) || 587,
      secure: (parseInt(smtpPort) || 587) === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });
  }

  // Fallback sur site-config.json
  try {
    const config = JSON.parse(readFileSync(join(__dirname, 'site-config.json'), 'utf-8'));
    const smtp = config.smtp || {};
    if (smtp.host && smtp.host !== '127.0.0.1' && smtp.user) {
      console.log(`[MAIL] SMTP configuré via site-config.json : ${smtp.host}:${smtp.port || 587}`);
      return nodemailer.createTransport({
        host: smtp.host,
        port: parseInt(smtp.port) || 587,
        secure: smtp.secure || false,
        auth: { user: smtp.user, pass: smtp.pass },
      });
    }
  } catch { /* pas de config */ }

  console.warn('[MAIL] SMTP non configuré — les emails ne seront pas envoyés. Définir SMTP_HOST, SMTP_USER, SMTP_PASS dans .env');
  return nodemailer.createTransport({ host: '127.0.0.1', port: 1025, ignoreTLS: true });
}
const transporter = createMailTransporter();

// MAIL_FROM : si défini, force l'expéditeur de TOUS les emails sortants (alignement SPF/DMARC
// quand le compte SMTP n'autorise pas un From: arbitraire).
const MAIL_FROM_OVERRIDE = process.env.MAIL_FROM?.trim();
if (MAIL_FROM_OVERRIDE) {
  const _originalSendMail = transporter.sendMail.bind(transporter);
  transporter.sendMail = (mailOptions, callback) => {
    const patched = { ...mailOptions, from: MAIL_FROM_OVERRIDE };
    const result = _originalSendMail(patched, callback);
    if (result && typeof result.then === 'function') {
      return result.then(
        (info) => {
          console.log(`[MAIL] ✓ envoyé à ${patched.to} — sujet: ${patched.subject} — id: ${info?.messageId || '?'}`);
          return info;
        },
        (err) => {
          console.error(`[MAIL] ✗ ÉCHEC envoi à ${patched.to} — sujet: ${patched.subject} — erreur: ${err.message}`);
          throw err;
        }
      );
    }
    return result;
  };
  console.log(`[MAIL] MAIL_FROM override actif : ${MAIL_FROM_OVERRIDE}`);
}

// Vérifie au démarrage que le SMTP répond
transporter.verify().then(
  () => console.log('[MAIL] ✓ connexion SMTP vérifiée — prêt à envoyer'),
  (err) => console.error(`[MAIL] ✗ connexion SMTP impossible : ${err.message}`)
);
// SITE_URL pour les liens dans les emails (newsletter, reset password, etc.)
const SITE_URL = process.env.SITE_URL || `http://38.242.229.122:${PORT}`;
// ---------------------------

// ─── SECURITY MIDDLEWARE ─────────────────────────────────────

// Helmet — HTTP security headers
app.use(helmet({
  contentSecurityPolicy: IS_PROD ? {
    reportOnly: false, // CSP réellement appliquée (HTTPS en place via Apache)
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' + 'unsafe-eval' nécessaires pour le bundle Vite/React
      // (script d'init inline + lib utilisant new Function). Le reste de la CSP
      // reste strict — pas de chargement de scripts externes hors 'self'.
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://i.ytimg.com", "blob:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      upgradeInsecureRequests: [], // Réactivé : HTTPS configuré
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  // YouTube embed (iframe cross-origin) déclenche "Erreur 153 - Configuration du
  // lecteur vidéo" quand le Referer est masqué. Helmet met no-referrer par
  // défaut ; YouTube demande au moins l'origine du site pour les lecteurs embed.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // On relâche aussi COOP/CORP pour les embeds tiers.
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
}));

// CORS — restrict origins
const ALLOWED_ORIGINS = IS_PROD
  ? ['https://senharmattan.com', 'https://www.senharmattan.com', 'http://38.242.229.122:3000', 'http://38.242.229.122:3001']
  : ['http://localhost:3000', 'http://localhost:3001', 'http://38.242.229.122:3000', 'http://38.242.229.122:3001'];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else { console.warn(`[CORS] Blocked origin: ${origin}`); cb(new Error('Origin not allowed')); }
  },
  credentials: true,
}));

app.use(compression());
app.use(cookieParser());
// `verify` capture le buffer brut pour vérifier les signatures HMAC sans dépendre
// de l'ordre des clés ou de l'échappement Unicode après re-stringification.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));

// ─── RATE LIMITING ──────────────────────────────────────────

// Global rate limit: 200 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessayez dans une minute' },
});
app.use('/api/', globalLimiter);

// Strict rate limit for auth endpoints: 10 attempts per 15 min
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
});

// Strict rate limit for newsletter: 5 per hour
const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes d\'inscription, réessayez plus tard' },
});

// Order creation: 10 per hour
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de commandes, réessayez plus tard' },
});

// Sync trigger: 2 per hour
const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 2,
  message: { error: 'Sync déjà déclenché récemment' },
});

// Soumission publique de manuscrits (upload PDF/DOCX) : 5 par heure par IP.
// L'upload est coûteux et la route est publique → cible privilégiée de spam.
const manuscriptSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de soumissions, réessayez dans une heure' },
});

// Téléchargement par lien tokenisé (intervenants externes) : 60 par 15 min / IP.
const fileDownloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de téléchargements, réessayez plus tard' },
});

// ─── CSRF PROTECTION ────────────────────────────────────────

// Comparaison constant-time sûre : retourne false si longueurs différentes
// (crypto.timingSafeEqual lève une RangeError sinon).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Generate CSRF secret per session (stored in cookie)
const CSRF_SECRET = crypto.randomBytes(32).toString('hex');

function generateCsrfToken(req) {
  const sessionId = req.cookies?.csrf_session || crypto.randomBytes(16).toString('hex');
  const token = crypto.createHmac('sha256', CSRF_SECRET)
    .update(sessionId)
    .digest('hex');
  return { token, sessionId };
}

// CSRF token endpoint — frontend fetches this on load
app.get('/api/csrf-token', (req, res) => {
  const { token, sessionId } = generateCsrfToken(req);
  res.cookie('csrf_session', sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    secure: COOKIE_SECURE,
    maxAge: 24 * 60 * 60 * 1000, // 24h
  });
  res.json({ csrfToken: token });
});

// CSRF validation middleware
function csrfProtection(req, res, next) {
  const token = req.headers['x-csrf-token'];
  const sessionId = req.cookies?.csrf_session;

  if (!token || !sessionId) {
    return res.status(403).json({ error: 'Token CSRF manquant' });
  }

  const expected = crypto.createHmac('sha256', CSRF_SECRET)
    .update(sessionId)
    .digest('hex');

  if (!safeEqual(token, expected)) {
    return res.status(403).json({ error: 'Token CSRF invalide' });
  }

  next();
}

// ─── INPUT SANITIZATION ─────────────────────────────────────

function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/[<>]/g, '') // Strip basic HTML tags
    .trim()
    .slice(0, 5000); // Max length
}

function sanitizeBody(fields) {
  return (req, res, next) => {
    if (req.body) {
      for (const field of fields) {
        if (req.body[field]) req.body[field] = sanitize(req.body[field]);
      }
    }
    next();
  };
}

// ─── SQL FILTER SANITIZER ───────────────────────────────────
function safeSqlFilter(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/'/g, "''").replace(/[()]/g, '').slice(0, 200);
}

// Parse book metadata from HTML description field
function parseBookMetadata(description) {
  if (!description) return {};
  // Decode common HTML entities and strip tags
  const text = description
    .replace(/&nbsp;/g, ' ').replace(/&bull;/g, '•').replace(/&eacute;/g, 'é')
    .replace(/&egrave;/g, 'è').replace(/&agrave;/g, 'à').replace(/&ccedil;/g, 'ç')
    .replace(/&ocirc;/g, 'ô').replace(/&ucirc;/g, 'û').replace(/&iuml;/g, 'ï')
    .replace(/&#\d+;/g, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const pages = text.match(/(\d+)\s*pages/i)?.[1] || null;
  const pubDate = text.match(/Date de publication\s*:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const language = text.match(/Langue\s*:\s*(.+?)(?:\n|$)/i)?.[1]?.trim() || null;
  const format = text.match(/format\s*:\s*(.+?)(?:•|\n|$)/i)?.[1]?.trim() || null;
  let year = null;
  if (pubDate) {
    const m = pubDate.match(/(\d{4})/);
    if (m) year = parseInt(m[1]);
  }
  return { pages: pages ? parseInt(pages) : null, year, language, format };
}

// Resolve the best available description: prefer longdescript extrafield, fallback to standard description
function resolveDescription(p) {
  const longdescript = p.longdescript || p.array_options?.options_longdescript || '';
  const description = p.description || '';
  return longdescript || description;
}

// Enrich a product object with parsed metadata
function enrichProduct(p, hasImage) {
  const meta = parseBookMetadata(p.description);
  const dateCreation = p.date_creation || p.datec;

  // Extract structured metadata from extrafields (source de vérité)
  // with fallback on regex parsing for legacy products
  const extrafieldPages = p.nombre_pages ?? p.array_options?.options_nombre_pages ?? null;
  const extrafieldYear = p.publication_year ?? p.array_options?.options_publication_year ?? null;
  const extrafieldEditeur = p.editeur ?? p.array_options?.options_editeur ?? null;

  return {
    id: String(p.id || p.rowid),
    ref: p.ref,
    label: p.label,
    description: resolveDescription(p),
    price: String(p.price || 0),
    price_ttc: String(p.price_ttc || p.price || 0),
    tva_tx: String(p.tva_tx || 0),
    barcode: p.barcode || null,
    stock_reel: String(p.stock_reel || p.stock || 0),
    status: String(p.status || p.tosell || 0),
    weight: p.weight,
    date_creation: dateCreation,
    date_modification: p.date_modification || p.tms,
    array_options: p.array_options || {
      options_longdescript: p.longdescript || null,
      options_auteur: p.auteur || null,
      options_soustitre: p.soustitre || null,
      options_publication_year: extrafieldYear,
      options_nombre_pages: extrafieldPages,
      options_editeur: extrafieldEditeur,
    },
    has_image: hasImage ?? false,
    parsed_meta: {
      pages: extrafieldPages ? parseInt(extrafieldPages) : meta.pages,
      publication_year: extrafieldYear ? parseInt(extrafieldYear) : (meta.year || (dateCreation ? new Date(dateCreation).getFullYear() : null)),
      editeur: extrafieldEditeur,
      language: meta.language,
      format_info: meta.format,
    },
    genre_category: p.genre_category || null,
  };
}

// Hache un token de session avant lookup/insertion en DB — le token brut ne
// vit que dans le cookie HttpOnly de l'utilisateur. En cas de fuite SQLite,
// les tokens stockés ne sont pas rejouables.
export function hashCustomerSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// ─── CUSTOMER AUTH MIDDLEWARE ────────────────────────────────
function requireCustomerAuth(req, res, next) {
  const token = req.cookies?.customer_session;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  const session = db.prepare(
    "SELECT cs.customer_id, c.* FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
  ).get(hashCustomerSessionToken(token));
  if (!session) return res.status(401).json({ error: 'Session expirée' });

  req.customer = session;
  next();
}

// ─── PAYTECH columns migration (idempotent) ─────────────────
import { migrateAddPaytechColumns } from './migrations/add-paytech-columns.js';
migrateAddPaytechColumns(db);
import { migrateAddUpcomingBooks } from './migrations/add-upcoming-books.js';
migrateAddUpcomingBooks(db);

// ─── DOLIBARR WEBHOOK SYNC ──────────────────────────────────
const WEBHOOK_SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';

// Sync log table
db.exec(`CREATE TABLE IF NOT EXISTS webhook_sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  product_id INTEGER,
  product_ref TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  detail TEXT,
  caches_cleared TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// ─── BOOK TAGS (curation éditoriale : Notre sélection, Livres du mois, etc.) ───
db.exec(`CREATE TABLE IF NOT EXISTS book_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#10531a',
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  is_system INTEGER DEFAULT 0,
  show_on_home INTEGER DEFAULT 1,
  max_items INTEGER DEFAULT 12,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`CREATE TABLE IF NOT EXISTS book_tag_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  discount_pct REAL,
  pinned INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  added_by INTEGER,
  UNIQUE(tag_id, product_id),
  FOREIGN KEY(tag_id) REFERENCES book_tags(id) ON DELETE CASCADE
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_btp_tag ON book_tag_products(tag_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_btp_product ON book_tag_products(product_id)`);

// Junction livre ↔ auteur SQLite (Phase 1 du refactor auteur, 2026-05-24)
// `pe.auteur` Dolibarr reste source de vérité lecture publique. Cette table est
// remplie en dual-write par BookForm save quand le nom matche un author SQLite.
db.exec(`CREATE TABLE IF NOT EXISTS book_authors (
  product_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'author',
  position INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, author_id, role),
  FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ba_product ON book_authors(product_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_ba_author ON book_authors(author_id)`);

// Seed les 4 tags système si absents
const SYSTEM_TAGS = [
  { slug: 'notre_selection', label: 'Notre sélection', color: '#ea580c', icon: 'FiStar', sort_order: 1, description: "Les livres choisis par l'équipe éditoriale" },
  { slug: 'livre_du_mois', label: 'Livres du mois', color: '#10531a', icon: 'FiCalendar', sort_order: 2, description: 'Les livres mis en avant ce mois-ci' },
  { slug: 'nouveaute', label: 'Nouveautés', color: '#059669', icon: 'FiZap', sort_order: 3, description: 'Les dernières parutions du catalogue' },
  { slug: 'promotion', label: 'Promotions', color: '#dc2626', icon: 'FiTag', sort_order: 4, description: 'Bonnes affaires du moment' },
];
const insertTag = db.prepare(`INSERT OR IGNORE INTO book_tags
  (slug, label, description, color, icon, sort_order, is_active, is_system, show_on_home, max_items)
  VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, 12)`);
for (const t of SYSTEM_TAGS) {
  insertTag.run(t.slug, t.label, t.description, t.color, t.icon, t.sort_order);
}

// Migration one-shot : extrafield livre_du_mois → book_tag_products
async function migrateLivreDuMois() {
  try {
    const tag = db.prepare('SELECT id FROM book_tags WHERE slug = ?').get('livre_du_mois');
    if (!tag) return;
    const alreadyMigrated = db.prepare('SELECT COUNT(*) AS c FROM book_tag_products WHERE tag_id = ?').get(tag.id);
    if (alreadyMigrated.c > 0) return; // idempotent
    const [rows] = await dolibarrPool.query(
      'SELECT fk_object FROM llx_product_extrafields WHERE livre_du_mois = 1'
    );
    const insert = db.prepare(
      'INSERT OR IGNORE INTO book_tag_products (tag_id, product_id) VALUES (?, ?)'
    );
    const trx = db.transaction((productIds) => {
      for (const pid of productIds) insert.run(tag.id, pid);
    });
    trx(rows.map((r) => r.fk_object));
    console.log(`[TAGS] Migration livre_du_mois → book_tag_products : ${rows.length} livres importés`);
  } catch (err) {
    console.error('[TAGS] Migration livre_du_mois failed:', err.message);
  }
}

app.post('/api/webhooks/dolibarr', (req, res) => {
  try {
    // ── Validate secret ──
    const headerSecret = req.headers['x-webhook-secret'] || '';
    const headerSignature = req.headers['x-webhook-signature'] || '';

    if (!WEBHOOK_SECRET) {
      console.warn('[WEBHOOK] No DOLIBARR_WEBHOOK_SECRET configured');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    // Validate via HMAC signature (preferred) or direct secret match
    // Comparaisons constant-time (safeEqual) pour éviter les timing attacks.
    // IMPORTANT : signer/vérifier sur le body BRUT (rawBody), pas sur la re-stringification
    // qui peut différer du JSON original (ordre des clés, échappement Unicode).
    const rawBuf = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const expectedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBuf).digest('hex');

    if (headerSignature && !safeEqual(headerSignature, expectedSignature)) {
      // Also try with raw body if JSON.stringify differs
      if (!safeEqual(headerSecret, WEBHOOK_SECRET)) {
        console.warn('[WEBHOOK] Invalid signature/secret');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      console.warn('[WEBHOOK] Authentification via secret en clair (signature absente/invalide)');
    } else if (!headerSignature) {
      if (!safeEqual(headerSecret, WEBHOOK_SECRET)) {
        console.warn('[WEBHOOK] Invalid secret');
        return res.status(401).json({ error: 'Invalid webhook secret' });
      }
      console.warn('[WEBHOOK] Authentification via secret en clair (signature absente)');
    }

    // ── Parse payload ──
    const { event, product, action } = req.body;
    if (!event || !product) {
      return res.status(400).json({ error: 'Missing event or product in payload' });
    }

    const productId = product.id;
    const productRef = product.ref || '—';
    console.log(`[WEBHOOK] ${event} — produit ${productRef} (ID: ${productId})`);

    // ── Invalidate relevant caches ──
    const cleared = [];

    // Single product cache
    cache.del(`product:${productId}`);
    cleared.push(`product:${productId}`);

    // All product listing caches (they contain stale data now)
    for (const k of cache.keys()) {
      if (k.startsWith('products:') || k.startsWith('suggest:')) {
        cache.del(k);
        cleared.push(k);
      }
    }

    // Price-related events: clear price range
    if (event.includes('price')) {
      cache.del('price-range');
      cleared.push('price-range');
    }

    // Stock events: clear all product listings
    if (event.includes('stock')) {
      // Already cleared above via products:* pattern
    }

    // Image events: clear image caches
    if (event.includes('image')) {
      if (productRef) {
        cache.del(`img:${productRef}`);
        cache.del(`realcover:${productRef}`);
        cleared.push(`img:${productRef}`, `realcover:${productRef}`);
      }
      // Clear image data caches
      for (const k of cache.keys()) {
        if (k.startsWith(`imgdata:${productId}:`) || k.startsWith(`catimg:`)) {
          cache.del(k);
          cleared.push(k);
        }
      }
      cache.del('refs-with-real-covers');
      cleared.push('refs-with-real-covers');
    }

    // Category events: clear category cache
    if (event.includes('category')) {
      cache.del('categories:all');
      cleared.push('categories:all');
    }

    // Delete event: clean up everything for this product
    if (event === 'product.deleted') {
      for (const k of cache.keys()) {
        if (k.includes(String(productId)) || (productRef && k.includes(productRef))) {
          cache.del(k);
          cleared.push(k);
        }
      }
    }

    // ── Log sync event ──
    db.prepare(`INSERT INTO webhook_sync_log (event, product_id, product_ref, status, detail, caches_cleared) VALUES (?, ?, ?, 'ok', ?, ?)`).run(
      event,
      productId,
      productRef,
      `Action: ${action || event}`,
      cleared.join(', ')
    );

    console.log(`[WEBHOOK] Cache invalidé: ${cleared.length} entrées (${cleared.slice(0, 5).join(', ')}${cleared.length > 5 ? '...' : ''})`);

    res.json({
      status: 'ok',
      event,
      product_id: productId,
      caches_cleared: cleared.length,
    });
  } catch (err) {
    console.error('[WEBHOOK] Error:', err);

    // Log the error
    try {
      db.prepare(`INSERT INTO webhook_sync_log (event, product_id, status, detail) VALUES (?, ?, 'error', ?)`).run(
        req.body?.event || 'unknown',
        req.body?.product?.id || 0,
        err.message
      );
    } catch { /* ignore logging errors */ }

    res.status(500).json({ error: 'Internal webhook processing error' });
  }
});

// Admin endpoint to view sync logs
app.get('/api/webhooks/logs', (req, res) => {
  // Only allow from admin session (reuse admin auth check if available)
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const logs = db.prepare('SELECT * FROM webhook_sync_log ORDER BY id DESC LIMIT ?').all(limit);
  res.json(logs);
});

// ─── POS MODULE ─────────────────────────────────────────────
import { createPosRouter } from './pos-routes.js';
app.use('/api/pos', createPosRouter({ db, dolibarrPool, csrfProtection, sanitizeBody, safeSqlFilter, transporter }));

// ─── AUTH MODULE ────────────────────────────────────────────
import { createAuthRouter } from './auth-routes.js';
app.use('/api/auth', createAuthRouter({ db, csrfProtection, sanitizeBody, authLimiter, requireCustomerAuth, dolibarrApi, dolibarrPool, transporter, cookieSecure: COOKIE_SECURE }));

// ─── CONTRACTS MODULE ───────────────────────────────────
import { createContractRouter } from './contract-routes.js';
app.use('/api/contracts', createContractRouter({ db, dolibarrPool, csrfProtection, sanitizeBody, transporter }));

// ─── CONTRACT QUOTES (devis de contribution auteur) ─────
import { createContractQuoteRouter } from './contract-quote-routes.js';
app.use('/api', createContractQuoteRouter({ db, dolibarrPool, csrfProtection }));

// ─── AUTHOR PORTAL (workflow éditorial) ────────────────────
import { createAuthorRouter } from './author-routes.js';
const { router: authorRouter, requireAuthorAuth } = createAuthorRouter({
  db, csrfProtection, sanitizeBody, authLimiter, transporter,
  cookieSecure: COOKIE_SECURE, siteUrl: SITE_URL, dolibarrPool,
});
app.use('/api/author', authorRouter);
 
const _requireAuthorAuth = requireAuthorAuth;

// ─── ESPACE PUBLIC DES AUTEURS (annuaire + profil) ─────────
import { createAuthorPublicRouter, ensureAuthorPublicSchema } from './author-public-routes.js';
try {
  ensureAuthorPublicSchema(db);
  console.log('[PUBLIC-AUTHORS] Schéma étendu (slug/bio/photo/socials) OK');
} catch (err) {
  console.error('[PUBLIC-AUTHORS] Init schéma:', err.message);
}
app.use('/api/authors', createAuthorPublicRouter({ db, dolibarrPool, cache }));

// ─── ADMIN MODULE ───────────────────────────────────────────
const siteConfigPath = join(__dirname, 'site-config.json');
function getSiteConfig() {
  try { return JSON.parse(readFileSync(siteConfigPath, 'utf-8')); }
  catch { return {}; }
}

function getUpcomingBookConfig(productId, config = getSiteConfig()) {
  // Source de vérité : le catalogue (table book_upcoming, pilotée depuis /admin/books).
  try {
    const row = db.prepare(
      'SELECT release_date, summary, preorder_discount_pct FROM book_upcoming WHERE product_id = ?'
    ).get(Number(productId));
    if (row) {
      return {
        product_id: String(productId),
        release_date: row.release_date || '',
        summary: row.summary || '',
        preorder_discount_pct: row.preorder_discount_pct || 0,
        link: `/produit/${productId}`,
      };
    }
  } catch (e) { void e; }

  // Rétrocompat : ancienne liste manuelle dans site-config.json
  const expectedLink = `/produit/${productId}`;
  return (config.upcoming_books || []).find((book) =>
    String(book?.product_id || '') === String(productId) || String(book?.link || '').trim() === expectedLink
  ) || null;
}

function getProductReleaseDate(product, config = getSiteConfig()) {
  const upcomingBook = getUpcomingBookConfig(product.id || product.rowid, config);
  if (upcomingBook?.release_date) return upcomingBook.release_date;

  const rawDescription = product.description || '';
  const match = rawDescription.match(/Date de publication\s*:\s*(.+?)(?:<br|\\n|\n|$)/i);
  return match?.[1]?.replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim() || null;
}

function buildPreorderReference() {
  return `PRE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

async function upsertPreorderThirdparty(customer, shippingAddress) {
  let localCustomer = db.prepare('SELECT * FROM customers WHERE email = ?').get(customer.email);
  let customerId = localCustomer?.dolibarr_id || null;

  if (!customerId) {
    try {
      const searchRes = await dolibarrApi.get('/thirdparties', {
        params: { sqlfilters: `(t.email:=:'${safeSqlFilter(customer.email)}')` },
      });
      if (searchRes.data && searchRes.data.length > 0) {
        customerId = searchRes.data[0].id;
      }
    } catch (err) {
      console.warn('Preorder customer search warning:', err.response?.data || err.message);
    }
  }

  if (!customerId) {
    const tpRes = await dolibarrApi.post('/thirdparties', {
      name: `${customer.firstname} ${customer.lastname}`,
      firstname: customer.firstname,
      email: customer.email,
      phone: customer.phone || '',
      address: shippingAddress.address,
      town: shippingAddress.city,
      country_code: 'SN',
      client: 1,
      code_client: -1,
    });
    customerId = tpRes.data;
  }

  try {
    await dolibarrApi.put(`/thirdparties/${customerId}`, {
      name: `${customer.firstname} ${customer.lastname}`,
      firstname: customer.firstname,
      email: customer.email,
      phone: customer.phone || '',
      address: shippingAddress.address,
      town: shippingAddress.city,
      country_code: 'SN',
    });
  } catch (err) {
    console.warn('Preorder address update warning:', err.response?.data || err.message);
  }

  if (localCustomer) {
    db.prepare(`
      UPDATE customers
      SET firstname = ?, lastname = ?, phone = ?, address = ?, city = ?, dolibarr_id = COALESCE(dolibarr_id, ?)
      WHERE id = ?
    `).run(
      customer.firstname,
      customer.lastname,
      customer.phone || null,
      shippingAddress.address,
      shippingAddress.city,
      customerId,
      localCustomer.id
    );
  } else {
    localCustomer = null;
  }

  return {
    localCustomerId: localCustomer?.id || null,
    dolibarrCustomerId: customerId,
  };
}

function getEnabledPaymentMethods(config = getSiteConfig()) {
  return Array.isArray(config?.payment_methods)
    ? config.payment_methods.filter((method) => method?.enabled)
    : [];
}

async function sendPreorderEmail(to, message) {
  if (!to || !message?.subject || !message?.html) return;
  await transporter.sendMail({
    from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
    to,
    subject: message.subject,
    html: message.html,
  });
}

async function sendPreorderConfirmationEmail(preorder, paymentMethods = getEnabledPaymentMethods()) {
  return sendPreorderEmail(preorder?.email, buildPreorderConfirmationEmail(preorder, paymentMethods));
}

async function sendPreorderCancellationEmail(preorder, paymentMethods = getEnabledPaymentMethods()) {
  return sendPreorderEmail(preorder?.email, buildPreorderCancellationEmail(preorder, paymentMethods));
}

async function sendPreorderReleaseEmail(preorder, paymentMethods = getEnabledPaymentMethods()) {
  return sendPreorderEmail(preorder?.email, buildPreorderReleaseEmail(preorder, paymentMethods));
}
import { setupAdminRoutes, adminAuth } from './admin-routes.js';
try {
  setupAdminRoutes(app, { db, csrfProtection, sanitizeBody, transporter, cache, dolibarrPool, cookieSecure: COOKIE_SECURE, authLimiter, manuscriptSubmitLimiter, siteUrl: SITE_URL });
  console.log('[ADMIN] Admin routes mounted');
} catch (err) {
  console.error('[ADMIN] Failed to mount admin routes:', err);
}

// ─── ACTUALITÉS (public + admin) — monté APRÈS setupAdminRoutes
// pour bénéficier du middleware RBAC global sur /api/admin
import { createNewsRouter } from './news-routes.js';
try {
  app.use(createNewsRouter({ db, cache, adminAuth: adminAuth(db), csrfProtection }));
  console.log('[NEWS] News routes mounted');
} catch (err) {
  console.error('[NEWS] Failed to mount news routes:', err);
}

// ─── MANUSCRIPT WORKFLOW (admin) — monté APRÈS setupAdminRoutes
// pour bénéficier du middleware RBAC global sur /api/admin
import { createManuscriptRouter } from './manuscript-routes.js';
import { transition as wfTransition } from './manuscript-workflow.js';
import { sendTransitionEmail, ensureNotificationsSchema, createAuthorNotification, getAuthorPreferences } from './manuscript-emails.js';
import { ensureFileTokensSchema, createPublicFileRouter } from './manuscript-file-tokens.js';

// Initialise la table author_notifications (cloche in-app auteur)
try { ensureNotificationsSchema(db); console.log('[NOTIF] Schéma author_notifications OK'); }
catch (err) { console.error('[NOTIF] Init schéma:', err.message); }

// Liens de téléchargement tokenisés pour les intervenants externes (sans compte).
// Route PUBLIQUE montée hors /api/admin (pas de RBAC), rate-limitée.
try { ensureFileTokensSchema(db); console.log('[FILES] Schéma manuscript_file_tokens OK'); }
catch (err) { console.error('[FILES] Init schéma:', err.message); }
app.use('/api/files', createPublicFileRouter({ db, limiter: fileDownloadLimiter }));

// Expose la config site pour les emails admin (lecture seule, rafraîchie à chaque notif)
// Utilisée par notifyTransition pour résoudre l'adresse admin de réception
try {
  global.__siteConfigFallback = JSON.parse(
    readFileSync(join(__dirname, 'site-config.json'), 'utf-8')
  );
} catch (err) { console.warn('[NOTIF] site-config.json lookup failed:', err.message); }

// Hook 1 : créer un contrat Dolibarr draft quand une évaluation est positive
async function createContractDraft(manuscript) {
  const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(manuscript.author_id);
  if (!author) throw new Error('Auteur introuvable');

  // Créer la thirdparty Dolibarr si nécessaire
  let thirdpartyId = author.dolibarr_thirdparty_id;
  if (!thirdpartyId) {
    try {
      // Dédup : réutiliser un tier actif existant (même email / téléphone) plutôt
      // que d'en créer un doublon, puis lier l'auteur.
      const existing = await findExistingTier(dolibarrPool, { email: author.email, phone: author.phone });
      if (existing) {
        thirdpartyId = existing.id;
      } else {
        const doliRes = await dolibarrApi.post('/thirdparties', {
          name: `${author.firstname} ${author.lastname}`,
          email: author.email,
          phone: author.phone || '',
          client: 1,
          code_client: -1,
        });
        thirdpartyId = doliRes.data;
      }
      db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ?').run(thirdpartyId, author.id);
    } catch (err) {
      console.error('[WORKFLOW] Thirdparty create error:', err.response?.data || err.message);
      throw new Error('Échec création thirdparty Dolibarr');
    }
  }

  // Créer le contrat brouillon via Dolibarr REST API.
  // Type par défaut : harmattan_2024 (contrat classique) — l'éditeur peut basculer
  // vers harmattan_dll / tamarinier dans le brouillon. Aligné avec ACTIVE_CONTRACT_TYPES.
  const CONTRACT_TYPE = 'harmattan_2024';
  const TEMPLATE_FILE = 'template_harmattan_2024';
  const modelPdf = `generic_contract_odt:/var/www/html/dolibarr/documents/doctemplates/contracts/${TEMPLATE_FILE}.odt`;
  try {
    const contractRes = await dolibarrApi.post('/contracts', {
      socid: parseInt(thirdpartyId, 10),
      date_contrat: Math.floor(Date.now() / 1000),
      model_pdf: modelPdf,
      array_options: {
        // Defaults alignés avec DEFAULTS_BY_TYPE[harmattan_2024] dans contract-routes.js
        options_contract_type: CONTRACT_TYPE,
        options_book_title: manuscript.title,
        options_royalty_rate_print: 10,
        options_royalty_rate_digital: 10,
        options_royalty_threshold: 500,
        options_free_author_copies: 5,
        options_tirage_initial: 100,
        options_format_ouvrage: '15 × 21 cm',
        options_prix_public_previsionnel: 15,
        options_nombre_pages_estime: 200,
        options_exemplaires_sp: 5,
      },
    });
    const contractId = contractRes.data;

    // Lier manuscrit ↔ contrat
    db.exec(`CREATE TABLE IF NOT EXISTS contract_manuscript_links (
      contract_id INTEGER, manuscript_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (contract_id, manuscript_id)
    )`);
    db.prepare('INSERT OR IGNORE INTO contract_manuscript_links (contract_id, manuscript_id) VALUES (?, ?)')
      .run(contractId, manuscript.id);

    // Transition → contract_pending + stockage du contract_id
    wfTransition(db, manuscript.id, 'contract_pending',
      { role: 'system', label: 'workflow' },
      { note: `Contrat Dolibarr #${contractId} créé (${CONTRACT_TYPE})`, updates: { contract_id: contractId } }
    );

    // Note : à ce stade le contrat est en brouillon — sa référence est provisoire
    // (« (PROV…) ») et le PDF définitif n'est pas généré. Le lien de signature
    // doit être envoyé manuellement par l'éditeur après validation du brouillon
    // (route POST /api/admin/contracts/:id/send-signature), pas ici.

    return { contract_id: contractId, thirdparty_id: thirdpartyId };
  } catch (err) {
    console.error('[WORKFLOW] Contract create error:', err.response?.data || err.message);
    throw new Error('Échec création contrat Dolibarr');
  }
}

// Hook 2 : créer produit Dolibarr + MO d'impression à la préparation
async function createPrintMO({ manuscript, qty, isbn }) {
  let productId = manuscript.dolibarr_product_id;
  if (!productId) {
    try {
      const prodRes = await dolibarrApi.post('/products', {
        ref: manuscript.ref.replace(/[^A-Z0-9-]/g, ''),
        label: manuscript.title,
        type: 0, // produit
        status: 1, // vendable
        status_buy: 1,
        barcode: isbn || null,
      });
      productId = prodRes.data;
    } catch (err) {
      console.error('[WORKFLOW] Product create error:', err.response?.data || err.message);
      throw new Error('Échec création produit Dolibarr');
    }
  }

  // Générer la référence MO et INSERT direct dans llx_mrp_mo
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [[maxRef]] = await dolibarrPool.query(
    `SELECT MAX(CAST(SUBSTRING(ref, 8) AS UNSIGNED)) AS max_seq FROM llx_mrp_mo WHERE ref LIKE 'MO${yymm}%'`
  );
  const seq = String((maxRef?.max_seq || 0) + 1).padStart(4, '0');
  const moRef = `MO${yymm}-${seq}`;
  const nowStr = now.toISOString().slice(0, 19).replace('T', ' ');
  const endDate = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const [result] = await dolibarrPool.query(
    `INSERT INTO llx_mrp_mo (ref, entity, label, qty, fk_warehouse, fk_product, status, date_start_planned, date_end_planned, date_creation, mrptype)
     VALUES (?, 1, ?, ?, 4, ?, 0, ?, ?, ?, 0)`,
    [moRef, `Impression initiale — ${manuscript.title}`, qty, productId, nowStr, endDate, nowStr]
  );

  db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
    .run('workflow', 'print_prepare', `Impression lancée : ${manuscript.ref} × ${qty} → ${moRef}`);

  return { dolibarr_product_id: productId, dolibarr_mo_id: result.insertId, dolibarr_mo_ref: moRef };
}

try {
  const manuscriptRouter = createManuscriptRouter({
    db,
    csrfProtection,
    adminAuth: adminAuth(db),
    transporter,
    siteUrl: SITE_URL,
    hooks: {
      onEvaluationPositive: async (manuscript) => {
        try {
          await createContractDraft(manuscript);
        } catch (err) {
          console.error('[WORKFLOW] Contract auto-create failed (non-blocking):', err.message);
        }
      },
      onPrintPrepare: createPrintMO,
    },
  });
  app.use('/api/admin', manuscriptRouter);
  console.log('[WORKFLOW] Manuscript workflow routes mounted');
} catch (err) {
  console.error('[WORKFLOW] Failed to mount manuscript routes:', err);
}

// ─── CRON : polling des signatures de contrat (5 min) ─────
setInterval(async () => {
  try {
    const pending = db.prepare(
      "SELECT id, contract_id, ref FROM manuscripts WHERE current_stage = 'contract_pending' AND contract_id IS NOT NULL"
    ).all();
    for (const m of pending) {
      try {
        const [[contract]] = await dolibarrPool.query(
          'SELECT signed_status FROM llx_contrat WHERE rowid = ?', [m.contract_id]
        );
        if (contract && [2, 9].includes(contract.signed_status)) {
          const signed = wfTransition(db, m.id, 'contract_signed',
            { role: 'system', label: 'polling' },
            { note: `Signature détectée (signed_status=${contract.signed_status})` }
          );
          console.log(`[WORKFLOW] ${m.ref} contrat signé détecté.`);

          // Notifier l'auteur du contract_signed (email + in-app)
          const author = db.prepare('SELECT id, email, firstname FROM authors WHERE id = ?').get(signed.author_id);
          if (author) {
            createAuthorNotification(db, signed, 'contract_signed', author, SITE_URL);
            if (author.email) {
              sendTransitionEmail(transporter, signed, 'contract_signed',
                { type: 'author', email: author.email, firstname: author.firstname }, SITE_URL);
            }
          }

          // Avancer automatiquement à payment_pending
          const pending = wfTransition(db, m.id, 'payment_pending',
            { role: 'system', label: 'polling' },
            { note: 'Paiement attendu après signature' }
          );

          // Notifier l'auteur du payment_pending (email + in-app)
          if (author) {
            createAuthorNotification(db, pending, 'payment_pending', author, SITE_URL);
            if (author.email) {
              sendTransitionEmail(transporter, pending, 'payment_pending',
                { type: 'author', email: author.email, firstname: author.firstname }, SITE_URL);
            }
          }
        }
      } catch (err) { console.warn('[WORKFLOW] signature poll error for', m.ref, ':', err.message); }
    }
  } catch (err) { console.error('[WORKFLOW] signature cron error:', err.message); }
}, 5 * 60 * 1000);

// ─── PAYMENT CONFIRMATION (admin confirms payment → invoice created) ────
const confirmPaymentAuth = adminAuth(db);
app.post('/api/admin/orders/:id/confirm-payment', confirmPaymentAuth, csrfProtection, async (req, res) => {
  try {
    const orderId = req.params.id;

    // Fetch the order from Dolibarr
    const orderDetail = await dolibarrApi.get(`/orders/${orderId}`);
    const order = orderDetail.data;

    if (!order || !order.socid) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }

    // Check if an invoice already exists for this order (requête directe sur la table de liens Dolibarr)
    try {
      const [existingLinks] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref FROM llx_element_element el
         JOIN llx_facture f ON f.rowid = el.fk_target
         WHERE el.sourcetype = 'commande' AND el.targettype = 'facture' AND el.fk_source = ?
         LIMIT 1`,
        [orderId]
      );
      if (existingLinks.length > 0) {
        return res.status(400).json({ error: `Facture ${existingLinks[0].ref} déjà créée pour cette commande` });
      }
    } catch { /* continue — table may not exist or link not found */ }

    // ── Revalidation stock juste avant création facture ──
    // Entre la commande et la confirmation paiement, le POS peut avoir vendu les
    // mêmes exemplaires. On revérifie p.stock pour tous les produits physiques
    // avant de valider la facture, sinon on crée une commande "facturée" sur du
    // stock qui n'existe pas.
    try {
      const productLines = (order.lines || []).filter((l) => l.fk_product);
      const productIds = productLines.map((l) => parseInt(l.fk_product));
      if (productIds.length > 0) {
        const placeholders = productIds.map(() => '?').join(',');
        // On vérifie le stock de l'entrepôt RAYON (4) — c'est lui que la facture
        // décrémente (idwarehouse:4). Vérifier le stock global laisserait confirmer
        // une commande que Dolibarr refusera de facturer faute de stock au Rayon
        // (STOCK_MUST_BE_ENOUGH_FOR_INVOICE=1, négatif interdit).
        const [stockRows] = await dolibarrPool.query(
          `SELECT p.rowid AS id, p.label, p.fk_product_type,
                  COALESCE(ps.reel, 0) AS wh_stock
           FROM llx_product p
           LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = 4
           WHERE p.rowid IN (${placeholders})`,
          productIds,
        );
        const stockMap = new Map(stockRows.map((r) => [r.id, r]));
        for (const line of productLines) {
          const pid = parseInt(line.fk_product);
          const row = stockMap.get(pid);
          if (!row || row.fk_product_type !== 0) continue;
          const available = Number(row.wh_stock) || 0;
          const qty = parseFloat(line.qty) || 0;
          if (available < qty) {
            return res.status(409).json({
              error: available <= 0 ? 'Article en rupture — paiement non confirmable' : 'Stock insuffisant pour confirmer cette commande',
              product_id: pid,
              product_label: row.label,
              requested: qty,
              available: Math.max(0, available),
            });
          }
        }
      }
    } catch (stockErr) {
      console.warn('[CONFIRM-PAYMENT] Stock recheck failed, allowing:', stockErr.message);
    }

    // Create invoice from order lines
    const invoiceRes = await dolibarrApi.post('/invoices', {
      socid: parseInt(order.socid),
      date: new Date().toISOString().split('T')[0],
      type: 0,
      // Tag canal de vente (cohérent avec /orders et avec module_source='takepos' du POS).
      module_source: 'ecommerce',
      lines: (order.lines || []).map((line) => ({
        fk_product: line.fk_product ? parseInt(line.fk_product) : null,
        qty: parseFloat(line.qty),
        subprice: parseFloat(line.subprice),
        tva_tx: parseFloat(line.tva_tx || 0),
        product_type: parseInt(line.product_type || 0),
        desc: line.description || line.product_label || '',
      })),
      linked_objects: { commande: orderId },
      note_private: `Paiement confirmé par ${req.admin.username} — ${order.note_private || ''}`,
      mode_reglement_id: order.mode_reglement_id || 0,
    });

    const invoiceId = invoiceRes.data;

    // Validate the invoice — idwarehouse:4 (Rayon) déclenche le décrément stock
    // sur le même dépôt que le POS, source de vérité pour la disponibilité physique.
    await dolibarrApi.post(`/invoices/${invoiceId}/validate`, { idwarehouse: 4 });
    const invoice = await dolibarrApi.get(`/invoices/${invoiceId}`);

    // Mettre à jour le suivi de paiement local
    db.prepare(
      'UPDATE order_payments SET payment_status = ?, invoice_ref = ?, confirmed_by = ?, confirmed_at = datetime(?) WHERE dolibarr_order_id = ?'
    ).run('confirmed', invoice.data.ref, req.admin.username, new Date().toISOString(), String(orderId));

    // Log activity
    db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
      .run(req.admin.username, 'confirm_payment', `Paiement confirmé : commande ${order.ref} → facture ${invoice.data.ref}`);

    // Invalidate customer caches
    cache.keys().filter((k) => k.startsWith('customer-orders:') || k.startsWith('customer-invoices:')).forEach((k) => cache.del(k));

    console.log(`[PAYMENT] ${req.admin.username} confirmed payment: order ${order.ref} → invoice ${invoice.data.ref}`);

    res.json({
      success: true,
      order_ref: order.ref,
      invoice_id: invoiceId,
      invoice_ref: invoice.data.ref,
    });
  } catch (err) {
    console.error('POST /api/admin/orders/:id/confirm-payment error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: 'Erreur confirmation de paiement' });
  }
});

// ─── PAYMENT MANAGEMENT (admin list, reject, update) ────────
const paymentMgmtAuth = adminAuth(db);

// Liste des paiements web avec filtres
app.get('/api/admin/payments', paymentMgmtAuth, (req, res) => {
  const { status, method, page = 1, limit = 30 } = req.query;
  const limitInt = Math.min(parseInt(limit) || 30, 100);
  const offset = (Math.max(1, parseInt(page)) - 1) * limitInt;

  let where = 'WHERE 1=1';
  const params = [];
  if (status) { where += ' AND payment_status = ?'; params.push(status); }
  if (method) { where += ' AND payment_method = ?'; params.push(method); }

  const total = db.prepare(`SELECT COUNT(*) AS c FROM order_payments ${where}`).get(...params)?.c || 0;
  const payments = db.prepare(
    `SELECT * FROM order_payments ${where} ORDER BY
     CASE payment_status WHEN 'pending' THEN 1 WHEN 'confirmed' THEN 2 WHEN 'rejected' THEN 3 ELSE 4 END,
     created_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limitInt, offset);

  res.json({ payments, total, page: Math.max(1, parseInt(page)), pages: Math.ceil(total / limitInt) });
});

// Paiements confirmés sans facture liée — incident à arbitrer manuellement.
// Cas typique : IPN PayTech a confirmé le paiement, mais la création de facture
// a échoué (timeout Dolibarr, stock insuffisant, etc.). L'admin doit voir cette
// liste pour relancer la facturation ou rembourser le client.
app.get('/api/admin/payments/orphans', paymentMgmtAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM order_payments
     WHERE payment_status = 'confirmed' AND (invoice_ref IS NULL OR invoice_ref = '')
     ORDER BY confirmed_at DESC, created_at DESC
     LIMIT 200`
  ).all();
  res.json({ payments: rows, total: rows.length });
});

// Rejeter un paiement
app.post('/api/admin/payments/:id/reject', paymentMgmtAuth, csrfProtection, (req, res) => {
  const payment = db.prepare('SELECT * FROM order_payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Paiement introuvable' });
  if (payment.payment_status !== 'pending') return res.status(400).json({ error: 'Seuls les paiements en attente peuvent être rejetés' });

  db.prepare(
    'UPDATE order_payments SET payment_status = ?, rejected_by = ?, rejected_at = ?, reject_reason = ? WHERE id = ?'
  ).run('rejected', req.admin.username, new Date().toISOString(), req.body.reason || '', req.params.id);

  db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
    .run(req.admin.username, 'reject_payment', `Paiement rejeté : ${payment.order_ref} — ${req.body.reason || 'sans motif'}`);

  res.json({ success: true });
});

// Détail complet d'une commande web (pour la fiche depuis l'écran Paiements).
// Sous /payments/* pour hériter de la whitelist RBAC (super_admin, admin, comptable).
const ORDER_STATUS_LABELS = { '-1': 'Annulée', 0: 'Brouillon', 1: 'Validée', 2: 'En cours', 3: 'Livrée' };
app.get('/api/admin/payments/order/:orderId', paymentMgmtAuth, async (req, res) => {
  const id = parseInt(req.params.orderId, 10);
  if (!id) return res.status(400).json({ error: 'Identifiant de commande invalide' });
  try {
    const [[order]] = await dolibarrPool.query(
      `SELECT c.rowid AS id, c.ref, c.fk_statut, c.facture AS billed,
              DATE_FORMAT(c.date_commande, '%Y-%m-%d') AS date_commande,
              c.total_ht, c.total_tva, c.total_ttc, c.note_public, c.note_private,
              c.fk_soc, s.nom AS customer_name, s.email AS customer_email,
              s.phone AS customer_phone, s.address, s.zip, s.town
       FROM llx_commande c
       LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
       WHERE c.rowid = ?`, [id]
    );
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const [lines] = await dolibarrPool.query(
      `SELECT cd.rowid AS id, cd.fk_product, p.ref AS product_ref, p.label AS product_label,
              cd.description, cd.qty, cd.subprice, cd.remise_percent, cd.total_ht, cd.total_ttc
       FROM llx_commandedet cd
       LEFT JOIN llx_product p ON p.rowid = cd.fk_product
       WHERE cd.fk_commande = ? AND cd.product_type = 0
       ORDER BY cd.rang ASC, cd.rowid ASC`, [id]
    );

    // Enregistrement de paiement local lié (méthode, réf transaction client, statut).
    const payment = db.prepare(
      'SELECT * FROM order_payments WHERE dolibarr_order_id = ? ORDER BY id DESC LIMIT 1'
    ).get(String(id)) || null;

    res.json({
      order: {
        id: order.id, ref: order.ref,
        status: order.fk_statut, statusLabel: ORDER_STATUS_LABELS[String(order.fk_statut)] || '?',
        billed: !!order.billed,
        date: order.date_commande,
        total_ht: Number(order.total_ht), total_tva: Number(order.total_tva), total_ttc: Number(order.total_ttc),
        note_public: order.note_public, note_private: order.note_private,
        customer: {
          id: order.fk_soc, name: order.customer_name, email: order.customer_email,
          phone: order.customer_phone, address: order.address, zip: order.zip, town: order.town,
        },
      },
      lines: lines.map(l => ({
        id: l.id, product_id: l.fk_product, ref: l.product_ref,
        label: l.product_label || l.description, qty: Number(l.qty),
        subprice: Number(l.subprice), remise_percent: Number(l.remise_percent),
        total_ht: Number(l.total_ht), total_ttc: Number(l.total_ttc),
      })),
      payment: payment ? {
        method: payment.payment_method, status: payment.payment_status,
        amount_expected: Number(payment.amount_expected), amount_received: payment.amount_received,
        transaction_ref: payment.transaction_ref, payer_phone: payment.payer_phone,
        invoice_ref: payment.invoice_ref, created_at: payment.created_at,
      } : null,
    });
  } catch (err) {
    console.error('GET /api/admin/payments/order/:orderId error:', err.message);
    res.status(500).json({ error: 'Erreur chargement de la commande' });
  }
});

// Client envoie sa référence de paiement (après commande)
app.post('/api/orders/:id/payment-proof', csrfProtection, (req, res) => {
  const { transaction_ref, payer_phone } = req.body;
  if (!transaction_ref?.trim()) return res.status(400).json({ error: 'Référence de transaction requise' });

  const payment = db.prepare('SELECT * FROM order_payments WHERE dolibarr_order_id = ?').get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'Commande introuvable' });
  if (payment.payment_status !== 'pending') return res.status(400).json({ error: 'Cette commande a déjà été traitée' });

  db.prepare(
    'UPDATE order_payments SET transaction_ref = ?, payer_phone = ?, provider_status = ? WHERE dolibarr_order_id = ?'
  ).run(transaction_ref.trim(), payer_phone?.trim() || '', 'proof_submitted', req.params.id);

  res.json({ success: true });
});

// ─── BOOKS MANAGEMENT MODULE ────────────────────────────────
import { createBookRouter } from './book-routes.js';
try {
  const bookAuth = adminAuth(db);
  app.use('/api/admin/books', createBookRouter({
    dolibarrPool,
    auth: bookAuth,
    csrfProtection,
    sanitizeBody,
    cache,
    db,
  }));
  console.log('[BOOKS] Book routes mounted');
} catch (err) {
  console.error('[BOOKS] Failed to mount book routes:', err);
}

// ─── BOOK TAGS (curation éditoriale home) ──────────────────
import { createTagRouter } from './tag-routes.js';
try {
  const tagAuth = adminAuth(db);
  app.use('/api', createTagRouter({
    db,
    auth: tagAuth,
    csrfProtection,
    dolibarrPool,
    enrichProduct,
    dolibarrApi,
    cache,
  }));
  console.log('[TAGS] Tag routes mounted');
} catch (err) {
  console.error('[TAGS] Failed to mount tag routes:', err);
}

// ─── PAYTECH (paiement hosted) ──────────────────────────────
import { createPaytechRouter, isPaytechConfigured } from './paytech-routes.js';
import * as emailService from './email-service.js';
import * as whatsappService from './whatsapp-service.js';
try {
  app.use('/api', createPaytechRouter({
    db,
    dolibarrApi,
    dolibarrPool,
    csrfProtection,
    requireCustomerAuth,
    cache,
    transporter,
    getAdminEmails: () => {
      try {
        const cfg = JSON.parse(readFileSync(join(__dirname, 'site-config.json'), 'utf-8'));
        return Array.isArray(cfg.admin_emails) ? cfg.admin_emails : [];
      } catch {
        return [];
      }
    },
    emailService,
    whatsapp: whatsappService,
  }));
  console.log(`[PAYTECH] routes mounted (configured=${isPaytechConfigured()})`);
} catch (err) {
  console.error('[PAYTECH] Failed to mount paytech routes:', err);
}

// ─── ADMIN STATS (KPI Dashboard) ────────────────────────────
import { createAdminStatsRouter } from './admin-stats-routes.js';
try {
  const adminStatsAuth = adminAuth(db);
  app.use('/api/admin/stats', createAdminStatsRouter({
    db,
    dolibarrPool,
    cache,
    auth: adminStatsAuth,
  }));
  console.log('[ADMIN-STATS] Stats KPI routes mounted');
} catch (err) {
  console.error('[ADMIN-STATS] Failed to mount stats routes:', err);
}

// ─── ADMIN POS MANAGEMENT ───────────────────────────────────
import { createAdminPosRouter } from './admin-pos-routes.js';
try {
  const adminPosAuth = adminAuth(db);
  app.use('/api/admin/pos', createAdminPosRouter({
    db,
    auth: adminPosAuth,
    csrfProtection,
  }));
  console.log('[ADMIN-POS] POS management routes mounted');
} catch (err) {
  console.error('[ADMIN-POS] Failed to mount POS management routes:', err);
}

// ─── CLIENTS & AUTEURS (portail admin) ──────────────────────
import { createAdminPeopleRouter } from './admin-people-routes.js';
try {
  const peopleAuth = adminAuth(db);
  app.use('/api/admin', createAdminPeopleRouter({
    db, dolibarrPool, auth: peopleAuth, csrfProtection, transporter,
  }));
  console.log('[PEOPLE] Customer + author admin routes mounted');
} catch (err) {
  console.error('[PEOPLE] Failed to mount customer/author admin routes:', err);
}

// ─── COMPTABILITÉ MODULE ───────────────────────────────────
import { createAccountingRouter } from './accounting-routes.js';
try {
  const accountingAuth = adminAuth(db);
  app.use('/api/admin/accounting', createAccountingRouter({ db, dolibarrPool, cache, auth: accountingAuth, csrfProtection }));
  console.log('[ACCOUNTING] Accounting routes mounted');
} catch (err) {
  console.error('[ACCOUNTING] Failed to mount accounting routes:', err);
}

// ─── GESTION FACTURES / RÉGULARISATIONS ─────────────────────
import { createInvoicesRouter } from './invoices-routes.js';
try {
  const invoicesAuth = adminAuth(db);
  app.use('/api/admin/invoices', createInvoicesRouter({ db, dolibarrPool, auth: invoicesAuth, csrfProtection }));
  console.log('[INVOICES] Invoice management routes mounted');
} catch (err) {
  console.error('[INVOICES] Failed to mount invoice routes:', err);
}

// ─── BONS DE LIVRAISON MODULE ───────────────────────────────
import { createDeliveryRouter } from './delivery-routes.js';
try {
  const deliveryAuth = adminAuth(db);
  app.use('/api/admin/deliveries', createDeliveryRouter({ db, dolibarrPool, auth: deliveryAuth, csrfProtection }));
  console.log('[DELIVERIES] Delivery notes routes mounted');
} catch (err) {
  console.error('[DELIVERIES] Failed to mount delivery routes:', err);
}

// ─── DÉPÔT-VENTE MODULE ─────────────────────────────────────
import { createConsignmentRouter } from './consignment-routes.js';
try {
  const consignmentAuth = adminAuth(db);
  app.use('/api/admin/consignments', createConsignmentRouter({ db, dolibarrPool, auth: consignmentAuth, csrfProtection }));
  console.log('[CONSIGNMENT] Consignment (dépôt-vente) routes mounted');
} catch (err) {
  console.error('[CONSIGNMENT] Failed to mount consignment routes:', err);
}

// ─── SORTIES D'ARGENT / DÉPENSES MODULE ─────────────────────
import { createExpensesRouter } from './expenses-routes.js';
try {
  const expensesAuth = adminAuth(db);
  app.use('/api/admin/expenses', createExpensesRouter({ db, dolibarrPool, auth: expensesAuth, csrfProtection, getTransporter: () => transporter }));
  console.log('[EXPENSES] Expenses (sorties d\'argent) routes mounted');
} catch (err) {
  console.error('[EXPENSES] Failed to mount expenses routes:', err);
}

// ─── COMMANDES WEB MODULE ───────────────────────────────────
import { createOrdersRouter } from './orders-routes.js';
try {
  app.use('/api/admin/orders', adminAuth(db), createOrdersRouter({ db, dolibarrPool }));
  console.log('[ORDERS] Web orders routes mounted');
} catch (err) {
  console.error('[ORDERS] Failed to mount orders routes:', err);
}

// ─── DEVIS MODULE (propositions commerciales) ───────────────
import { createPropalsRouter } from './propals-routes.js';
try {
  app.use('/api/admin/propals', adminAuth(db), createPropalsRouter({ dolibarrPool, csrfProtection }));
  console.log('[PROPALS] Devis routes mounted');
} catch (err) {
  console.error('[PROPALS] Failed to mount propals routes:', err);
}

// ─── STOCK & REAPPROVISIONNEMENT MODULE ─────────────────────
import { createStockRouter, createSuppliersRouter } from './stock-routes.js';
import { runDailyBatch, runClassificationBatch } from './stock-engine.js';
try {
  const stockAuth = adminAuth(db);
  app.use('/api/admin/stock', createStockRouter({ db, dolibarrPool, auth: stockAuth, csrfProtection }));
  app.use('/api/admin/suppliers', createSuppliersRouter({ db, dolibarrPool, auth: stockAuth, csrfProtection }));
  console.log('[STOCK] Stock & suppliers routes mounted');
} catch (err) {
  console.error('[STOCK] Failed to mount stock routes:', err);
}

// ─── INVENTAIRE PHYSIQUE (comptage de stock) ─────────────────
import { createInventoryRouter } from './inventory-routes.js';
try {
  const inventoryAuth = adminAuth(db);
  app.use('/api/admin/inventory', createInventoryRouter({ db, dolibarrPool, auth: inventoryAuth, csrfProtection }));
  console.log('[INVENTORY] Inventory routes mounted');
} catch (err) {
  console.error('[INVENTORY] Failed to mount inventory routes:', err);
}

// ─── DÉPÔT LÉGAL MODULE ─────────────────────────────────────
import { createLegalDepositRouter } from './legal-deposit-routes.js';
try {
  app.use('/api/admin/legal-deposits', createLegalDepositRouter({ db, dolibarrPool, auth: adminAuth(db), csrfProtection }));
  console.log('[LEGAL_DEPOSIT] Legal deposit routes mounted');
} catch (err) {
  console.error('[LEGAL_DEPOSIT] Failed to mount legal deposit routes:', err);
}

// ─── YOUTUBE VIDEOS ─────────────────────────────────────────
const siteConf = getSiteConfig();
const YT_CHANNEL_ID = siteConf.youtube_channel_id || 'UCnXwbe8yIv7sBohERVNB-ZA';
const YT_RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL_ID}`;

app.get('/api/youtube/videos', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 5, 10);
    const cacheKey = `youtube:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { default: axios } = await import('axios');
    const { parseStringPromise } = await import('xml2js');

    const response = await axios.get(YT_RSS_URL, { timeout: 10000 });
    const parsed = await parseStringPromise(response.data);
    const entries = parsed.feed.entry || [];

    const videos = entries.slice(0, limit).map((e) => ({
      id: e['yt:videoId']?.[0],
      title: e.title?.[0],
      published: e.published?.[0],
      thumbnail: `https://i.ytimg.com/vi/${e['yt:videoId']?.[0]}/hqdefault.jpg`,
      url: e.link?.[0]?.['$']?.href,
      description: e['media:group']?.[0]?.['media:description']?.[0]?.substring(0, 150),
    }));

    cache.set(cacheKey, videos, 1800); // 30min cache
    res.json(videos);
  } catch (err) {
    console.error('YouTube fetch error:', err.message);
    res.status(500).json({ error: 'Erreur chargement vidéos' });
  }
});

// ─── API ROUTES ─────────────────────────────────────────────

// Newsletter subscription (Double Opt-in)
app.post('/api/newsletter/subscribe', newsletterLimiter, csrfProtection, sanitizeBody(['email']), (req, res) => {
  try {
    const { email, accepted } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    if (!accepted) {
      return res.status(400).json({ error: 'Vous devez accepter les conditions.' });
    }

    const token = crypto.randomBytes(20).toString('hex');
    const row = db.prepare('SELECT id, confirmed FROM newsletter WHERE email = ?').get(email);

    if (row) {
      if (row.confirmed) {
        return res.status(400).json({ error: 'Cet email est déjà inscrit.' });
      }
      db.prepare('UPDATE newsletter SET token = ? WHERE email = ?').run(token, email);
      sendConfirmationEmail(email, token);
      return res.json({ success: true, message: 'Un email de confirmation vous a été renvoyé.' });
    }

    db.prepare('INSERT INTO newsletter (email, token) VALUES (?, ?)').run(email, token);
    sendConfirmationEmail(email, token);
    res.json({ success: true, message: 'Un email de confirmation vous a été envoyé.' });
  } catch (err) {
    console.error('Newsletter subscribe error:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/newsletter/confirm', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token manquant');

  const result = db.prepare('UPDATE newsletter SET confirmed = 1, token = NULL WHERE token = ?').run(token);
  if (result.changes === 0) {
    return res.status(400).send('Lien invalide ou expiré.');
  }
  res.send('<h1>Merci !</h1><p>Votre inscription à la newsletter est confirmée.</p><a href="/">Retour au site</a>');
});

function sendConfirmationEmail(email, token) {
  const confirmLink = `${SITE_URL}/api/newsletter/confirm?token=${token}`;
  console.log(`[NEWSLETTER] Envoyer email à ${email} avec lien: ${confirmLink}`);
  // Mock email send
  transporter.sendMail({
    from: '"Sen Harmattan" <noreply@senharmattan.com>',
    to: email,
    subject: 'Confirmez votre inscription à la newsletter',
    html: `<p>Bonjour,</p><p>Merci de vous être inscrit. Veuillez cliquer sur le lien ci-dessous pour confirmer votre email :</p><p><a href="${confirmLink}">Confirmer mon inscription</a></p>`
  }).catch(console.error);
}

// Lightweight search suggestions (dedicated endpoint)
app.get('/api/search/suggest', async (req, res) => {
  try {
    const q = safeSqlFilter(String(req.query.q || '').trim());
    if (q.length < 2) return res.json([]);

    const cacheKey = `suggest:${q.toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const [rows] = await dolibarrPool.query(
      `SELECT p.rowid AS id, p.ref, p.label, p.price_ttc
       FROM llx_product p
       WHERE p.tosell = 1 AND (p.label LIKE ? OR p.ref LIKE ? OR p.barcode LIKE ?)
       ORDER BY p.label ASC LIMIT 6`,
      [`%${q}%`, `%${q}%`, `%${q}%`]
    );

    const results = rows.map(r => ({
      id: String(r.id),
      ref: r.ref,
      label: r.label,
      price_ttc: parseFloat(r.price_ttc),
    }));

    cache.set(cacheKey, results, 120); // 2min cache
    res.json(results);
  } catch (err) {
    console.error('Search suggest error:', err.message);
    res.json([]);
  }
});

// Products listing with cache
app.get('/api/products', async (req, res) => {
  try {
    const {
      page = 0, limit = 20, q, category, sort = 't.ref', order = 'ASC',
      author, price_min, price_max, in_stock, with_cover,
    } = req.query;
    const cacheKey = `products:${page}:${limit}:${q || ''}:${category || ''}:${sort}:${order}:${author || ''}:${price_min || ''}:${price_max || ''}:${in_stock || ''}:${with_cover || ''}`;

    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    let data;
    const pageInt = parseInt(page);
    const limitInt = parseInt(limit);

    // Use MySQL for advanced search (author, description, price range)
    const hasAdvancedFilters = author || price_min || price_max || in_stock || with_cover || (q && q.length > 1);

    if (hasAdvancedFilters || category) {
      // Build MySQL query for advanced filtering
      // tosell=1 : exclure les produits masqués par l'admin
      const conditions = ['p.entity = 1', 'p.fk_product_type = 0', 'p.tosell = 1'];
      const params = [];

      if (q) {
        // Recherche full-text : titre, ISBN/ref, code-barre, description courte/longue, auteur
        conditions.push('(p.label LIKE ? OR p.ref LIKE ? OR p.barcode LIKE ? OR p.description LIKE ? OR pe.longdescript LIKE ? OR pe.auteur LIKE ?)');
        const pat = `%${q}%`;
        params.push(pat, pat, pat, pat, pat, pat);
      }

      if (author) {
        conditions.push('(pe.auteur LIKE ? OR p.description LIKE ? OR p.label LIKE ?)');
        params.push(`%${author}%`, `%${author}%`, `%${author}%`);
      }

      if (price_min) {
        conditions.push('p.price >= ?');
        params.push(parseFloat(price_min));
      }

      if (price_max) {
        conditions.push('p.price <= ?');
        params.push(parseFloat(price_max));
      }

      if (in_stock === '1') {
        conditions.push('p.stock > 0');
      }

      if (category) {
        conditions.push('cp.fk_categorie = ?');
        params.push(parseInt(category));
      }

      // Filter by real cover at SQL level
      if (with_cover === '1') {
        const refsWithCovers = getRefsWithRealCovers();
        if (refsWithCovers.length > 0) {
          conditions.push(`p.ref IN (${refsWithCovers.map(() => '?').join(',')})`);
          params.push(...refsWithCovers);
        } else {
          // No covers at all — return empty
          const result = { products: [], page: pageInt, limit: limitInt, total: 0 };
          cache.set(cacheKey, result, 300);
          return res.json(result);
        }
      }

      // Sort mapping
      const sortMap = {
        't.rowid': 'p.rowid', 't.ref': 'p.ref', 't.label': 'p.label',
        't.price': 'p.price', 't.stock_reel': 'p.stock',
      };
      const sortCol = sortMap[sort] || 'p.rowid';
      const sortDir = order === 'DESC' ? 'DESC' : 'ASC';

      const joinParts = [
        'FROM llx_product p',
        'LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid',
      ];
      if (category) {
        joinParts.push('INNER JOIN llx_categorie_product cp ON cp.fk_product = p.rowid');
      }

      // Count query
      const countSql = `SELECT COUNT(DISTINCT p.rowid) AS total ${joinParts.join(' ')} WHERE ${conditions.join(' AND ')}`;
      const [countRows] = await dolibarrPool.query(countSql, params);
      const total = countRows[0]?.total || 0;

      // Data query
      const dataSql = `
        SELECT DISTINCT p.rowid AS id, p.ref, p.label, p.description, p.price,
          p.price_ttc, p.tva_tx, p.barcode, p.stock AS stock_reel, p.fk_product_type,
          p.datec AS date_creation, p.tms AS date_modification, p.weight, p.tosell AS status,
          pe.longdescript, pe.auteur, pe.soustitre,
          pe.publication_year, pe.nombre_pages, pe.editeur,
          (SELECT c.label FROM llx_categorie c
           INNER JOIN llx_categorie_product cp2 ON cp2.fk_categorie = c.rowid
           WHERE cp2.fk_product = p.rowid
           AND c.label NOT IN (${excludedCategorySqlList()})
           LIMIT 1) AS genre_category
        ${joinParts.join(' ')}
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${sortCol} ${sortDir}
        LIMIT ? OFFSET ?
      `;
      params.push(limitInt, pageInt * limitInt);

      const [rows] = await dolibarrPool.query(dataSql, params);

      const products = rows.map((p) => enrichProduct(p, cache.get(`img:${p.ref}`) || false));

      const result = { products, page: pageInt, limit: limitInt, total };
      cache.set(cacheKey, result, 300);
      return res.json(result);
    }

    // Simple query — use Dolibarr API directly
    const apiParams = { limit: limitInt, page: pageInt, sortfield: sort, sortorder: order };
    // tosell=1 : exclure les produits masqués par l'admin (filtre inconditionnel)
    const tosellFilter = `(t.tosell:=:1)`;
    if (q) {
      const safeQ = safeSqlFilter(q);
      apiParams.sqlfilters = `${tosellFilter} and ((t.label:like:'%${safeQ}%') or (t.ref:like:'%${safeQ}%'))`;
    } else {
      apiParams.sqlfilters = tosellFilter;
    }
    const prodRes = await dolibarrApi.get('/products', { params: apiParams });
    data = prodRes.data;

    const products = (Array.isArray(data) ? data : []).map((p) => enrichProduct(p, cache.get(`img:${p.ref}`) || false));

    const result = { products, page: pageInt, limit: limitInt };
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    console.error('GET /api/products error:', err.response?.status, err.response?.data);
    res.status(err.response?.status || 500).json({ error: 'Erreur chargement produits' });
  }
});

// Price range stats for search filters
app.get('/api/products/price-range', async (req, res) => {
  try {
    const cached = cache.get('price-range');
    if (cached) return res.json(cached);

    const [rows] = await dolibarrPool.query(
      'SELECT MIN(price) AS min_price, MAX(price) AS max_price FROM llx_product WHERE tosell = 1 AND price > 0'
    );
    const result = {
      min: Math.floor(rows[0]?.min_price || 0),
      max: Math.ceil(rows[0]?.max_price || 50000),
    };
    cache.set('price-range', result, 3600);
    res.json(result);
  } catch (err) {
    console.warn('Price range error:', err.message);
    res.json({ min: 0, max: 50000 });
  }
});

// Scan filesystem for products with real covers (not default_cover.jpg)
function getRefsWithRealCovers() {
  const cached = cache.get('refs-with-real-covers');
  if (cached) return cached;

  const docsDir = '/var/www/html/dolibarr/documents/produit';
  const refs = [];

  try {
    const dirs = readdirSync(docsDir);
    for (const dir of dirs) {
      try {
        const fullPath = join(docsDir, dir);
        if (!statSync(fullPath).isDirectory()) continue;
        const files = readdirSync(fullPath);
        const hasRealCover = files.some(
          (f) => /\.(jpg|jpeg|png|gif|webp)$/i.test(f) && !f.startsWith('default_cover') && !f.includes('_mini') && !f.includes('_small')
        );
        if (hasRealCover) refs.push(dir);
      } catch (err) {
        console.warn('Error reading directory:', err.message);
      }
    }
  } catch (err) {
    console.error('Error scanning covers:', err.message);
  }

  cache.set('refs-with-real-covers', refs, 3600); // 1h cache
  return refs;
}

// Products prioritizing those with real covers (for homepage)
app.get('/api/products/featured', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;
    const cacheKey = `products:featured:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Get refs with real covers from filesystem
    const refsWithCovers = getRefsWithRealCovers();

    // Fetch products that have real covers
    const withImage = [];

    if (refsWithCovers.length > 0) {
      // Pick random refs to get variety
      const shuffled = [...refsWithCovers].sort(() => Math.random() - 0.5);
      const batch = shuffled.slice(0, limit * 3); // fetch more than needed in case some fail

      for (const ref of batch) {
        if (withImage.length >= limit) break;
        try {
          const prodRes = await dolibarrApi.get('/products', {
            params: { sqlfilters: `(t.tosell:=:1) and (t.ref:=:'${safeSqlFilter(ref)}')`, limit: 1 },
          });
          if (prodRes.data && prodRes.data.length > 0) {
            const p = prodRes.data[0];
            withImage.push(enrichProduct(p, true));
          }
        } catch (err) {
          console.warn('Error fetching product detail:', err.message);
        }
      }
    }

    // Fill remaining slots with recent products if needed
    if (withImage.length < limit) {
      const remaining = limit - withImage.length;
      const existingIds = new Set(withImage.map((p) => p.id));
      try {
        const prodRes = await dolibarrApi.get('/products', {
          params: { limit: remaining + 10, page: 0, sortfield: 't.rowid', sortorder: 'DESC', sqlfilters: `(t.tosell:=:1)` },
        });
        for (const p of prodRes.data || []) {
          if (withImage.length >= limit) break;
          if (existingIds.has(p.id)) continue;
          withImage.push(enrichProduct(p, true));
        }
      } catch (err) {
        console.warn('Error fetching extra products:', err.message);
      }
    }

    const result = { products: withImage, page: 0, limit };
    cache.set(cacheKey, result, 600); // cache 10 min
    res.json(result);
  } catch (err) {
    console.error('GET /api/products/featured error:', err.response?.status, err.response?.data);
    res.status(err.response?.status || 500).json({ error: 'Erreur chargement produits' });
  }
});

// Livre du mois — priorité source book_tag_products (nouvelle), fallback extrafield Dolibarr
app.get('/api/products/livre-du-mois', async (req, res) => {
  try {
    const cacheKey = 'products:livre-du-mois';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Source 1 : book_tag_products (nouvelle source de vérité)
    let productIds = [];
    try {
      const tag = db.prepare('SELECT id FROM book_tags WHERE slug = ? AND is_active = 1').get('livre_du_mois');
      if (tag) {
        const tagRows = db.prepare(`SELECT product_id FROM book_tag_products
          WHERE tag_id = ?
          ORDER BY pinned DESC, sort_order ASC, added_at DESC`).all(tag.id);
        productIds = tagRows.map((r) => r.product_id);
      }
    } catch (e) {
      console.warn('[livre-du-mois] SQLite read failed, falling back to extrafield:', e.message);
    }

    // Fallback : extrafield Dolibarr si nouvelle source vide
    const products = [];
    let rows;
    if (productIds.length > 0) {
      rows = productIds.map((id) => ({ fk_object: id }));
    } else {
      [rows] = await dolibarrPool.query(
        'SELECT fk_object FROM llx_product_extrafields WHERE livre_du_mois = 1'
      );
    }

    const excludedCats = EXCLUDED_CATEGORIES_SET;

    for (const { fk_object: pid } of rows) {
      try {
        const prodRes = await dolibarrApi.get(`/products/${pid}`);
        const p = prodRes.data;

        // Skip si masqué par l'admin (tosell=0)
        if (!p || Number(p.status) !== 1) continue;

        // Get product category
        let category = '';
        try {
          const catRes = await dolibarrApi.get('/categories', {
            params: { type: 'product', object_id: pid },
          });
          const cats = (catRes.data || [])
            .map((c) => c.label?.replace(/&[^;]+;/g, (m) => {
              const map = { '&eacute;': 'é', '&acirc;': 'â', '&egrave;': 'è', '&ocirc;': 'ô', '&ucirc;': 'û', '&icirc;': 'î', '&agrave;': 'à' };
              return map[m] || m;
            }))
            .filter((l) => l && !excludedCats.has(l));
          category = cats[0] || '';
        } catch (catErr) {
          console.warn(`Error fetching category for product ${pid}:`, catErr.message);
        }

        const stock = parseInt(p.stock_reel) || 0;
        const enriched = enrichProduct(p, true);

        products.push({
          ...enriched,
          stock_reel: stock,
          category,
          author: enriched.array_options?.options_auteur || p.auteur || '',
          ribbon: p.array_options?.options_livre_du_mois_ribbon || 'LIVRE DU MOIS',
        });
      } catch (prodErr) {
        console.warn(`Error fetching product ${pid}:`, prodErr.message);
      }
    }

    cache.set(cacheKey, products, 300); // 5 min cache
    res.json(products);
  } catch (err) {
    console.error('GET /api/products/livre-du-mois error:', err.message);
    res.status(500).json({ error: 'Erreur chargement livre du mois' });
  }
});

// Événements publics depuis Dolibarr Agenda
const PUBLIC_EVENT_TYPES = new Set(['AC_DEDICACE', 'AC_LANCEMENT', 'AC_SALON', 'AC_CONFERENCE']);
const EVENT_TYPE_LABELS = {
  AC_DEDICACE: 'Dédicace',
  AC_LANCEMENT: 'Lancement',
  AC_SALON: 'Salon',
  AC_CONFERENCE: 'Conférence',
};

app.get('/api/evenements', async (req, res) => {
  try {
    const cacheKey = 'evenements';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Query Dolibarr MySQL for public events (custom types only)
    const typeCodes = [...PUBLIC_EVENT_TYPES].map((t) => `'${t}'`).join(',');
    const [rows] = await dolibarrPool.query(`
      SELECT a.id, a.label, a.datep, a.datep2 AS datef, a.location, a.note,
             a.percent AS percentage, a.fulldayevent, c.code AS type_code
      FROM llx_actioncomm a
      LEFT JOIN llx_c_actioncomm c ON a.fk_action = c.id
      WHERE c.code IN (${typeCodes})
      ORDER BY a.datep ASC
    `);

    const now = Math.floor(Date.now() / 1000);

    const evenements = rows.map((e) => {
      const datep = Math.floor(new Date(e.datep).getTime() / 1000);
      const datef = e.datef ? Math.floor(new Date(e.datef).getTime() / 1000) : datep;

      let statut = 'a-venir';
      if (datef < now) statut = 'passe';
      else if (datep <= now && datef >= now) statut = 'en-cours';

      // Extract URL from note if present
      const noteText = e.note || '';
      const urlMatch = noteText.match(/(https?:\/\/[^\s]+)/);

      return {
        id: e.id,
        title: e.label,
        type: EVENT_TYPE_LABELS[e.type_code] || e.type_code,
        type_code: e.type_code,
        datep,
        datef,
        lieu: e.location || '',
        description: noteText.replace(/(https?:\/\/[^\s]+)/g, '').trim(),
        lien: urlMatch ? urlMatch[1] : null,
        statut,
        fulldayevent: e.fulldayevent === '1',
      };
    });

    cache.set(cacheKey, evenements, 300); // 5 min cache
    res.json(evenements);
  } catch (err) {
    console.error('GET /api/evenements error:', err.message);
    res.status(500).json({ error: 'Erreur chargement événements' });
  }
});

// Single product
app.get('/api/products/:id', async (req, res) => {
  try {
    const cacheKey = `product:${req.params.id}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const pid = req.params.id;

    // Fetch product, stock, and images in parallel
    const [prodRes, stockResult, docResult] = await Promise.all([
      dolibarrApi.get(`/products/${pid}`),
      dolibarrApi.get(`/products/${pid}/stock`).catch(() => null),
      dolibarrApi.get('/documents', {
        params: { modulepart: 'produit', id: parseInt(pid) },
      }).catch(() => null),
    ]);

    const p = prodRes.data;

    // Refuser si produit masqué par l'admin (tosell=0)
    // L'API Dolibarr expose `status` (=tosell). Tolère les types string/number.
    if (p && Number(p.status) !== 1) {
      return res.status(404).json({ error: 'Produit non disponible' });
    }

    let stockDetails = [];
    const sw = stockResult?.data?.stock_warehouses;
    if (sw && typeof sw === 'object' && !Array.isArray(sw)) {
      stockDetails = Object.entries(sw).map(([whId, s]) => ({
        warehouse_id: whId,
        quantity: parseFloat(s.real || 0),
      }));
    }

    // Ordre : recto (non-verso, plus récent en 1er) puis verso
    const rawImgs = (docResult?.data || [])
      .filter((d) => /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name) && !d.name.startsWith('default_cover'));
    const isVerso = (n) => /(^|-|_)(verso|back)(-|_|\.)/i.test(n);
    const rectoList = rawImgs.filter((d) => !isVerso(d.name)).sort((a, b) => (b.date || 0) - (a.date || 0));
    const versoList = rawImgs.filter((d) => isVerso(d.name)).sort((a, b) => (b.date || 0) - (a.date || 0));
    const ordered = [...rectoList, ...versoList];
    const images = ordered.map((d) => ({
      name: d.name,
      url: `/api/image/${p.id}?file=${encodeURIComponent(d.name)}`,
      size: d.size,
      side: isVerso(d.name) ? 'verso' : 'recto',
    }));

    const product = {
      id: p.id,
      ref: p.ref,
      label: p.label,
      description: resolveDescription(p),
      price: p.price,
      price_ttc: p.price_ttc,
      tva_tx: p.tva_tx,
      barcode: p.barcode,
      stock_reel: p.stock_reel,
      status: p.status,
      weight: p.weight,
      weight_units: p.weight_units,
      date_creation: p.date_creation,
      date_modification: p.date_modification,
      array_options: p.array_options,
      stock_details: stockDetails,
      images,
    };

    cache.set(cacheKey, product, 1800); // 30min cache
    res.json(product);
  } catch (err) {
    console.error('GET /api/products/:id error:', err.response?.status);
    res.status(err.response?.status || 500).json({ error: 'Produit introuvable' });
  }
});

// Product image by product ID - auto-finds first image
// ETag = nom du fichier source (cover-<timestamp>.ext) → change à chaque upload
app.get('/api/image/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const fileParam = req.query.file || '';
    const cacheKey = `imgdata:${productId}:${fileParam}`;

    function sendWithValidation(buffer, contentType, etag) {
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=600, must-revalidate'); // 10 min + revalidation
      res.set('Vary', 'Accept');
      if (etag) res.set('ETag', etag);
      if (etag && req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
      res.send(buffer);
    }

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached === 'none') return sendPlaceholder(res, req.query.title);
      return sendWithValidation(cached.buffer, cached.contentType, cached.etag);
    }

    // Find product documents
    const docRes = await dolibarrApi.get('/documents', {
      params: { modulepart: 'produit', id: parseInt(productId) },
    });

    const images = (docRes.data || []).filter((d) =>
      /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name)
    );

    if (images.length === 0) {
      cache.set(cacheKey, 'none', 3600);
      return sendPlaceholder(res, req.query.title);
    }

    // If a specific file is requested, use it; otherwise prefer real covers
    const requestedFile = req.query.file;
    let img;
    if (requestedFile) {
      img = images.find((i) => i.name === requestedFile) || images[0];
    } else {
      // Filtrer les placeholders par défaut
      const realImages = images.filter((i) => !i.name.startsWith('default_cover'));

      // Détection robuste recto/verso : nom contient verso/back/dos/arriere (séparateurs - _ . début/fin)
      const isVerso = (n) => /(^|[-_. ])(verso|back|dos|arriere|arrière)([-_. ]|\.)/i.test(n);
      const isRecto = (n) => /(^|[-_. ])(recto|front|cover|couverture|couv)([-_. ]|\.)/i.test(n);

      const rectoList = realImages
        .filter((i) => !isVerso(i.name))
        .sort((a, b) => {
          // Priorité 1 : noms qui contiennent explicitement recto/cover/front
          const aRecto = isRecto(a.name) ? 1 : 0;
          const bRecto = isRecto(b.name) ? 1 : 0;
          if (aRecto !== bRecto) return bRecto - aRecto;
          // Priorité 2 : plus récent en premier
          return (b.date || 0) - (a.date || 0);
        });
      const versoList = realImages
        .filter((i) => isVerso(i.name))
        .sort((a, b) => (b.date || 0) - (a.date || 0));

      img = rectoList[0] || versoList[0] || images[0];
    }
    const ref = img.level1name || img.path.split('/').pop();
    // ETag stable : change quand on upload une nouvelle cover (nom contient un timestamp)
    const acceptsWebp = req.headers.accept?.includes('image/webp');
    const etag = `"${Buffer.from(`${img.name}:${img.size || ''}:${acceptsWebp ? 'w' : 'j'}`).toString('base64').slice(0, 27)}"`;

    // Early 304 avant de re-télécharger depuis Dolibarr
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).set('ETag', etag).end();
    }

    const response = await dolibarrApi.get('/documents/download', {
      params: {
        modulepart: 'produit',
        original_file: `${ref}/${img.name}`,
      },
      responseType: 'arraybuffer',
    });

    let imageBuffer;
    try {
      const json = JSON.parse(response.data.toString());
      if (json.content) {
        imageBuffer = Buffer.from(json.content, 'base64');
      }
    } catch {
      imageBuffer = Buffer.from(response.data);
    }

    if (!imageBuffer || imageBuffer.length < 100) {
      cache.set(cacheKey, 'none', 3600);
      return sendPlaceholder(res, req.query.title);
    }

    // Optimize image: resize to max 800px wide, convert to webp
    const width = parseInt(req.query.w) || 800;

    let optimized;
    let contentType;
    try {
      const pipeline = sharp(imageBuffer).resize({ width, withoutEnlargement: true });
      if (acceptsWebp) {
        optimized = await pipeline.webp({ quality: 80 }).toBuffer();
        contentType = 'image/webp';
      } else {
        optimized = await pipeline.jpeg({ quality: 82, progressive: true }).toBuffer();
        contentType = 'image/jpeg';
      }
    } catch {
      // Fallback: serve original if sharp fails
      optimized = imageBuffer;
      const ext = img.name.split('.').pop().toLowerCase();
      const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      contentType = mimeTypes[ext] || 'image/jpeg';
    }

    // Cache the optimized image (2 hours)
    cache.set(cacheKey, { buffer: optimized, contentType, etag }, 7200);

    sendWithValidation(optimized, contentType, etag);
  } catch (err) {
    console.warn(`Error in /api/image/${req.params.productId}:`, err.message);
    sendPlaceholder(res, req.query.title);
  }
});

// SVG placeholder for books without images
function sendPlaceholder(res, title = 'Livre') {
  const displayTitle = decodeURIComponent(title || 'Livre').substring(0, 40);
  // Split title into lines of ~20 chars
  const words = displayTitle.split(' ');
  let lines = [];
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length > 20) {
      if (currentLine) lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine = (currentLine + ' ' + word).trim();
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  lines = lines.slice(0, 3);

  const titleSvg = lines
    .map((line, i) => `<text x="150" y="${170 + i * 28}" text-anchor="middle" font-family="Georgia,serif" font-size="18" font-weight="bold" fill="#c4a35a">${escapeXml(line)}</text>`)
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420">
    <rect width="300" height="420" rx="4" fill="#1a2332"/>
    <rect x="12" y="12" width="276" height="396" rx="2" fill="none" stroke="#c4a35a" stroke-width="1.5" opacity="0.4"/>
    <rect x="20" y="20" width="260" height="380" rx="2" fill="none" stroke="#c4a35a" stroke-width="0.5" opacity="0.3"/>
    <line x1="40" y1="130" x2="260" y2="130" stroke="#c4a35a" stroke-width="1" opacity="0.5"/>
    <line x1="40" y1="${200 + (lines.length - 1) * 28}" x2="260" y2="${200 + (lines.length - 1) * 28}" stroke="#c4a35a" stroke-width="1" opacity="0.5"/>
    ${titleSvg}
    <text x="150" y="340" text-anchor="middle" font-family="Georgia,serif" font-size="12" fill="#c4a35a" opacity="0.6">Sen Harmattan</text>
    <text x="150" y="360" text-anchor="middle" font-family="Georgia,serif" font-size="10" fill="#c4a35a" opacity="0.4">Éditions</text>
    <!-- Book spine effect -->
    <rect x="0" y="0" width="8" height="420" fill="#0f1722"/>
    <rect x="8" y="0" width="2" height="420" fill="#c4a35a" opacity="0.2"/>
  </svg>`;

  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(svg);
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Category cover image - returns a product image from that category
app.get('/api/categories/:id/image', async (req, res) => {
  try {
    const catId = req.params.id;
    const cacheKey = `catimg:${catId}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached === 'none') return sendCategoryPlaceholder(res, req.query.label);
      res.set('Content-Type', cached.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buffer);
    }

    // Get products from this category
    const catRes = await dolibarrApi.get(`/categories/${catId}/objects`, {
      params: { type: 'product', limit: 20 },
    });

    const products = catRes.data || [];

    // Try to find a product with an image
    for (const p of products) {
      try {
        const docRes = await dolibarrApi.get('/documents', {
          params: { modulepart: 'produit', id: parseInt(p.id) },
        });
        const images = (docRes.data || []).filter((d) =>
          /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name)
        );
        if (images.length > 0) {
          const img = images.find((i) => /cover|default/i.test(i.name)) || images[0];
          const ref = img.level1name || img.path.split('/').pop();
          const response = await dolibarrApi.get('/documents/download', {
            params: { modulepart: 'produit', original_file: `${ref}/${img.name}` },
            responseType: 'arraybuffer',
          });

          let imageBuffer;
          try {
            const json = JSON.parse(response.data.toString());
            if (json.content) imageBuffer = Buffer.from(json.content, 'base64');
          } catch {
            imageBuffer = Buffer.from(response.data);
          }

          if (imageBuffer && imageBuffer.length > 100) {
            const ext = img.name.split('.').pop().toLowerCase();
            const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
            const contentType = mimeTypes[ext] || 'image/jpeg';
            cache.set(cacheKey, { buffer: imageBuffer, contentType }, 7200);
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=86400');
            return res.send(imageBuffer);
          }
        }
      } catch (docErr) {
        console.warn(`Error fetching documents for product ${p.id}:`, docErr.message);
      }
    }

    cache.set(cacheKey, 'none', 3600);
    sendCategoryPlaceholder(res, req.query.label);
  } catch (err) {
    console.warn(`Error in /api/categories/${req.params.id}/image:`, err.message);
    sendCategoryPlaceholder(res, req.query.label);
  }
});

function sendCategoryPlaceholder(res, label = 'Catégorie') {
  const displayLabel = decodeURIComponent(label || 'Catégorie').substring(0, 30);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#10531a"/>
        <stop offset="100%" stop-color="#1a2332"/>
      </linearGradient>
    </defs>
    <rect width="400" height="300" fill="url(#g)"/>
    <text x="200" y="140" text-anchor="middle" font-family="Georgia,serif" font-size="40" fill="#c4a35a" opacity="0.3">&#128214;</text>
    <text x="200" y="200" text-anchor="middle" font-family="Lato,sans-serif" font-size="20" font-weight="700" fill="#ffffff">${escapeXml(displayLabel)}</text>
  </svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(svg);
}

// Categories
app.get('/api/categories', async (req, res) => {
  try {
    const cached = cache.get('categories:all');
    if (cached) return res.json(cached);

    const catRes = await dolibarrApi.get('/categories', {
      params: { type: 'product', sortfield: 't.label', sortorder: 'ASC', limit: 100 },
    });

    const categories = (catRes.data || []).map((c) => ({
      id: parseInt(c.id, 10),
      label: c.label,
      description: c.description,
      fk_parent: c.fk_parent !== null && c.fk_parent !== undefined ? parseInt(c.fk_parent, 10) : 0,
      color: c.color,
    }));

    cache.set('categories:all', categories, 120); // cache 2 min (fraîcheur vs. coût)
    res.json(categories);
  } catch (err) {
    console.error('GET /api/categories error:', err.response?.status);
    res.status(err.response?.status || 500).json({ error: 'Erreur chargement catégories' });
  }
});

// Create order
app.post('/api/orders', orderLimiter, csrfProtection, async (req, res) => {
  try {
    const { customer, items, payment_method, shipping_address } = req.body;

    if (!customer || !items || items.length === 0) {
      return res.status(400).json({ error: 'Données de commande incomplètes' });
    }

    // ── Validation des quantités (entier entre 1 et 100) ──
    const MAX_QTY = 100;
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
        return res.status(400).json({ error: `Quantité invalide pour un article (entier entre 1 et ${MAX_QTY})` });
      }
    }

    // ── Contrôle de disponibilité stock (anti-survente face au POS) ──
    // p.stock = source de vérité globale Dolibarr. Le POS décrémente p.stock à
    // chaque validation de facture (idwarehouse=4), donc une commande web qui
    // demande plus que p.stock disponible doit être refusée avant création.
    // Note: il subsiste une fenêtre entre /api/orders et la confirmation paiement
    // (facture créée plus tard) — la réservation locale serait l'étape suivante.
    try {
      const productIds = items.map((it) => parseInt(it.id, 10)).filter(Number.isInteger);
      if (productIds.length === items.length && productIds.length > 0) {
        const placeholders = productIds.map(() => '?').join(',');
        const [stockRows] = await dolibarrPool.query(
          `SELECT rowid AS id, label, stock, fk_product_type FROM llx_product WHERE rowid IN (${placeholders})`,
          productIds,
        );
        const stockMap = new Map(stockRows.map((r) => [r.id, r]));
        for (const item of items) {
          const pid = parseInt(item.id, 10);
          const row = stockMap.get(pid);
          // fk_product_type !== 0 = service (pas de stock physique) → on laisse passer.
          if (!row || row.fk_product_type !== 0) continue;
          const available = Number(row.stock) || 0;
          const qty = Number(item.quantity);
          if (available < qty) {
            return res.status(409).json({
              error: available <= 0 ? 'Article en rupture de stock' : 'Stock insuffisant pour cet article',
              product_id: pid,
              product_label: row.label,
              requested: qty,
              available: Math.max(0, available),
            });
          }
        }
      }
    } catch (stockErr) {
      console.warn('[ORDERS] Stock check failed, allowing order:', stockErr.message);
      // En cas d'erreur de lecture stock, on n'empêche pas la commande — la
      // facture/paiement ultérieurs détecteront le problème côté Dolibarr.
    }

    // ── Résolution du tiers Dolibarr (socid) ──
    // SÉCURITÉ : on n'accepte JAMAIS de dolibarr_id/socid venu du body.
    // Si la requête est authentifiée → on utilise le dolibarr_id de la session.
    // Sinon (checkout invité) → on résout/crée le tiers à partir de l'email.
    let customerId = null;
    const sessionToken = req.cookies?.customer_session;
    if (sessionToken) {
      const session = db.prepare(
        "SELECT c.* FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
      ).get(hashCustomerSessionToken(sessionToken));
      if (session && session.dolibarr_id) {
        customerId = session.dolibarr_id;
      }
    }

    if (!customerId) {
      try {
        const searchRes = await dolibarrApi.get('/thirdparties', {
        params: { sqlfilters: `(t.email:=:'${safeSqlFilter(customer.email)}')` },
      });
      if (searchRes.data && searchRes.data.length > 0) {
        customerId = searchRes.data[0].id;
      }
    } catch (err) {
      console.warn('Customer search warning:', err.response?.data || err.message);
    }
    }

    if (!customerId) {
      const tpRes = await dolibarrApi.post('/thirdparties', {
        name: `${customer.firstname} ${customer.lastname}`,
        firstname: customer.firstname,
        email: customer.email,
        phone: customer.phone,
        address: shipping_address?.address || '',
        town: shipping_address?.city || 'Dakar',
        country_code: 'SN',
        client: 1,
        code_client: -1,
      });
      customerId = tpRes.data;
    }

    // Update thirdparty address if shipping address provided
    if (shipping_address?.address) {
      try {
        await dolibarrApi.put(`/thirdparties/${customerId}`, {
        address: shipping_address.address,
        town: shipping_address.city || 'Dakar',
        phone: customer.phone,
      });
    } catch (err) {
      console.warn('Address update warning:', err.response?.data || err.message);
    }
    }

    // Create order
    // SÉCURITÉ : le prix de chaque ligne est récupéré côté serveur depuis
    // Dolibarr — tout price_ttc/subprice envoyé par le client est ignoré.
    const orderLines = [];
    let serverTotal = 0;
    for (const item of items) {
      const productId = parseInt(item.id, 10);
      if (!Number.isInteger(productId) || productId < 1) {
        return res.status(400).json({ error: 'Identifiant produit invalide' });
      }
      let trustedPrice;
      try {
        const productRes = await dolibarrApi.get(`/products/${productId}`);
        trustedPrice = parseFloat(productRes.data?.price_ttc || productRes.data?.price || 0);
      } catch (err) {
        console.warn(`Product price lookup failed (id=${productId}):`, err.response?.data || err.message);
        return res.status(400).json({ error: `Produit introuvable (ID: ${productId})` });
      }
      if (!(trustedPrice > 0)) {
        return res.status(400).json({ error: `Prix indisponible pour le produit ${productId}` });
      }
      const qty = Number(item.quantity);
      serverTotal += trustedPrice * qty;
      orderLines.push({
        fk_product: productId,
        qty,
        subprice: trustedPrice,
        tva_tx: 0,
        product_type: 0,
      });
    }

    console.log(`[ORDERS] Total recalculé côté serveur: ${serverTotal} XOF (${orderLines.length} ligne(s))`);

    const orderRes = await dolibarrApi.post('/orders', {
      socid: parseInt(customerId),
      date: new Date().toISOString().split('T')[0],
      lines: orderLines,
      // module_source='ecommerce' tague la commande comme issue du site web
      // (par symétrie avec 'takepos' utilisé par le POS). Permet aux stats
      // Dolibarr de distinguer les canaux de vente. Copié sur la facture
      // par createfromorder.
      module_source: 'ecommerce',
      note_private: `Paiement: ${payment_method} | Tel: ${customer.phone}`,
      note_public: `Commande en ligne - ${payment_method}`,
      mode_reglement_id: getPaymentModeId(payment_method),
    });

    const orderId = orderRes.data;

    // Validate order
    try {
      await dolibarrApi.post(`/orders/${orderId}/validate`);
    } catch (err) {
      console.warn('Order validation warning:', err.response?.data || err.message);
    }

    // La facture n'est PAS créée ici — elle sera générée quand le paiement sera
    // confirmé par un admin via POST /api/admin/orders/:id/confirm-payment.
    // Cela sépare l'intention de commande de la validation comptable.

    // Get order details
    const orderDetail = await dolibarrApi.get(`/orders/${orderId}`);

    // Persister le statut de paiement en local (traçabilité)
    db.prepare(
      `INSERT INTO order_payments (dolibarr_order_id, order_ref, customer_name, customer_email, customer_phone, payment_method, payment_status, amount_expected)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    ).run(String(orderId), orderDetail.data.ref, `${customer.firstname} ${customer.lastname}`, customer.email, customer.phone || '', payment_method, parseFloat(orderDetail.data.total_ttc) || 0);

    // Invalidate caches
    items.forEach((item) => {
      cache.del(`product:${item.id}`);
    });
    cache.keys().filter((k) => k.startsWith('products:')).forEach((k) => cache.del(k));
    cache.keys().filter((k) => k.startsWith('customer-orders:')).forEach((k) => cache.del(k));
    cache.keys().filter((k) => k.startsWith('customer-invoices:')).forEach((k) => cache.del(k));

    // ── Notifier l'équipe (best-effort) qu'une nouvelle commande web est arrivée ──
    // PayTech a sa propre notification « payée » via l'IPN (paytech-routes.js) ; ici
    // on couvre les paiements manuels (Wave, Orange Money, espèces, virement) qui
    // exigent un suivi humain pour confirmer le paiement — sinon l'équipe n'est
    // jamais alertée et ne voit la commande qu'en ouvrant /admin/orders.
    if (payment_method !== 'paytech') {
      try {
        let adminEmails = [];
        try {
          const cfg = JSON.parse(readFileSync(join(__dirname, 'site-config.json'), 'utf-8'));
          adminEmails = Array.isArray(cfg.admin_emails) ? cfg.admin_emails : [];
        } catch { /* config absente → notification ignorée */ }
        emailService.sendNewOrderNotificationToAdmin({
          transporter,
          order: {
            ref: orderDetail.data.ref,
            total: orderDetail.data.total_ttc,
            items: items.map((it) => ({ label: it.title || it.label, quantity: it.quantity, price_ttc: it.price_ttc || it.price })),
            customer: {
              email: customer.email,
              firstname: customer.firstname,
              lastname: customer.lastname,
              phone: customer.phone,
            },
          },
          adminEmails,
          siteUrl: SITE_URL,
          status: 'pending',
          paymentInfo: { method: payment_method },
        });
      } catch (notifyErr) {
        console.error('[ORDERS] admin notification failed:', notifyErr.message);
      }
    }

    // Si le client a choisi PayTech, initier le checkout hosted dans la foulée
    let paytechRedirectUrl = null;
    if (payment_method === 'paytech' && isPaytechConfigured()) {
      try {
        const refCommand = orderDetail.data.ref || `SO-${orderId}`;
        const total = parseInt(orderDetail.data.total_ttc, 10) || 0;
        if (total > 0) {
          const ptPayload = {
            item_name: `Commande ${refCommand}`,
            item_price: total,
            currency: 'XOF',
            ref_command: refCommand,
            command_name: `Commande ${refCommand}`,
            env: (process.env.PAYTECH_ENV || 'test').toLowerCase(),
            ipn_url: process.env.PAYTECH_IPN_URL || `${SITE_URL}/api/webhooks/paytech`,
            success_url: `${process.env.PAYTECH_RETURN_URL || `${SITE_URL}/commande/succes`}?ref=${encodeURIComponent(refCommand)}`,
            cancel_url: `${process.env.PAYTECH_CANCEL_URL || `${SITE_URL}/commande/echec`}?ref=${encodeURIComponent(refCommand)}`,
            custom_field: JSON.stringify({ order_id: String(orderId), order_ref: refCommand }),
          };
          const ptRes = await axios.post(
            'https://paytech.sn/api/payment/request-payment',
            ptPayload,
            {
              headers: {
                API_KEY: process.env.PAYTECH_API_KEY,
                API_SECRET: process.env.PAYTECH_API_SECRET,
                'Content-Type': 'application/json',
              },
              timeout: 15000,
            }
          );
          if (ptRes.data?.success === 1 && ptRes.data?.redirect_url) {
            paytechRedirectUrl = ptRes.data.redirect_url;
            db.prepare(
              `UPDATE order_payments
               SET external_transaction_id = ?, external_provider = 'paytech', external_status = 'pending'
               WHERE dolibarr_order_id = ?`
            ).run(ptRes.data.token || '', String(orderId));
          } else {
            console.warn('[PAYTECH] init unexpected:', ptRes.data);
          }
        }
      } catch (ptErr) {
        console.error('[PAYTECH] init error inside /api/orders:', ptErr.response?.data || ptErr.message);
        // On ne fait pas planter la commande — on retourne quand même les infos
        // et le client peut retenter via /api/payments/paytech/init
      }
    }

    res.json({
      success: true,
      order_id: orderId,
      order_ref: orderDetail.data.ref,
      payment_status: 'pending',
      total: orderDetail.data.total_ttc,
      paytech_redirect_url: paytechRedirectUrl,
    });
  } catch (err) {
    console.error('POST /api/orders error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Erreur lors de la création de la commande',
    });
  }
});

app.post('/api/preorders', orderLimiter, csrfProtection, sanitizeBody([
  'product_id',
  'quantity',
  'payment_method',
]), async (req, res) => {
  try {
    const payload = {
      ...req.body,
      customer: {
        firstname: sanitize(req.body?.customer?.firstname || ''),
        lastname: sanitize(req.body?.customer?.lastname || ''),
        email: sanitize(req.body?.customer?.email || ''),
        phone: sanitize(req.body?.customer?.phone || ''),
        address: sanitize(req.body?.customer?.address || ''),
        city: sanitize(req.body?.customer?.city || ''),
        country: sanitize(req.body?.customer?.country || ''),
      },
    };

    const errors = validatePreorderPayload(payload);
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        error: 'Veuillez corriger les informations de précommande.',
        details: errors,
      });
    }

    const config = getSiteConfig();
    const productId = String(payload.product_id);
    const quantity = parseInt(payload.quantity, 10);
    const paymentMethods = getEnabledPaymentMethods(config);
    const paymentCheck = resolvePreorderPayment(payload.payment_method, paymentMethods);

    if (!paymentCheck.ok) {
      return res.status(paymentCheck.statusCode).json({ error: paymentCheck.error });
    }

    const productRes = await dolibarrApi.get(`/products/${productId}`);
    const product = productRes.data;
    const releaseDate = getProductReleaseDate(product, config);

    if (!releaseDate || !isUpcomingRelease(releaseDate)) {
      return res.status(400).json({ error: 'Ce livre n’est pas ouvert à la précommande pour le moment.' });
    }

    const upcomingBook = getUpcomingBookConfig(productId, config);
    const pricing = calculatePreorderPricing(
      parseFloat(product.price_ttc || product.price || 0),
      Number(upcomingBook?.preorder_discount_pct || 0),
      quantity
    );

    const customer = {
      firstname: payload.customer.firstname,
      lastname: payload.customer.lastname,
      email: payload.customer.email,
      phone: payload.customer.phone || '',
    };
    const shippingAddress = {
      address: payload.customer.address,
      city: payload.customer.city,
      country: payload.customer.country,
    };
    const thirdparty = await upsertPreorderThirdparty(customer, shippingAddress);
    const preorderRef = buildPreorderReference();

    db.prepare(`
      INSERT INTO preorders (
        preorder_ref, product_id, product_ref, product_label, customer_id, customer_dolibarr_id,
        firstname, lastname, email, phone, address, city, country, quantity,
        original_unit_price_ttc, preorder_unit_price_ttc, discount_rate, total_price_ttc,
        payment_method, payment_status, status, estimated_release_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      preorderRef,
      String(product.id || product.rowid),
      product.ref || null,
      product.label || 'Livre à paraître',
      thirdparty.localCustomerId,
      String(thirdparty.dolibarrCustomerId || ''),
      customer.firstname,
      customer.lastname,
      customer.email,
      customer.phone || null,
      shippingAddress.address,
      shippingAddress.city,
      shippingAddress.country,
      pricing.quantity,
      pricing.originalUnitPrice,
      pricing.preorderUnitPrice,
      pricing.discountRate,
      pricing.totalPrice,
      payload.payment_method,
      paymentCheck.paymentStatus,
      paymentCheck.preorderStatus,
      parseReleaseDate(releaseDate)?.toISOString().split('T')[0] || releaseDate
    );

    const preorder = db.prepare('SELECT * FROM preorders WHERE preorder_ref = ?').get(preorderRef);

    sendPreorderConfirmationEmail(preorder, paymentMethods).catch((err) => {
      console.error('[PREORDER] Confirmation email error:', err.message);
    });

    res.json({
      success: true,
      preorder_ref: preorder.preorder_ref,
      status: preorder.status,
      payment_status: preorder.payment_status,
      estimated_release_date: preorder.estimated_release_date,
      total_price_ttc: preorder.total_price_ttc,
      preorder_unit_price_ttc: preorder.preorder_unit_price_ttc,
      discount_rate: preorder.discount_rate,
    });
  } catch (err) {
    console.error('POST /api/preorders error:', err.response?.data || err.message);
    res.status(err.response?.status || 500).json({
      error: 'Erreur lors de l’enregistrement de la précommande',
    });
  }
});

app.post('/api/preorders/:reference/cancel', orderLimiter, csrfProtection, sanitizeBody(['email', 'reason']), (req, res) => {
  try {
    const email = sanitize(req.body.email || '');
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Veuillez fournir l’email associé à la précommande.' });
    }

    const preorder = db.prepare('SELECT * FROM preorders WHERE preorder_ref = ? AND email = ?').get(req.params.reference, email);
    const cancellation = buildCancellationUpdate(preorder, req.body.reason);

    if (!cancellation.ok) {
      return res.status(cancellation.statusCode).json({ error: cancellation.error });
    }

    db.prepare(`
      UPDATE preorders
      SET status = ?, cancel_reason = ?, cancelled_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE preorder_ref = ?
    `).run(
      cancellation.status,
      cancellation.cancelReason || null,
      cancellation.cancelledAt,
      req.params.reference
    );

    const updatedPreorder = db.prepare('SELECT * FROM preorders WHERE preorder_ref = ?').get(req.params.reference);

    sendPreorderCancellationEmail(updatedPreorder, getEnabledPaymentMethods()).catch((err) => {
      console.error('[PREORDER] Cancellation email error:', err.message);
    });

    res.json({
      success: true,
      preorder_ref: req.params.reference,
      status: cancellation.status,
    });
  } catch (err) {
    console.error('POST /api/preorders/:reference/cancel error:', err.message);
    res.status(500).json({ error: 'Erreur lors de l’annulation de la précommande' });
  }
});

// Order tracking — requires authentication + ownership check
app.get('/api/orders/:id', requireCustomerAuth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'ID invalide' });
    const orderRes = await dolibarrApi.get(`/orders/${req.params.id}`);
    const order = orderRes.data;
    // Vérifier que la commande appartient au client connecté
    if (String(order.socid) !== String(req.customer.dolibarr_id)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    res.json(order);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: 'Commande introuvable' });
  }
});

// Auth routes moved to server/auth-routes.js (mounted at /api/auth)

// Get customer invoices — ownership check
app.get('/api/customers/:id/invoices', requireCustomerAuth, async (req, res) => {
  try {
    const customerId = req.params.id;
    if (!/^\d+$/.test(customerId)) return res.status(400).json({ error: 'ID invalide' });
    // IDOR protection: vérifier que le client demande ses propres factures
    if (String(req.customer.dolibarr_id) !== String(customerId)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    const cacheKey = `customer-invoices:${customerId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const invoicesRes = await dolibarrApi.get('/invoices', {
      params: {
        sortfield: 't.rowid',
        sortorder: 'DESC',
        limit: 50,
        sqlfilters: `(t.fk_soc:=:'${safeSqlFilter(customerId)}')`,
      },
    });

    const invoices = (invoicesRes.data || []).map((inv) => ({
      id: inv.id,
      ref: inv.ref,
      date: inv.date,
      date_creation: inv.date_creation,
      date_lim_reglement: inv.date_lim_reglement,
      total_ht: inv.total_ht,
      total_tva: inv.total_tva,
      total_ttc: inv.total_ttc,
      statut: inv.statut,
      paye: inv.paye,
      nb_lines: inv.lines?.length || 0,
      lines: (inv.lines || []).map((l) => ({
        product_label: l.product_label || l.description,
        qty: l.qty,
        total_ttc: l.total_ttc,
        fk_product: l.fk_product,
      })),
    }));

    cache.set(cacheKey, invoices, 120);
    res.json(invoices);
  } catch (err) {
    console.error('GET /api/customers/:id/invoices error:', err.response?.status);
    if (err.response?.status === 404 || err.response?.status === 403) return res.json([]);
    res.status(err.response?.status || 500).json({ error: 'Erreur chargement factures' });
  }
});

// Download invoice PDF — ownership check
app.get('/api/invoices/:id/pdf', requireCustomerAuth, async (req, res) => {
  try {
    const invoiceId = req.params.id;

    // IDOR protection: vérifier que la facture appartient au client connecté
    try {
      const checkRes = await dolibarrApi.get(`/invoices/${invoiceId}`);
      if (String(checkRes.data.socid) !== String(req.customer.dolibarr_id)) {
        return res.status(403).json({ error: 'Accès non autorisé' });
      }
    } catch {
      return res.status(404).json({ error: 'Facture introuvable' });
    }

    // First generate the document if not already done
    try {
      await dolibarrApi.put(`/invoices/${invoiceId}/builddoc`, {
        langcode: 'fr_FR',
        modelpdf: 'crabe',
      });
    } catch (buildErr) {
      console.warn(`Error building doc for invoice ${invoiceId}:`, buildErr.message);
    }

    // Get invoice details to find the PDF file
    const invoiceRes = await dolibarrApi.get(`/invoices/${invoiceId}`);
    const invoice = invoiceRes.data;
    const lastDoc = invoice.last_main_doc;

    if (!lastDoc) {
      return res.status(404).json({ error: 'PDF non disponible' });
    }

    // Download the document
    const filename = lastDoc.split('/').pop();
    const docRes = await dolibarrApi.get('/documents/download', {
      params: {
        modulepart: 'facture',
        original_file: filename,
      },
      responseType: 'arraybuffer',
    });

    let pdfBuffer;
    try {
      const json = JSON.parse(docRes.data.toString());
      if (json.content) pdfBuffer = Buffer.from(json.content, 'base64');
    } catch {
      pdfBuffer = Buffer.from(docRes.data);
    }

    if (!pdfBuffer || pdfBuffer.length < 100) {
      return res.status(404).json({ error: 'PDF non disponible' });
    }

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${invoice.ref}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('GET /api/invoices/:id/pdf error:', err.response?.status);
    res.status(500).json({ error: 'Erreur téléchargement facture' });
  }
});

// Get customer orders — ownership check
app.get('/api/customers/:id/orders', requireCustomerAuth, async (req, res) => {
  try {
    const customerId = req.params.id;
    if (!/^\d+$/.test(customerId)) return res.status(400).json({ error: 'ID invalide' });
    // IDOR protection: vérifier que le client demande ses propres commandes
    if (String(req.customer.dolibarr_id) !== String(customerId)) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    const cacheKey = `customer-orders:${customerId}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const ordersRes = await dolibarrApi.get('/orders', {
      params: {
        sortfield: 't.rowid',
        sortorder: 'DESC',
        limit: 50,
        sqlfilters: `(t.fk_soc:=:'${safeSqlFilter(customerId)}')`,
      },
    });

    const orders = (ordersRes.data || []).map((o) => ({
      id: o.id,
      ref: o.ref,
      date: o.date,
      date_creation: o.date_creation,
      total_ttc: o.total_ttc,
      statut: o.statut,
      nb_lines: o.lines?.length || 0,
      lines: (o.lines || []).map((l) => ({
        product_label: l.product_label || l.description,
        qty: l.qty,
        total_ttc: l.total_ttc,
        fk_product: l.fk_product,
      })),
    }));

    cache.set(cacheKey, orders, 120);
    res.json(orders);
  } catch (err) {
    console.error('GET /api/customers/:id/orders error:', err.response?.status);
    if (err.response?.status === 404 || err.response?.status === 403) return res.json([]);
    res.status(err.response?.status || 500).json({ error: 'Erreur chargement commandes' });
  }
});

// Sync status
app.get('/api/sync/status', (req, res) => {
  res.json(getSyncStatus());
});

// Manual sync trigger
app.post('/api/sync/trigger', syncLimiter, async (req, res) => {
  try {
    const { type = 'all' } = req.body;
    if (type === 'products' || type === 'all') await syncProducts();
    if (type === 'categories' || type === 'all') await syncCategories();
    if (type === 'stock' || type === 'all') await syncStock();
    res.json({ success: true, status: getSyncStatus() });
  } catch (err) {
    console.error('Sync trigger error:', err.message);
    res.status(500).json({ error: 'Erreur de synchronisation' });
  }
});

// ─── CRON JOBS ──────────────────────────────────────────────

// Sync stock every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  console.log('[CRON] Syncing stock...');
  try { await syncStock(); } catch (e) { console.error('[CRON] Stock sync error:', e.message); }
});

// Sync categories every hour
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Syncing categories...');
  try { await syncCategories(); } catch (e) { console.error('[CRON] Category sync error:', e.message); }
});

// Full product sync every 6 hours
cron.schedule('0 */6 * * *', async () => {
  console.log('[CRON] Full product sync...');
  try { await syncProducts(); } catch (e) { console.error('[CRON] Product sync error:', e.message); }
});

cron.schedule('15 * * * *', () => {
  try {
    const preorders = db.prepare("SELECT preorder_ref, status, estimated_release_date FROM preorders WHERE status = 'preorder'").all();
    const now = new Date();
    let updated = 0;
    const paymentMethods = getEnabledPaymentMethods();

    for (const preorder of preorders) {
      const nextStatus = buildReleasedStatus(preorder, now);
      if (nextStatus !== preorder.status) {
        db.prepare(`
          UPDATE preorders
          SET status = ?, released_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE preorder_ref = ?
        `).run(nextStatus, now.toISOString(), preorder.preorder_ref);
        const updatedPreorder = db.prepare('SELECT * FROM preorders WHERE preorder_ref = ?').get(preorder.preorder_ref);
        sendPreorderReleaseEmail(updatedPreorder, paymentMethods).catch((err) => {
          console.error('[PREORDER] Release email error:', err.message);
        });
        updated += 1;
      }
    }

    if (updated > 0) {
      console.log(`[CRON] ${updated} précommande(s) basculée(s) en disponible`);
    }
  } catch (err) {
    console.error('[CRON] Preorder status sync error:', err.message);
  }
});

// Stock alerts — recalcul quotidien à 6h du matin
cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] Stock daily batch...');
  try { await runDailyBatch(dolibarrPool, db); } catch (e) { console.error('[CRON] Stock daily batch error:', e.message); }
});

// Classification ABC/XYZ — hebdomadaire le lundi à 5h
cron.schedule('0 5 * * 1', async () => {
  console.log('[CRON] Stock ABC/XYZ classification...');
  try { await runClassificationBatch(dolibarrPool, db); } catch (e) { console.error('[CRON] Classification error:', e.message); }
});

// Relances workflow auteur — quotidien à 8h Dakar
// Stages en attente d'action auteur : correction_author_review, bat_author_review
// → J+7 : rappel auteur (email + notif in-app)
// → J+14 : rappel auteur + copie admin
cron.schedule('0 8 * * *', () => {
  try {
    const stalled = db.prepare(
      `SELECT m.*, a.email AS author_email, a.firstname AS author_firstname,
              CAST((julianday('now') - julianday(m.updated_at)) AS INTEGER) AS days_idle
       FROM manuscripts m
       JOIN authors a ON a.id = m.author_id
       WHERE m.current_stage IN ('correction_author_review', 'bat_author_review')
         AND CAST((julianday('now') - julianday(m.updated_at)) AS INTEGER) >= 7`
    ).all();

    for (const m of stalled) {
      const days = m.days_idle;
      const level = days >= 14 ? 'urgent' : 'rappel';

      // Anti-doublon : si on a déjà envoyé une relance dans les 6 derniers jours pour ce manuscrit, on saute
      const recent = db.prepare(
        `SELECT id FROM author_notifications
         WHERE author_id = ? AND manuscript_id = ?
           AND stage LIKE 'reminder%'
           AND created_at > datetime('now', '-6 days')
         LIMIT 1`
      ).get(m.author_id, m.id);
      if (recent) continue;

      const stageLabel = m.current_stage === 'bat_author_review' ? 'le BAT couverture' : 'les corrections';
      const title = level === 'urgent'
        ? `Rappel important — ${m.title}`
        : `Rappel — ${m.title}`;
      const message = `Vous n'avez pas encore validé ${stageLabel} depuis ${days} jours. Merci de vous prononcer pour ne pas bloquer la suite du projet.`;

      // Notification in-app
      try {
        db.prepare(
          `INSERT INTO author_notifications
            (author_id, manuscript_id, manuscript_ref, manuscript_title, stage, title, message, action_url, action_required)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
        ).run(
          m.author_id, m.id, m.ref, m.title,
          `reminder_${level}`,
          title, message,
          `${SITE_URL}/auteur/manuscrits/${m.id}`
        );
      } catch (e) { console.warn('[CRON] reminder notif insert error:', e.message); }

      // Email auteur — uniquement si l'auteur n'a pas opt-out des rappels
      const prefs = getAuthorPreferences(db, m.author_id);
      if (transporter && m.author_email && prefs.reminders) {
        transporter.sendMail({
          to: m.author_email,
          subject: title,
          html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
            <h2 style="color:${level === 'urgent' ? '#dc2626' : '#10531a'}">${title.replace(/^Rappel\s*(important\s*)?—\s*/, '')}</h2>
            <p>Bonjour ${m.author_firstname || ''},</p>
            <p>${message}</p>
            <p><a href="${SITE_URL}/auteur/manuscrits/${m.id}" style="background:#10531a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Accéder à mon manuscrit</a></p>
            <p style="color:#666;font-size:0.9em;margin-top:24px">L'équipe éditoriale — L'Harmattan Sénégal</p>
            <p style="color:#999;font-size:0.75em;margin-top:8px">Vous pouvez désactiver ces rappels depuis vos <a href="${SITE_URL}/auteur/preferences" style="color:#10531a">préférences de notifications</a>.</p>
          </div>`,
        }).catch((err) => console.error('[CRON] reminder email error:', err.message));
      }

      // Copie admin si urgent (>= 14j)
      if (level === 'urgent' && transporter) {
        try {
          const cfg = JSON.parse(readFileSync(join(__dirname, 'site-config.json'), 'utf-8'));
          const adminEmail = cfg.contact?.emails?.[0];
          if (adminEmail) {
            transporter.sendMail({
              to: adminEmail,
              subject: `[Workflow] ${m.ref} bloqué — ${days} jours sans réponse auteur`,
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
                <h2 style="color:#dc2626">Manuscrit bloqué côté auteur</h2>
                <p>Le manuscrit <strong>${m.title}</strong> (${m.ref}) est en attente de validation auteur (${m.current_stage === 'bat_author_review' ? 'BAT couverture' : 'corrections'}) depuis <strong>${days} jours</strong>.</p>
                <p>Auteur : ${m.author_firstname} (${m.author_email || 'email manquant'})</p>
                <p><a href="${SITE_URL}/admin/manuscripts/${m.id}" style="background:#10531a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Voir dans l'admin</a></p>
              </div>`,
            }).catch((err) => console.error('[CRON] reminder admin copy error:', err.message));
          }
        } catch (e) { void e; }
      }

      console.log(`[CRON] Relance ${level} envoyée pour ${m.ref} (${days}j sans réponse auteur)`);
    }
  } catch (err) {
    console.error('[CRON] Workflow reminders error:', err.message);
  }
});

// ─── SERVE STATIC IN PRODUCTION ─────────────────────────────

// Block access to database and sensitive files
app.use((req, res, next) => {
  if (/\.(sqlite|db|env)(-.*)?$/i.test(req.path)) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
});

if (IS_PROD) {
  const distPath = join(__dirname, '..', 'dist');
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      // index.html ne doit jamais être caché : sinon les anciens hash d'assets
      // restent référencés après un rebuild → erreurs MIME au prochain chargement.
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (/\/assets\//.test(filePath)) {
        // Assets fingerprintés (hash dans le nom) → cache agressif sûr.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  app.get('{*path}', (req, res) => {
    // Don't intercept API routes
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    // Ne pas servir index.html pour un asset manquant : sinon le navigateur reçoit
    // du text/html et refuse de l'exécuter comme module JS/CSS (erreur MIME).
    if (req.path.startsWith('/assets/') || /\.(js|mjs|css|map|json|woff2?|ttf|png|jpe?g|gif|svg|webp|ico)$/i.test(req.path)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    res.sendFile(join(distPath, 'index.html'));
  });
}

// ─── HELPERS ────────────────────────────────────────────────

function getPaymentModeId(method) {
  // Aligné sur le POS : Wave=54 (compte 6), Orange Money=55 (compte 4)
  const modes = { virement: 2, cb: 6, orange_money: 55, wave: 54 };
  return modes[method] || 0;
}

// ─── GLOBAL ERROR HANDLER ───────────────────────────────────
// Monté après toutes les routes : capture les erreurs non gérées
// et évite de divulguer la stack au client.
app.use((err, req, res, next) => {
  console.error('[ERR]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Erreur serveur' });
});

// ─── START ──────────────────────────────────────────────────

app.listen(PORT, process.env.HOST || '127.0.0.1', async () => {
  console.log(`\n  Sen Harmattan API Server running on port ${PORT}`);
  console.log(`  Mode: ${IS_PROD ? 'Production' : 'Development'}\n`);

  // Initial sync
  console.log('[INIT] Starting initial sync...');
  try {
    await syncCategories();
    console.log('[INIT] Categories synced');
  } catch (e) {
    console.error('[INIT] Category sync failed:', e.message);
  }

  // Migration one-shot des tags système (idempotent)
  await migrateLivreDuMois();

  // ─── Product Change Polling (complements webhook for REST API changes) ───
  let lastPollTimestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  async function pollProductChanges() {
    try {
      const [rows] = await dolibarrPool.query(
        'SELECT p.rowid AS id, p.ref, p.label, p.tms FROM llx_product p WHERE p.tms > ? ORDER BY p.tms DESC LIMIT 50',
        [lastPollTimestamp]
      );

      if (rows.length > 0) {
        let cleared = 0;
        for (const p of rows) {
          cache.del(`product:${p.id}`);
          cleared++;
        }
        // Clear listing caches once
        for (const k of cache.keys()) {
          if (k.startsWith('products:') || k.startsWith('suggest:')) {
            cache.del(k);
            cleared++;
          }
        }
        cache.del('price-range');

        // Log
        const refs = rows.map(r => r.ref).join(', ');
        db.prepare(`INSERT INTO webhook_sync_log (event, product_id, product_ref, status, detail, caches_cleared) VALUES (?, ?, ?, 'ok', ?, ?)`).run(
          'poll.products_changed',
          rows[0].id,
          refs.slice(0, 200),
          `${rows.length} produit(s) modifié(s) détecté(s) par polling`,
          `${cleared} caches invalidés`
        );

        console.log(`[POLL] ${rows.length} produit(s) modifié(s) détecté(s), ${cleared} caches invalidés`);

        // Update timestamp to latest tms
        lastPollTimestamp = rows[0].tms instanceof Date
          ? rows[0].tms.toISOString().replace('T', ' ').slice(0, 19)
          : String(rows[0].tms);
      }
    } catch (err) {
      console.error('[POLL] Error:', err.message);
    }
  }

  // Poll every 30 seconds
  setInterval(pollProductChanges, 30_000);
  console.log('[POLL] Product change polling started (every 30s)');
});
