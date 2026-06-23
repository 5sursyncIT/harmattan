/**
 * Special Orders Routes — Commandes spéciales (livres indisponibles en stock).
 *
 * Quand un client demande un ouvrage qui n'est pas en stock, L'Harmattan Sénégal
 * ouvre une « commande spéciale » : on enregistre la demande, on suit son
 * acheminement (édition / approvisionnement) jusqu'à la mise à disposition et le
 * retrait par le client, et on encaisse le règlement (intégral, acompte ou
 * tranches) au fil de l'eau.
 *
 * 100 % NATIF (comme les bons de livraison / dépôt-vente) : tout est stocké en
 * SQLite, le PDF du bon de commande est généré localement (ODT → LibreOffice),
 * les paiements sont suivis dans un registre dédié et le client est notifié à
 * chaque étape (email maintenant ; SMS / WhatsApp pluggables).
 *
 * Dolibarr n'est sollicité qu'en lecture (recherche tiers + produits) — aucune
 * écriture comptable tant que la commande n'est pas honorée.
 *
 * Sécurité : monté sur /api/admin/special-orders, whitelist RBAC
 * (super_admin, admin, librarian, comptable, gestionnaire_stock) dans
 * roles-config.js. Mutations protégées CSRF + journalisées (admin_activity_log).
 */

import { Router } from 'express';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';

const EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || "L'Harmattan Sénégal";
const FOOTER_LEGAL = "L'HARMATTAN SENEGAL SARL – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";

// ─── Cycle de vie de la commande ─────────────────────────────
const STATUS = {
  registered:         { label: 'Enregistrée',                  color: '#475569', bg: '#f1f5f9' },
  pending_validation: { label: 'En attente de validation',     color: '#92400e', bg: '#fffbeb' },
  sent_to_supply:     { label: "Envoyée à l'approvisionnement", color: '#1e40af', bg: '#eff6ff' },
  in_production:      { label: "En cours d'acquisition",        color: '#5b21b6', bg: '#f5f3ff' },
  available:          { label: 'Livre disponible',             color: '#166534', bg: '#f0fdf4' },
  client_notified:    { label: 'Client notifié',               color: '#0e7490', bg: '#ecfeff' },
  picked_up:          { label: 'Retirée par le client',        color: '#065f46', bg: '#ecfdf5' },
  closed:             { label: 'Clôturée',                     color: '#334155', bg: '#e2e8f0' },
  cancelled:          { label: 'Annulée',                      color: '#991b1b', bg: '#fef2f2' },
};
// Ordre linéaire du workflow (hors 'cancelled', terminal transverse).
const STATUS_ORDER = ['registered', 'pending_validation', 'sent_to_supply', 'in_production', 'available', 'client_notified', 'picked_up', 'closed'];

// Événement de notification client déclenché par l'ENTRÉE dans un statut.
// (les autres statuts sont des étapes internes — pas de notification automatique)
const STATUS_NOTIFY = {
  sent_to_supply:  'validated',           // « votre commande est validée »
  in_production:   'in_processing',       // « votre livre est en cours d'acquisition »
  client_notified: 'available',           // « votre livre est disponible, venez le retirer »
  picked_up:       'pickup_confirmation', // « merci, commande retirée »
  cancelled:       'cancelled',           // « votre commande a été annulée »
};

// Statuts « en cours de traitement » et « prêts au retrait » pour les KPI.
const IN_PROGRESS = ['pending_validation', 'sent_to_supply', 'in_production'];
const READY = ['available', 'client_notified'];
// Une commande « en retard » : date prévue dépassée alors que le livre n'est pas
// encore disponible / retiré / clôturé / annulé.
const OVERDUE_OPEN = ['registered', 'pending_validation', 'sent_to_supply', 'in_production'];

const PAYMENT_METHODS = ['cash', 'wave', 'orange_money', 'virement', 'cb', 'cheque'];

const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const cleanQty = (v) => Math.max(1, Math.min(100000, parseInt(v, 10) || 0));
const cleanMoney = (v) => Math.max(0, Math.round((parseFloat(v) || 0) * 100) / 100);
const fmtMoney = (n) => (parseInt(n, 10) || 0).toLocaleString('fr-FR') + ' FCFA';
const fmtDateFr = (s) => {
  if (!s) return '—';
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
};

// ─── Schéma SQLite ───────────────────────────────────────────
function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS special_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    fk_soc INTEGER,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    customer_phone TEXT,
    customer_address TEXT,
    expected_date TEXT,
    delay_estimate TEXT,
    status TEXT NOT NULL DEFAULT 'registered',
    total_amount REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS special_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER,
    isbn TEXT,
    title TEXT NOT NULL,
    author TEXT,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    line_total REAL NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS special_order_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_username TEXT,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS special_order_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT,
    reference TEXT,
    note TEXT,
    received_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS special_order_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    event TEXT NOT NULL,
    recipient TEXT,
    status TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sporders_status ON special_orders(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sporders_created ON special_orders(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sporder_lines_order ON special_order_lines(order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sporder_hist_order ON special_order_status_history(order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sporder_pay_order ON special_order_payments(order_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sporder_notif_order ON special_order_notifications(order_id)');
}

// ─── ROUTER FACTORY ──────────────────────────────────────────
export function createSpecialOrdersRouter({
  db, dolibarrPool, auth, csrfProtection,
  transporter, emailService, whatsapp, smsService,
  siteUrl,
}) {
  const router = Router();
  ensureTables(db);
  const noCsrf = csrfProtection || ((req, res, next) => next());

  // Audit dans la table partagée admin_activity_log (créée par admin-routes.js).
  function logActivity(username, action, details) {
    try {
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(username || 'admin', action, typeof details === 'string' ? details : JSON.stringify(details || {}));
    } catch (e) { void e; }
  }

  // Réf CS{aamm}-{0001}. Encapsulé dans une transaction → pas de collision UNIQUE.
  function generateRef() {
    const now = new Date();
    const yymm = String(now.getFullYear() % 100).padStart(2, '0') + String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `CS${yymm}-`;
    const max = db.prepare('SELECT MAX(ref) AS max FROM special_orders WHERE ref LIKE ?').get(`${prefix}%`);
    let next = 1;
    if (max?.max) next = (parseInt(String(max.max).split('-')[1], 10) || 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  function computeTotals(orderId, totalAmount) {
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM special_order_payments WHERE order_id = ?').get(orderId).s;
    const total = Number(totalAmount || 0);
    const paidN = Number(paid || 0);
    return { total, paid: paidN, balance: Math.max(0, Math.round((total - paidN) * 100) / 100) };
  }

  function statusDto(key) {
    const s = STATUS[key] || { label: key, color: '#475569', bg: '#f1f5f9' };
    return { key, label: s.label, color: s.color, bg: s.bg };
  }

  // Lignes commande → normalisation depuis le body.
  function sanitizeLines(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((l) => {
        const quantity = cleanQty(l.quantity);
        const unit_price = cleanMoney(l.unit_price);
        return {
          product_id: l.product_id ? parseInt(l.product_id, 10) : null,
          isbn: String(l.isbn || '').trim().slice(0, 40) || null,
          title: String(l.title || l.label || '').trim().slice(0, 300),
          author: String(l.author || '').trim().slice(0, 200) || null,
          quantity,
          unit_price,
          line_total: Math.round(quantity * unit_price * 100) / 100,
        };
      })
      .filter((l) => l.title);
  }

  function orderToDto(row, { withChildren = false } = {}) {
    const totals = computeTotals(row.id, row.total_amount);
    const dto = {
      id: row.id,
      ref: row.ref,
      customer: {
        id: row.fk_soc || null,
        name: row.customer_name,
        email: row.customer_email,
        phone: row.customer_phone,
        address: row.customer_address,
      },
      expectedDate: row.expected_date,
      delayEstimate: row.delay_estimate,
      status: row.status,
      statusInfo: statusDto(row.status),
      totals,
      notes: row.notes,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      overdue: !!(row.expected_date && OVERDUE_OPEN.includes(row.status)
        && String(row.expected_date) < new Date().toISOString().slice(0, 10)),
    };
    if (withChildren) {
      dto.lines = db.prepare('SELECT * FROM special_order_lines WHERE order_id = ? ORDER BY id ASC').all(row.id);
      dto.payments = db.prepare('SELECT * FROM special_order_payments WHERE order_id = ? ORDER BY created_at ASC, id ASC').all(row.id);
      dto.history = db.prepare('SELECT * FROM special_order_status_history WHERE order_id = ? ORDER BY created_at ASC, id ASC')
        .all(row.id).map((h) => ({ ...h, fromInfo: h.from_status ? statusDto(h.from_status) : null, toInfo: statusDto(h.to_status) }));
      dto.notifications = db.prepare('SELECT * FROM special_order_notifications WHERE order_id = ? ORDER BY created_at DESC, id DESC').all(row.id);
    }
    return dto;
  }

  function getRow(id) {
    return db.prepare('SELECT * FROM special_orders WHERE id = ?').get(parseInt(id, 10));
  }

  // ── Dispatcher de notifications (email réel ; SMS / WhatsApp pluggables) ──
  function logNotif(orderId, channel, event, recipient, status, detail) {
    try {
      db.prepare('INSERT INTO special_order_notifications (order_id, channel, event, recipient, status, detail) VALUES (?,?,?,?,?,?)')
        .run(orderId, channel, event, recipient || null, status, detail || null);
    } catch (e) { void e; }
  }

  async function notifyOrder(orderRow, event, { channels } = {}) {
    const dto = orderToDto(orderRow, { withChildren: true });
    const firstname = (orderRow.customer_name || '').trim().split(/\s+/)[0] || '';
    const payload = {
      ref: orderRow.ref,
      customer: { name: orderRow.customer_name, firstname, email: orderRow.customer_email, phone: orderRow.customer_phone },
      items: dto.lines.map((l) => ({ label: l.title + (l.author ? ` — ${l.author}` : ''), quantity: l.quantity, price_ttc: l.unit_price })),
      total: dto.totals.total,
      paid: dto.totals.paid,
      balance: dto.totals.balance,
      expected_date: orderRow.expected_date,
      delay_estimate: orderRow.delay_estimate,
    };

    // Canaux : par défaut email + canaux activés (SMS / WhatsApp).
    const wanted = channels && channels.length
      ? channels
      : ['email',
        ...(smsService?.isSmsEnabled?.() ? ['sms'] : []),
        ...(whatsapp?.isWhatsAppEnabled?.() ? ['whatsapp'] : [])];

    // EMAIL
    if (wanted.includes('email')) {
      if (orderRow.customer_email && transporter && emailService?.sendSpecialOrderNotification) {
        let ok = false;
        try { ok = await emailService.sendSpecialOrderNotification({ transporter, order: payload, event, siteUrl }); }
        catch (e) { ok = false; console.error('[SPECIAL-ORDERS] email failed:', e.message); }
        logNotif(orderRow.id, 'email', event, orderRow.customer_email, ok ? 'sent' : 'failed', ok ? null : 'Échec envoi SMTP');
      } else {
        logNotif(orderRow.id, 'email', event, orderRow.customer_email || '', 'skipped',
          orderRow.customer_email ? 'Service email indisponible' : 'Aucune adresse email');
      }
    }

    // SMS (pluggable — stub no-op tant que non configuré)
    if (wanted.includes('sms')) {
      if (orderRow.customer_phone && smsService?.sendSpecialOrderSms) {
        let r = { ok: false, skipped: true };
        try { r = await smsService.sendSpecialOrderSms({ phone: orderRow.customer_phone, event, order: payload }); }
        catch (e) { r = { ok: false, error: e.message }; }
        logNotif(orderRow.id, 'sms', event, orderRow.customer_phone,
          r.skipped ? 'skipped' : (r.ok ? 'sent' : 'failed'), r.error || (r.skipped ? 'SMS non configuré' : null));
      } else {
        logNotif(orderRow.id, 'sms', event, orderRow.customer_phone || '', 'skipped',
          orderRow.customer_phone ? 'SMS non configuré' : 'Aucun téléphone');
      }
    }

    // WHATSAPP (pluggable — stub no-op tant que non configuré)
    if (wanted.includes('whatsapp')) {
      if (orderRow.customer_phone && whatsapp?.sendSpecialOrderUpdate) {
        let r = { ok: false, skipped: true };
        try { r = await whatsapp.sendSpecialOrderUpdate({ phone: orderRow.customer_phone, firstname, event, orderRef: orderRow.ref }); }
        catch (e) { r = { ok: false, error: e.message }; }
        logNotif(orderRow.id, 'whatsapp', event, orderRow.customer_phone,
          r.skipped ? 'skipped' : (r.ok ? 'sent' : 'failed'), r.error || (r.skipped ? 'WhatsApp non configuré' : null));
      } else {
        logNotif(orderRow.id, 'whatsapp', event, orderRow.customer_phone || '', 'skipped',
          orderRow.customer_phone ? 'WhatsApp non configuré' : 'Aucun téléphone');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // RESSOURCES (recherche tiers + produits Dolibarr) — avant /:id
  // ═══════════════════════════════════════════════════════════
  router.get('/search/customers', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ customers: [] });
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, code_client, email, phone, address, zip, town
         FROM llx_societe
         WHERE status = 1 AND (nom LIKE ? OR code_client LIKE ? OR email LIKE ? OR phone LIKE ?)
         ORDER BY nom ASC LIMIT 20`,
        [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]
      );
      res.json({ customers: rows.map((r) => ({
        id: r.id, name: r.nom, code: r.code_client, email: r.email, phone: r.phone,
        address: [r.address, [r.zip, r.town].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      })) });
    } catch (err) {
      console.error('[SPECIAL-ORDERS] customers search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche client' });
    }
  });

  router.get('/search/products', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ products: [] });
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, barcode, price_ttc
         FROM llx_product
         WHERE (ref LIKE ? OR label LIKE ? OR barcode LIKE ?)
         ORDER BY label ASC LIMIT 20`,
        [`%${q}%`, `%${q}%`, `%${q}%`]
      );
      res.json({ products: rows.map((r) => ({
        id: r.id, ref: r.ref, title: r.label, isbn: r.barcode, price_ttc: Number(r.price_ttc || 0),
      })) });
    } catch (err) {
      console.error('[SPECIAL-ORDERS] products search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche produit' });
    }
  });

  // Constantes UI (statuts, méthodes de paiement) pour le frontend.
  router.get('/meta', auth, (req, res) => {
    res.json({
      statuses: STATUS_ORDER.map(statusDto).concat([statusDto('cancelled')]),
      paymentMethods: PAYMENT_METHODS,
    });
  });

  // ═══════════════════════════════════════════════════════════
  // LISTE + KPI (dashboard)
  // ═══════════════════════════════════════════════════════════
  router.get('/', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.status && STATUS[req.query.status]) { where.push('o.status = ?'); params.push(req.query.status); }
      if (req.query.search) {
        const pat = `%${req.query.search}%`;
        where.push(`(o.ref LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?
          OR EXISTS (SELECT 1 FROM special_order_lines l WHERE l.order_id = o.id AND (l.title LIKE ? OR l.isbn LIKE ?)))`);
        params.push(pat, pat, pat, pat, pat);
      }
      if (req.query.date_from) { where.push('date(o.created_at) >= date(?)'); params.push(req.query.date_from); }
      if (req.query.date_to)   { where.push('date(o.created_at) <= date(?)'); params.push(req.query.date_to); }
      if (req.query.overdue === '1') {
        where.push(`o.expected_date IS NOT NULL AND o.expected_date < date('now') AND o.status IN (${OVERDUE_OPEN.map(() => '?').join(',')})`);
        params.push(...OVERDUE_OPEN);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM special_orders o ${whereSql}`).get(...params).n;
      const rows = db.prepare(`SELECT o.* FROM special_orders o ${whereSql} ORDER BY o.id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);

      // Résumé des ouvrages (1ʳᵉ ligne + nombre) pour l'affichage en liste.
      const summaryStmt = db.prepare('SELECT title, COUNT(*) AS n, SUM(quantity) AS q FROM special_order_lines WHERE order_id = ? GROUP BY order_id');
      const firstTitleStmt = db.prepare('SELECT title FROM special_order_lines WHERE order_id = ? ORDER BY id ASC LIMIT 1');

      res.json({
        orders: rows.map((r) => {
          const dto = orderToDto(r);
          const sum = summaryStmt.get(r.id);
          const first = firstTitleStmt.get(r.id);
          dto.books = { count: sum ? Number(sum.n) : 0, qty: sum ? Number(sum.q) : 0, firstTitle: first ? first.title : null };
          return dto;
        }),
        total, page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: computeDashboardKpis(),
      });
    } catch (err) {
      console.error('[SPECIAL-ORDERS] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement commandes spéciales' });
    }
  });

  // KPI globaux (non filtrés) pour le tableau de bord.
  function computeDashboardKpis() {
    const byStatusRows = db.prepare('SELECT status, COUNT(*) AS n FROM special_orders GROUP BY status').all();
    const byStatus = {};
    for (const r of byStatusRows) byStatus[r.status] = Number(r.n);
    const count = (keys) => keys.reduce((s, k) => s + (byStatus[k] || 0), 0);

    const total = db.prepare('SELECT COUNT(*) AS n FROM special_orders').get().n;
    const collected = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM special_order_payments').get().s;
    // Solde dû : Σ (total_amount − payé) sur les commandes non clôturées/annulées.
    const balanceRow = db.prepare(`
      SELECT COALESCE(SUM(o.total_amount),0) AS billed,
             COALESCE((SELECT SUM(p.amount) FROM special_order_payments p
                       JOIN special_orders o2 ON o2.id = p.order_id
                       WHERE o2.status NOT IN ('closed','cancelled')),0) AS paid_open
      FROM special_orders o WHERE o.status NOT IN ('closed','cancelled')`).get();
    const balanceDue = Math.max(0, Number(balanceRow.billed || 0) - Number(balanceRow.paid_open || 0));
    const overdue = db.prepare(`SELECT COUNT(*) AS n FROM special_orders
      WHERE expected_date IS NOT NULL AND expected_date < date('now')
      AND status IN (${OVERDUE_OPEN.map(() => '?').join(',')})`).get(...OVERDUE_OPEN).n;

    return {
      total: Number(total),
      pending: count(IN_PROGRESS),          // « en cours de traitement »
      ready: count(READY),                  // « prêtes à être retirées »
      pickedUp: byStatus.picked_up || 0,
      closed: byStatus.closed || 0,
      cancelled: byStatus.cancelled || 0,
      registered: byStatus.registered || 0,
      overdue: Number(overdue),
      collected: Number(collected),
      balanceDue,
      byStatus,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CRÉATION
  // ═══════════════════════════════════════════════════════════
  router.post('/', auth, noCsrf, async (req, res) => {
    try {
      const b = req.body || {};
      const customerName = String(b.customer_name || '').trim().slice(0, 200);
      if (!customerName) return res.status(400).json({ error: 'Client requis' });
      const lines = sanitizeLines(b.lines);
      if (lines.length === 0) return res.status(400).json({ error: 'Au moins un livre demandé' });

      const totalAmount = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
      const initialPayment = cleanMoney(b.initial_payment);
      if (initialPayment > totalAmount + 0.01) {
        return res.status(400).json({ error: 'Le règlement initial dépasse le montant total' });
      }

      const username = req.admin?.username || 'admin';
      const create = db.transaction(() => {
        const ref = generateRef();
        const r = db.prepare(`INSERT INTO special_orders (
          ref, fk_soc, customer_name, customer_email, customer_phone, customer_address,
          expected_date, delay_estimate, status, total_amount, notes, created_by
        ) VALUES (?,?,?,?,?,?,?,?, 'registered', ?, ?, ?)`).run(
          ref,
          b.fk_soc ? parseInt(b.fk_soc, 10) : null,
          customerName,
          String(b.customer_email || '').trim().slice(0, 200) || null,
          String(b.customer_phone || '').trim().slice(0, 60) || null,
          String(b.customer_address || '').trim().slice(0, 400) || null,
          String(b.expected_date || '').trim().slice(0, 10) || null,
          String(b.delay_estimate || '').trim().slice(0, 120) || null,
          totalAmount,
          String(b.notes || '').trim().slice(0, 2000) || null,
          username,
        );
        const orderId = r.lastInsertRowid;
        const insLine = db.prepare(`INSERT INTO special_order_lines
          (order_id, product_id, isbn, title, author, quantity, unit_price, line_total)
          VALUES (?,?,?,?,?,?,?,?)`);
        for (const l of lines) insLine.run(orderId, l.product_id, l.isbn, l.title, l.author, l.quantity, l.unit_price, l.line_total);
        db.prepare('INSERT INTO special_order_status_history (order_id, from_status, to_status, actor_username, comment) VALUES (?,?,?,?,?)')
          .run(orderId, null, 'registered', username, 'Commande spéciale enregistrée');
        if (initialPayment > 0) {
          db.prepare(`INSERT INTO special_order_payments (order_id, amount, method, reference, note, received_by) VALUES (?,?,?,?,?,?)`)
            .run(orderId, initialPayment, PAYMENT_METHODS.includes(b.payment_method) ? b.payment_method : 'cash',
              String(b.payment_reference || '').trim().slice(0, 120) || null, 'Règlement à la commande', username);
        }
        return { orderId, ref };
      });

      const { orderId, ref } = create();
      logActivity(username, 'special_order_created', { id: orderId, ref, total: totalAmount, lines: lines.length });

      // Confirmation client (best-effort) — ne bloque pas la réponse.
      const row = getRow(orderId);
      notifyOrder(row, 'order_confirmation').catch((e) => console.error('[SPECIAL-ORDERS] notify create:', e.message));

      res.status(201).json({ id: orderId, ref });
    } catch (err) {
      console.error('[SPECIAL-ORDERS] create error:', err.message);
      res.status(500).json({ error: 'Erreur création commande spéciale' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', auth, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      res.json(orderToDto(row, { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement commande' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // MISE À JOUR (métadonnées + lignes tant que la commande est tôt dans le cycle)
  // ═══════════════════════════════════════════════════════════
  router.patch('/:id', auth, noCsrf, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      if (['closed', 'cancelled'].includes(row.status)) {
        return res.status(409).json({ error: 'Commande clôturée ou annulée — non modifiable' });
      }
      const b = req.body || {};
      const username = req.admin?.username || 'admin';

      // Champs « méta » toujours modifiables.
      const sets = [];
      const params = [];
      const setField = (col, val) => { sets.push(`${col} = ?`); params.push(val); };
      if (b.customer_email !== undefined) setField('customer_email', String(b.customer_email || '').trim().slice(0, 200) || null);
      if (b.customer_phone !== undefined) setField('customer_phone', String(b.customer_phone || '').trim().slice(0, 60) || null);
      if (b.customer_address !== undefined) setField('customer_address', String(b.customer_address || '').trim().slice(0, 400) || null);
      if (b.expected_date !== undefined) setField('expected_date', String(b.expected_date || '').trim().slice(0, 10) || null);
      if (b.delay_estimate !== undefined) setField('delay_estimate', String(b.delay_estimate || '').trim().slice(0, 120) || null);
      if (b.notes !== undefined) setField('notes', String(b.notes || '').trim().slice(0, 2000) || null);

      // Lignes modifiables uniquement avant l'envoi à l'approvisionnement.
      let newLines = null;
      if (b.lines !== undefined) {
        if (!['registered', 'pending_validation'].includes(row.status)) {
          return res.status(409).json({ error: "Les livres ne sont plus modifiables après l'envoi à l'approvisionnement" });
        }
        newLines = sanitizeLines(b.lines);
        if (newLines.length === 0) return res.status(400).json({ error: 'Au moins un livre demandé' });
        setField('total_amount', Math.round(newLines.reduce((s, l) => s + l.line_total, 0) * 100) / 100);
      }

      if (sets.length === 0) return res.json(orderToDto(row, { withChildren: true }));

      const update = db.transaction(() => {
        db.prepare(`UPDATE special_orders SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params, row.id);
        if (newLines) {
          db.prepare('DELETE FROM special_order_lines WHERE order_id = ?').run(row.id);
          const insLine = db.prepare(`INSERT INTO special_order_lines
            (order_id, product_id, isbn, title, author, quantity, unit_price, line_total) VALUES (?,?,?,?,?,?,?,?)`);
          for (const l of newLines) insLine.run(row.id, l.product_id, l.isbn, l.title, l.author, l.quantity, l.unit_price, l.line_total);
        }
      });
      update();
      logActivity(username, 'special_order_updated', { id: row.id, ref: row.ref, fields: sets.length, lines: newLines ? newLines.length : undefined });
      res.json(orderToDto(getRow(row.id), { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] update error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour commande' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // TRANSITION DE STATUT (workflow)
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/status', auth, noCsrf, async (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const to = String(req.body?.status || '').trim();
      if (!STATUS[to]) return res.status(400).json({ error: 'Statut inconnu' });
      if (!canTransition(row.status, to)) {
        return res.status(409).json({ error: `Transition impossible : ${STATUS[row.status].label} → ${STATUS[to].label}` });
      }
      const comment = String(req.body?.comment || '').trim().slice(0, 1000) || null;
      const username = req.admin?.username || 'admin';
      const closing = (to === 'closed' || to === 'cancelled');

      db.transaction(() => {
        db.prepare(`UPDATE special_orders SET status = ?, updated_at = CURRENT_TIMESTAMP${closing ? ', closed_at = CURRENT_TIMESTAMP' : ''} WHERE id = ?`)
          .run(to, row.id);
        db.prepare('INSERT INTO special_order_status_history (order_id, from_status, to_status, actor_username, comment) VALUES (?,?,?,?,?)')
          .run(row.id, row.status, to, username, comment);
      })();
      logActivity(username, 'special_order_status', { id: row.id, ref: row.ref, from: row.status, to });

      // Notification client si l'entrée dans ce statut en déclenche une.
      const event = STATUS_NOTIFY[to];
      const updated = getRow(row.id);
      if (event) {
        await notifyOrder(updated, event).catch((e) => console.error('[SPECIAL-ORDERS] notify status:', e.message));
      }
      res.json(orderToDto(updated, { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] status error:', err.message);
      res.status(500).json({ error: 'Erreur changement de statut' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PAIEMENTS (acompte / tranches)
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/payments', auth, noCsrf, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      if (row.status === 'cancelled') return res.status(409).json({ error: 'Commande annulée — aucun encaissement possible' });
      const amount = cleanMoney(req.body?.amount);
      if (amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
      const { balance } = computeTotals(row.id, row.total_amount);
      if (amount > balance + 0.01) {
        return res.status(400).json({ error: `Le montant dépasse le solde restant dû (${fmtMoney(balance)})` });
      }
      const method = PAYMENT_METHODS.includes(req.body?.method) ? req.body.method : 'cash';
      const username = req.admin?.username || 'admin';
      db.prepare(`INSERT INTO special_order_payments (order_id, amount, method, reference, note, received_by) VALUES (?,?,?,?,?,?)`)
        .run(row.id, amount, method,
          String(req.body?.reference || '').trim().slice(0, 120) || null,
          String(req.body?.note || '').trim().slice(0, 300) || null,
          username);
      db.prepare('UPDATE special_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      logActivity(username, 'special_order_payment', { id: row.id, ref: row.ref, amount, method });
      res.status(201).json(orderToDto(getRow(row.id), { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] payment error:', err.message);
      res.status(500).json({ error: 'Erreur enregistrement paiement' });
    }
  });

  // Suppression d'un paiement (correction de saisie).
  router.delete('/:id/payments/:paymentId', auth, noCsrf, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const pay = db.prepare('SELECT * FROM special_order_payments WHERE id = ? AND order_id = ?')
        .get(parseInt(req.params.paymentId, 10), row.id);
      if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
      db.prepare('DELETE FROM special_order_payments WHERE id = ?').run(pay.id);
      db.prepare('UPDATE special_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      logActivity(req.admin?.username || 'admin', 'special_order_payment_deleted', { id: row.id, ref: row.ref, amount: pay.amount });
      res.json(orderToDto(getRow(row.id), { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] delete payment error:', err.message);
      res.status(500).json({ error: 'Erreur suppression paiement' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // NOTIFICATION MANUELLE (ex. rappel de solde)
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/notify', auth, noCsrf, async (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const ALLOWED_EVENTS = ['order_confirmation', 'validated', 'in_processing', 'available', 'balance_reminder', 'pickup_confirmation'];
      const event = ALLOWED_EVENTS.includes(req.body?.event) ? req.body.event : 'balance_reminder';
      const channels = Array.isArray(req.body?.channels) && req.body.channels.length
        ? req.body.channels.filter((c) => ['email', 'sms', 'whatsapp'].includes(c))
        : ['email'];
      await notifyOrder(row, event, { channels });
      logActivity(req.admin?.username || 'admin', 'special_order_notify', { id: row.id, ref: row.ref, event, channels });
      res.json(orderToDto(getRow(row.id), { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] notify error:', err.message);
      res.status(500).json({ error: 'Erreur envoi notification' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SUPPRESSION (uniquement une commande enregistrée sans paiement)
  // ═══════════════════════════════════════════════════════════
  router.delete('/:id', auth, noCsrf, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const paid = computeTotals(row.id, row.total_amount).paid;
      if (paid > 0 || row.status !== 'registered') {
        return res.status(409).json({ error: 'Seule une commande enregistrée sans paiement peut être supprimée. Sinon, annulez-la.' });
      }
      db.transaction(() => {
        db.prepare('DELETE FROM special_order_lines WHERE order_id = ?').run(row.id);
        db.prepare('DELETE FROM special_order_status_history WHERE order_id = ?').run(row.id);
        db.prepare('DELETE FROM special_order_notifications WHERE order_id = ?').run(row.id);
        db.prepare('DELETE FROM special_order_payments WHERE order_id = ?').run(row.id);
        db.prepare('DELETE FROM special_orders WHERE id = ?').run(row.id);
      })();
      logActivity(req.admin?.username || 'admin', 'special_order_deleted', { id: row.id, ref: row.ref });
      res.json({ success: true });
    } catch (err) {
      console.error('[SPECIAL-ORDERS] delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression commande' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PDF — Bon de commande (ODT → LibreOffice)
  // ═══════════════════════════════════════════════════════════
  router.get('/:id/pdf', auth, (req, res) => {
    let tmpDir;
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const dto = orderToDto(row, { withChildren: true });

      tmpDir = join('/tmp', `cs-${row.id}-${Date.now()}`);
      mkdirSync(join(tmpDir, 'META-INF'), { recursive: true });
      writeFileSync(join(tmpDir, 'mimetype'), 'application/vnd.oasis.opendocument.text');
      writeFileSync(join(tmpDir, 'META-INF/manifest.xml'), SO_MANIFEST);
      writeFileSync(join(tmpDir, 'styles.xml'), buildSoStyles());
      writeFileSync(join(tmpDir, 'content.xml'), buildSoContent(dto));

      const odt = join(tmpDir, 'cs.odt');
      execFileSync('zip', ['-q', '-X', '-0', odt, 'mimetype'], { cwd: tmpDir });
      execFileSync('zip', ['-q', '-r', '-X', odt, 'META-INF', 'content.xml', 'styles.xml'], { cwd: tmpDir });

      const profile = join(tmpDir, 'profile');
      mkdirSync(profile, { recursive: true });
      execFileSync('soffice', [
        '--headless', '--norestore', '--nologo', '--nofirststartwizard',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to', 'pdf', '--outdir', tmpDir, odt,
      ], { stdio: 'pipe', timeout: 60000 });

      const pdfPath = join(tmpDir, 'cs.pdf');
      if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée');
      const buf = readFileSync(pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${dto.ref}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[SPECIAL-ORDERS] pdf error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  return router;
}

// Transition autorisée : avance (saut possible), recul d'un cran, ou annulation.
function canTransition(from, to) {
  if (from === to) return false;
  if (to === 'cancelled') return !['closed', 'cancelled', 'picked_up'].includes(from);
  if (from === 'cancelled' || from === 'closed') return false;
  const fi = STATUS_ORDER.indexOf(from);
  const ti = STATUS_ORDER.indexOf(to);
  if (fi === -1 || ti === -1) return false;
  return ti > fi || ti === fi - 1;
}

// ─── GÉNÉRATION ODT ──────────────────────────────────────────
const SO_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

const SO_PRIMARY = '#10531a';
const SO_MUTED = '#6b7280';

export function buildSoStyles() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties fo:margin-bottom="0.15cm" fo:line-height="130%"/>
   <style:text-properties style:font-name="Liberation Sans" fo:font-size="10.5pt" fo:color="#1a1a1a" fo:language="fr" fo:country="FR"/>
  </style:default-style>
  <style:style style:name="Editor" style:family="paragraph"><style:text-properties fo:font-size="15pt" fo:font-weight="bold" fo:color="${SO_PRIMARY}"/></style:style>
  <style:style style:name="Tag" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.4cm" fo:border-bottom="1pt solid ${SO_PRIMARY}" fo:padding-bottom="0.2cm"/><style:text-properties fo:font-size="8.5pt" fo:color="${SO_MUTED}" fo:letter-spacing="0.05cm"/></style:style>
  <style:style style:name="DocTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.2cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="20pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${SO_PRIMARY}"/></style:style>
  <style:style style:name="DocRef" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.5cm"/><style:text-properties fo:font-size="11pt" fo:color="${SO_MUTED}"/></style:style>
  <style:style style:name="BlockTitle" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.3cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${SO_MUTED}"/></style:style>
  <style:style style:name="Box" style:family="paragraph"><style:paragraph-properties fo:background-color="#f0fdf4" fo:border-left="3pt solid ${SO_PRIMARY}" fo:padding="0.3cm 0.4cm" fo:margin-bottom="0.3cm"/></style:style>
  <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Muted" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.15cm"/><style:text-properties fo:font-size="9pt" fo:color="${SO_MUTED}"/></style:style>
  <style:style style:name="FooterLegal" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="7.5pt" fo:color="${SO_MUTED}"/></style:style>
  <style:style style:name="SignHead" style:family="paragraph"><style:paragraph-properties fo:margin-top="1cm" fo:text-align="center" fo:keep-with-next="always"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.1cm" fo:color="${SO_PRIMARY}"/></style:style>
  <style:style style:name="SignLine" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="SignBox" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:border="0.3pt dashed ${SO_MUTED}" fo:padding="1.1cm 0.4cm" fo:margin-top="0.2cm"/><style:text-properties fo:font-size="8pt" fo:color="${SO_MUTED}"/></style:style>
  <style:style style:name="THead" style:family="table-cell"><style:table-cell-properties fo:background-color="${SO_PRIMARY}" fo:padding="0.15cm 0.25cm"/></style:style>
  <style:style style:name="TCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.12cm 0.25cm" fo:border-bottom="0.3pt solid #d1d5db"/></style:style>
  <style:style style:name="THeadP" style:family="paragraph"><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPR" style:family="paragraph"><style:paragraph-properties fo:text-align="right"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="TCellC" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
  <style:style style:name="TCellR" style:family="paragraph"><style:paragraph-properties fo:text-align="right"/></style:style>
  <style:style style:name="Total" style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="0.15cm"/><style:text-properties fo:font-size="10.5pt"/></style:style>
  <style:style style:name="TotalStrong" style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="0.2cm"/><style:text-properties fo:font-size="12pt" fo:font-weight="bold" fo:color="${SO_PRIMARY}"/></style:style>
  <style:style style:name="Due" style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="0.1cm"/><style:text-properties fo:font-size="11pt" fo:font-weight="bold" fo:color="#b45309"/></style:style>
  <style:style style:name="DTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.3cm" fo:margin-bottom="0.2cm"/></style:style>
  <style:style style:name="ColRef" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>
  <style:style style:name="ColLabel" style:family="table-column"><style:table-column-properties style:column-width="7.6cm"/></style:style>
  <style:style style:name="ColQty" style:family="table-column"><style:table-column-properties style:column-width="1.6cm"/></style:style>
  <style:style style:name="ColPU" style:family="table-column"><style:table-column-properties style:column-width="2.2cm"/></style:style>
  <style:style style:name="ColTot" style:family="table-column"><style:table-column-properties style:column-width="2.2cm"/></style:style>
  <style:style style:name="SignTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="center" fo:margin-top="0.4cm"/></style:style>
  <style:style style:name="SignCol" style:family="table-column"><style:table-column-properties style:column-width="8.3cm"/></style:style>
  <style:style style:name="SignCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.3cm"/></style:style>
 </office:styles>
 <office:automatic-styles>
  <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.2cm" fo:margin-right="2.2cm"/>
   <style:footer-style><style:header-footer-properties fo:min-height="1cm" fo:margin-top="0.4cm"/></style:footer-style>
  </style:page-layout>
 </office:automatic-styles>
 <office:master-styles>
  <style:master-page style:name="Standard" style:page-layout-name="pm1">
   <style:footer><text:p text:style-name="FooterLegal">${escXml(FOOTER_LEGAL)}</text:p></style:footer>
  </style:master-page>
 </office:master-styles>
</office:document-styles>`;
}

export function buildSoContent(dto) {
  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const c = dto.customer;
  const addr = [c.address].filter(Boolean);
  let clientBox = `<text:p text:style-name="Box"><text:span text:style-name="Bold">${escXml(c.name)}</text:span>`;
  if (c.phone) clientBox += `<text:line-break/>Tél : ${escXml(c.phone)}`;
  if (c.email) clientBox += `<text:line-break/>${escXml(c.email)}`;
  for (const a of addr) clientBox += `<text:line-break/>${escXml(a)}`;
  clientBox += `</text:p>`;

  const rows = dto.lines.map((l) => `
   <table:table-row>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(l.isbn || '—')}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(l.title)}${l.author ? `<text:line-break/>${escXml(l.author)}` : ''}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellC">${escXml(String(l.quantity))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(fmtMoney(l.unit_price))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(fmtMoney(l.line_total))}</text:p></table:table-cell>
   </table:table-row>`).join('');

  const delayLine = (dto.expectedDate || dto.delayEstimate)
    ? `<text:p text:style-name="Muted">Disponibilité prévue : <text:span text:style-name="Bold">${escXml(dto.expectedDate ? fmtDateFr(dto.expectedDate) : dto.delayEstimate)}</text:span>${dto.expectedDate && dto.delayEstimate ? ` (${escXml(dto.delayEstimate)})` : ''}</text:p>`
    : '';
  const noteLine = dto.notes ? `<text:p text:style-name="Muted">Note : ${escXml(dto.notes)}</text:p>` : '';
  const paidLine = dto.totals.paid > 0
    ? `<text:p text:style-name="Total">Déjà réglé : ${escXml(fmtMoney(dto.totals.paid))}</text:p>` : '';
  const dueLine = dto.totals.balance > 0
    ? `<text:p text:style-name="Due">Reste à payer : ${escXml(fmtMoney(dto.totals.balance))}</text:p>`
    : `<text:p text:style-name="Total"><text:span text:style-name="Bold">Soldée — réglée intégralement</text:span></text:p>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:automatic-styles/>
 <office:body><office:text>
  <text:p text:style-name="Editor">${escXml(EDITOR_NAME)}</text:p>
  <text:p text:style-name="Tag">ÉDITION · DIFFUSION · LIBRAIRIE — Faire revenir le livre dans le quotidien des Sénégalais</text:p>

  <text:p text:style-name="DocTitle">BON DE COMMANDE SPÉCIALE</text:p>
  <text:p text:style-name="DocRef">N° <text:span text:style-name="Bold">${escXml(dto.ref)}</text:span> · ${escXml(today)}</text:p>

  <text:p text:style-name="BlockTitle">CLIENT</text:p>
  ${clientBox}
  ${delayLine}

  <text:p text:style-name="BlockTitle">OUVRAGES COMMANDÉS</text:p>
  <table:table table:name="Lines" table:style-name="DTable">
   <table:table-column table:style-name="ColRef"/>
   <table:table-column table:style-name="ColLabel"/>
   <table:table-column table:style-name="ColQty"/>
   <table:table-column table:style-name="ColPU"/>
   <table:table-column table:style-name="ColTot"/>
   <table:table-row>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">ISBN</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Titre / Auteur</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPC">Qté</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">P.U.</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Total</text:p></table:table-cell>
   </table:table-row>${rows}
  </table:table>

  <text:p text:style-name="TotalStrong">Total : ${escXml(fmtMoney(dto.totals.total))}</text:p>
  ${paidLine}
  ${dueLine}
  ${noteLine}

  <text:p text:style-name="SignHead">BON POUR COMMANDE</text:p>
  <table:table table:name="Sign" table:style-name="SignTable">
   <table:table-column table:style-name="SignCol"/>
   <table:table-column table:style-name="SignCol"/>
   <table:table-row>
    <table:table-cell table:style-name="SignCell">
     <text:p text:style-name="SignLine">LE CLIENT</text:p>
     <text:p text:style-name="SignBox">Nom, date et signature</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="SignCell">
     <text:p text:style-name="SignLine">${escXml(EDITOR_NAME.toUpperCase())}</text:p>
     <text:p text:style-name="SignBox">Cachet et signature</text:p>
    </table:table-cell>
   </table:table-row>
  </table:table>
 </office:text></office:body>
</office:document-content>`;
}
