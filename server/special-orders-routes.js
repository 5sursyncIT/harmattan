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
import { adminApi } from './dolibarr-admin-client.js';
import { recordInvoicePayment, resolvePaymentId } from './dolibarr-payments.js';
import { findExistingTier, TYPENT_PARTICULIER } from './tier-dedup.js';

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

// ─── Comptabilisation Dolibarr ───────────────────────────────
// Consigne Direction (2026-07-14) : tout encaissement doit figurer au livre
// comptable. À la première somme reçue, on crée la facture client Dolibarr et
// on y impute les règlements au fil de l'eau (acompte, tranches, solde).
//
// Correspondance méthode → mode de règlement + compte de trésorerie. Le compte
// détermine où l'argent tombe réellement : ce n'est pas qu'un libellé.
// Pièges (cf. dolibarr-payments.js et l'audit des comptes) :
//   · WAVE → compte 6 (WAVE LIBRAIRIE QR, courant) et non 5, qui est de type
//     caisse et refuse tout mode ≠ LIQ ;
//   · le virement passe par P16 : le code VIR existe mais est INACTIF en base ;
//   · CHQ exige un chqemetteur, sinon Dolibarr renvoie 400.
const DOLIBARR_PAYMENT = {
  cash:         { code: 'LIQ',  accountId: 3 },  // COMPTE LIQUIDE
  wave:         { code: 'WAVE', accountId: 6 },  // WAVE LIBRAIRIE QR
  orange_money: { code: 'OM',   accountId: 4 },  // Code marchand OM
  cb:           { code: 'CB',   accountId: 1 },  // COMPTE CBAO
  cheque:       { code: 'CHQ',  accountId: 1 },  // COMPTE CBAO
  virement:     { code: 'P16',  accountId: 1 },  // Transfert bancaire (VIR est inactif)
};

// ─── Alertes internes ────────────────────────────────────────
// Le client n'est joignable automatiquement que par email — or presque aucun n'en
// a fourni, et les canaux SMS / WhatsApp ne sont pas branchés. Le module ne peut
// donc pas prévenir le client tout seul : il retourne la charge vers l'équipe.
// Toute commande qui dérive lève une alerte, visible dans l'interface et comptée
// dans la pastille de navigation. Une alerte s'éteint quand l'équipe agit
// (appel tracé, encaissement, avancement du statut).
const OPEN_STATUSES = ['registered', 'pending_validation', 'sent_to_supply', 'in_production', 'available', 'client_notified'];
const STALE_DAYS = 14;           // commande ouverte sans aucun mouvement
const PICKUP_REMINDER_DAYS = 7;  // client prévenu mais qui n'est jamais venu chercher
const NO_DATE_DAYS = 3;          // commande ouverte sans date de disponibilité annoncée

const ALERT_DEFS = {
  not_accounted:   { severity: 'action', label: 'Hors livre comptable' },
  to_contact:      { severity: 'action', label: 'Client à prévenir' },
  balance_due:     { severity: 'action', label: 'Solde impayé' },
  pickup_pending:  { severity: 'warn',   label: 'Livre non retiré' },
  overdue:         { severity: 'warn',   label: 'Date dépassée' },
  stale:           { severity: 'warn',   label: 'Sans mouvement' },
  no_date:         { severity: 'info',   label: 'Sans date prévue' },
  no_contact_info: { severity: 'info',   label: 'Client injoignable' },
};
const ALERT_KEYS = Object.keys(ALERT_DEFS);
const SEVERITY_RANK = { action: 3, warn: 2, info: 1 };
// Une alerte « action » ou « warn » = une commande à traiter (pastille de navigation).
const ACTIONABLE = ['action', 'warn'];

// Contact manuel : l'équipe appelle le client, on trace l'appel pour qu'il compte
// comme un contact abouti au même titre qu'un email parti.
const MANUAL_CHANNELS = ['phone', 'whatsapp_manual', 'sms_manual', 'in_person'];
// Événements pour lesquels le client attend une action de sa part : si aucun canal
// automatique n'aboutit, l'équipe doit être prévenue de le contacter à la main.
const STAFF_ALERT_EVENTS = ['available', 'balance_reminder'];

const DAY_MS = 86400000;
// created_at / updated_at sont écrits par SQLite en UTC — d'où le « Z » à la lecture.
const daysSinceUtc = (s) => {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY_MS));
};
const todayIso = () => new Date().toISOString().slice(0, 10);

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
  // Qui a passé l'appel / envoyé le message (les contacts manuels sont saisis par un agent).
  try { db.exec('ALTER TABLE special_order_notifications ADD COLUMN actor_username TEXT'); } catch { /* colonne déjà présente */ }
  // Liaison comptable : la facture Dolibarr portant les encaissements de la commande.
  try { db.exec('ALTER TABLE special_orders ADD COLUMN dolibarr_invoice_id INTEGER'); } catch { /* déjà présente */ }
  try { db.exec('ALTER TABLE special_orders ADD COLUMN invoice_ref TEXT'); } catch { /* déjà présente */ }
  try { db.exec('ALTER TABLE special_orders ADD COLUMN delivered_at DATETIME'); } catch { /* déjà présente */ }
  // Chaque règlement pointe vers son paiement Dolibarr. NULL = pas encore au livre
  // comptable (Dolibarr indisponible au moment de l'encaissement) → alerte + rejeu.
  try { db.exec('ALTER TABLE special_order_payments ADD COLUMN dolibarr_payment_id INTEGER'); } catch { /* déjà présente */ }
  try { db.exec('ALTER TABLE special_order_payments ADD COLUMN sync_error TEXT'); } catch { /* déjà présente */ }
}

// ─── MOTEUR D'ALERTES ────────────────────────────────────────
// Les alertes de toutes les commandes se calculent en 4 requêtes groupées, pas en
// N+1 : le résultat sert à la fois à la liste, aux KPI, au filtre et à la pastille.
function buildAlertMap(db) {
  const orders = db.prepare(`SELECT id, status, expected_date, created_at, updated_at,
    total_amount, customer_email, customer_phone FROM special_orders`).all();
  const paid = new Map(db.prepare('SELECT order_id, SUM(amount) AS s FROM special_order_payments GROUP BY order_id')
    .all().map((r) => [r.order_id, Number(r.s) || 0]));
  // « Contact abouti » = le CLIENT a réellement appris que son livre l'attend, que ce
  // soit par un envoi automatique parti ou par un appel que l'équipe a tracé.
  // Le canal 'internal' est exclu : c'est l'email qui prévient l'équipe qu'elle doit
  // appeler — le compter ici éteindrait l'alerte qu'il vient précisément de lever.
  const contacted = new Set(db.prepare(
    `SELECT DISTINCT order_id FROM special_order_notifications
     WHERE status = 'sent' AND event = 'available' AND channel <> 'internal'`
  ).all().map((r) => r.order_id));
  const notifiedAt = new Map(db.prepare(
    `SELECT order_id, MAX(created_at) AS d FROM special_order_status_history
     WHERE to_status = 'client_notified' GROUP BY order_id`
  ).all().map((r) => [r.order_id, r.d]));
  // Encaissements restés hors du livre comptable (échec d'écriture Dolibarr).
  const unaccounted = new Map(db.prepare(
    `SELECT order_id, COUNT(*) AS n, SUM(amount) AS s FROM special_order_payments
     WHERE dolibarr_payment_id IS NULL GROUP BY order_id`
  ).all().map((r) => [r.order_id, { n: Number(r.n), sum: Number(r.s) || 0 }]));

  const map = new Map();
  for (const o of orders) {
    map.set(o.id, computeAlerts(o, {
      paid: paid.get(o.id) || 0,
      contacted: contacted.has(o.id),
      notifiedAt: notifiedAt.get(o.id) || null,
      unaccounted: unaccounted.get(o.id) || null,
    }));
  }
  return map;
}

function computeAlerts(o, { paid, contacted, notifiedAt, unaccounted }) {
  const alerts = [];
  const push = (key, detail) => alerts.push({ key, ...ALERT_DEFS[key], detail });
  const open = OPEN_STATUSES.includes(o.status);
  const balance = Math.max(0, Math.round((Number(o.total_amount || 0) - paid) * 100) / 100);

  // De l'argent encaissé qui n'est pas au livre comptable : à rejouer d'urgence.
  if (unaccounted && unaccounted.n > 0) {
    push('not_accounted', `${unaccounted.n} règlement${unaccounted.n > 1 ? 's' : ''} (${fmtMoney(unaccounted.sum)}) encaissé${unaccounted.n > 1 ? 's' : ''} hors du livre comptable`);
  }

  // Le livre est arrivé, mais rien ne prouve que le client l'ait appris.
  if (['available', 'client_notified'].includes(o.status) && !contacted) {
    push('to_contact', o.customer_phone
      ? `Aucun contact abouti — appeler le ${o.customer_phone}`
      : 'Aucun contact abouti, et aucun téléphone au dossier');
  }
  // Livre remis, argent jamais encaissé.
  if (['picked_up', 'closed'].includes(o.status) && balance > 0) {
    push('balance_due', `Livre remis mais ${fmtMoney(balance)} jamais encaissés`);
  }
  // Client prévenu, qui ne vient pas : il faut le relancer.
  if (o.status === 'client_notified' && contacted) {
    const d = daysSinceUtc(notifiedAt);
    if (d !== null && d >= PICKUP_REMINDER_DAYS) push('pickup_pending', `Prévenu il y a ${d} jours, livre toujours pas retiré`);
  }
  if (o.expected_date && OVERDUE_OPEN.includes(o.status) && String(o.expected_date) < todayIso()) {
    push('overdue', `Disponibilité annoncée au client pour le ${fmtDateFr(o.expected_date)}`);
  }
  if (open) {
    const d = daysSinceUtc(o.updated_at || o.created_at);
    if (d !== null && d >= STALE_DAYS) push('stale', `Aucun mouvement depuis ${d} jours`);
  }
  // Sans date prévue, la commande échappe au radar « en retard » et peut dormir indéfiniment.
  if (open && !o.expected_date) {
    const d = daysSinceUtc(o.created_at);
    if (d !== null && d >= NO_DATE_DAYS) push('no_date', `Ouverte depuis ${d} jours sans date de disponibilité`);
  }
  if (open && !o.customer_phone && !o.customer_email) {
    push('no_contact_info', 'Ni téléphone ni email : ce client sera impossible à prévenir');
  }

  alerts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return alerts;
}

const alertLevelOf = (alerts) =>
  (alerts.length ? alerts.reduce((best, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[best] ? a.severity : best), 'info') : null);
const needsAction = (alerts) => alerts.some((a) => ACTIONABLE.includes(a.severity));

// Commandes réclamant une action — alimente la pastille de la navigation admin.
export function countSpecialOrderActionsRequired(db) {
  try {
    let n = 0;
    for (const alerts of buildAlertMap(db).values()) if (needsAction(alerts)) n += 1;
    return n;
  } catch (e) {
    console.error('[SPECIAL-ORDERS] comptage alertes:', e.message);
    return 0;
  }
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

  function orderToDto(row, { withChildren = false, alerts = null } = {}) {
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
      deliveredAt: row.delivered_at,
      // Facture Dolibarr portant les encaissements (null tant que rien n'est encaissé).
      invoice: row.dolibarr_invoice_id
        ? { id: Number(row.dolibarr_invoice_id), ref: row.invoice_ref }
        : null,
      overdue: !!(row.expected_date && OVERDUE_OPEN.includes(row.status)
        && String(row.expected_date) < todayIso()),
    };
    // Alertes : fournies par l'appelant s'il a déjà bâti la carte (liste), sinon calculées.
    const list = alerts || buildAlertMap(db).get(row.id) || [];
    dto.alerts = list;
    dto.alertLevel = alertLevelOf(list);
    dto.needsAction = needsAction(list);
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

  // ═══════════════════════════════════════════════════════════
  // COMPTABILISATION (Dolibarr)
  // ═══════════════════════════════════════════════════════════
  // Doctrine du projet : jamais d'INSERT SQL dans les tables comptables — on passe
  // par l'API REST avec la clé admin, pour hériter de la numérotation légale, des
  // triggers et des règles métier.

  // Le client d'une commande spéciale a payé de l'argent : il lui faut une fiche
  // tiers. On déduplique par téléphone/email (JAMAIS par nom : les patronymes se
  // répètent trop au Sénégal pour servir de clé — cf. l'incident des 1493 faux
  // fournisseurs).
  async function ensureOrderTier(row) {
    if (row.fk_soc) return Number(row.fk_soc);

    const existing = await findExistingTier(dolibarrPool, {
      email: row.customer_email, phone: row.customer_phone,
    });
    let socid = existing?.rowid || existing?.id || null;

    if (!socid) {
      const res = await adminApi.post('/thirdparties', {
        name: String(row.customer_name || '').trim().slice(0, 128),
        email: String(row.customer_email || '').trim(),
        phone: String(row.customer_phone || '').trim(),
        address: String(row.customer_address || '').trim(),
        client: 1,
        code_client: -1,            // référence client auto-générée par Dolibarr
        typent_id: TYPENT_PARTICULIER,
      });
      socid = Number(res.data);
    }

    db.prepare('UPDATE special_orders SET fk_soc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(socid, row.id);
    return socid;
  }

  // Facture client portant la commande. Créée à la PREMIÈRE somme reçue (ou à la
  // livraison si rien n'a été encaissé : la vente est alors une créance).
  // Idempotente : une commande n'a qu'une facture, les tranches s'y imputent.
  //
  // Lignes en SERVICE (product_type: 1, sans fk_product) et validation SANS
  // idwarehouse : par définition le livre n'est pas en stock. Un fk_product ferait
  // d'ailleurs échouer la création (STOCK_MUST_BE_ENOUGH_FOR_INVOICE=1 sur cette
  // instance rejette toute facture dont un produit manque en stock).
  // TVA = 0 : L'Harmattan Sénégal ne facture pas la TVA, le prix affiché EST le prix.
  async function ensureOrderInvoice(row) {
    if (row.dolibarr_invoice_id) {
      return { invoiceId: Number(row.dolibarr_invoice_id), invoiceRef: row.invoice_ref, created: false };
    }
    const socid = await ensureOrderTier(row);
    const lines = db.prepare('SELECT * FROM special_order_lines WHERE order_id = ? ORDER BY id ASC').all(row.id);
    if (lines.length === 0) throw new Error('Commande sans ligne — facturation impossible');

    const createRes = await adminApi.post('/invoices', {
      socid,
      date: todayIso(),
      type: 0,
      note_public: `Commande spéciale ${row.ref}`,
      note_private: `Commande spéciale ${row.ref} — ${row.customer_name}${row.customer_phone ? ` (${row.customer_phone})` : ''}`,
      lines: lines.map((l) => ({
        desc: [l.title, l.author, l.isbn].filter(Boolean).join(' — ').slice(0, 250),
        subprice: Math.round(Number(l.unit_price) || 0),
        qty: Number(l.quantity) || 1,
        tva_tx: 0,
        product_type: 1,
      })),
    });
    const invoiceId = Number(createRes.data);   // le POST renvoie l'ID brut, pas un objet
    await adminApi.post(`/invoices/${invoiceId}/validate`);

    let invoiceRef = null;
    try { invoiceRef = (await adminApi.get(`/invoices/${invoiceId}`)).data?.ref || null; } catch (e) { void e; }

    db.prepare('UPDATE special_orders SET dolibarr_invoice_id = ?, invoice_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(invoiceId, invoiceRef, row.id);
    return { invoiceId, invoiceRef, created: true };
  }

  // Impute un règlement sur la facture de la commande. Renvoie l'id du paiement
  // Dolibarr. Passe par recordInvoicePayment (/invoices/paymentsdistributed), seul
  // endpoint qui respecte le montant : /invoices/{id}/payments IGNORE `amount` et
  // impute tout le reste-à-payer (bug du double encaissement, déjà régressé une fois).
  async function pushPaymentToDolibarr(row, { amount, method, reference, isLast }) {
    const map = DOLIBARR_PAYMENT[method] || DOLIBARR_PAYMENT.cash;
    const { invoiceId } = await ensureOrderInvoice(getRow(row.id));

    const paymentId = await resolvePaymentId(dolibarrPool, map.code);
    if (!paymentId) throw new Error(`Mode de règlement inconnu dans Dolibarr : ${map.code}`);

    const dolibarrPaymentId = await recordInvoicePayment(adminApi, {
      invoiceId,
      amount: Math.round(Number(amount) || 0),
      paymentId,
      accountId: map.accountId,
      datepaye: Math.floor(new Date(`${todayIso()}T12:00:00Z`).getTime() / 1000), // midi UTC : pas de dérive de fuseau
      isLast: !!isLast,                        // ne solde la facture que sur le dernier règlement
      numPayment: reference || undefined,
      comment: `Commande spéciale ${row.ref}`,
      // Dolibarr refuse un chèque sans émetteur (400 « Emetteur is mandatory »).
      ...(map.code === 'CHQ' ? { chqemetteur: String(row.customer_name || 'Client').slice(0, 100) } : {}),
    });

    if (isLast) {
      // L'API ne bascule pas toujours la facture en « payée » d'elle-même.
      try { await adminApi.post(`/invoices/${invoiceId}/settopaid`); } catch (e) { void e; }
    }
    return Number(dolibarrPaymentId);
  }

  // Comptabilise un règlement déjà enregistré en SQLite. On n'échoue JAMAIS
  // l'encaissement pour un problème Dolibarr : l'argent est déjà dans la caisse, le
  // nier serait pire. On trace l'échec, l'alerte « Hors livre comptable » s'allume,
  // et l'écriture est rejouable d'un clic.
  async function accountPayment(orderId, paymentRowId) {
    const row = getRow(orderId);
    const pay = db.prepare('SELECT * FROM special_order_payments WHERE id = ?').get(paymentRowId);
    if (!row || !pay || pay.dolibarr_payment_id) return { ok: true, skipped: true };

    const { balance } = computeTotals(row.id, row.total_amount);
    try {
      const dolibarrPaymentId = await pushPaymentToDolibarr(row, {
        amount: pay.amount, method: pay.method, reference: pay.reference,
        isLast: balance <= 0.01,               // ce règlement solde la commande
      });
      db.prepare('UPDATE special_order_payments SET dolibarr_payment_id = ?, sync_error = NULL WHERE id = ?')
        .run(dolibarrPaymentId, pay.id);
      return { ok: true, dolibarrPaymentId };
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : err.message;
      console.error(`[SPECIAL-ORDERS] comptabilisation ${row.ref} échouée:`, detail);
      db.prepare('UPDATE special_order_payments SET sync_error = ? WHERE id = ?').run(detail, pay.id);
      return { ok: false, error: detail };
    }
  }

  // ── Dispatcher de notifications (email réel ; SMS / WhatsApp pluggables) ──
  function logNotif(orderId, channel, event, recipient, status, detail, actor) {
    try {
      db.prepare(`INSERT INTO special_order_notifications
        (order_id, channel, event, recipient, status, detail, actor_username) VALUES (?,?,?,?,?,?,?)`)
        .run(orderId, channel, event, recipient || null, status, detail || null, actor || null);
    } catch (e) { void e; }
  }

  // Aucun canal automatique n'a atteint le client alors qu'il attend une action de sa
  // part : ce n'est pas un échec silencieux, c'est une tâche pour l'équipe. On la lui
  // envoie par email interne, et la commande reste en alerte tant que l'appel n'est
  // pas tracé.
  async function alertStaffContactRequired(orderRow, event) {
    try {
      if (!transporter || !emailService?.sendSpecialOrderStaffAlert) return;
      const staff = db.prepare(
        `SELECT email FROM admin_users WHERE is_active = 1 AND email IS NOT NULL AND email != ''
           AND role IN ('super_admin','admin','librarian','gestionnaire_stock')`
      ).all().map((r) => r.email).filter(Boolean);
      if (!staff.length) return;
      const ok = await emailService.sendSpecialOrderStaffAlert({
        transporter, to: staff, order: orderToDto(orderRow, { withChildren: true }), event, siteUrl,
      });
      logNotif(orderRow.id, 'internal', event, staff.join(', '), ok ? 'sent' : 'failed',
        ok ? "Équipe alertée : le client doit être contacté à la main" : "Échec de l'alerte interne", 'système');
    } catch (e) {
      console.error('[SPECIAL-ORDERS] alerte interne:', e.message);
    }
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

    // Le client a-t-il vraiment été atteint par au moins un canal ?
    let reached = false;

    // EMAIL
    if (wanted.includes('email')) {
      if (orderRow.customer_email && transporter && emailService?.sendSpecialOrderNotification) {
        let ok = false;
        try { ok = await emailService.sendSpecialOrderNotification({ transporter, order: payload, event, siteUrl }); }
        catch (e) { ok = false; console.error('[SPECIAL-ORDERS] email failed:', e.message); }
        if (ok) reached = true;
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
        if (r.ok) reached = true;
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
        if (r.ok) reached = true;
        logNotif(orderRow.id, 'whatsapp', event, orderRow.customer_phone,
          r.skipped ? 'skipped' : (r.ok ? 'sent' : 'failed'), r.error || (r.skipped ? 'WhatsApp non configuré' : null));
      } else {
        logNotif(orderRow.id, 'whatsapp', event, orderRow.customer_phone || '', 'skipped',
          orderRow.customer_phone ? 'WhatsApp non configuré' : 'Aucun téléphone');
      }
    }

    // Le client attend une action de sa part et personne n'a pu le joindre : à l'équipe de jouer.
    if (!reached && STAFF_ALERT_EVENTS.includes(event)) await alertStaffContactRequired(orderRow, event);
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

  // Constantes UI (statuts, méthodes de paiement, alertes) pour le frontend.
  router.get('/meta', auth, (req, res) => {
    res.json({
      statuses: STATUS_ORDER.map(statusDto).concat([statusDto('cancelled')]),
      paymentMethods: PAYMENT_METHODS,
      alerts: ALERT_KEYS.map((key) => ({ key, ...ALERT_DEFS[key] })),
      manualChannels: MANUAL_CHANNELS,
      // Canaux automatiques réellement opérationnels : le frontend prévient l'équipe
      // que le reste ne partira pas (l'équipe devra contacter le client à la main).
      channelsEnabled: {
        email: !!transporter,
        sms: !!smsService?.isSmsEnabled?.(),
        whatsapp: !!whatsapp?.isWhatsAppEnabled?.(),
      },
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

      // Les alertes se calculent en JS : on filtre donc sur les identifiants retenus.
      // `alert=any` = toutes les commandes réclamant une action.
      const alertMap = buildAlertMap(db);
      const alertFilter = String(req.query.alert || '').trim();
      if (alertFilter && (alertFilter === 'any' || ALERT_KEYS.includes(alertFilter))) {
        const ids = [];
        for (const [id, alerts] of alertMap) {
          const hit = alertFilter === 'any' ? needsAction(alerts) : alerts.some((a) => a.key === alertFilter);
          if (hit) ids.push(id);
        }
        if (ids.length === 0) {
          return res.json({ orders: [], total: 0, page: 1, pages: 1, kpis: computeDashboardKpis(alertMap) });
        }
        where.push(`o.id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
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
          const dto = orderToDto(r, { alerts: alertMap.get(r.id) || [] });
          const sum = summaryStmt.get(r.id);
          const first = firstTitleStmt.get(r.id);
          dto.books = { count: sum ? Number(sum.n) : 0, qty: sum ? Number(sum.q) : 0, firstTitle: first ? first.title : null };
          return dto;
        }),
        total, page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: computeDashboardKpis(alertMap),
      });
    } catch (err) {
      console.error('[SPECIAL-ORDERS] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement commandes spéciales' });
    }
  });

  // KPI globaux (non filtrés) pour le tableau de bord.
  function computeDashboardKpis(alertMap = buildAlertMap(db)) {
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

    // Alertes : combien de commandes portent chaque type, et combien réclament une action.
    const alerts = Object.fromEntries(ALERT_KEYS.map((k) => [k, 0]));
    let actionRequired = 0;
    for (const list of alertMap.values()) {
      for (const a of list) alerts[a.key] += 1;
      if (needsAction(list)) actionRequired += 1;
    }

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
      alerts,
      actionRequired,
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
        let paymentRowId = null;
        if (initialPayment > 0) {
          const p = db.prepare(`INSERT INTO special_order_payments (order_id, amount, method, reference, note, received_by) VALUES (?,?,?,?,?,?)`)
            .run(orderId, initialPayment, PAYMENT_METHODS.includes(b.payment_method) ? b.payment_method : 'cash',
              String(b.payment_reference || '').trim().slice(0, 120) || null, 'Règlement à la commande', username);
          paymentRowId = p.lastInsertRowid;
        }
        return { orderId, ref, paymentRowId };
      });

      const { orderId, ref, paymentRowId } = create();
      logActivity(username, 'special_order_created', { id: orderId, ref, total: totalAmount, lines: lines.length });

      // Le règlement à la commande (acompte) entre au livre comptable : c'est là que
      // naissent le tiers et la facture de la commande.
      let warning;
      if (paymentRowId) {
        const acc = await accountPayment(orderId, paymentRowId);
        if (!acc.ok) warning = "Commande créée et acompte encaissé, mais son écriture comptable a échoué. Le règlement est signalé « Hors livre comptable » et peut être rejoué depuis la fiche.";
      }

      // Confirmation client (best-effort) — ne bloque pas la réponse.
      const row = getRow(orderId);
      notifyOrder(row, 'order_confirmation').catch((e) => console.error('[SPECIAL-ORDERS] notify create:', e.message));

      res.status(201).json({ id: orderId, ref, warning });
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
  // CONFIRMATION DE LIVRAISON
  // ═══════════════════════════════════════════════════════════
  // Consigne Direction (2026-07-14) : quand l'argent est encaissé mais que le livre
  // n'est ni disponible ni sorti d'impression, l'équipe doit pouvoir constater la
  // remise au client dès qu'elle a lieu — sans dérouler le workflow étape par étape
  // (dans les faits, personne ne le déroule : l'audit montre que les statuts
  // intermédiaires ne sont jamais utilisés).
  //
  // La livraison est un FAIT : on l'autorise même avec un solde impayé, mais jamais
  // par accident — le client doit confirmer explicitement (force: true), et la
  // commande reste alors signalée « Solde impayé » jusqu'à l'encaissement.
  //
  // Livrer, c'est aussi réaliser la vente : la facture est créée si elle ne l'est pas
  // encore (commande remise sans le moindre acompte), de sorte qu'aucun livre ne sorte
  // du magasin sans exister au livre comptable — même en créance.
  router.post('/:id/deliver', auth, noCsrf, async (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      if (row.status === 'cancelled') return res.status(409).json({ error: 'Commande annulée — livraison impossible' });
      if (['picked_up', 'closed'].includes(row.status)) {
        return res.status(409).json({ error: 'Cette commande est déjà livrée' });
      }

      const { balance } = computeTotals(row.id, row.total_amount);
      if (balance > 0.01 && !req.body?.force) {
        return res.status(409).json({
          error: `Il reste ${fmtMoney(balance)} à payer sur cette commande.`,
          requiresConfirmation: true,
          balance,
        });
      }

      const username = req.admin?.username || 'admin';
      const comment = String(req.body?.comment || '').trim().slice(0, 1000)
        || (balance > 0.01 ? `Livraison confirmée avec ${fmtMoney(balance)} restant dus` : 'Livraison confirmée');

      // La vente doit exister en comptabilité, même si le client n'a rien versé.
      let warning;
      try {
        await ensureOrderInvoice(getRow(row.id));
      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
        console.error(`[SPECIAL-ORDERS] facture à la livraison ${row.ref} échouée:`, detail);
        warning = "Livraison confirmée, mais la facture n'a pas pu être créée dans la comptabilité.";
      }

      db.transaction(() => {
        db.prepare(`UPDATE special_orders SET status = 'picked_up', delivered_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
        db.prepare('INSERT INTO special_order_status_history (order_id, from_status, to_status, actor_username, comment) VALUES (?,?,?,?,?)')
          .run(row.id, row.status, 'picked_up', username, comment);
      })();
      logActivity(username, 'special_order_delivered', { id: row.id, ref: row.ref, from: row.status, balance });

      const updated = getRow(row.id);
      await notifyOrder(updated, 'pickup_confirmation').catch((e) => console.error('[SPECIAL-ORDERS] notify deliver:', e.message));

      const dto = orderToDto(getRow(row.id), { withChildren: true });
      if (warning) dto.warning = warning;
      res.json(dto);
    } catch (err) {
      console.error('[SPECIAL-ORDERS] deliver error:', err.message);
      res.status(500).json({ error: 'Erreur confirmation de livraison' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PAIEMENTS (acompte / tranches)
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/payments', auth, noCsrf, async (req, res) => {
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
      const ins = db.prepare(`INSERT INTO special_order_payments (order_id, amount, method, reference, note, received_by) VALUES (?,?,?,?,?,?)`)
        .run(row.id, amount, method,
          String(req.body?.reference || '').trim().slice(0, 120) || null,
          String(req.body?.note || '').trim().slice(0, 300) || null,
          username);
      db.prepare('UPDATE special_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      logActivity(username, 'special_order_payment', { id: row.id, ref: row.ref, amount, method });

      // Consigne Direction : l'encaissement doit entrer au livre comptable.
      const acc = await accountPayment(row.id, ins.lastInsertRowid);

      const dto = orderToDto(getRow(row.id), { withChildren: true });
      if (!acc.ok) {
        dto.warning = "Règlement encaissé, mais son écriture comptable a échoué. Il est signalé « Hors livre comptable » et peut être rejoué.";
      }
      res.status(201).json(dto);
    } catch (err) {
      console.error('[SPECIAL-ORDERS] payment error:', err.message);
      res.status(500).json({ error: 'Erreur enregistrement paiement' });
    }
  });

  // Rejeu de l'écriture comptable d'un règlement resté hors du livre.
  router.post('/:id/payments/:paymentId/account', auth, noCsrf, async (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const pay = db.prepare('SELECT * FROM special_order_payments WHERE id = ? AND order_id = ?')
        .get(parseInt(req.params.paymentId, 10), row.id);
      if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
      if (pay.dolibarr_payment_id) return res.status(409).json({ error: 'Ce règlement est déjà au livre comptable' });

      const acc = await accountPayment(row.id, pay.id);
      if (!acc.ok) return res.status(502).json({ error: `Comptabilisation impossible : ${acc.error}` });
      logActivity(req.admin?.username || 'admin', 'special_order_payment_accounted', { id: row.id, ref: row.ref, amount: pay.amount });
      res.json(orderToDto(getRow(row.id), { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] account payment error:', err.message);
      res.status(500).json({ error: 'Erreur comptabilisation' });
    }
  });

  // Suppression d'un paiement (correction de saisie). Un règlement déjà porté au
  // livre comptable ne s'efface pas d'un clic : le supprimer ici le laisserait vivant
  // dans Dolibarr et ferait diverger la caisse de la compta. La correction passe par
  // le module Factures, qui sait défaire proprement un paiement Dolibarr.
  router.delete('/:id/payments/:paymentId', auth, noCsrf, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });
      const pay = db.prepare('SELECT * FROM special_order_payments WHERE id = ? AND order_id = ?')
        .get(parseInt(req.params.paymentId, 10), row.id);
      if (!pay) return res.status(404).json({ error: 'Paiement introuvable' });
      if (pay.dolibarr_payment_id) {
        return res.status(409).json({
          error: `Ce règlement est enregistré au livre comptable${row.invoice_ref ? ` (facture ${row.invoice_ref})` : ''}. Corrigez-le depuis le module Factures pour que caisse et comptabilité restent d'accord.`,
        });
      }
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
  // CONTACT MANUEL — l'équipe a joint le client de vive voix
  // ═══════════════════════════════════════════════════════════
  // Tant que le SMS et WhatsApp ne sont pas branchés, le client est prévenu par
  // téléphone. Sans trace, ce travail est invisible : le module croit le client
  // jamais joint et l'alerte « Client à prévenir » ne s'éteint jamais. Tracer
  // l'appel vaut donc notification aboutie.
  router.post('/:id/contacts', auth, noCsrf, (req, res) => {
    try {
      const row = getRow(req.params.id);
      if (!row) return res.status(404).json({ error: 'Commande introuvable' });

      const channel = MANUAL_CHANNELS.includes(req.body?.channel) ? req.body.channel : 'phone';
      const ALLOWED_EVENTS = ['order_confirmation', 'validated', 'in_processing', 'available', 'balance_reminder', 'pickup_confirmation'];
      const event = ALLOWED_EVENTS.includes(req.body?.event) ? req.body.event : 'available';
      const outcome = ['reached', 'no_answer'].includes(req.body?.outcome) ? req.body.outcome : 'reached';
      const note = String(req.body?.note || '').trim().slice(0, 300) || null;
      const username = req.admin?.username || 'admin';

      // Un appel sans réponse est tracé mais ne vaut pas contact : l'alerte reste allumée.
      const status = outcome === 'reached' ? 'sent' : 'failed';
      const detail = outcome === 'reached'
        ? (note || 'Client joint et informé')
        : `Sans réponse${note ? ` — ${note}` : ''}`;

      logNotif(row.id, channel, event, row.customer_phone || row.customer_email || null, status, detail, username);
      db.prepare('UPDATE special_orders SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
      logActivity(username, 'special_order_contact', { id: row.id, ref: row.ref, channel, event, outcome });

      res.status(201).json(orderToDto(getRow(row.id), { withChildren: true }));
    } catch (err) {
      console.error('[SPECIAL-ORDERS] contact error:', err.message);
      res.status(500).json({ error: 'Erreur enregistrement du contact' });
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
