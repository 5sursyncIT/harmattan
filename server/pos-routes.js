import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import 'dotenv/config';
import { dolibarrApi } from './dolibarr-client.js';
import { EXCLUDED_CATEGORIES_SET } from '../src/utils/excludedCategories.js';

// Dolibarr admin API key (for invoice/payment operations)
const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
if (!ADMIN_API_KEY) console.warn('[SECURITY] DOLIBARR_ADMIN_API_KEY non définie — le POS ne pourra pas facturer');
const adminApi = (await import('axios')).default.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  // Accept-Encoding: identity → Dolibarr/Apache renvoie des réponses NON compressées.
  // Sans ça, les grosses réponses (ex. détail d'une facture à 29 lignes) étaient
  // gzippées par Apache et axios échouait à les décompresser → « incorrect header
  // check » (zlib) → rollback de la vente. Réseau localhost : coût négligeable.
  headers: { 'DOLAPIKEY': ADMIN_API_KEY, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
  timeout: 30000,
});

// POS Configuration
const POS_CONFIG = {
  defaultTerminal: 3,
  warehouse: 4,           // Rayon
  defaultCustomer: 13,    // CLIENT LIBRAIRE
  receiptName: 'HARMATTAN',
};

// Authentification POS : la session est portée par un cookie HttpOnly (non
// lisible par du JavaScript — protège contre le vol de token via XSS),
// au lieu de localStorage. Marqué Secure dès que COOKIE_SECURE=true (HTTPS).
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const POS_SESSION_COOKIE = 'pos_session';
function posCookieOptions() {
  return {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'strict',
    path: '/api/pos',
    maxAge: 24 * 60 * 60 * 1000, // 24h — couvre largement le plafond de session
  };
}

// Extract terminal number from request (body or query), fallback to default
// Le terminal est lié à l'appareil enrôlé (req.posDevice) — il n'est plus
// piloté par le client. Repli sur la valeur transmise, puis le défaut.
function getTerminal(req) {
  const deviceTerminal = parseInt(req.posDevice?.terminal);
  if (deviceTerminal >= 1 && deviceTerminal <= 10) return deviceTerminal;
  const fallback = parseInt(req.body?.terminal || req.query?.terminal);
  return (fallback >= 1 && fallback <= 10) ? fallback : POS_CONFIG.defaultTerminal;
}

// Payment method → Dolibarr payment ID + bank account ID
// bankAccount = id du compte bancaire Dolibarr (config instance, non résoluble par code).
// paymentId = repli ; en pratique l'id réel est RÉSOLU dynamiquement par le code
// Dolibarr (llx_c_paiement.code) via resolvePaymentId — les ids codés en dur dérivent
// d'une instance à l'autre (ex. le chèque n'était pas l'id 7 ici → échec).
const PAYMENT_MAP = {
  LIQ:  { paymentId: 4,  bankAccount: 3,  label: 'Espèces' },
  CB:   { paymentId: 6,  bankAccount: 1,  label: 'Carte bancaire' },
  CHQ:  { paymentId: 7,  bankAccount: 1,  label: 'Chèque' },
  WAVE: { paymentId: 54, bankAccount: 6,  label: 'Wave' },
  OM:   { paymentId: 55, bankAccount: 4,  label: 'Orange Money' },
};

// Résout l'id Dolibarr du moyen de paiement à partir de son CODE (llx_c_paiement),
// avec cache mémoire et repli sur l'id codé en dur. Évite les échecs dus à des ids
// qui diffèrent entre instances Dolibarr (le code, lui, est stable : LIQ/CB/CHQ/WAVE/OM).
const _paymentIdCache = new Map();
async function resolvePaymentId(pool, code, fallback) {
  if (_paymentIdCache.has(code)) return _paymentIdCache.get(code);
  try {
    const [rows] = await pool.query(
      'SELECT id FROM llx_c_paiement WHERE code = ? AND active = 1 ORDER BY id LIMIT 1', [code]
    );
    const id = rows[0]?.id ? Number(rows[0].id) : null;
    if (id) { _paymentIdCache.set(code, id); return id; }
  } catch (e) {
    console.warn(`[POS] resolvePaymentId(${code}) échec, repli sur ${fallback}:`, e.message);
  }
  return fallback;
}

function normalizePaymentCode(code) {
  const raw = String(code || '').trim();
  const key = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  const aliases = {
    CASH: 'LIQ',
    ESPECES: 'LIQ',
    ESPECE: 'LIQ',
    LIQUIDE: 'LIQ',
    LIQ: 'LIQ',
    CARD: 'CB',
    CARTE: 'CB',
    CARTE_BANCAIRE: 'CB',
    CB: 'CB',
    CHECK: 'CHQ',
    CHEQUE: 'CHQ',
    CHQ: 'CHQ',
    ORANGE_MONEY: 'OM',
    ORANGEMONEY: 'OM',
    OM: 'OM',
    WAVE: 'WAVE',
  };
  return aliases[key] || key;
}

// Mutex asynchrone — sérialise une section critique (les appels passés à
// la fonction renvoyée s'exécutent un par un, dans l'ordre d'arrivée).
function createMutex() {
  let tail = Promise.resolve();
  return function lock(fn) {
    const result = tail.then(() => fn());
    tail = result.then(() => {}, () => {}); // la chaîne continue quel que soit le résultat
    return result;
  };
}

export function createPosRouter({ db, dolibarrPool, csrfProtection, safeSqlFilter }) {
  const router = Router();

  // Sérialise la section critique des ventes (vérif stock → création →
  // validation facture) pour empêcher deux caisses de survendre le même article.
  const saleMutex = createMutex();

  // ─── Rate Limiters ──────────────────────────────────────
  const pinLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 5,
    message: { error: 'Trop de tentatives, réessayez dans 5 minutes' },
    validate: { xForwardedForHeader: false },
  });

  const saleLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 120,
    message: { error: 'Limite de ventes atteinte' },
    validate: { xForwardedForHeader: false },
  });

  // Global PIN rate limit (all IPs combined)
  const globalPinLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: () => 'global-pos-pin',
    message: { error: 'Trop de tentatives, POS verrouillé pour 15 minutes' },
    validate: { xForwardedForHeader: false },
  });

  // Limite les tentatives d'enrôlement d'appareil (protège le code bootstrap).
  const enrollLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: "Trop de tentatives d'enrôlement, réessayez dans 15 minutes" },
    validate: { xForwardedForHeader: false },
  });

  // ─── Device Verification Middleware ────────────────────
  function requireDevice(req, res, next) {
    // Enrollment endpoint is exempt
    if (req.path === '/devices/enroll' && req.method === 'POST') return next();

    const deviceToken = req.headers['x-pos-device'];
    if (!deviceToken) {
      return res.status(403).json({ error: 'Appareil non enregistré', code: 'DEVICE_REQUIRED' });
    }

    const device = db.prepare('SELECT * FROM pos_devices WHERE device_token = ? AND active = 1').get(deviceToken);
    if (!device) {
      return res.status(403).json({ error: 'Appareil non reconnu ou révoqué', code: 'DEVICE_INVALID' });
    }

    db.prepare("UPDATE pos_devices SET last_seen_at = datetime('now'), last_ip = ? WHERE id = ?")
      .run(req.socket?.remoteAddress || 'unknown', device.id);

    req.posDevice = device;
    next();
  }

  router.use(requireDevice);

  // ─── POS Sessions Table ────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS pos_sessions (
    token TEXT PRIMARY KEY,
    staff_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  )`);
  // Plafond d'expiration absolu — la session ne survit jamais au-delà, même
  // avec l'expiration glissante. Idempotent : ignore si la colonne existe déjà.
  try { db.exec("ALTER TABLE pos_sessions ADD COLUMN absolute_expiry TEXT"); } catch { /* colonne déjà présente */ }
  db.prepare("DELETE FROM pos_sessions WHERE expires_at < datetime('now')").run();

  // Flag de configuration POS — sert notamment à rendre le code bootstrap
  // consommable une seule fois de façon permanente.
  db.exec("CREATE TABLE IF NOT EXISTS pos_meta (key TEXT PRIMARY KEY, value TEXT)");

  // Hache un token de session — le token n'est jamais stocké en clair.
  const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

  // ─── POS Sale Idempotency Table ────────────────────────
  // Déduplique les ventes : un même client_sale_id ne crée qu'une facture,
  // quel que soit le nombre de soumissions (double-clic, rejeu file offline,
  // réponse réseau perdue).
  // Idempotence retours/avoirs — pattern identique à `pos_sale_idempotency`
  // pour éviter qu'un double-clic UI ou un retry réseau crée deux avoirs.
  db.exec(`CREATE TABLE IF NOT EXISTS pos_return_idempotency (
    client_return_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.prepare("DELETE FROM pos_return_idempotency WHERE created_at < datetime('now', '-7 days')").run();

  db.exec(`CREATE TABLE IF NOT EXISTS pos_sale_idempotency (
    client_sale_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'processing',
    response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.prepare("DELETE FROM pos_sale_idempotency WHERE created_at < datetime('now', '-7 days')").run();

  // Réserve un client_sale_id pour traitement. Renvoie false s'il est déjà
  // réservé (double soumission concurrente). Une réservation périmée
  // (>2 min, requête morte) est récupérée.
  function claimSaleId(id) {
    db.prepare(
      "DELETE FROM pos_sale_idempotency WHERE client_sale_id = ? AND status = 'processing' AND created_at < datetime('now', '-2 minutes')"
    ).run(id);
    try {
      db.prepare("INSERT INTO pos_sale_idempotency (client_sale_id, status) VALUES (?, 'processing')").run(id);
      return true;
    } catch {
      return false;
    }
  }

  // Mirror de `claimSaleId` pour les retours.
  function claimReturnId(id) {
    db.prepare(
      "DELETE FROM pos_return_idempotency WHERE client_return_id = ? AND status = 'processing' AND created_at < datetime('now', '-2 minutes')",
    ).run(id);
    try {
      db.prepare("INSERT INTO pos_return_idempotency (client_return_id, status) VALUES (?, 'processing')").run(id);
      return true;
    } catch {
      return false;
    }
  }

  // Plus petit numéro de terminal (1-10) non encore attribué à un appareil.
  function nextFreeTerminal() {
    const used = new Set(
      db.prepare('SELECT DISTINCT terminal FROM pos_devices WHERE terminal IS NOT NULL').all().map(r => r.terminal)
    );
    for (let t = 1; t <= 10; t++) if (!used.has(t)) return t;
    return POS_CONFIG.defaultTerminal;
  }

  // Annule une vente échouée selon l'étape atteinte — ne laisse jamais de
  // facture validée impayée « fantôme » dans Dolibarr. Ne lève jamais d'erreur.
  async function rollbackSale(sale) {
    if (!sale.invoiceId) return; // rien n'a été créé dans Dolibarr
    const tag = sale.invoiceRef || `#${sale.invoiceId}`;

    // Cas 1 — facture restée au brouillon (échec avant/pendant validation).
    //         Aucun mouvement de stock : suppression directe.
    if (!sale.validated) {
      try {
        await adminApi.delete(`/invoices/${sale.invoiceId}`);
        console.error(`[POS ROLLBACK] Brouillon ${tag} supprimé`);
      } catch (e) {
        console.error(`[POS ROLLBACK] Échec suppression brouillon ${tag}:`, e.response?.data || e.message);
      }
      return;
    }

    // Cas 2 — facture validée, aucun paiement enregistré : retour au brouillon
    //         (restocke les articles) puis suppression. Aucune créance, aucune trace.
    if (sale.paymentsRecorded === 0) {
      try {
        await adminApi.post(`/invoices/${sale.invoiceId}/settodraft`, { idwarehouse: POS_CONFIG.warehouse });
        try {
          await adminApi.delete(`/invoices/${sale.invoiceId}`);
          console.error(`[POS ROLLBACK] Facture ${tag} annulée (brouillon + suppression)`);
        } catch (delErr) {
          // Suppression refusée : la facture reste un brouillon — pas une créance,
          // stock déjà restitué. Acceptable, à purger manuellement si besoin.
          console.error(`[POS ROLLBACK] Facture ${tag} repassée en brouillon, non supprimée:`, delErr.response?.data || delErr.message);
        }
      } catch (e) {
        console.error(`[POS ROLLBACK] CRITIQUE: échec annulation facture ${tag}:`, e.response?.data || e.message);
      }
      return;
    }

    // Cas 3 — facture validée AVEC paiement(s) déjà enregistré(s). Impossible
    //         de la supprimer : on crée un avoir (restocke + neutralise la
    //         compta) et on sort la facture des créances (classée « abandonnée »).
    try {
      const creditRes = await adminApi.post('/invoices', {
        socid: parseInt(sale.socid),
        date: new Date().toISOString().split('T')[0],
        type: 2,
        fk_facture_source: sale.invoiceId,
        module_source: 'takepos',
        pos_source: String(sale.terminal),
        lines: sale.lines || [], // qty/subprice positifs — Dolibarr applique le signe avoir via type:2
        note_private: `AVOIR AUTO - Échec paiement ${tag} | POS T${sale.terminal}`,
      });
      await adminApi.post(`/invoices/${creditRes.data}/validate`, { idwarehouse: POS_CONFIG.warehouse });
      try {
        await adminApi.post(`/invoices/${sale.invoiceId}/settopaid`, {
          close_code: 'abandon',
          close_note: `Vente POS annulée — avoir automatique ${tag}`,
        });
      } catch (closeErr) {
        console.error(`[POS ROLLBACK] Avoir créé mais facture ${tag} non classée:`, closeErr.response?.data || closeErr.message);
      }
      console.error(`[POS ROLLBACK] Avoir créé pour ${tag} (paiement partiel — remboursement à vérifier)`);
    } catch (e) {
      console.error(`[POS ROLLBACK] CRITIQUE: échec avoir pour ${tag}:`, e.response?.data || e.message);
    }
  }

  // Quantités déjà retournées par produit pour une facture donnée (somme des
  // lignes des avoirs validés rattachés à cette facture via fk_facture_source).
  async function getReturnedQuantities(invoiceId) {
    const [rows] = await dolibarrPool.query(
      `SELECT fd.fk_product, SUM(ABS(fd.qty)) AS returned
       FROM llx_facturedet fd
       JOIN llx_facture f ON f.rowid = fd.fk_facture
       WHERE f.fk_facture_source = ? AND f.type = 2 AND f.fk_statut <> 0
       GROUP BY fd.fk_product`,
      [invoiceId]
    );
    const map = {};
    for (const r of rows) {
      if (r.fk_product != null) map[r.fk_product] = parseFloat(r.returned) || 0;
    }
    return map;
  }

  // Add pin_expires_at column if missing
  try { db.exec('ALTER TABLE pos_staff ADD COLUMN pin_expires_at DATETIME'); } catch (err) { console.warn('Column pin_expires_at already exists or error:', err.message); }
  // Set default expiry for staff without one (15 days from now)
  db.prepare("UPDATE pos_staff SET pin_expires_at = datetime('now', '+15 days') WHERE pin_expires_at IS NULL").run();

  // Lier chaque appareil à un numéro de terminal (choisi par le manager à la
  // génération du code, ou auto-assigné en repli).
  try { db.exec('ALTER TABLE pos_devices ADD COLUMN terminal INTEGER'); } catch { /* colonne déjà présente */ }
  try { db.exec('ALTER TABLE pos_enrollment_codes ADD COLUMN terminal INTEGER'); } catch { /* colonne déjà présente */ }
  // Migration : attribuer un terminal aux appareils qui n'en ont pas.
  for (const d of db.prepare('SELECT id FROM pos_devices WHERE terminal IS NULL ORDER BY id').all()) {
    db.prepare('UPDATE pos_devices SET terminal = ? WHERE id = ?').run(nextFreeTerminal(), d.id);
  }

  // Liste des terminaux 1..10 avec leur occupation (appareil actif).
  function listTerminalsSlots() {
    const max = 10;
    const rows = db.prepare(
      'SELECT id, device_name, terminal, active FROM pos_devices WHERE terminal IS NOT NULL ORDER BY terminal ASC'
    ).all();
    const byTerminal = new Map();
    for (const r of rows) {
      if (r.active === 1) byTerminal.set(r.terminal, r); // un terminal actif gagne
      else if (!byTerminal.has(r.terminal)) byTerminal.set(r.terminal, r);
    }
    const slots = [];
    for (let t = 1; t <= max; t++) {
      const d = byTerminal.get(t);
      slots.push({
        terminal: t,
        free: !d || d.active === 0,
        device_id: d?.id ?? null,
        device_name: d?.device_name ?? null,
        device_active: d?.active === 1,
      });
    }
    return slots;
  }

  // ─── POS Auth Middleware ────────────────────────────────
  function requirePosAuth(req, res, next) {
    // Cookie HttpOnly en priorité ; en-tête X-POS-Token gardé en repli le temps
    // que les postes encore sur l'ancien build se reconnectent.
    const token = req.cookies?.[POS_SESSION_COOKIE] || req.headers['x-pos-token'];
    if (!token) return res.status(401).json({ error: 'Authentification POS requise' });
    // Le token n'est stocké que haché — on cherche par empreinte.
    const tokenHash = hashToken(token);
    const session = db.prepare(
      "SELECT ps.staff_id, s.id, s.name, s.role, s.dolibarr_user_id FROM pos_sessions ps JOIN pos_staff s ON s.id = ps.staff_id WHERE ps.token = ? AND ps.expires_at > datetime('now') AND (ps.absolute_expiry IS NULL OR ps.absolute_expiry > datetime('now')) AND s.active = 1"
    ).get(tokenHash);
    if (!session) return res.status(401).json({ error: 'Session POS expirée' });
    req.posStaff = { id: session.id, name: session.name, role: session.role, dolibarr_user_id: session.dolibarr_user_id };
    // Expiration glissante : prolonge expires_at de 24h — mais JAMAIS
    // absolute_expiry, qui plafonne la durée de vie totale de la session.
    db.prepare("UPDATE pos_sessions SET expires_at = datetime('now', '+24 hours') WHERE token = ?").run(tokenHash);
    next();
  }

  // ═══════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════

  router.post('/auth/login', globalPinLimiter, pinLimiter, csrfProtection, (req, res) => {
    try {
      const { pin } = req.body;
      // PIN strictement numérique de 6 chiffres — contre le brute-force.
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return res.status(400).json({ error: 'PIN invalide (6 chiffres requis)' });
      }

      const staffList = db.prepare('SELECT * FROM pos_staff WHERE active = 1').all();
      for (const s of staffList) {
        if (bcrypt.compareSync(pin, s.pin)) {
          // Check PIN expiry
          const pinExpired = s.pin_expires_at && new Date(s.pin_expires_at) < new Date();
          // Token brut renvoyé au client, mais seul son hachage est stocké.
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h glissantes
          db.prepare("INSERT INTO pos_sessions (token, staff_id, expires_at, absolute_expiry) VALUES (?, ?, ?, datetime('now', '+12 hours'))")
            .run(hashToken(token), s.id, expiresAt);
          // Session déposée dans un cookie HttpOnly — non exposée au JavaScript.
          res.cookie(POS_SESSION_COOKIE, token, posCookieOptions());
          return res.json({ id: s.id, name: s.name, role: s.role, token, pin_expired: pinExpired });
        }
      }

      res.status(401).json({ error: 'PIN incorrect' });
    } catch (err) {
      console.error('POS login error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // Change PIN
  router.put('/auth/change-pin', pinLimiter, requirePosAuth, csrfProtection, (req, res) => {
    try {
      const { currentPin, newPin } = req.body;
      // Exactement 6 chiffres — doit correspondre au format accepté au login
      // (/^\d{6}$/) ; un PIN plus long verrouillerait le caissier.
      if (typeof newPin !== 'string' || !/^\d{6}$/.test(newPin)) {
        return res.status(400).json({ error: 'Le nouveau PIN doit contenir exactement 6 chiffres' });
      }

      const staff = db.prepare('SELECT * FROM pos_staff WHERE id = ?').get(req.posStaff.id);
      if (!staff || !bcrypt.compareSync(currentPin, staff.pin)) {
        return res.status(401).json({ error: 'PIN actuel incorrect' });
      }

      const hash = bcrypt.hashSync(newPin, 10);
      const newExpiry = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare('UPDATE pos_staff SET pin = ?, pin_expires_at = ? WHERE id = ?').run(hash, newExpiry, staff.id);

      res.json({ success: true, pin_expires_at: newExpiry });
    } catch (err) {
      console.error('Change PIN error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  router.post('/auth/logout', csrfProtection, (req, res) => {
    const token = req.cookies?.[POS_SESSION_COOKIE] || req.headers['x-pos-token'];
    if (token) db.prepare('DELETE FROM pos_sessions WHERE token = ?').run(hashToken(token));
    res.clearCookie(POS_SESSION_COOKIE, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'strict', path: '/api/pos' });
    res.json({ ok: true });
  });

  // ═══════════════════════════════════════════════════════
  // PRODUCT SEARCH (MySQL direct for speed)
  // ═══════════════════════════════════════════════════════

  router.get('/products/search', requirePosAuth, async (req, res) => {
    try {
      const { q = '', category, limit = 50 } = req.query;
      const params = [];
      let where = 'WHERE p.tosell = 1';

      if (q.trim()) {
        where += ' AND (p.ref LIKE ? OR p.label LIKE ? OR p.barcode LIKE ?)';
        const term = `%${q.trim()}%`;
        params.push(term, term, term);
      }

      if (category) {
        where += ` AND p.rowid IN (
          SELECT fk_product FROM llx_categorie_product WHERE fk_categorie = ?
        )`;
        params.push(parseInt(category));
      }

      params.push(Math.min(parseInt(limit) || 50, 100));

      const [rows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.label, p.price_ttc, p.barcode,
                COALESCE(ps.reel, 0) AS stock_reel
         FROM llx_product p
         LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = ${POS_CONFIG.warehouse}
         ${where}
         ORDER BY p.label ASC
         LIMIT ?`,
        params
      );

      res.json(rows);
    } catch (err) {
      console.error('POS search error:', err);
      res.status(500).json({ error: 'Erreur recherche' });
    }
  });

  router.get('/products/barcode/:code', requirePosAuth, async (req, res) => {
    try {
      const code = req.params.code.trim();
      const [rows] = await dolibarrPool.query(
        `SELECT p.rowid AS id, p.ref, p.label, p.price_ttc, p.barcode,
                COALESCE(ps.reel, 0) AS stock_reel
         FROM llx_product p
         LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = ${POS_CONFIG.warehouse}
         WHERE p.ref = ? OR p.barcode = ?
         LIMIT 1`,
        [code, code]
      );

      if (rows.length === 0) return res.status(404).json({ error: 'Produit non trouvé' });
      res.json(rows[0]);
    } catch (err) {
      console.error('POS barcode error:', err);
      res.status(500).json({ error: 'Erreur lecture code-barres' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // DEVICE MANAGEMENT
  // ═══════════════════════════════════════════════════════

  // Enroll device (no auth required — needs valid enrollment code or bootstrap code)
  router.post('/devices/enroll', enrollLimiter, csrfProtection, (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'Code requis' });

      const upperCode = code.toUpperCase().trim();

      // Check bootstrap code first (for first device ever)
      const bootstrapCode = process.env.POS_BOOTSTRAP_CODE;
      let deviceName = 'Terminal principal';

      let usedBootstrap = false;
      if (bootstrapCode && upperCode === bootstrapCode.toUpperCase()) {
        // Le code bootstrap n'est consommable qu'UNE SEULE FOIS de façon
        // permanente — un flag persistant le neutralise après usage, quel que
        // soit le nombre d'appareils actifs (révocation totale incluse).
        const bootstrapUsed = db.prepare("SELECT value FROM pos_meta WHERE key = 'bootstrap_used'").get();
        if (bootstrapUsed && bootstrapUsed.value === '1') {
          return res.status(403).json({ error: "Code bootstrap déjà utilisé et définitivement désactivé. Demandez un code d'enrôlement à un manager." });
        }
        deviceName = String(req.body.device_name || '').trim().slice(0, 60) || 'Terminal principal';
        usedBootstrap = true;
      }

      let presetTerminal = null;
      if (!usedBootstrap) {
        // Normal enrollment via generated code
        const enrollment = db.prepare(
          "SELECT * FROM pos_enrollment_codes WHERE code = ? AND used = 0 AND expires_at > datetime('now')"
        ).get(upperCode);

        if (!enrollment) return res.status(400).json({ error: 'Code invalide ou expiré' });

        // Le nom saisi sur l'appareil au moment de l'enrôlement PRIME (personnalisation
        // par l'opérateur) ; à défaut on retombe sur le nom porté par le code, puis
        // sur un libellé générique. Sans ça, le nom tapé sur l'appareil était ignoré
        // et tous les appareils héritaient du défaut « Nouveau POS » du code.
        const providedName = String(req.body.device_name || '').trim().slice(0, 60);
        deviceName = providedName || enrollment.device_name || 'Nouveau POS';
        presetTerminal = enrollment.terminal || null;
        db.prepare('UPDATE pos_enrollment_codes SET used = 1 WHERE code = ?').run(upperCode);
      }

      const deviceToken = crypto.randomBytes(64).toString('hex');
      // Terminal demandé par le manager s'il est encore libre, sinon repli auto.
      let terminal = nextFreeTerminal();
      if (presetTerminal) {
        const conflict = db.prepare(
          'SELECT id FROM pos_devices WHERE terminal = ? AND active = 1'
        ).get(presetTerminal);
        if (!conflict) terminal = presetTerminal;
      }
      db.prepare('INSERT INTO pos_devices (device_token, device_name, last_ip, terminal) VALUES (?, ?, ?, ?)')
        .run(deviceToken, deviceName, req.socket?.remoteAddress || 'unknown', terminal);

      // Enrôlement bootstrap réussi — neutralise définitivement le code bootstrap.
      if (usedBootstrap) {
        db.prepare("INSERT OR REPLACE INTO pos_meta (key, value) VALUES ('bootstrap_used', '1')").run();
      }

      res.json({ device_token: deviceToken, device_name: deviceName, terminal });
    } catch (err) {
      console.error('Device enrollment error:', err.message);
      res.status(500).json({ error: 'Erreur enregistrement appareil' });
    }
  });

  // Generate enrollment code (manager only)
  router.post('/devices/generate-code', requirePosAuth, csrfProtection, (req, res) => {
    if (req.posStaff.role !== 'manager') {
      return res.status(403).json({ error: 'Seul un manager peut enregistrer un appareil' });
    }

    const { device_name, terminal } = req.body;
    if (!device_name?.trim()) return res.status(400).json({ error: "Nom d'appareil requis" });

    let chosenTerminal = null;
    if (terminal != null && terminal !== '') {
      const t = parseInt(terminal);
      if (isNaN(t) || t < 1 || t > 10) return res.status(400).json({ error: 'Terminal invalide (1-10)' });
      const conflict = db.prepare('SELECT id, device_name FROM pos_devices WHERE terminal = ? AND active = 1').get(t);
      if (conflict) return res.status(409).json({ error: `Terminal ${t} déjà attribué à « ${conflict.device_name} ». Révoquez-le d'abord.` });
      chosenTerminal = t;
    }

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('INSERT INTO pos_enrollment_codes (code, created_by, device_name, expires_at, terminal) VALUES (?, ?, ?, ?, ?)')
      .run(code, req.posStaff.id, device_name.trim(), expiresAt, chosenTerminal);

    res.json({ code, expires_in: 600, device_name: device_name.trim(), terminal: chosenTerminal });
  });

  // Liste des slots terminaux (1..10) avec leur occupation. Tout caissier
  // authentifié peut consulter (lecture seule, sert au sélecteur de terminal
  // de l'écran d'ouverture de caisse + à la modal manager d'enrôlement).
  router.get('/devices/terminals', requirePosAuth, (req, res) => {
    res.json(listTerminalsSlots());
  });

  // Réassigner le terminal d'un appareil existant.
  // Tout caissier authentifié peut réassigner SON appareil (celui sur lequel il
  // est connecté). Un manager peut réassigner n'importe quel appareil.
  router.patch('/devices/:id/terminal', requirePosAuth, csrfProtection, (req, res) => {
    const id = parseInt(req.params.id);
    const t = parseInt(req.body?.terminal);
    if (!id || isNaN(t) || t < 1 || t > 10) return res.status(400).json({ error: 'Paramètres invalides' });

    const device = db.prepare('SELECT id, device_name, terminal, active FROM pos_devices WHERE id = ?').get(id);
    if (!device) return res.status(404).json({ error: 'Appareil introuvable' });

    // Non-manager : restreint à son propre appareil
    if (req.posStaff.role !== 'manager' && req.posDevice?.id !== device.id) {
      return res.status(403).json({ error: 'Vous ne pouvez réassigner que votre propre appareil' });
    }

    const conflict = db.prepare('SELECT id, device_name FROM pos_devices WHERE terminal = ? AND active = 1 AND id != ?').get(t, id);
    if (conflict) return res.status(409).json({ error: `Terminal ${t} déjà attribué à « ${conflict.device_name} »` });

    // Refuse le swap si l'appareil a une session en cours côté Dolibarr — sinon
    // les ventes/clôture seraient comptées sur le mauvais terminal.
    (async () => {
      try {
        const [open] = await dolibarrPool.query(
          "SELECT rowid FROM llx_pos_cash_fence WHERE posnumber = ? AND posmodule = 'takepos' AND status = 0",
          [String(device.terminal)],
        );
        if (open.length > 0) {
          return res.status(409).json({ error: 'Session de caisse encore ouverte sur ce terminal — clôturez avant de changer.' });
        }
        db.prepare('UPDATE pos_devices SET terminal = ? WHERE id = ?').run(t, id);
        res.json({ success: true, id, terminal: t });
      } catch (err) {
        console.error('Reassign terminal error:', err.message);
        res.status(500).json({ error: 'Erreur réassignation terminal' });
      }
    })();
  });

  // List devices (manager only)
  router.get('/devices', requirePosAuth, (req, res) => {
    if (req.posStaff.role !== 'manager') return res.status(403).json({ error: 'Accès manager requis' });
    const devices = db.prepare('SELECT id, device_name, terminal, last_seen_at, last_ip, active, created_at FROM pos_devices ORDER BY created_at DESC').all();
    res.json(devices);
  });

  // Revoke device (manager only)
  router.delete('/devices/:id', requirePosAuth, csrfProtection, (req, res) => {
    if (req.posStaff.role !== 'manager') return res.status(403).json({ error: 'Accès manager requis' });
    db.prepare('UPDATE pos_devices SET active = 0 WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // ═══════════════════════════════════════════════════════
  // CATEGORIES
  // ═══════════════════════════════════════════════════════

  const EXCLUDED_CATEGORIES = EXCLUDED_CATEGORIES_SET;

  router.get('/categories', requirePosAuth, async (req, res) => {
    try {
      const response = await dolibarrApi.get('/categories', {
        params: { type: 'product', sortfield: 't.label', sortorder: 'ASC', limit: 200 },
      });
      const categories = (response.data || [])
        .filter(c => !EXCLUDED_CATEGORIES.has(c.label) && parseInt(c.visible) === 1)
        .map(c => ({ id: parseInt(c.id, 10), label: c.label, description: c.description || '' }));
      res.json(categories);
    } catch (err) {
      console.error('POS categories error:', err.message);
      res.status(500).json({ error: 'Erreur catégories' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // CUSTOMER SEARCH
  // ═══════════════════════════════════════════════════════

  router.get('/customers/search', requirePosAuth, async (req, res) => {
    try {
      const q = String(req.query?.q || '').trim();
      if (q.length < 2) return res.json([]);

      // 1) Recherche Dolibarr llx_societe directement (couvre clients, prospects,
      //    fournisseurs, auteurs déjà liés à un tier). Pas de filtre client/fournisseur
      //    — le POS doit pouvoir encaisser n'importe quel tier.
      const pat = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      const [dolRows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom AS name, email, phone, client, fournisseur
           FROM llx_societe
          WHERE status = 1
            AND (nom LIKE ? OR name_alias LIKE ? OR email LIKE ? OR phone LIKE ?)
          ORDER BY nom ASC
          LIMIT 15`,
        [pat, pat, pat, pat],
      );

      // 2) Recherche auteurs locaux (table SQLite `authors`). Couvre les auteurs
      //    sans tier Dolibarr (registrés mais sans contrat encore généré).
      const authorRows = db.prepare(
        `SELECT id AS author_id, firstname, lastname, email, phone, dolibarr_thirdparty_id
           FROM authors
          WHERE firstname LIKE ?
             OR lastname LIKE ?
             OR (firstname || ' ' || lastname) LIKE ?
             OR email LIKE ?
             OR phone LIKE ?
          ORDER BY lastname, firstname
          LIMIT 15`,
      ).all(pat, pat, pat, pat, pat);

      // 3) Fusion : on évite les doublons (auteur déjà présent dans Dolibarr).
      const linkedTierIds = new Set(
        authorRows.filter((a) => a.dolibarr_thirdparty_id).map((a) => a.dolibarr_thirdparty_id),
      );
      const dolFmt = dolRows.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email || null,
        phone: c.phone || null,
        source: linkedTierIds.has(c.id) ? 'author' : 'client',
      }));
      const authorOnly = authorRows
        .filter((a) => !a.dolibarr_thirdparty_id)
        .map((a) => ({
          id: null,
          author_id: a.author_id,
          name: `${a.firstname || ''} ${a.lastname || ''}`.trim(),
          email: a.email || null,
          phone: a.phone || null,
          source: 'author_pending', // pas encore de tier Dolibarr — sera créé à la sélection
        }));

      res.json([...dolFmt, ...authorOnly].slice(0, 20));
    } catch (err) {
      console.error('POS customer search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche client' });
    }
  });

  // Promeut un auteur local sans tier Dolibarr en client POS. Idempotent :
  // si l'auteur est déjà lié, retourne simplement les infos du tier.
  router.post('/customers/from-author/:id', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const authorId = parseInt(req.params.id);
      if (!authorId) return res.status(400).json({ error: 'ID auteur invalide' });

      const author = db.prepare(
        'SELECT id, email, firstname, lastname, phone, dolibarr_thirdparty_id FROM authors WHERE id = ?',
      ).get(authorId);
      if (!author) return res.status(404).json({ error: 'Auteur introuvable' });

      // Déjà lié à un tier Dolibarr → on récupère + on renvoie.
      if (author.dolibarr_thirdparty_id) {
        const [[tier]] = await dolibarrPool.query(
          'SELECT rowid AS id, nom AS name, email, phone FROM llx_societe WHERE rowid = ?',
          [author.dolibarr_thirdparty_id],
        );
        if (tier) return res.json({ id: tier.id, name: tier.name, email: tier.email, phone: tier.phone });
        // Le tier a été supprimé côté Dolibarr — on recrée ci-dessous.
      }

      // Création d'un tier Dolibarr client à partir des infos auteur.
      const fullName = `${author.firstname || ''} ${author.lastname || ''}`.trim() || `Auteur #${authorId}`;
      const created = await adminApi.post('/thirdparties', {
        name: fullName,
        email: author.email || '',
        phone: author.phone || '',
        client: 1,
        code_client: -1,
      });
      const newId = parseInt(created.data);

      db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ?').run(newId, authorId);

      res.json({ id: newId, name: fullName, email: author.email || null, phone: author.phone || null });
    } catch (err) {
      console.error('POS from-author error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur création client à partir de l\'auteur' });
    }
  });

  // Create a new customer in Dolibarr
  router.post('/customers', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { name, phone, email } = req.body;
      if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Nom requis (2 caractères min.)' });

      const customerRes = await adminApi.post('/thirdparties', {
        name: name.trim(),
        phone: phone || '',
        email: email || '',
        client: 1,   // Mark as customer
        code_client: -1, // Auto-generate
      });

      const newId = customerRes.data;
      const detail = await adminApi.get(`/thirdparties/${newId}`);

      res.json({
        id: detail.data.id,
        name: detail.data.name || detail.data.nom,
        email: detail.data.email,
        phone: detail.data.phone,
      });
    } catch (err) {
      console.error('POS create customer error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur création client' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // SALE (Invoice + Payment + Stock)
  // ═══════════════════════════════════════════════════════

  router.post('/sales', requirePosAuth, saleLimiter, csrfProtection, async (req, res) => {
    // État de la vente — suivi pour permettre un rollback ciblé en cas d'échec.
    const sale = { invoiceId: null, invoiceRef: null, validated: false, paymentsRecorded: 0, lines: null, socid: null, terminal: null };
    try {
      const { items, customer_id, payments, note, client_sale_id, unpaid } = req.body;
      const terminal = getTerminal(req);

      if (!items?.length) return res.status(400).json({ error: 'Aucun article' });
      // Facture à crédit (impayée) : aucun paiement requis, MAIS un client identifié
      // est obligatoire pour attribuer la créance (pas le client comptoir par défaut).
      if (!unpaid && !payments?.length) return res.status(400).json({ error: 'Aucun paiement' });
      if (unpaid && (!customer_id || parseInt(customer_id) === POS_CONFIG.defaultCustomer)) {
        return res.status(400).json({ error: 'Sélectionnez un client identifié pour émettre une facture à crédit (impayée).' });
      }
      if (client_sale_id && (typeof client_sale_id !== 'string' || client_sale_id.length > 64)) {
        return res.status(400).json({ error: 'client_sale_id invalide' });
      }

      // Valider chaque article. Deux cas :
      // - is_free === true : ligne libre saisie par le caissier (pas de fk_product)
      //   → label (1-200 chars), subprice entier strict > 0, < 10M, qty bornée
      // - sinon : product_id entier > 0 (lookup côté serveur pour prix de confiance)
      for (const item of items) {
        const qty = item?.qty;
        if (!Number.isInteger(qty) || qty < 1 || qty > 1000) {
          return res.status(400).json({ error: `Quantité invalide pour l'article ${item?.label || item?.product_id} (entier entre 1 et 1000 requis)` });
        }
        if (item?.is_free === true) {
          const lbl = String(item?.label || '').trim();
          if (!lbl || lbl.length > 200) {
            return res.status(400).json({ error: `Libellé du produit libre invalide (1-200 caractères)` });
          }
          const sp = parseInt(item?.subprice ?? item?.price_ttc);
          if (!Number.isInteger(sp) || sp <= 0 || sp > 10_000_000) {
            return res.status(400).json({ error: `Prix du produit libre invalide (${lbl})` });
          }
        } else {
          const pid = parseInt(item?.product_id);
          if (!Number.isInteger(pid) || pid <= 0) {
            return res.status(400).json({ error: `Article invalide : product_id manquant ou incorrect` });
          }
          // Override de prix : autorisé uniquement avec un motif (3-200 caractères).
          // Le prix override est validé contre les mêmes bornes que les produits libres.
          if (item?.price_override_reason || item?.price_original != null) {
            const op = parseInt(item?.price_ttc);
            if (!Number.isInteger(op) || op <= 0 || op > 10_000_000) {
              return res.status(400).json({ error: `Prix modifié invalide pour l'article ${item?.label || pid}` });
            }
            const r = String(item?.price_override_reason || '').trim();
            if (r.length < 3 || r.length > 200) {
              return res.status(400).json({ error: `Motif de modification de prix requis (3-200 caractères) pour ${item?.label || pid}` });
            }
          }
        }
      }

      // Séparation : items référencés (lookup prix serveur, vérif stock) vs items libres.
      const productItems = items.filter((i) => !i.is_free);
      const freeItems = items.filter((i) => i.is_free === true);

      // Idempotence : une vente déjà finalisée pour ce client_sale_id est
      // rejouée à l'identique (double soumission, resynchro offline) au lieu
      // de créer une nouvelle facture.
      if (client_sale_id) {
        const done = db.prepare(
          "SELECT response FROM pos_sale_idempotency WHERE client_sale_id = ? AND status = 'done'"
        ).get(client_sale_id);
        if (done) return res.json({ ...JSON.parse(done.response), idempotent_replay: true });
      }

      // 0a. Récupère le VRAI prix unitaire côté serveur depuis llx_product —
      //     le price_ttc envoyé par le client est totalement ignoré (sinon le
      //     client pourrait facturer un article à n'importe quel prix).
      //     Skip si seuls des produits libres : ils portent leur propre prix saisi.
      const productIds = productItems.map(i => parseInt(i.product_id));
      const priceMap = {};
      if (productIds.length > 0) {
        const pricePlaceholders = productIds.map(() => '?').join(',');
        const [priceRows] = await dolibarrPool.query(
          `SELECT p.rowid AS id, p.price_ttc, p.label
           FROM llx_product p
           WHERE p.rowid IN (${pricePlaceholders})`,
          productIds
        );
        for (const r of priceRows) {
          priceMap[r.id] = { price_ttc: parseFloat(r.price_ttc) || 0, label: r.label };
        }
        const unknownProduct = productItems.find(i => !priceMap[parseInt(i.product_id)]);
        if (unknownProduct) {
          return res.status(400).json({ error: `Produit introuvable : ${unknownProduct.label || unknownProduct.product_id}` });
        }
      }

      // 0b. Normalize + validate payment methods before any Dolibarr write.
      // An unknown code used to be counted in paidSum but skipped during payment
      // creation, leaving a validated invoice with no linked payment.
      const normalizedPayments = (payments || []).map((p) => ({
        ...p,
        code: normalizePaymentCode(p.code),
      }));
      const unknownPayments = normalizedPayments.filter((p) => !PAYMENT_MAP[p.code]);
      if (unknownPayments.length > 0) {
        return res.status(400).json({
          error: `Moyen de paiement POS inconnu : ${unknownPayments.map((p) => p.code || '?').join(', ')}`,
        });
      }

      // 0c. Verify the payments cover the sale total — server-side recompute
      //     (XOF = no decimals, tva 0) à partir des prix DE CONFIANCE. Rejected
      //     before any Dolibarr write, so an under-paid sale never produces an
      //     orphan invoice.
      // Helper : prix effectif d'une ligne (override accepté si motif fourni
      // côté validation, sinon prix catalogue serveur).
      const effectivePrice = (item) => {
        if (item.is_free) return parseInt(item.subprice ?? item.price_ttc);
        const r = String(item.price_override_reason || '').trim();
        if (r.length >= 3) return parseInt(item.price_ttc);
        return priceMap[parseInt(item.product_id)].price_ttc;
      };
      const expectedTotal = items.reduce((sum, item) => {
        const price = effectivePrice(item);
        const disc = parseFloat(item.discount) || 0;
        return sum + Math.round(price * item.qty * (1 - disc / 100));
      }, 0);
      const paidSum = normalizedPayments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      // Contrôle de couverture ignoré pour une facture à crédit (paidSum = 0 attendu).
      if (!unpaid && paidSum + 1 < expectedTotal) {
        return res.status(400).json({
          error: `Paiement insuffisant : ${Math.round(paidSum)} FCFA reçus pour ${expectedTotal} FCFA dûs`,
        });
      }

      // Réserve le client_sale_id — l'INSERT atomique bloque une double
      // soumission concurrente avant toute écriture dans Dolibarr.
      if (client_sale_id && !claimSaleId(client_sale_id)) {
        return res.status(409).json({ error: 'Vente déjà en cours de traitement', code: 'SALE_IN_PROGRESS' });
      }

      const socid = customer_id || POS_CONFIG.defaultCustomer;
      const today = new Date().toISOString().split('T')[0];
      sale.socid = socid;
      sale.terminal = terminal;

      // subprice = prix unitaire DE CONFIANCE (côté serveur) pour les produits
      // référencés. Pour les lignes libres, le subprice provient du body (validé
      // ci-dessus : entier 1..10M).
      // Trace les overrides de prix appliqués (pour la note de facture et
      // l'audit log) — seuls les overrides validés (motif fourni) atterrissent ici.
      const priceOverrides = [];
      const lines = items.map((item) => {
        if (item.is_free) {
          return {
            fk_product: null,
            qty: item.qty,
            subprice: parseInt(item.subprice ?? item.price_ttc),
            tva_tx: 0,
            product_type: 0,
            remise_percent: item.discount || 0,
            desc: String(item.label).trim().slice(0, 200),
            label: String(item.label).trim().slice(0, 200),
          };
        }
        const pid = parseInt(item.product_id);
        const catalogPrice = priceMap[pid].price_ttc;
        const reason = String(item.price_override_reason || '').trim();
        const subprice = reason.length >= 3 ? parseInt(item.price_ttc) : catalogPrice;
        if (reason.length >= 3 && subprice !== catalogPrice) {
          priceOverrides.push({ pid, label: priceMap[pid].label, from: catalogPrice, to: subprice, reason });
        }
        return {
          fk_product: pid,
          qty: item.qty,
          subprice,
          tva_tx: 0,
          product_type: 0,
          remise_percent: item.discount || 0,
        };
      });
      sale.lines = lines;

      // 1+2. Section critique sérialisée (saleMutex) : vérification du stock,
      //      création puis validation de la facture sont atomiques — aucune
      //      autre vente ne peut s'intercaler et survendre le même article.
      let stockError = null;
      await saleMutex(async () => {
        // 0. Verify stock availability (under lock). Lignes libres ignorées
        //    (pas de fk_product → pas de stock). Skip entièrement si aucun
        //    produit référencé dans le ticket.
        if (productIds.length > 0) {
          const placeholders = productIds.map(() => '?').join(',');
          // On contrôle DEUX stocks :
          //  - le stock RÉEL de l'entrepôt Rayon (ce qu'on peut physiquement vendre)
          //  - le cache GLOBAL llx_product.stock, car c'est CE champ que Dolibarr
          //    vérifie à la création de facture (STOCK_MUST_BE_ENOUGH_FOR_INVOICE=1).
          //    Sans ce 2e contrôle, un cache désynchronisé (stock réel OK mais cache 0)
          //    laissait passer la vente puis Dolibarr la rejetait avec un 500 opaque.
          const [stockRows] = await dolibarrPool.query(
            `SELECT p.rowid AS fk_product, p.label, p.stock AS global_stock,
                    COALESCE(ps.reel, 0) AS wh_stock
             FROM llx_product p
             LEFT JOIN llx_product_stock ps ON ps.fk_product = p.rowid AND ps.fk_entrepot = ${POS_CONFIG.warehouse}
             WHERE p.rowid IN (${placeholders})`,
            productIds
          );
          const stockMap = Object.fromEntries(stockRows.map(r => [r.fk_product, {
            // disponible = le plus contraignant des deux (rayon réel vs cache global)
            stock: Math.min(Number(r.wh_stock), Number(r.global_stock)),
            label: r.label,
          }]));
          const outOfStock = productItems.filter(i => {
            const s = stockMap[parseInt(i.product_id)];
            return !s || s.stock < i.qty;
          });
          if (outOfStock.length > 0) {
            const names = outOfStock.map(i => {
              const s = stockMap[parseInt(i.product_id)];
              return `${i.label} (demandé: ${i.qty}, dispo: ${Math.max(0, s?.stock ?? 0)})`;
            });
            stockError = `Stock insuffisant: ${names.join(', ')}`;
            return;
          }
        }

        // Note privée enrichie des éventuels overrides de prix (audit trail).
        // L'override de prix est ouvert à tous les rôles POS (cashier =
        // libraire, manager) — l'audit nominatif suffit comme garde-fou.
        const roleLabel = req.posStaff.role === 'manager' ? 'manager' : 'libraire';
        let invoiceNote = `POS Terminal ${terminal} | Caissier: ${req.posStaff.name} (${roleLabel})${note ? ' | ' + note : ''}`;
        if (priceOverrides.length > 0) {
          const lines = priceOverrides.map((o) =>
            `[PRIX MODIFIÉ par ${req.posStaff.name}/${roleLabel}] ${o.label} : ${o.from} → ${o.to} F (${o.reason})`,
          );
          invoiceNote += '\n' + lines.join('\n');
          // Audit local : une ligne par override (avec rôle pour filtrage rapport)
          for (const o of priceOverrides) {
            try {
              db.prepare(
                "INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)",
              ).run(
                req.posStaff.name || 'pos',
                'pos_price_override',
                `T${terminal} | ${roleLabel} | ${o.label} #${o.pid} : ${o.from} → ${o.to} F | ${o.reason}`,
              );
            } catch (e) { void e; }
          }
        }

        // 1. Create draft invoice
        const invoiceRes = await adminApi.post('/invoices', {
          socid: parseInt(socid),
          date: today,
          type: 0,
          module_source: 'takepos',
          pos_source: String(terminal),
          lines,
          note_private: invoiceNote,
        });
        sale.invoiceId = invoiceRes.data;

        // 2. Validate invoice (triggers stock decrement from warehouse)
        await adminApi.post(`/invoices/${sale.invoiceId}/validate`, {
          idwarehouse: POS_CONFIG.warehouse,
        });
        sale.validated = true;
      });

      if (stockError) {
        // Article devenu indisponible — libère la réservation d'idempotence.
        if (client_sale_id) {
          try { db.prepare('DELETE FROM pos_sale_idempotency WHERE client_sale_id = ?').run(client_sale_id); } catch { /* ignore */ }
        }
        return res.status(400).json({ error: stockError });
      }

      const invoiceId = sale.invoiceId;

      // 3. Get invoice details for ref
      const invoiceDetail = await adminApi.get(`/invoices/${invoiceId}`);
      const invoiceRef = invoiceDetail.data.ref;
      const totalTtc = parseFloat(invoiceDetail.data.total_ttc);
      sale.invoiceRef = invoiceRef;

      // 4-5. Encaissement — INTÉGRALEMENT SAUTÉ pour une facture à crédit (impayée) :
      //      la facture reste validée avec paye=0 (créance), réglable plus tard.
      const paymentResults = [];
      if (!unpaid) {
        // 4. Record each payment, capped at the invoice total.
        //    Cash tendered above the total is change — it must not be recorded
        //    as a Dolibarr payment (that would overpay the invoice).
        let toRecord = totalTtc;
        const cappedPayments = [];
        for (const p of normalizedPayments) {
          const mapping = PAYMENT_MAP[p.code];
          const amount = Math.min(parseFloat(p.amount) || 0, toRecord);
          if (amount <= 0) continue;
          toRecord -= amount;
          cappedPayments.push({ code: p.code, mapping, amount, cheque_issuer: p.cheque_issuer });
        }

        // 4a-bis. Émetteur du chèque : Dolibarr exige chqemetteur dès que le
        //         code de paiement est CHQ (sinon 400 « Emetteur is mandatory »).
        //         On le déduit du nom du client de la facture (le tireur du
        //         chèque), avec repli sur l'override éventuel envoyé par le POS.
        let chequeIssuerDefault = '';
        if (cappedPayments.some((p) => p.code === 'CHQ')) {
          try {
            const [sRows] = await dolibarrPool.query(
              'SELECT nom FROM llx_societe WHERE rowid = ?', [parseInt(socid)],
            );
            chequeIssuerDefault = String(sRows[0]?.nom || '').trim();
          } catch { /* repli ci-dessous */ }
          if (!chequeIssuerDefault) chequeIssuerDefault = `Client POS T${terminal}`;
        }

        // 4b. Record payments. A failure here propagates to the outer catch,
        //     which rolls the sale back cleanly via rollbackSale().
        for (let i = 0; i < cappedPayments.length; i++) {
          const { code, mapping, amount, cheque_issuer } = cappedPayments[i];
          const isLast = i === cappedPayments.length - 1;
          const paymentId = await resolvePaymentId(dolibarrPool, code, mapping.paymentId);
          const payRes = await adminApi.post(`/invoices/${invoiceId}/payments`, {
            datepaye: Math.floor(Date.now() / 1000),
            paymentid: paymentId,
            closepaidinvoices: isLast ? 'yes' : 'no',
            accountid: mapping.bankAccount,
            num_payment: invoiceRef,
            comment: `POS T${terminal} - ${mapping.label}`,
            amount,
            ...(code === 'CHQ'
              ? { chqemetteur: String(cheque_issuer || '').trim() || chequeIssuerDefault }
              : {}),
          });
          paymentResults.push({ code, amount, payment_id: payRes.data });
          sale.paymentsRecorded++;
        }

        // 5. Mark invoice as paid — only if the recorded payments fully cover it.
        //    Never force-close an under-paid invoice (that would hide a shortfall).
        const recordedSum = paymentResults.reduce((s, p) => s + p.amount, 0);
        if (recordedSum + 1 >= totalTtc) {
          try {
            await adminApi.post(`/invoices/${invoiceId}/settopaid`);
          } catch (paidErr) {
            console.error(`[POS] Paiement enregistré mais facture ${invoiceRef} non marquée payée:`, paidErr.response?.data || paidErr.message);
          }
        } else {
          throw new Error(`Paiement POS non enregistré intégralement (${recordedSum}/${totalTtc})`);
        }
      } else {
        // Trace de la vente à crédit (audit).
        try {
          db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
            .run(req.posStaff.name || 'pos', 'pos_credit_sale', `T${terminal} | Facture à crédit ${invoiceRef} (${Math.round(totalTtc)} F) — client #${socid}`);
        } catch { /* ignore */ }
      }

      const responsePayload = {
        invoice_id: invoiceId,
        invoice_ref: invoiceRef,
        total_ttc: totalTtc,
        payments: paymentResults,
        unpaid: !!unpaid,
        staff: req.posStaff.name,
        terminal,
      };
      // Marque la vente comme finalisée — toute resoumission renverra ce résultat.
      if (client_sale_id) {
        db.prepare("UPDATE pos_sale_idempotency SET status = 'done', response = ? WHERE client_sale_id = ?")
          .run(JSON.stringify(responsePayload), client_sale_id);
      }
      res.json(responsePayload);
    } catch (err) {
      console.error('POS sale error:', JSON.stringify(err.response?.data || err.message), 'status:', err.response?.status);
      // Rollback : annuler proprement la facture selon l'étape atteinte
      // (brouillon supprimé, facture validée repassée en brouillon, ou avoir).
      try { await rollbackSale(sale); } catch (rbErr) { console.error('[POS ROLLBACK] erreur inattendue:', rbErr.message); }
      // Libère la réservation d'idempotence — une vente échouée doit être relançable.
      if (req.body?.client_sale_id) {
        try { db.prepare('DELETE FROM pos_sale_idempotency WHERE client_sale_id = ?').run(req.body.client_sale_id); } catch { /* ignore */ }
      }
      const msg = sale.paymentsRecorded > 0
        ? 'Échec de la vente après encaissement partiel. Un avoir a été créé — vérifiez le remboursement du client.'
        : 'Échec de la vente — aucun montant débité, vous pouvez réessayer.';
      res.status(500).json({ error: msg });
    }
  });

  // ═══════════════════════════════════════════════════════
  // IMPAYÉS — liste des factures à régler + règlement ultérieur
  // ═══════════════════════════════════════════════════════

  // Liste des factures validées non soldées (créances) — recherche par réf/client.
  router.get('/invoices/unpaid', requirePosAuth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const where = ["f.fk_statut = 1", "f.paye = 0", "f.type = 0"];
      const params = [];
      if (q) {
        where.push('(f.ref LIKE ? OR s.nom LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, DATE_FORMAT(f.datef, '%Y-%m-%d') AS date,
                f.total_ttc, s.nom AS customer_name, s.rowid AS customer_id,
                COALESCE(pf.paid, 0) AS paid
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         WHERE ${where.join(' AND ')}
           AND (f.total_ttc - COALESCE(pf.paid, 0)) > 0.5
         ORDER BY f.datef DESC, f.rowid DESC LIMIT 50`, params
      );
      res.json({
        invoices: rows.map(r => ({
          id: r.id, ref: r.ref, date: r.date,
          customer_id: r.customer_id, customer_name: r.customer_name || 'Comptoir',
          total_ttc: Number(r.total_ttc), paid: Number(r.paid),
          remaining: Number(r.total_ttc) - Number(r.paid),
        })),
      });
    } catch (err) {
      console.error('[POS] unpaid list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement des impayés' });
    }
  });

  // Règlement (total ou partiel) d'une facture impayée existante.
  router.post('/invoices/:id/settle', requirePosAuth, saleLimiter, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { payments } = req.body;
      if (!id) return res.status(400).json({ error: 'Facture invalide' });
      if (!payments?.length) return res.status(400).json({ error: 'Aucun paiement' });

      const norm = payments.map(p => ({ ...p, code: normalizePaymentCode(p.code) }));
      const unknown = norm.filter(p => !PAYMENT_MAP[p.code]);
      if (unknown.length) return res.status(400).json({ error: `Moyen de paiement inconnu : ${unknown.map(p => p.code || '?').join(', ')}` });

      const [[inv]] = await dolibarrPool.query(
        `SELECT f.rowid, f.ref, f.fk_statut, f.paye, f.total_ttc, COALESCE(pf.paid, 0) AS paid,
                s.nom AS customer_name
         FROM llx_facture f
         LEFT JOIN (SELECT fk_facture, SUM(amount) AS paid FROM llx_paiement_facture GROUP BY fk_facture) pf
           ON pf.fk_facture = f.rowid
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.rowid = ?`, [id]
      );
      if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
      if (parseInt(inv.fk_statut) !== 1) return res.status(409).json({ error: 'La facture doit être validée' });
      if (parseInt(inv.paye) === 1) return res.status(409).json({ error: 'Facture déjà soldée' });
      const remaining = Number(inv.total_ttc) - Number(inv.paid);
      if (remaining <= 0.5) return res.status(409).json({ error: 'Rien à régler sur cette facture' });

      // Plafonne les paiements au reste dû.
      let toRecord = remaining;
      const capped = [];
      for (const p of norm) {
        const amt = Math.min(parseFloat(p.amount) || 0, toRecord);
        if (amt <= 0) continue;
        toRecord -= amt;
        capped.push({ mapping: PAYMENT_MAP[p.code], code: p.code, amount: amt, cheque_issuer: p.cheque_issuer });
      }
      if (capped.length === 0) return res.status(400).json({ error: 'Montant invalide' });

      // Émetteur du chèque exigé par Dolibarr dès que le code = CHQ (cf. vente).
      const chequeIssuerDefault = String(inv.customer_name || '').trim() || `Client POS T${getTerminal(req)}`;

      const results = [];
      for (let i = 0; i < capped.length; i++) {
        const { mapping, code, amount, cheque_issuer } = capped[i];
        const isLast = i === capped.length - 1;
        const paymentId = await resolvePaymentId(dolibarrPool, code, mapping.paymentId);
        const r = await adminApi.post(`/invoices/${id}/payments`, {
          datepaye: Math.floor(Date.now() / 1000),
          paymentid: paymentId,
          closepaidinvoices: isLast ? 'yes' : 'no',
          accountid: mapping.bankAccount,
          num_payment: inv.ref,
          comment: `POS règlement T${getTerminal(req)} - ${mapping.label}`,
          amount,
          ...(code === 'CHQ'
            ? { chqemetteur: String(cheque_issuer || '').trim() || chequeIssuerDefault }
            : {}),
        });
        results.push({ code, amount, payment_id: r.data });
      }
      const recorded = results.reduce((s, p) => s + p.amount, 0);
      const fullyPaid = recorded + 1 >= remaining;
      if (fullyPaid) {
        try { await adminApi.post(`/invoices/${id}/settopaid`); }
        catch (e) { console.error(`[POS] règlement ${inv.ref} : settopaid échoué`, e.response?.data || e.message); }
      }

      try {
        db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
          .run(req.posStaff.name || 'pos', 'pos_settle', `Règlement ${inv.ref} : ${Math.round(recorded)} F${fullyPaid ? ' (soldée)' : ' (partiel)'}`);
      } catch { /* ignore */ }

      res.json({ success: true, invoice_ref: inv.ref, paid: recorded, remaining: Math.max(0, remaining - recorded), fully_paid: fullyPaid, payments: results });
    } catch (err) {
      console.error('[POS] settle error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur lors du règlement' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // RETURNS (Credit Notes)
  // ═══════════════════════════════════════════════════════

  // Lookup invoice by ref
  router.get('/invoices/lookup/:ref', requirePosAuth, async (req, res) => {
    try {
      const invoiceRef = req.params.ref;
      const response = await adminApi.get('/invoices', {
        params: { sqlfilters: `(t.ref:=:'${safeSqlFilter(invoiceRef)}')`, limit: 1 },
      });
      const invoices = response.data || [];
      if (invoices.length === 0) return res.status(404).json({ error: 'Facture non trouvée' });

      const inv = invoices[0];
      // Quantités déjà retournées — pour borner ce qui reste retournable.
      const returned = await getReturnedQuantities(inv.id);

      // Moyens de paiement utilisés sur la facture d'origine — utilisé côté UI
      // pour pré-sélectionner le moyen de remboursement et imposer une
      // validation manager si le caissier veut rembourser via un autre canal.
      let originalPaymentMethods = [];
      try {
        const [methodRows] = await dolibarrPool.query(
          `SELECT DISTINCT cp.code
             FROM llx_paiement_facture pf
             JOIN llx_paiement p ON p.rowid = pf.fk_paiement
             JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
            WHERE pf.fk_facture = ?`,
          [inv.id],
        );
        originalPaymentMethods = methodRows.map((r) => normalizePaymentCode(r.code)).filter(Boolean);
      } catch (e) {
        console.warn('Original payment methods lookup error:', e.message);
      }

      res.json({
        id: inv.id,
        ref: inv.ref,
        total_ttc: parseFloat(inv.total_ttc),
        date: inv.date,
        customer_name: inv.thirdparty?.name || '',
        original_payment_methods: originalPaymentMethods,
        lines: (inv.lines || []).map(l => {
          const qty = parseInt(l.qty);
          const alreadyReturned = returned[l.fk_product] || 0;
          return {
            product_id: l.fk_product,
            label: l.product_label || l.desc,
            qty,
            qty_returned: alreadyReturned,
            qty_returnable: Math.max(0, qty - alreadyReturned),
            price_ttc: parseFloat(l.subprice),
            line_total: parseFloat(l.total_ttc),
          };
        }),
      });
    } catch (err) {
      if (err.response?.status === 404) return res.status(404).json({ error: 'Facture non trouvée' });
      console.error('Invoice lookup error:', err.message);
      res.status(500).json({ error: 'Erreur recherche facture' });
    }
  });

  // Create credit note (return)
  router.post('/returns', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { invoice_id, invoice_ref, items, reason, refund_method, client_return_id, manager_pin } = req.body;
      const terminal = getTerminal(req);

      if (!invoice_id || !items?.length) return res.status(400).json({ error: 'Facture et articles requis' });
      if (client_return_id && (typeof client_return_id !== 'string' || client_return_id.length > 64)) {
        return res.status(400).json({ error: 'client_return_id invalide' });
      }

      // FIX #1 — Idempotence : si déjà finalisé, on rejoue la réponse.
      if (client_return_id) {
        const done = db.prepare(
          "SELECT response FROM pos_return_idempotency WHERE client_return_id = ? AND status = 'done'",
        ).get(client_return_id);
        if (done) return res.json({ ...JSON.parse(done.response), idempotent_replay: true });
      }

      // FIX #5 — Vérifie que le compte bancaire du moyen de remboursement est
      // configuré AVANT toute écriture. Sinon on créerait un avoir orphelin
      // sans la ligne bancaire compensatoire (catch silencieux plus bas).
      const refundMethod = PAYMENT_MAP[refund_method] ? refund_method : 'LIQ';
      const refundMapping = PAYMENT_MAP[refundMethod];
      if (!refundMapping?.bankAccount) {
        return res.status(400).json({
          error: `Le moyen de remboursement « ${refundMapping?.label || refundMethod} » n'a pas de compte bancaire configuré.`,
        });
      }

      // FIX #2+#3 — Cross-method requiert un PIN manager. On récupère d'abord
      // les moyens de paiement de la facture source.
      let originalMethods = [];
      try {
        const [rows] = await dolibarrPool.query(
          `SELECT DISTINCT cp.code
             FROM llx_paiement_facture pf
             JOIN llx_paiement p ON p.rowid = pf.fk_paiement
             JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
            WHERE pf.fk_facture = ?`,
          [invoice_id],
        );
        originalMethods = rows.map((r) => normalizePaymentCode(r.code)).filter(Boolean);
      } catch (e) {
        console.warn('Return — original methods lookup failed:', e.message);
      }
      const crossMethod = originalMethods.length > 0 && !originalMethods.includes(refundMethod);
      let managerOverrideId = null;
      if (crossMethod && req.posStaff.role !== 'manager') {
        if (!manager_pin || typeof manager_pin !== 'string') {
          return res.status(403).json({
            error: `Remboursement en ${refundMapping.label} alors que la vente initiale était en ${originalMethods.join('/')}. Un PIN manager est requis.`,
            code: 'MANAGER_PIN_REQUIRED',
            original_methods: originalMethods,
          });
        }
        // Vérifie le PIN manager — bcrypt comparaison constant-time.
        const managers = db.prepare(
          "SELECT id, name, pin FROM pos_staff WHERE role = 'manager' AND active = 1",
        ).all();
        const match = managers.find((m) => bcrypt.compareSync(String(manager_pin), m.pin));
        if (!match) {
          return res.status(403).json({ error: 'PIN manager invalide', code: 'MANAGER_PIN_INVALID' });
        }
        managerOverrideId = match.id;
        // Audit immédiat — quel manager a validé quel cross-method.
        try {
          db.prepare(
            "INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)",
          ).run(
            req.posStaff.name || 'pos',
            'pos_refund_method_override',
            `T${terminal} | caissier=${req.posStaff.name} | manager=${match.name} | facture=${invoice_ref} | original=${originalMethods.join(',')} → remboursement=${refundMethod}`,
          );
        } catch (e) { void e; }
      }

      if (client_return_id && !claimReturnId(client_return_id)) {
        return res.status(409).json({ error: 'Remboursement déjà en cours de traitement', code: 'RETURN_IN_PROGRESS' });
      }

      // Get original invoice
      const original = await adminApi.get(`/invoices/${invoice_id}`);
      const socid = original.data.socid;
      const today = new Date().toISOString().split('T')[0];

      // Quantité, prix et remise d'origine par produit — référence de confiance.
      const origLine = {};
      for (const l of (original.data.lines || [])) {
        const pid = parseInt(l.fk_product);
        if (!pid) continue;
        if (!origLine[pid]) {
          origLine[pid] = { qty: 0, subprice: parseFloat(l.subprice), remise_percent: parseFloat(l.remise_percent) || 0 };
        }
        origLine[pid].qty += parseInt(l.qty);
      }
      const returned = await getReturnedQuantities(invoice_id);

      // Valider les quantités demandées : jamais plus que (vendu − déjà retourné).
      const requested = {};
      for (const item of items) {
        const pid = parseInt(item.product_id);
        const qty = parseInt(item.qty);
        if (!pid || !qty || qty <= 0) {
          return res.status(400).json({ error: `Quantité invalide pour l'article ${item.label || pid}` });
        }
        requested[pid] = (requested[pid] || 0) + qty;
      }
      const errors = [];
      for (const pid of Object.keys(requested)) {
        const sold = origLine[pid]?.qty || 0;
        const alreadyReturned = returned[pid] || 0;
        const returnable = sold - alreadyReturned;
        if (requested[pid] > returnable) {
          errors.push(`produit ${pid} : ${requested[pid]} demandé, ${Math.max(0, returnable)} retournable (vendu ${sold}, déjà retourné ${alreadyReturned})`);
        }
      }
      if (errors.length) {
        return res.status(400).json({ error: `Retour refusé — ${errors.join(' ; ')}` });
      }

      // Lignes de l'avoir — prix et remise repris de la facture d'origine
      // (le client ne peut pas gonfler le montant remboursé). qty/subprice
      // positifs : Dolibarr applique le signe avoir via type:2.
      const lines = items.map(item => {
        const pid = parseInt(item.product_id);
        const ol = origLine[pid] || {};
        return {
          fk_product: pid,
          qty: parseInt(item.qty),
          subprice: ol.subprice != null ? ol.subprice : parseFloat(item.price_ttc),
          remise_percent: ol.remise_percent || 0,
          tva_tx: 0,
          product_type: 0,
        };
      });

      // Create credit note in Dolibarr
      const creditRes = await adminApi.post('/invoices', {
        socid: parseInt(socid),
        date: today,
        type: 2, // Credit note
        fk_facture_source: invoice_id,
        module_source: 'takepos',
        pos_source: String(terminal),
        lines,
        note_private: `AVOIR POS T${terminal} | caissier=${req.posStaff.name}${managerOverrideId ? ` | manager-override=${managerOverrideId}` : ''} | Ref: ${invoice_ref} | Motif: ${reason || 'Retour'}${crossMethod ? ` | ${originalMethods.join(',')}→${refundMethod}` : ''}`,
      });

      const creditId = creditRes.data;
      await adminApi.post(`/invoices/${creditId}/validate`, { idwarehouse: POS_CONFIG.warehouse });

      const creditDetail = await adminApi.get(`/invoices/${creditId}`);
      const refundAmount = Math.abs(parseFloat(creditDetail.data.total_ttc)) || 0;

      // Rattacher le remboursement à la session de caisse ouverte sur ce
      // terminal — la clôture de caisse en tiendra compte.
      let refundSessionId = null;
      try {
        const [openSess] = await dolibarrPool.query(
          "SELECT rowid FROM llx_pos_cash_fence WHERE posnumber = ? AND posmodule = 'takepos' AND status = 0 ORDER BY rowid DESC LIMIT 1",
          [String(terminal)]
        );
        if (openSess.length) refundSessionId = openSess[0].rowid;
      } catch (e) {
        console.error('POS return — recherche session échouée:', e.message);
      }

      // Tracer le remboursement en local (réconciliation de caisse).
      try {
        db.prepare(`INSERT INTO pos_refunds
          (session_id, terminal, credit_id, credit_ref, original_ref, method, amount, staff_id, staff_name)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(
          refundSessionId, terminal, creditId, creditDetail.data.ref, invoice_ref || null,
          refundMethod, refundAmount, req.posStaff.id, req.posStaff.name
        );
      } catch (e) {
        console.error('POS return — échec enregistrement local remboursement:', e.message);
      }

      // Sortie d'argent dans Dolibarr — ligne bancaire négative sur le compte
      // du moyen de remboursement, pour que le solde bancaire reste juste.
      try {
        await adminApi.post(`/bankaccounts/${refundMapping.bankAccount}/lines`, {
          date: today,
          amount_capital: -refundAmount,
          label: `Remboursement POS T${terminal} — avoir ${creditDetail.data.ref} (${refundMapping.label})`,
          type: 'PRE',
        });
      } catch (bankErr) {
        console.error('POS return — création ligne bancaire échouée (avoir créé):', bankErr.message);
      }

      const response = {
        credit_id: creditId,
        credit_ref: creditDetail.data.ref,
        total_ttc: parseFloat(creditDetail.data.total_ttc),
        original_ref: invoice_ref,
        refund_method: refundMethod,
        refund_amount: refundAmount,
      };

      // FIX #1 — cache la réponse pour rejouer un éventuel retry idempotent.
      if (client_return_id) {
        try {
          db.prepare("UPDATE pos_return_idempotency SET status = 'done', response = ? WHERE client_return_id = ?")
            .run(JSON.stringify(response), client_return_id);
        } catch (e) { void e; }
      }

      res.json(response);
    } catch (err) {
      console.error('POS return error:', err.response?.data || err.message);
      // Libère le claim pour permettre un retry propre.
      if (req.body?.client_return_id) {
        try { db.prepare('DELETE FROM pos_return_idempotency WHERE client_return_id = ?').run(req.body.client_return_id); } catch { /* ignore */ }
      }
      res.status(500).json({ error: 'Erreur création avoir' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // SALES HISTORY (today)
  // ═══════════════════════════════════════════════════════

  // Rapport de caisse (équivalent Z-report) — agrège ventes, paiements,
  // mouvements de caisse et overrides de prix sur la période courante :
  // depuis l'ouverture de la session si une est en cours, sinon depuis le
  // début de la journée. Sert au caissier pour contrôle intermédiaire avant
  // clôture.
  router.get('/session/report', requirePosAuth, async (req, res) => {
    try {
      const terminal = getTerminal(req);

      // 1) Session ouverte (si existe) — fixe le point de départ de la période.
      const [openSessions] = await dolibarrPool.query(
        `SELECT rowid AS id, date_creation, cash AS opening_cash, fk_user_creat AS staff_id
           FROM llx_pos_cash_fence
          WHERE posnumber = ? AND posmodule = 'takepos' AND status = 0
          ORDER BY rowid DESC LIMIT 1`,
        [String(terminal)],
      );
      const session = openSessions[0] || null;
      const periodStart = session
        ? session.date_creation
        : new Date(new Date().setHours(0, 0, 0, 0));
      const periodStartIso = periodStart instanceof Date
        ? periodStart.toISOString().slice(0, 19).replace('T', ' ')
        : periodStart;

      // 2) Ventes encaissées sur la période, par moyen de paiement.
      const [byMethod] = await dolibarrPool.query(
        `SELECT cp.code,
                COUNT(DISTINCT pf.fk_facture) AS invoices,
                COALESCE(SUM(pf.amount), 0) AS amount
           FROM llx_paiement_facture pf
           JOIN llx_paiement p ON p.rowid = pf.fk_paiement
           JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
           JOIN llx_facture f ON f.rowid = pf.fk_facture
          WHERE f.module_source = 'takepos'
            AND f.pos_source = ?
            AND p.datep >= ?
          GROUP BY cp.code`,
        [String(terminal), periodStartIso],
      );

      // 3) Tickets validés sur la période — total, nb, ticket moyen.
      const [[totals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS invoices,
                COALESCE(SUM(total_ttc), 0) AS total_ttc,
                COALESCE(SUM(total_ht), 0) AS total_ht
           FROM llx_facture f
          WHERE f.module_source = 'takepos'
            AND f.pos_source = ?
            AND f.datef >= UNIX_TIMESTAMP(?)
            AND f.fk_statut > 0`,
        [String(terminal), periodStartIso],
      );

      // 4) Top 5 articles vendus (par quantité) sur la période.
      const [topItems] = await dolibarrPool.query(
        `SELECT COALESCE(p.ref, fd.description) AS ref,
                COALESCE(p.label, fd.description) AS label,
                SUM(fd.qty) AS qty,
                SUM(fd.total_ttc) AS total_ttc
           FROM llx_facturedet fd
           JOIN llx_facture f ON f.rowid = fd.fk_facture
      LEFT JOIN llx_product p ON p.rowid = fd.fk_product
          WHERE f.module_source = 'takepos'
            AND f.pos_source = ?
            AND f.datef >= UNIX_TIMESTAMP(?)
            AND f.fk_statut > 0
            AND f.type = 0
          GROUP BY COALESCE(p.rowid, fd.description), label, ref
          ORDER BY qty DESC
          LIMIT 5`,
        [String(terminal), periodStartIso],
      );

      // 5) Avoirs (remboursements) sur la période — réduisent l'encaisse.
      const [[refundsTotals]] = await dolibarrPool.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount
           FROM pos_refunds
          WHERE terminal = ? AND created_at >= ?`,
        [terminal, periodStartIso],
      ).catch(() => [[{ n: 0, amount: 0 }]]);

      // 6) Mouvements de caisse (entrées/sorties) — uniquement si session ouverte.
      let cashMovements = [];
      if (session) {
        cashMovements = db.prepare(
          'SELECT id, type, amount, reason, created_at FROM pos_cash_movements WHERE session_id = ? ORDER BY created_at ASC',
        ).all(session.id);
      }
      const cashIn = cashMovements.filter((m) => m.type === 'in').reduce((s, m) => s + m.amount, 0);
      const cashOut = cashMovements.filter((m) => m.type === 'out').reduce((s, m) => s + m.amount, 0);

      // 7) Overrides de prix appliqués sur la période — depuis l'audit log.
      const priceOverrides = db.prepare(
        `SELECT created_at, admin_username AS staff, details
           FROM admin_activity_log
          WHERE action = 'pos_price_override'
            AND details LIKE ?
            AND created_at >= ?
          ORDER BY id DESC LIMIT 20`,
      ).all(`T${terminal} |%`, periodStartIso);

      // 8) Mapping codes → labels (cohérent avec PAYMENT_MAP).
      const methods = {};
      for (const code of Object.keys(PAYMENT_MAP)) {
        methods[code] = { label: PAYMENT_MAP[code].label, invoices: 0, amount: 0 };
      }
      for (const r of byMethod) {
        const code = normalizePaymentCode(r.code);
        if (!methods[code]) methods[code] = { label: code, invoices: 0, amount: 0 };
        methods[code].invoices = parseInt(r.invoices) || 0;
        methods[code].amount = parseFloat(r.amount) || 0;
      }

      const totalInvoices = parseInt(totals.invoices) || 0;
      const totalTtc = parseFloat(totals.total_ttc) || 0;
      const cashSales = methods.LIQ?.amount || 0;
      const expectedCash = (session ? parseFloat(session.opening_cash) || 0 : 0) + cashSales + cashIn - cashOut - (parseFloat(refundsTotals?.amount) || 0);

      res.json({
        terminal,
        staff: req.posStaff.name,
        period_start: periodStartIso,
        generated_at: new Date().toISOString(),
        session: session ? {
          id: session.id,
          opened_at: session.date_creation,
          opening_cash: parseFloat(session.opening_cash) || 0,
        } : null,
        totals: {
          invoices: totalInvoices,
          total_ttc: totalTtc,
          total_ht: parseFloat(totals.total_ht) || 0,
          avg_ticket: totalInvoices > 0 ? totalTtc / totalInvoices : 0,
        },
        methods,
        cash: {
          opening: session ? parseFloat(session.opening_cash) || 0 : 0,
          sales: cashSales,
          in: cashIn,
          out: cashOut,
          refunds: parseFloat(refundsTotals?.amount) || 0,
          expected: expectedCash,
        },
        cash_movements: cashMovements,
        refunds: { count: parseInt(refundsTotals?.n) || 0, amount: parseFloat(refundsTotals?.amount) || 0 },
        top_items: topItems.map((i) => ({ ref: i.ref, label: i.label, qty: parseFloat(i.qty), total_ttc: parseFloat(i.total_ttc) })),
        price_overrides: priceOverrides,
      });
    } catch (err) {
      console.error('POS report error:', err);
      res.status(500).json({ error: 'Erreur rapport de caisse' });
    }
  });

  router.get('/sales/today', requirePosAuth, async (req, res) => {
    try {
      const terminal = getTerminal(req);
      const today = new Date().toISOString().split('T')[0];
      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.total_ttc, f.datef AS date,
                f.paye AS paid, f.fk_statut AS status,
                s.nom AS customer_name
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.module_source = 'takepos'
           AND f.pos_source = ?
           AND DATE(FROM_UNIXTIME(f.datef)) = ?
         ORDER BY f.rowid DESC`,
        [String(terminal), today]
      );
      res.json(rows);
    } catch (err) {
      console.error('POS sales today error:', err);
      res.status(500).json({ error: 'Erreur historique ventes' });
    }
  });

  // Historique complet des factures POS — pagination + filtres optionnels
  // (recherche, dates, statut). Pas de filtre par défaut hors `module_source`
  // pour limiter au périmètre POS (caissier ne doit pas voir les factures
  // e-commerce / contrats).
  router.get('/sales/history', requirePosAuth, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 25));
      const offset = (page - 1) * pageSize;
      const search = String(req.query.search || '').trim().slice(0, 100);
      const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom || '') ? req.query.dateFrom : null;
      const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo || '') ? req.query.dateTo : null;
      const status = ['paid', 'unpaid'].includes(req.query.status) ? req.query.status : null;

      const where = ["f.module_source = 'takepos'"];
      const params = [];

      if (search) {
        where.push('(f.ref LIKE ? OR s.nom LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }
      if (dateFrom) {
        where.push('DATE(FROM_UNIXTIME(f.datef)) >= ?');
        params.push(dateFrom);
      }
      if (dateTo) {
        where.push('DATE(FROM_UNIXTIME(f.datef)) <= ?');
        params.push(dateTo);
      }
      if (status === 'paid') where.push('f.paye = 1');
      else if (status === 'unpaid') where.push('f.paye = 0');

      const whereSql = where.join(' AND ');

      const [countRows] = await dolibarrPool.query(
        `SELECT COUNT(*) AS total
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE ${whereSql}`,
        params
      );
      const total = countRows[0].total;

      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.total_ht, f.total_ttc, f.datef AS date,
                f.date_lim_reglement AS date_due,
                f.paye AS paid, f.fk_statut AS status, f.pos_source AS terminal,
                s.nom AS customer_name,
                COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.firstname, u.lastname)), ''), u.login) AS creator_name
         FROM llx_facture f
         LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         LEFT JOIN llx_user u ON u.rowid = f.fk_user_author
         WHERE ${whereSql}
         ORDER BY f.datef DESC, f.rowid DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );

      res.json({ rows, total, page, pageSize });
    } catch (err) {
      console.error('POS sales history error:', err);
      res.status(500).json({ error: 'Erreur historique factures' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // CASH REGISTER SESSION
  // ═══════════════════════════════════════════════════════

  router.get('/session/current', requirePosAuth, async (req, res) => {
    try {
      const terminal = getTerminal(req);
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, date_creation, cash, status,
                fk_user_creat AS staff_id
         FROM llx_pos_cash_fence
         WHERE posnumber = ? AND posmodule = 'takepos' AND status = 0
         ORDER BY rowid DESC LIMIT 1`,
        [String(terminal)]
      );

      if (rows.length === 0) return res.json(null);

      // Get cash movements for this session
      const movements = db.prepare(
        'SELECT * FROM pos_cash_movements WHERE session_id = ? ORDER BY created_at ASC'
      ).all(rows[0].id);

      res.json({ ...rows[0], movements });
    } catch (err) {
      console.error('POS session current error:', err);
      res.status(500).json({ error: 'Erreur session caisse' });
    }
  });

  router.post('/session/open', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { opening_cash = 0 } = req.body;
      const terminal = getTerminal(req);

      // Check no session already open
      const [existing] = await dolibarrPool.query(
        `SELECT rowid FROM llx_pos_cash_fence
         WHERE posnumber = ? AND posmodule = 'takepos' AND status = 0`,
        [String(terminal)]
      );

      if (existing.length > 0) {
        return res.status(400).json({ error: 'Une session est déjà ouverte sur ce terminal' });
      }

      const [result] = await dolibarrPool.query(
        `INSERT INTO llx_pos_cash_fence
         (entity, posnumber, posmodule, date_creation, cash, status, fk_user_creat)
         VALUES (1, ?, 'takepos', NOW(), ?, 0, ?)`,
        [String(terminal), parseFloat(opening_cash), req.posStaff.dolibarr_user_id || req.posStaff.id]
      );

      res.json({
        session_id: result.insertId,
        terminal,
        opening_cash: parseFloat(opening_cash),
        staff: req.posStaff.name,
      });
    } catch (err) {
      console.error('POS session open error:', err);
      res.status(500).json({ error: 'Erreur ouverture caisse' });
    }
  });

  // Historique complet des clôtures de caisse — conserve Wave/OM et le fond
  // d'ouverture, que la table Dolibarr llx_pos_cash_fence ne sait pas stocker.
  db.exec(`CREATE TABLE IF NOT EXISTS pos_session_closures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    terminal INTEGER,
    staff_id INTEGER,
    staff_name TEXT,
    opening_cash REAL DEFAULT 0,
    expected_cash REAL DEFAULT 0, expected_card REAL DEFAULT 0, expected_cheque REAL DEFAULT 0,
    expected_wave REAL DEFAULT 0, expected_om REAL DEFAULT 0,
    counted_cash REAL DEFAULT 0, counted_card REAL DEFAULT 0, counted_cheque REAL DEFAULT 0,
    counted_wave REAL DEFAULT 0, counted_om REAL DEFAULT 0,
    diff_cash REAL DEFAULT 0, diff_card REAL DEFAULT 0, diff_cheque REAL DEFAULT 0,
    diff_wave REAL DEFAULT 0, diff_om REAL DEFAULT 0,
    cash_in REAL DEFAULT 0, cash_out REAL DEFAULT 0,
    closed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Remboursements POS (avoirs) — trace le moyen et le montant rendu au client,
  // rattachés à la session de caisse pour la réconciliation à la clôture.
  db.exec(`CREATE TABLE IF NOT EXISTS pos_refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    terminal INTEGER,
    credit_id INTEGER,
    credit_ref TEXT,
    original_ref TEXT,
    method TEXT NOT NULL DEFAULT 'LIQ',
    amount REAL NOT NULL DEFAULT 0,
    staff_id INTEGER,
    staff_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  router.post('/session/close', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { session_id, counted_cash = 0, counted_card = 0, counted_cheque = 0, counted_wave = 0, counted_om = 0 } = req.body;
      const terminal = getTerminal(req);

      if (!session_id) return res.status(400).json({ error: 'Session ID requis' });

      // Get session
      const [sessions] = await dolibarrPool.query(
        'SELECT * FROM llx_pos_cash_fence WHERE rowid = ? AND status = 0',
        [session_id]
      );

      if (sessions.length === 0) {
        return res.status(404).json({ error: 'Session non trouvée ou déjà clôturée' });
      }
      const session = sessions[0];

      // Encaissements attendus — limités à la PÉRIODE de cette session (depuis
      // son ouverture), et non à toute la journée du terminal : sinon une
      // 2ᵉ session du jour compterait aussi les ventes de la 1ʳᵉ.
      const [sales] = await dolibarrPool.query(
        `SELECT
           COALESCE(SUM(CASE WHEN cp.code = 'LIQ' THEN pf.amount ELSE 0 END), 0) AS expected_cash,
           COALESCE(SUM(CASE WHEN cp.code = 'CB' THEN pf.amount ELSE 0 END), 0) AS expected_card,
           COALESCE(SUM(CASE WHEN cp.code = 'CHQ' THEN pf.amount ELSE 0 END), 0) AS expected_cheque,
           COALESCE(SUM(CASE WHEN cp.code = 'WAVE' THEN pf.amount ELSE 0 END), 0) AS expected_wave,
           COALESCE(SUM(CASE WHEN cp.code = 'OM' THEN pf.amount ELSE 0 END), 0) AS expected_om
         FROM llx_paiement_facture pf
         JOIN llx_paiement p ON p.rowid = pf.fk_paiement
         JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
         JOIN llx_facture f ON f.rowid = pf.fk_facture
         WHERE f.module_source = 'takepos'
           AND f.pos_source = ?
           AND p.datep >= ?`,
        [String(terminal), session.date_creation]
      );

      const expected = sales[0] || {};

      // Add cash movements
      const movements = db.prepare(
        'SELECT type, SUM(amount) AS total FROM pos_cash_movements WHERE session_id = ? GROUP BY type'
      ).all(session_id);

      let cashIn = 0, cashOut = 0;
      for (const m of movements) {
        if (m.type === 'in') cashIn = m.total;
        if (m.type === 'out') cashOut = m.total;
      }

      // Remboursements (avoirs) de la session — réduisent les encaissements attendus.
      const refundRows = db.prepare(
        'SELECT method, SUM(amount) AS total FROM pos_refunds WHERE session_id = ? GROUP BY method'
      ).all(session_id);
      const refund = { LIQ: 0, CB: 0, CHQ: 0, WAVE: 0, OM: 0 };
      for (const r of refundRows) {
        if (r.method in refund) refund[r.method] += parseFloat(r.total) || 0;
      }

      const num = (v) => parseFloat(v) || 0;
      const opening = num(session.cash);
      const expectedCashTotal = opening + num(expected.expected_cash) + cashIn - cashOut - refund.LIQ;
      const expectedCard = num(expected.expected_card) - refund.CB;
      const expectedCheque = num(expected.expected_cheque) - refund.CHQ;
      const expectedWave = num(expected.expected_wave) - refund.WAVE;
      const expectedOm = num(expected.expected_om) - refund.OM;

      const result = {
        session_id,
        opening,
        expected: {
          cash: expectedCashTotal,
          card: expectedCard,
          cheque: expectedCheque,
          wave: expectedWave,
          om: expectedOm,
        },
        counted: {
          cash: num(counted_cash), card: num(counted_card), cheque: num(counted_cheque),
          wave: num(counted_wave), om: num(counted_om),
        },
        difference: {
          cash: num(counted_cash) - expectedCashTotal,
          card: num(counted_card) - expectedCard,
          cheque: num(counted_cheque) - expectedCheque,
          wave: num(counted_wave) - expectedWave,
          om: num(counted_om) - expectedOm,
        },
        cash_in: cashIn,
        cash_out: cashOut,
        refunds: refund,
      };

      // Clôturer la session — NE PAS écraser la colonne `cash` (fond d'ouverture).
      await dolibarrPool.query(
        'UPDATE llx_pos_cash_fence SET status = 1, date_valid = NOW() WHERE rowid = ?',
        [session_id]
      );

      // Conserver la clôture détaillée en local (Wave/OM, écarts, caissier).
      try {
        db.prepare(`INSERT INTO pos_session_closures
          (session_id, terminal, staff_id, staff_name, opening_cash,
           expected_cash, expected_card, expected_cheque, expected_wave, expected_om,
           counted_cash, counted_card, counted_cheque, counted_wave, counted_om,
           diff_cash, diff_card, diff_cheque, diff_wave, diff_om, cash_in, cash_out)
          VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?)`).run(
          session_id, terminal, req.posStaff.id, req.posStaff.name, opening,
          result.expected.cash, result.expected.card, result.expected.cheque, result.expected.wave, result.expected.om,
          result.counted.cash, result.counted.card, result.counted.cheque, result.counted.wave, result.counted.om,
          result.difference.cash, result.difference.card, result.difference.cheque, result.difference.wave, result.difference.om,
          cashIn, cashOut
        );
      } catch (recErr) {
        console.error('POS session close — échec enregistrement local clôture:', recErr.message);
      }

      res.json(result);
    } catch (err) {
      console.error('POS session close error:', err);
      res.status(500).json({ error: 'Erreur clôture caisse' });
    }
  });

  router.post('/session/cash-in-out', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { session_id, type, amount, reason } = req.body;

      if (!session_id || !type || amount == null) {
        return res.status(400).json({ error: 'session_id, type et amount requis' });
      }

      if (!['in', 'out'].includes(type)) {
        return res.status(400).json({ error: 'Type doit être "in" ou "out"' });
      }

      // Montant : nombre fini strictement positif (pas de négatif ni de zéro,
      // qui fausseraient la réconciliation de caisse).
      const amountNum = parseFloat(amount);
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        return res.status(400).json({ error: 'Montant invalide (nombre positif requis)' });
      }

      if (type === 'out' && req.posStaff.role !== 'manager') {
        return res.status(403).json({ error: 'Sortie espèces réservée aux managers' });
      }

      // Vérifier que la session de caisse existe et est OUVERTE (status = 0)
      // avant tout enregistrement — sinon le mouvement serait orphelin ou
      // rattaché à une caisse déjà clôturée.
      const [openSessions] = await dolibarrPool.query(
        "SELECT rowid FROM llx_pos_cash_fence WHERE rowid = ? AND posmodule = 'takepos' AND status = 0",
        [session_id]
      );
      if (openSessions.length === 0) {
        return res.status(409).json({ error: 'Session de caisse introuvable ou déjà clôturée' });
      }

      // Save locally
      const stmt = db.prepare(
        'INSERT INTO pos_cash_movements (session_id, type, amount, reason, staff_id) VALUES (?, ?, ?, ?, ?)'
      );
      const result = stmt.run(session_id, type, amountNum, reason || null, req.posStaff.id);

      // Sync to Dolibarr bank account (cash account = bankAccount 3)
      try {
        const cashBankId = PAYMENT_MAP.LIQ.bankAccount;
        const signedAmount = type === 'in' ? amountNum : -amountNum;
        const label = `POS ${type === 'in' ? 'Entrée' : 'Sortie'} caisse — ${reason || 'Sans motif'} (${req.posStaff.name})`;
        await adminApi.post(`/bankaccounts/${cashBankId}/lines`, {
          date: new Date().toISOString().split('T')[0],
          amount_capital: signedAmount,
          label,
          type: 'PRE', // Prelevement/versement interne
        });
      } catch (bankErr) {
        console.error('[POS] Dolibarr bank line creation failed (local saved):', bankErr.message);
      }

      res.json({ id: result.lastInsertRowid, type, amount: amountNum, reason });
    } catch (err) {
      console.error('POS cash movement error:', err);
      res.status(500).json({ error: 'Erreur mouvement caisse' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // QUOTES (Devis)
  // ═══════════════════════════════════════════════════════

  // Create quotes table
  db.exec(`CREATE TABLE IF NOT EXISTS pos_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE NOT NULL,
    customer_name TEXT,
    customer_phone TEXT,
    customer_email TEXT,
    items TEXT NOT NULL,
    total_ttc REAL NOT NULL,
    staff_name TEXT,
    terminal INTEGER,
    validity_days INTEGER DEFAULT 30,
    status TEXT DEFAULT 'valid',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Échappe les caractères réservés XML — toute valeur dynamique insérée dans
  // content.xml doit y passer (sinon injection / document ODT corrompu).
  function escapeXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Generate next quote ref: FP-YYYYMM-NNN
  function nextQuoteRef() {
    const prefix = `FP-${new Date().toISOString().slice(0, 7).replace('-', '')}`;
    const last = db.prepare("SELECT ref FROM pos_quotes WHERE ref LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`);
    const num = last ? parseInt(last.ref.split('-').pop()) + 1 : 1;
    return `${prefix}-${String(num).padStart(3, '0')}`;
  }

  // Create a quote (SQLite + Dolibarr propal)
  router.post('/quotes', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { items, customer } = req.body;
      const terminal = getTerminal(req);
      if (!items?.length) return res.status(400).json({ error: 'Panier vide' });
      const total = items.reduce((s, i) => s + i.qty * i.price_ttc, 0);
      const ref = nextQuoteRef();

      // Create propal in Dolibarr
      let dolibarrPropalId = null;
      let dolibarrPropalRef = null;
      try {
        const propalLines = items.map((item) => ({
          fk_product: parseInt(item.product_id),
          qty: item.qty,
          subprice: parseFloat(item.price_ttc),
          tva_tx: 0,
          product_type: 0,
        }));

        const socid = customer?.id || POS_CONFIG.defaultCustomer;
        const today = new Date().toISOString().split('T')[0];

        const propalRes = await adminApi.post('/proposals', {
          socid: parseInt(socid),
          date: today,
          duree_validite: 30,
          lines: propalLines,
          note_private: `POS Terminal ${terminal} | ${req.posStaff.name} | Ref locale: ${ref}`,
        });
        dolibarrPropalId = propalRes.data;

        // Validate the proposal
        await adminApi.post(`/proposals/${dolibarrPropalId}/validate`);
        const propalDetail = await adminApi.get(`/proposals/${dolibarrPropalId}`);
        dolibarrPropalRef = propalDetail.data.ref;
      } catch (propalErr) {
        console.error('[POS] Dolibarr propal creation failed (continuing with local):', propalErr.message);
      }

      // Save local copy (for ODT generation)
      const stmt = db.prepare(`INSERT INTO pos_quotes (ref, customer_name, customer_phone, customer_email, items, total_ttc, staff_name, terminal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

      stmt.run(
        ref,
        customer?.name || 'Client comptoir',
        customer?.phone || null,
        customer?.email || null,
        JSON.stringify(items),
        total,
        req.posStaff.name,
        terminal
      );

      res.json({
        ref,
        dolibarr_ref: dolibarrPropalRef,
        customer_name: customer?.name || 'Client comptoir',
        items,
        total_ttc: total,
        staff: req.posStaff.name,
        terminal,
        date: new Date().toISOString(),
        validity_days: 30,
      });
    } catch (err) {
      console.error('POS quote error:', err);
      res.status(500).json({ error: 'Erreur création devis' });
    }
  });

  // List today's quotes
  router.get('/quotes/today', requirePosAuth, (req, res) => {
    const quotes = db.prepare("SELECT * FROM pos_quotes WHERE date(created_at) = date('now') ORDER BY id DESC").all();
    quotes.forEach(q => q.items = JSON.parse(q.items));
    res.json(quotes);
  });

  // Get a specific quote
  router.get('/quotes/:ref', requirePosAuth, (req, res) => {
    const quote = db.prepare("SELECT * FROM pos_quotes WHERE ref = ?").get(req.params.ref);
    if (!quote) return res.status(404).json({ error: 'Devis non trouvé' });
    quote.items = JSON.parse(quote.items);
    res.json(quote);
  });

  // Download quote as ODT
  router.get('/quotes/:ref/odt', requirePosAuth, async (req, res) => {
    try {
      const quote = db.prepare("SELECT * FROM pos_quotes WHERE ref = ?").get(req.params.ref);
      if (!quote) return res.status(404).json({ error: 'Devis non trouvé' });
      quote.items = JSON.parse(quote.items);

      const { join, dirname } = await import('path');
      const { fileURLToPath } = await import('url');
      const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
      const { execSync } = await import('child_process');
      const __dir = dirname(fileURLToPath(import.meta.url));
      const templatePath = join(__dir, 'templates', 'devis-librairie.odt');

      // Create temp dir, extract template
      const tmpDir = join('/tmp', `quote-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      execSync(`cd ${tmpDir} && unzip -o "${templatePath}" 2>/dev/null`);

      // Read content.xml
      let content = readFileSync(join(tmpDir, 'content.xml'), 'utf-8');

      // Replace simple placeholders
      const dateStr = new Date(quote.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
      content = content.replace('{REF}', escapeXml(quote.ref));
      content = content.replace('{DATE}', escapeXml(dateStr));
      content = content.replace('{CLIENT}', escapeXml(quote.customer_name));
      content = content.replace('{TOTAL_AMOUNT}', escapeXml(parseInt(quote.total_ttc).toLocaleString('fr-FR')));
      content = content.replace('{TOTAL_TEXT}', escapeXml(numberToWordsFR(quote.total_ttc) + ' Francs CFA'));

      // Find and duplicate the data row for each item
      const rowRegex = /<table:table-row[^>]*>(?:(?!<table:table-row)[\s\S])*?\{ITEM_LABEL\}[\s\S]*?<\/table:table-row>/;
      const rowMatch = content.match(rowRegex);

      if (rowMatch) {
        const templateRow = rowMatch[0];
        const allRows = quote.items.map((item) => {
          const lineTotal = item.line_total || item.qty * item.price_ttc * (1 - (item.discount || 0) / 100);
          return templateRow
            .replace('{ITEM_ISBN}', escapeXml(item.ref || ''))
            .replace('{ITEM_LABEL}', escapeXml(item.label))
            .replace('{ITEM_QTY}', escapeXml(String(item.qty)))
            .replace('{ITEM_PU}', escapeXml(parseInt(item.price_ttc).toLocaleString('fr-FR')))
            .replace('{ITEM_DISCOUNT}', escapeXml(item.discount > 0 ? `-${item.discount}%` : ''))
            .replace('{ITEM_TOTAL}', escapeXml(Math.round(lineTotal).toLocaleString('fr-FR')));
        }).join('');
        content = content.replace(templateRow, allRows);
      }

      // Write modified content
      writeFileSync(join(tmpDir, 'content.xml'), content);

      // Repack ODT
      const outPath = join(tmpDir, 'output.odt');
      execSync(`cd ${tmpDir} && zip -0 -X "${outPath}" mimetype && zip -r -X "${outPath}" META-INF/ media/ content.xml styles.xml settings.xml meta.xml 2>/dev/null`);

      const odtBuffer = readFileSync(outPath);

      // Cleanup
      rmSync(tmpDir, { recursive: true, force: true });

      res.setHeader('Content-Type', 'application/vnd.oasis.opendocument.text');
      res.setHeader('Content-Disposition', `attachment; filename="${quote.ref}.odt"`);
      res.send(odtBuffer);
    } catch (err) {
      console.error('Quote ODT error:', err);
      res.status(500).json({ error: 'Erreur génération document' });
    }
  });

  // Simple number to French words (for amounts)
  function numberToWordsFR(n) {
    n = Math.round(n);
    if (n === 0) return 'zéro';
    const units = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
    const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];
    function chunk(num) {
      if (num === 0) return '';
      if (num < 20) return units[num];
      if (num < 70) return tens[Math.floor(num / 10)] + (num % 10 === 1 ? ' et un' : num % 10 ? '-' + units[num % 10] : '');
      if (num < 80) return 'soixante' + (num % 20 === 1 ? ' et onze' : '-' + units[10 + num % 10]);
      if (num < 100) return 'quatre-vingt' + (num % 20 === 0 ? 's' : '-' + units[num % 20 < 20 ? num % 20 : num % 10]);
      if (num < 200) return 'cent' + (num % 100 === 0 ? '' : ' ' + chunk(num % 100));
      if (num < 1000) return units[Math.floor(num / 100)] + ' cent' + (num % 100 === 0 ? 's' : ' ' + chunk(num % 100));
      if (num < 2000) return 'mille' + (num % 1000 === 0 ? '' : ' ' + chunk(num % 1000));
      if (num < 1000000) return chunk(Math.floor(num / 1000)) + ' mille' + (num % 1000 === 0 ? '' : ' ' + chunk(num % 1000));
      return String(num);
    }
    return chunk(n);
  }

  // ═══════════════════════════════════════════════════════
  // CONFIG (payment methods, terminal info)
  // ═══════════════════════════════════════════════════════

  router.get('/config', requirePosAuth, (req, res) => {
    const terminal = getTerminal(req);
    const deviceId = req.posDevice?.id || null;
    const deviceName = req.posDevice?.device_name || null;
    // Dernière clôture sur ce terminal → suggère le fond de caisse pour la
    // prochaine ouverture (TakePOS / Dolibarr fait pareil).
    const lastClose = db.prepare(
      `SELECT counted_cash, closed_at, staff_name
         FROM pos_session_closures
        WHERE terminal = ?
        ORDER BY id DESC LIMIT 1`,
    ).get(terminal) || null;
    res.json({
      terminal,
      device_id: deviceId,
      device_name: deviceName,
      warehouse: POS_CONFIG.warehouse,
      defaultCustomer: POS_CONFIG.defaultCustomer,
      receiptName: POS_CONFIG.receiptName,
      last_close: lastClose,
      paymentMethods: Object.entries(PAYMENT_MAP).map(([code, m]) => ({
        code,
        label: m.label,
      })),
    });
  });

  return router;
}
