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
import { dolibarrApi } from './dolibarr-client.js';
import { cache, getSyncStatus, syncProducts, syncCategories, syncStock } from './sync.js';
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
// SITE_URL pour les liens dans les emails (newsletter, reset password, etc.)
const SITE_URL = process.env.SITE_URL || `http://38.242.229.122:${PORT}`;
// ---------------------------

// ─── SECURITY MIDDLEWARE ─────────────────────────────────────

// Helmet — HTTP security headers
app.use(helmet({
  contentSecurityPolicy: IS_PROD ? {
    reportOnly: true, // Passer à false une fois HTTPS configuré
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://i.ytimg.com", "blob:"],
      connectSrc: ["'self'"],
      frameSrc: ["'self'", "https://www.youtube.com"],
      upgradeInsecureRequests: null, // Désactivé tant que HTTPS n'est pas configuré
    },
  } : false,
  crossOriginEmbedderPolicy: false,
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
app.use(express.json({ limit: '1mb' }));

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
  validate: { xForwardedForHeader: false },
});

// Strict rate limit for newsletter: 5 per hour
const newsletterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes d\'inscription, réessayez plus tard' },
  validate: { xForwardedForHeader: false },
});

// Order creation: 10 per hour
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Trop de commandes, réessayez plus tard' },
  validate: { xForwardedForHeader: false },
});

// Sync trigger: 2 per hour
const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 2,
  message: { error: 'Sync déjà déclenché récemment' },
  validate: { xForwardedForHeader: false },
});

// ─── CSRF PROTECTION ────────────────────────────────────────

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

  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
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

// ─── CUSTOMER AUTH MIDDLEWARE ────────────────────────────────
function requireCustomerAuth(req, res, next) {
  const token = req.cookies?.customer_session;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  const session = db.prepare(
    "SELECT cs.customer_id, c.* FROM customer_sessions cs JOIN customers c ON c.id = cs.customer_id WHERE cs.token = ? AND cs.expires_at > datetime('now')"
  ).get(token);
  if (!session) return res.status(401).json({ error: 'Session expirée' });

  req.customer = session;
  next();
}

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
    const bodyStr = JSON.stringify(req.body);
    const expectedSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');

    if (headerSignature && headerSignature !== expectedSignature) {
      // Also try with raw body if JSON.stringify differs
      if (headerSecret !== WEBHOOK_SECRET) {
        console.warn('[WEBHOOK] Invalid signature/secret');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    } else if (!headerSignature && headerSecret !== WEBHOOK_SECRET) {
      console.warn('[WEBHOOK] Invalid secret');
      return res.status(401).json({ error: 'Invalid webhook secret' });
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
app.use('/api/pos', createPosRouter({ db, dolibarrPool, csrfProtection, sanitizeBody, safeSqlFilter }));

// ─── AUTH MODULE ────────────────────────────────────────────
import { createAuthRouter } from './auth-routes.js';
app.use('/api/auth', createAuthRouter({ db, csrfProtection, sanitizeBody, authLimiter, requireCustomerAuth, dolibarrApi, transporter, cookieSecure: COOKIE_SECURE }));

// ─── CONTRACTS MODULE ───────────────────────────────────
import { createContractRouter } from './contract-routes.js';
app.use('/api/contracts', createContractRouter({ db, dolibarrPool, csrfProtection, sanitizeBody }));

// ─── AUTHOR PORTAL (workflow éditorial) ────────────────────
import { createAuthorRouter } from './author-routes.js';
const { router: authorRouter, requireAuthorAuth } = createAuthorRouter({
  db, csrfProtection, sanitizeBody, authLimiter, transporter,
  cookieSecure: COOKIE_SECURE, siteUrl: SITE_URL,
});
app.use('/api/author', authorRouter);
// eslint-disable-next-line no-unused-vars
const _requireAuthorAuth = requireAuthorAuth;

// ─── ADMIN MODULE ───────────────────────────────────────────
const siteConfigPath = join(__dirname, 'site-config.json');
function getSiteConfig() {
  try { return JSON.parse(readFileSync(siteConfigPath, 'utf-8')); }
  catch { return {}; }
}

function getUpcomingBookConfig(productId, config = getSiteConfig()) {
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
  setupAdminRoutes(app, { db, csrfProtection, sanitizeBody, transporter, cache, dolibarrPool, cookieSecure: COOKIE_SECURE, authLimiter });
  console.log('[ADMIN] Admin routes mounted');
} catch (err) {
  console.error('[ADMIN] Failed to mount admin routes:', err);
}

// ─── MANUSCRIPT WORKFLOW (admin) — monté APRÈS setupAdminRoutes
// pour bénéficier du middleware RBAC global sur /api/admin
import { createManuscriptRouter } from './manuscript-routes.js';
import { generateSignatureUrl } from './contract-routes.js';
import { transition as wfTransition } from './manuscript-workflow.js';
import { sendTransitionEmail } from './manuscript-emails.js';

// Hook 1 : créer un contrat Dolibarr draft quand une évaluation est positive
async function createContractDraft(manuscript) {
  const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(manuscript.author_id);
  if (!author) throw new Error('Auteur introuvable');

  // Créer la thirdparty Dolibarr si nécessaire
  let thirdpartyId = author.dolibarr_thirdparty_id;
  if (!thirdpartyId) {
    try {
      const doliRes = await dolibarrApi.post('/thirdparties', {
        name: `${author.firstname} ${author.lastname}`,
        email: author.email,
        phone: author.phone || '',
        client: 1,
        code_client: -1,
      });
      thirdpartyId = doliRes.data;
      db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ?').run(thirdpartyId, author.id);
    } catch (err) {
      console.error('[WORKFLOW] Thirdparty create error:', err.response?.data || err.message);
      throw new Error('Échec création thirdparty Dolibarr');
    }
  }

  // Créer le contrat brouillon via Dolibarr REST API
  const TEMPLATE_FILE = 'template_harmattan_2024';
  const modelPdf = `generic_contract_odt:/var/www/html/dolibarr/documents/doctemplates/contracts/${TEMPLATE_FILE}.odt`;
  try {
    const contractRes = await dolibarrApi.post('/contracts', {
      socid: parseInt(thirdpartyId, 10),
      date_contrat: Math.floor(Date.now() / 1000),
      model_pdf: modelPdf,
      array_options: {
        options_contract_type: 'harmattan_2024',
        options_book_title: manuscript.title,
        options_royalty_rate_print: 8,
        options_royalty_rate_digital: 15,
        options_royalty_threshold: 500,
        options_free_author_copies: 10,
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
      { note: `Contrat Dolibarr #${contractId} créé`, updates: { contract_id: contractId } }
    );

    // Email auteur avec le lien de signature (best-effort)
    try {
      const [[contractRow]] = await dolibarrPool.query('SELECT ref FROM llx_contrat WHERE rowid = ?', [contractId]);
      if (contractRow?.ref) {
        const signatureUrl = generateSignatureUrl(contractRow.ref);
        transporter?.sendMail({
          from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
          to: author.email,
          subject: `Contrat d'édition ${contractRow.ref} — signature en ligne`,
          html: `<p>Bonjour ${author.firstname},</p><p>Votre contrat d'édition est prêt. Vous pouvez le signer en ligne via ce lien sécurisé :</p><p><a href="${signatureUrl}" style="background:#10531a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Signer mon contrat</a></p><p>Référence : <strong>${contractRow.ref}</strong></p>`,
        }).catch((err) => console.error('[WORKFLOW] Signature email error:', err.message));
      }
    } catch (err) { console.warn('[WORKFLOW] Signature link fetch warning:', err.message); }

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
          const updated = wfTransition(db, m.id, 'contract_signed',
            { role: 'system', label: 'polling' },
            { note: `Signature détectée (signed_status=${contract.signed_status})` }
          );
          console.log(`[WORKFLOW] ${m.ref} contrat signé détecté.`);
          // Avancer automatiquement à payment_pending
          wfTransition(db, m.id, 'payment_pending',
            { role: 'system', label: 'polling' },
            { note: 'Paiement attendu après signature' }
          );
          // Notifier l'auteur
          const author = db.prepare('SELECT email, firstname FROM authors WHERE id = ?').get(updated.author_id);
          if (author) {
            sendTransitionEmail(transporter, updated, 'payment_pending',
              { type: 'author', email: author.email, firstname: author.firstname }, SITE_URL);
          }
        }
      } catch (err) { console.warn('[WORKFLOW] signature poll error for', m.ref, ':', err.message); }
    }
  } catch (err) { console.error('[WORKFLOW] signature cron error:', err.message); }
}, 5 * 60 * 1000);

// ─── PAYMENT CONFIRMATION (admin confirms payment → invoice created) ────
const confirmPaymentAuth = adminAuth(db);
// Le comptable est en lecture seule : bloquer les actions d'écriture sur les paiements
function blockComptableWrite(req, res, next) {
  if (req.admin?.role === 'comptable') {
    return res.status(403).json({ error: 'Accès en lecture seule pour le profil comptable' });
  }
  next();
}
app.post('/api/admin/orders/:id/confirm-payment', confirmPaymentAuth, blockComptableWrite, csrfProtection, async (req, res) => {
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

    // Create invoice from order lines
    const invoiceRes = await dolibarrApi.post('/invoices', {
      socid: parseInt(order.socid),
      date: new Date().toISOString().split('T')[0],
      type: 0,
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

    // Validate the invoice
    await dolibarrApi.post(`/invoices/${invoiceId}/validate`);
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

// Rejeter un paiement
app.post('/api/admin/payments/:id/reject', paymentMgmtAuth, blockComptableWrite, csrfProtection, (req, res) => {
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
  }));
  console.log('[BOOKS] Book routes mounted');
} catch (err) {
  console.error('[BOOKS] Failed to mount book routes:', err);
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

// ─── COMPTABILITÉ MODULE ───────────────────────────────────
import { createAccountingRouter } from './accounting-routes.js';
try {
  const accountingAuth = adminAuth(db);
  app.use('/api/admin/accounting', createAccountingRouter({ db, dolibarrPool, cache, auth: accountingAuth }));
  console.log('[ACCOUNTING] Accounting routes mounted');
} catch (err) {
  console.error('[ACCOUNTING] Failed to mount accounting routes:', err);
}

// ─── STOCK & REAPPROVISIONNEMENT MODULE ─────────────────────
import { createStockRouter, createSuppliersRouter } from './stock-routes.js';
import { runDailyBatch, runClassificationBatch } from './stock-engine.js';
try {
  const stockAuth = adminAuth(db);
  app.use('/api/admin/stock', createStockRouter({ db, dolibarrPool, auth: stockAuth, csrfProtection }));
  app.use('/api/admin/suppliers', createSuppliersRouter({ db, auth: stockAuth, csrfProtection }));
  console.log('[STOCK] Stock & suppliers routes mounted');
} catch (err) {
  console.error('[STOCK] Failed to mount stock routes:', err);
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
      const conditions = ['p.entity = 1', 'p.fk_product_type = 0'];
      const params = [];

      if (q) {
        conditions.push('(p.label LIKE ? OR p.ref LIKE ? OR p.description LIKE ?)');
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
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
           AND c.label NOT IN ('LIBRAIRIE','LIVRES','Accueil','Services','Racine','Livres du mois','http://senharmattan.com/')
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
    if (q) {
      const safeQ = safeSqlFilter(q);
      apiParams.sqlfilters = `(t.label:like:'%${safeQ}%') or (t.ref:like:'%${safeQ}%')`;
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
            params: { sqlfilters: `(t.ref:=:'${safeSqlFilter(ref)}')`, limit: 1 },
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
          params: { limit: remaining + 10, page: 0, sortfield: 't.rowid', sortorder: 'DESC' },
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

// Livre du mois — products tagged via Dolibarr extrafield
app.get('/api/products/livre-du-mois', async (req, res) => {
  try {
    const cacheKey = 'products:livre-du-mois';
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // Fetch tagged product IDs from Dolibarr MySQL
    const products = [];
    const [rows] = await dolibarrPool.query(
      'SELECT fk_object FROM llx_product_extrafields WHERE livre_du_mois = 1'
    );

    const excludedCats = new Set([
      'LIBRAIRIE', 'LIVRES', 'Racine', 'Accueil', 'Services',
      'http://senharmattan.com/', 'Livres du mois',
    ]);

    for (const { fk_object: pid } of rows) {
      try {
        const prodRes = await dolibarrApi.get(`/products/${pid}`);
        const p = prodRes.data;

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

    let stockDetails = [];
    const sw = stockResult?.data?.stock_warehouses;
    if (sw && typeof sw === 'object' && !Array.isArray(sw)) {
      stockDetails = Object.entries(sw).map(([whId, s]) => ({
        warehouse_id: whId,
        quantity: parseFloat(s.real || 0),
      }));
    }

    const images = (docResult?.data || [])
      .filter((d) => /\.(jpg|jpeg|png|gif|webp)$/i.test(d.name) && !d.name.startsWith('default_cover'))
      .sort((a, b) => (/cover/i.test(a.name) ? -1 : 1) - (/cover/i.test(b.name) ? -1 : 1))
      .map((d) => ({
        name: d.name,
        url: `/api/image/${p.id}?file=${encodeURIComponent(d.name)}`,
        size: d.size,
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
app.get('/api/image/:productId', async (req, res) => {
  try {
    const productId = req.params.productId;
    const fileParam = req.query.file || '';
    const cacheKey = `imgdata:${productId}:${fileParam}`;

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      if (cached === 'none') return sendPlaceholder(res, req.query.title);
      res.set('Content-Type', cached.contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buffer);
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
      const realImages = images.filter((i) => !i.name.startsWith('default_cover'));
      img = realImages.find((i) => /cover/i.test(i.name)) || realImages[0] || images[0];
    }
    const ref = img.level1name || img.path.split('/').pop();

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
    const acceptsWebp = req.headers.accept?.includes('image/webp');

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
    cache.set(cacheKey, { buffer: optimized, contentType }, 7200);

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=604800, immutable'); // 7 days
    res.set('Vary', 'Accept');
    res.send(optimized);
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
      id: c.id,
      label: c.label,
      description: c.description,
      fk_parent: c.fk_parent,
      color: c.color,
    }));

    cache.set('categories:all', categories, 600); // cache 10 min
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

    // Use dolibarr_id if logged-in customer provided it, otherwise search/create
    let customerId = customer.dolibarr_id || null;

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
    const orderLines = items.map((item) => ({
      fk_product: parseInt(item.id),
      qty: item.quantity,
      subprice: parseFloat(item.price_ttc),
      tva_tx: 0,
      product_type: 0,
    }));

    const orderRes = await dolibarrApi.post('/orders', {
      socid: parseInt(customerId),
      date: new Date().toISOString().split('T')[0],
      lines: orderLines,
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

    res.json({
      success: true,
      order_id: orderId,
      order_ref: orderDetail.data.ref,
      payment_status: 'pending',
      total: orderDetail.data.total_ttc,
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
  app.use(express.static(distPath));
  app.get('{*path}', (req, res) => {
    // Don't intercept API routes
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(join(distPath, 'index.html'));
  });
}

// ─── HELPERS ────────────────────────────────────────────────

function getPaymentModeId(method) {
  // Aligné sur le POS : Wave=54 (compte 6), Orange Money=55 (compte 4)
  const modes = { virement: 2, cb: 6, orange_money: 55, wave: 54 };
  return modes[method] || 0;
}

// ─── START ──────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', async () => {
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
