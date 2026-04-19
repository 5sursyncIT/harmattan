import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import 'dotenv/config';
import { dolibarrApi } from './dolibarr-client.js';

// Dolibarr admin API key (for invoice/payment operations)
const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
if (!ADMIN_API_KEY) console.warn('[SECURITY] DOLIBARR_ADMIN_API_KEY non définie — le POS ne pourra pas facturer');
const adminApi = (await import('axios')).default.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { 'DOLAPIKEY': ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

// POS Configuration
const POS_CONFIG = {
  defaultTerminal: 3,
  warehouse: 4,           // Rayon
  defaultCustomer: 13,    // CLIENT LIBRAIRE
  receiptName: 'HARMATTAN',
};

// Extract terminal number from request (body or query), fallback to default
function getTerminal(req) {
  const t = parseInt(req.body?.terminal || req.query?.terminal);
  return (t >= 1 && t <= 10) ? t : POS_CONFIG.defaultTerminal;
}

// Payment method → Dolibarr payment ID + bank account ID
const PAYMENT_MAP = {
  LIQ:  { paymentId: 4,  bankAccount: 3,  label: 'Espèces' },
  CB:   { paymentId: 6,  bankAccount: 1,  label: 'Carte bancaire' },
  CHQ:  { paymentId: 7,  bankAccount: 1,  label: 'Chèque' },
  WAVE: { paymentId: 54, bankAccount: 6,  label: 'Wave' },
  OM:   { paymentId: 55, bankAccount: 4,  label: 'Orange Money' },
};

export function createPosRouter({ db, dolibarrPool, csrfProtection, safeSqlFilter }) {
  const router = Router();

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
  db.prepare("DELETE FROM pos_sessions WHERE expires_at < datetime('now')").run();

  // Add pin_expires_at column if missing
  try { db.exec('ALTER TABLE pos_staff ADD COLUMN pin_expires_at DATETIME'); } catch (err) { console.warn('Column pin_expires_at already exists or error:', err.message); }
  // Set default expiry for staff without one (15 days from now)
  db.prepare("UPDATE pos_staff SET pin_expires_at = datetime('now', '+15 days') WHERE pin_expires_at IS NULL").run();

  // ─── POS Auth Middleware ────────────────────────────────
  function requirePosAuth(req, res, next) {
    const token = req.headers['x-pos-token'];
    if (!token) return res.status(401).json({ error: 'Authentification POS requise' });
    const session = db.prepare(
      "SELECT ps.staff_id, s.id, s.name, s.role, s.dolibarr_user_id FROM pos_sessions ps JOIN pos_staff s ON s.id = ps.staff_id WHERE ps.token = ? AND ps.expires_at > datetime('now') AND s.active = 1"
    ).get(token);
    if (!session) return res.status(401).json({ error: 'Session POS expirée' });
    req.posStaff = { id: session.id, name: session.name, role: session.role, dolibarr_user_id: session.dolibarr_user_id };
    // Sliding expiration: extend token by 24h on each successful request
    db.prepare("UPDATE pos_sessions SET expires_at = datetime('now', '+24 hours') WHERE token = ?").run(token);
    next();
  }

  // ═══════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════

  router.post('/auth/login', globalPinLimiter, pinLimiter, csrfProtection, (req, res) => {
    try {
      const { pin } = req.body;
      if (!pin || pin.length < 4) {
        return res.status(400).json({ error: 'PIN invalide (4 chiffres minimum)' });
      }

      const staffList = db.prepare('SELECT * FROM pos_staff WHERE active = 1').all();
      for (const s of staffList) {
        if (bcrypt.compareSync(pin, s.pin)) {
          // Check PIN expiry
          const pinExpired = s.pin_expires_at && new Date(s.pin_expires_at) < new Date();
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h
          db.prepare('INSERT INTO pos_sessions (token, staff_id, expires_at) VALUES (?, ?, ?)').run(token, s.id, expiresAt);
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
  router.put('/auth/change-pin', requirePosAuth, csrfProtection, (req, res) => {
    try {
      const { currentPin, newPin } = req.body;
      if (!newPin || newPin.length < 6 || !/^\d+$/.test(newPin)) {
        return res.status(400).json({ error: 'Le nouveau PIN doit contenir au moins 6 chiffres' });
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
    const token = req.headers['x-pos-token'];
    if (token) db.prepare('DELETE FROM pos_sessions WHERE token = ?').run(token);
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
  router.post('/devices/enroll', csrfProtection, (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'Code requis' });

      const upperCode = code.toUpperCase().trim();

      // Check bootstrap code first (for first device ever)
      const bootstrapCode = process.env.POS_BOOTSTRAP_CODE;
      let deviceName = 'Terminal principal';

      if (bootstrapCode && upperCode === bootstrapCode.toUpperCase()) {
        // Bootstrap enrollment
        deviceName = req.body.device_name || 'Terminal principal';
      } else {
        // Normal enrollment via generated code
        const enrollment = db.prepare(
          "SELECT * FROM pos_enrollment_codes WHERE code = ? AND used = 0 AND expires_at > datetime('now')"
        ).get(upperCode);

        if (!enrollment) return res.status(400).json({ error: 'Code invalide ou expiré' });

        deviceName = enrollment.device_name;
        db.prepare('UPDATE pos_enrollment_codes SET used = 1 WHERE code = ?').run(upperCode);
      }

      const deviceToken = crypto.randomBytes(64).toString('hex');
      db.prepare('INSERT INTO pos_devices (device_token, device_name, last_ip) VALUES (?, ?, ?)')
        .run(deviceToken, deviceName, req.socket?.remoteAddress || 'unknown');

      res.json({ device_token: deviceToken, device_name: deviceName });
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

    const { device_name } = req.body;
    if (!device_name?.trim()) return res.status(400).json({ error: "Nom d'appareil requis" });

    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('INSERT INTO pos_enrollment_codes (code, created_by, device_name, expires_at) VALUES (?, ?, ?, ?)')
      .run(code, req.posStaff.id, device_name.trim(), expiresAt);

    res.json({ code, expires_in: 600, device_name: device_name.trim() });
  });

  // List devices (manager only)
  router.get('/devices', requirePosAuth, (req, res) => {
    if (req.posStaff.role !== 'manager') return res.status(403).json({ error: 'Accès manager requis' });
    const devices = db.prepare('SELECT id, device_name, last_seen_at, last_ip, active, created_at FROM pos_devices ORDER BY created_at DESC').all();
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

  const EXCLUDED_CATEGORIES = new Set(['Accueil', 'Racine', 'Services', 'LIBRAIRIE', 'Livres du mois', 'http://senharmattan.com/', 'LIVRES']);

  router.get('/categories', requirePosAuth, async (req, res) => {
    try {
      const response = await dolibarrApi.get('/categories', {
        params: { type: 'product', sortfield: 't.label', sortorder: 'ASC', limit: 200 },
      });
      const categories = (response.data || [])
        .filter(c => !EXCLUDED_CATEGORIES.has(c.label) && parseInt(c.visible) === 1)
        .map(c => ({ id: c.id, label: c.label, description: c.description || '' }));
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
      const { q = '' } = req.query;
      if (q.length < 2) return res.json([]);

      const response = await adminApi.get('/thirdparties', {
        params: {
          sqlfilters: `(t.nom:like:'%${safeSqlFilter(q)}%') OR (t.email:like:'%${safeSqlFilter(q)}%') OR (t.phone:like:'%${safeSqlFilter(q)}%')`,
          limit: 10,
        },
      });

      const customers = (response.data || []).map((c) => ({
        id: c.id,
        name: c.name || c.nom,
        email: c.email,
        phone: c.phone,
      }));

      res.json(customers);
    } catch (err) {
      if (err.response?.status === 404) return res.json([]);
      console.error('POS customer search error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur recherche client' });
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
    try {
      const { items, customer_id, payments, note } = req.body;
      const terminal = getTerminal(req);

      if (!items?.length) return res.status(400).json({ error: 'Aucun article' });
      if (!payments?.length) return res.status(400).json({ error: 'Aucun paiement' });

      // 0. Verify stock availability
      const productIds = items.map(i => parseInt(i.product_id));
      const placeholders = productIds.map(() => '?').join(',');
      const [stockRows] = await dolibarrPool.query(
        `SELECT ps.fk_product, ps.reel, p.label
         FROM llx_product_stock ps
         JOIN llx_product p ON p.rowid = ps.fk_product
         WHERE ps.fk_product IN (${placeholders}) AND ps.fk_entrepot = ${POS_CONFIG.warehouse}`,
        productIds
      );
      const stockMap = Object.fromEntries(stockRows.map(r => [r.fk_product, { stock: r.reel, label: r.label }]));
      const outOfStock = items.filter(i => {
        const s = stockMap[parseInt(i.product_id)];
        return !s || s.stock < i.qty;
      });
      if (outOfStock.length > 0) {
        const names = outOfStock.map(i => {
          const s = stockMap[parseInt(i.product_id)];
          return `${i.label} (demandé: ${i.qty}, dispo: ${s?.stock || 0})`;
        });
        return res.status(400).json({ error: `Stock insuffisant: ${names.join(', ')}` });
      }

      const socid = customer_id || POS_CONFIG.defaultCustomer;
      const today = new Date().toISOString().split('T')[0];

      // 1. Create draft invoice
      const lines = items.map((item) => ({
        fk_product: parseInt(item.product_id),
        qty: item.qty,
        subprice: parseFloat(item.price_ttc),
        tva_tx: 0,
        product_type: 0,
        remise_percent: item.discount || 0,
      }));

      const invoiceRes = await adminApi.post('/invoices', {
        socid: parseInt(socid),
        date: today,
        type: 0,
        module_source: 'takepos',
        pos_source: String(terminal),
        lines,
        note_private: `POS Terminal ${terminal} | Caissier: ${req.posStaff.name}${note ? ' | ' + note : ''}`,
      });

      const invoiceId = invoiceRes.data;

      // 2. Validate invoice (triggers stock decrement from warehouse)
      await adminApi.post(`/invoices/${invoiceId}/validate`, {
        idwarehouse: POS_CONFIG.warehouse,
      });

      // 3. Get invoice details for ref
      const invoiceDetail = await adminApi.get(`/invoices/${invoiceId}`);
      const invoiceRef = invoiceDetail.data.ref;
      const totalTtc = parseFloat(invoiceDetail.data.total_ttc);

      // 4. Record each payment (with rollback on failure)
      let paymentResults = [];
      try {
        for (let i = 0; i < payments.length; i++) {
          const p = payments[i];
          const mapping = PAYMENT_MAP[p.code];
          if (!mapping) {
            console.error(`Unknown payment code: ${p.code}`);
            continue;
          }

          const isLast = i === payments.length - 1;
          const payRes = await adminApi.post(`/invoices/${invoiceId}/payments`, {
            datepaye: Math.floor(Date.now() / 1000),
            paymentid: mapping.paymentId,
            closepaidinvoices: isLast ? 'yes' : 'no',
            accountid: mapping.bankAccount,
            num_payment: invoiceRef,
            comment: `POS T${terminal} - ${mapping.label}`,
            amount: parseFloat(p.amount),
          });
          paymentResults.push({ code: p.code, amount: p.amount, payment_id: payRes.data });
        }
      } catch (payErr) {
        // Payment failed after invoice validated — create credit note to compensate
        console.error(`[POS ROLLBACK] Payment failed for invoice ${invoiceRef}, creating credit note:`, payErr.message);
        try {
          const creditRes = await adminApi.post('/invoices', {
            socid: parseInt(socid),
            date: today,
            type: 2, // Credit note
            fk_facture_source: invoiceId,
            module_source: 'takepos',
            pos_source: String(terminal),
            lines: lines.map(l => ({ ...l, qty: -l.qty })),
            note_private: `AVOIR AUTO - Échec paiement ${invoiceRef} | POS T${terminal}`,
          });
          await adminApi.post(`/invoices/${creditRes.data}/validate`, { idwarehouse: POS_CONFIG.warehouse });
          console.error(`[POS ROLLBACK] Credit note created for invoice ${invoiceRef}`);
        } catch (creditErr) {
          console.error(`[POS ROLLBACK] CRITICAL: Failed to create credit note for ${invoiceRef}:`, creditErr.message);
        }
        throw new Error(`Échec paiement pour facture ${invoiceRef}. Un avoir a été créé automatiquement.`);
      }

      // 5. Mark invoice as paid
      try {
        await adminApi.post(`/invoices/${invoiceId}/settopaid`);
      } catch {
        // May already be set to paid by closepaidinvoices
      }

      res.json({
        invoice_id: invoiceId,
        invoice_ref: invoiceRef,
        total_ttc: totalTtc,
        payments: paymentResults,
        staff: req.posStaff.name,
        terminal,
      });
    } catch (err) {
      console.error('POS sale error:', JSON.stringify(err.response?.data || err.message), 'status:', err.response?.status);
      res.status(500).json({ error: 'Erreur lors de la vente' });
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
      res.json({
        id: inv.id,
        ref: inv.ref,
        total_ttc: parseFloat(inv.total_ttc),
        date: inv.date,
        customer_name: inv.thirdparty?.name || '',
        lines: (inv.lines || []).map(l => ({
          product_id: l.fk_product,
          label: l.product_label || l.desc,
          qty: parseInt(l.qty),
          price_ttc: parseFloat(l.subprice),
          line_total: parseFloat(l.total_ttc),
        })),
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
      const { invoice_id, invoice_ref, items, reason } = req.body;
      const terminal = getTerminal(req);

      if (!invoice_id || !items?.length) return res.status(400).json({ error: 'Facture et articles requis' });

      // Get original invoice
      const original = await adminApi.get(`/invoices/${invoice_id}`);
      const socid = original.data.socid;
      const today = new Date().toISOString().split('T')[0];

      // Create credit note lines (negative qty)
      const lines = items.map(item => ({
        fk_product: parseInt(item.product_id),
        qty: item.qty,
        subprice: parseFloat(item.price_ttc),
        tva_tx: 0,
        product_type: 0,
      }));

      // Create credit note in Dolibarr
      const creditRes = await adminApi.post('/invoices', {
        socid: parseInt(socid),
        date: today,
        type: 2, // Credit note
        fk_facture_source: invoice_id,
        module_source: 'takepos',
        pos_source: String(terminal),
        lines,
        note_private: `AVOIR POS T${terminal} | ${req.posStaff.name} | Ref: ${invoice_ref} | Motif: ${reason || 'Retour'}`,
      });

      const creditId = creditRes.data;
      await adminApi.post(`/invoices/${creditId}/validate`, { idwarehouse: POS_CONFIG.warehouse });

      const creditDetail = await adminApi.get(`/invoices/${creditId}`);

      res.json({
        credit_id: creditId,
        credit_ref: creditDetail.data.ref,
        total_ttc: parseFloat(creditDetail.data.total_ttc),
        original_ref: invoice_ref,
      });
    } catch (err) {
      console.error('POS return error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur création avoir' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // SALES HISTORY (today)
  // ═══════════════════════════════════════════════════════

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

      // Calculate expected totals from today's POS invoices
      const today = new Date().toISOString().split('T')[0];
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
           AND DATE(FROM_UNIXTIME(f.datef)) = ?`,
        [String(terminal), today]
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

      const opening = parseFloat(sessions[0].cash) || 0;
      const expectedCashTotal = opening + (expected.expected_cash || 0) + cashIn - cashOut;

      // Close the session
      await dolibarrPool.query(
        `UPDATE llx_pos_cash_fence
         SET status = 1, date_valid = NOW(),
             cash = ?, card = ?, cheque = ?
         WHERE rowid = ?`,
        [parseFloat(counted_cash), parseFloat(counted_card), parseFloat(counted_cheque), session_id]
      );

      res.json({
        session_id,
        opening,
        expected: {
          cash: expectedCashTotal,
          card: expected.expected_card || 0,
          cheque: expected.expected_cheque || 0,
          wave: expected.expected_wave || 0,
          om: expected.expected_om || 0,
        },
        counted: {
          cash: parseFloat(counted_cash),
          card: parseFloat(counted_card),
          cheque: parseFloat(counted_cheque),
          wave: parseFloat(counted_wave),
          om: parseFloat(counted_om),
        },
        difference: {
          cash: parseFloat(counted_cash) - expectedCashTotal,
          card: parseFloat(counted_card) - (expected.expected_card || 0),
          cheque: parseFloat(counted_cheque) - (expected.expected_cheque || 0),
          wave: parseFloat(counted_wave) - (expected.expected_wave || 0),
          om: parseFloat(counted_om) - (expected.expected_om || 0),
        },
      });
    } catch (err) {
      console.error('POS session close error:', err);
      res.status(500).json({ error: 'Erreur clôture caisse' });
    }
  });

  router.post('/session/cash-in-out', requirePosAuth, csrfProtection, async (req, res) => {
    try {
      const { session_id, type, amount, reason } = req.body;

      if (!session_id || !type || !amount) {
        return res.status(400).json({ error: 'session_id, type et amount requis' });
      }

      if (!['in', 'out'].includes(type)) {
        return res.status(400).json({ error: 'Type doit être "in" ou "out"' });
      }

      if (type === 'out' && req.posStaff.role !== 'manager') {
        return res.status(403).json({ error: 'Sortie espèces réservée aux managers' });
      }

      // Save locally
      const stmt = db.prepare(
        'INSERT INTO pos_cash_movements (session_id, type, amount, reason, staff_id) VALUES (?, ?, ?, ?, ?)'
      );
      const result = stmt.run(session_id, type, parseFloat(amount), reason || null, req.posStaff.id);

      // Sync to Dolibarr bank account (cash account = bankAccount 3)
      try {
        const cashBankId = PAYMENT_MAP.LIQ.bankAccount;
        const signedAmount = type === 'in' ? parseFloat(amount) : -parseFloat(amount);
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

      res.json({ id: result.lastInsertRowid, type, amount: parseFloat(amount), reason });
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
      content = content.replace('{REF}', quote.ref);
      content = content.replace('{DATE}', dateStr);
      content = content.replace('{CLIENT}', quote.customer_name);
      content = content.replace('{TOTAL_AMOUNT}', parseInt(quote.total_ttc).toLocaleString('fr-FR'));
      content = content.replace('{TOTAL_TEXT}', numberToWordsFR(quote.total_ttc) + ' Francs CFA');

      // Find and duplicate the data row for each item
      const rowRegex = /<table:table-row[^>]*>(?:(?!<table:table-row)[\s\S])*?\{ITEM_LABEL\}[\s\S]*?<\/table:table-row>/;
      const rowMatch = content.match(rowRegex);

      if (rowMatch) {
        const templateRow = rowMatch[0];
        const allRows = quote.items.map((item) => {
          const lineTotal = item.line_total || item.qty * item.price_ttc * (1 - (item.discount || 0) / 100);
          return templateRow
            .replace('{ITEM_ISBN}', item.ref || '')
            .replace('{ITEM_LABEL}', item.label)
            .replace('{ITEM_QTY}', String(item.qty))
            .replace('{ITEM_PU}', parseInt(item.price_ttc).toLocaleString('fr-FR'))
            .replace('{ITEM_DISCOUNT}', item.discount > 0 ? `-${item.discount}%` : '')
            .replace('{ITEM_TOTAL}', Math.round(lineTotal).toLocaleString('fr-FR'));
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
    res.json({
      terminal: getTerminal(req),
      warehouse: POS_CONFIG.warehouse,
      defaultCustomer: POS_CONFIG.defaultCustomer,
      receiptName: POS_CONFIG.receiptName,
      paymentMethods: Object.entries(PAYMENT_MAP).map(([code, m]) => ({
        code,
        label: m.label,
      })),
    });
  });

  return router;
}
