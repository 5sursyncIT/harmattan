/**
 * Consignment Routes — Dépôt-vente fournisseurs externes.
 *
 * Un « déposant » (fournisseur externe) confie des livres à L'Harmattan Sénégal.
 * L'Harmattan les vend (POS + web), retient une COMMISSION (%) et reverse le solde
 * au déposant. Modèle entièrement natif (SQLite local) + intégration Dolibarr :
 *   - chaque ISBN déposé devient/retrouve un produit Dolibarr réel (ref+barcode=ISBN) ;
 *   - la validation d'un dépôt fait une ENTRÉE de stock réelle (/stockmovements) ;
 *   - les ventes sont attribuées au déposant via la table consignment_products
 *     (1 produit = 1 déposant) et lues depuis llx_facturedet ⋈ llx_facture ;
 *   - le reversement (settlement) fige une période non-chevauchante et calcule
 *     ventes × (1 − commission) = net dû, avec relevé PDF natif (ODT → LibreOffice).
 *
 * Documents : bon de dépôt PDF natif (preuve de remise, signé par le déposant) et
 * facture fournisseur Dolibarr du NET à reverser (cf. ensureConsignorTier).
 *
 * Sécurité : monté sur /api/admin/consignments, whitelist RBAC (super_admin, admin,
 * comptable et gestionnaire_stock ; librarian en lecture). Mutations protégées CSRF.
 * Les routes qui touchent à l'argent (création de facture fournisseur, règlement)
 * sont en plus restreintes à FINANCE_ROLES — cf. requireFinance.
 */

import { Router } from 'express';
import axios from 'axios';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'fs';
import { resolvePaymentId } from './dolibarr-payments.js';

const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.warn('[CONSIGNMENT] DOLIBARR_ADMIN_API_KEY non définie — création produit / mouvement de stock échouera');
}
const adminApi = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { DOLAPIKEY: ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const DEP_STATUS = { draft: 'Brouillon', validated: 'Validé', closed: 'Clôturé' };
const SET_STATUS = { draft: 'Brouillon', paid: 'Reversé' };
const EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || "L'Harmattan Sénégal";
const FOOTER_LEGAL = "L'HARMATTAN SENEGAL SARL – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";

// PDF Dolibarr : l'API REST /builddoc renvoie 404 en v21 → endpoint PHP custom.
const DOC_BUILDDOC_URL = 'http://localhost/dolibarr/htdocs/custom/senharmattansync/document-builddoc.php';
const DOLIBARR_WEBHOOK_SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';

// En-tête des documents : même logo que le filigrane des contrats
// (cf. scripts/contract-builddoc.php). Le ratio est celui du fichier fourni ;
// il n'est PAS recalculé à chaud pour éviter une dépendance de décodage d'image —
// si le logo est remplacé par un fichier de proportions différentes, ajuster ici.
const LOGO_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'images', 'logo.png');
const LOGO_RATIO = 1153 / 586;
const LOGO_WIDTH_CM = 4.4;
const hasLogo = () => existsSync(LOGO_PATH);

/**
 * Modes de règlement d'un reversement → { code llx_c_paiement, compte llx_bank_account }.
 * Aligné sur ECOMMERCE_PAYMENT_MAP (dolibarr-payments.js) : le compte CPTEWAVE (5)
 * est de type caisse (courant=2) et refuse tout mode ≠ LIQ, d'où WAVE → compte 6.
 * Les `code` sont résolus dynamiquement en id via resolvePaymentId (v21 n'accepte
 * plus le code seul) ; les accountId sont propres à cette instance.
 */
const SETTLEMENT_PAYMENT_MODES = {
  LIQ:  { code: 'LIQ',  accountId: 3, label: 'Espèces' },
  WAVE: { code: 'WAVE', accountId: 6, label: 'Wave' },
  OM:   { code: 'OM',   accountId: 4, label: 'Orange Money' },
  VIR:  { code: 'P16',  accountId: 1, label: 'Virement bancaire' },
  CHQ:  { code: 'CHQ',  accountId: 1, label: 'Chèque' },
};

// ─── HELPERS ─────────────────────────────────────────────────
function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS consignors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fk_soc INTEGER,
    name TEXT NOT NULL,
    contact_email TEXT,
    contact_phone TEXT,
    default_commission_rate REAL NOT NULL DEFAULT 30,
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS consignment_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    consignor_id INTEGER NOT NULL,
    warehouse_id INTEGER,
    warehouse_name TEXT,
    deposit_date TEXT,
    note TEXT,
    lines_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    stock_moved INTEGER NOT NULL DEFAULT 0,
    total_qty INTEGER NOT NULL DEFAULT 0,
    total_value REAL NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    validated_by TEXT,
    validated_at DATETIME
  )`);

  // Mapping produit → déposant (1 produit = 1 déposant). Sert à attribuer les
  // ventes au bon déposant pour le calcul du reversement.
  db.exec(`CREATE TABLE IF NOT EXISTS consignment_products (
    product_id INTEGER PRIMARY KEY,
    consignor_id INTEGER NOT NULL,
    commission_rate REAL NOT NULL,
    sale_price_ttc REAL,
    first_deposit_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS consignment_settlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    consignor_id INTEGER NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    total_qty INTEGER NOT NULL DEFAULT 0,
    total_sales_ttc REAL NOT NULL DEFAULT 0,
    total_commission REAL NOT NULL DEFAULT 0,
    total_net_due REAL NOT NULL DEFAULT 0,
    lines_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    payment_ref TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    paid_by TEXT,
    paid_at DATETIME
  )`);

  db.exec('CREATE INDEX IF NOT EXISTS idx_consdep_consignor ON consignment_deposits(consignor_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_consdep_status ON consignment_deposits(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_consprod_consignor ON consignment_products(consignor_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_consset_consignor ON consignment_settlements(consignor_id)');

  // Rattachement à la facture fournisseur du net reversé (ajout post-création :
  // les bases existantes n'ont pas ces colonnes).
  addColumn(db, 'consignment_settlements', 'fk_facture_fourn', 'INTEGER');
  addColumn(db, 'consignment_settlements', 'facture_fourn_ref', 'TEXT');
  addColumn(db, 'consignment_settlements', 'fk_paiement_fourn', 'INTEGER');
  addColumn(db, 'consignment_settlements', 'payment_mode', 'TEXT');
}

/** ALTER TABLE ADD COLUMN idempotent (SQLite n'a pas de IF NOT EXISTS sur les colonnes). */
function addColumn(db, table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

// Les caractères de contrôle sont interdits en XML 1.0 : un titre ou une note
// collé depuis un PDF en contient parfois, et soffice refuse alors le document.
const escXml = (s) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const cleanQty = (v) => Math.max(1, Math.min(100000, parseInt(v, 10) || 0));
const cleanPrice = (v) => Math.max(0, Math.min(100000000, Math.round((parseFloat(v) || 0) * 100) / 100));
const cleanRate = (v) => Math.max(0, Math.min(100, Math.round((parseFloat(v) || 0) * 100) / 100));
const fmtFcfa = (n) => `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} FCFA`;

// Valide un ISBN (10 ou 13 chiffres, tirets/espaces tolérés).
function validateISBN(isbn) {
  const clean = String(isbn || '').replace(/[-\s]/g, '');
  return /^(97[89]\d{10}|\d{10})$/.test(clean);
}
const normIsbn = (isbn) => String(isbn || '').replace(/[-\s]/g, '').trim();

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtDateFr = (s) => (s ? new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

/**
 * Assemble un ODT (mimetype + manifest + styles + content) et le convertit en PDF
 * via LibreOffice headless. Retourne le buffer PDF ; le répertoire temporaire est
 * toujours nettoyé. Le compteur `odtSeq` évite toute collision entre deux rendus
 * concurrents du même document dans le même process.
 */
let odtSeq = 0;
function renderOdtPdf(prefix, contentXml) {
  const tmpDir = join('/tmp', `${prefix}-${process.pid}-${++odtSeq}`);
  try {
    const withLogo = hasLogo();
    mkdirSync(join(tmpDir, 'META-INF'), { recursive: true });
    writeFileSync(join(tmpDir, 'mimetype'), 'application/vnd.oasis.opendocument.text');
    writeFileSync(join(tmpDir, 'META-INF/manifest.xml'), buildCvManifest(withLogo));
    writeFileSync(join(tmpDir, 'styles.xml'), buildCvStyles());
    writeFileSync(join(tmpDir, 'content.xml'), contentXml);
    if (withLogo) {
      mkdirSync(join(tmpDir, 'Pictures'), { recursive: true });
      copyFileSync(LOGO_PATH, join(tmpDir, 'Pictures/logo.png'));
    }

    const odt = join(tmpDir, 'doc.odt');
    // mimetype d'abord, non compressé (-0) : exigence du format ODF.
    execFileSync('zip', ['-q', '-X', '-0', odt, 'mimetype'], { cwd: tmpDir });
    execFileSync('zip', ['-q', '-r', '-X', odt,
      'META-INF', 'content.xml', 'styles.xml', ...(withLogo ? ['Pictures'] : [])], { cwd: tmpDir });

    const profile = join(tmpDir, 'profile');
    mkdirSync(profile, { recursive: true });
    execFileSync('soffice', [
      '--headless', '--norestore', '--nologo', '--nofirststartwizard',
      `-env:UserInstallation=file://${profile}`,
      '--convert-to', 'pdf', '--outdir', tmpDir, odt,
    ], { stdio: 'pipe', timeout: 60000 });

    const pdfPath = join(tmpDir, 'doc.pdf');
    if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée');
    return readFileSync(pdfPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Relaie une demande de PDF Dolibarr vers l'endpoint PHP et le streame au client. */
async function streamDolibarrPdf(res, { type, id, filename }) {
  if (!DOLIBARR_WEBHOOK_SECRET) return res.status(500).json({ error: 'DOLIBARR_WEBHOOK_SECRET non configuré' });
  const phpRes = await axios.post(DOC_BUILDDOC_URL, { type, id }, {
    headers: { 'X-Dolibarr-Secret': DOLIBARR_WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: () => true, // on inspecte le status nous-mêmes
  });
  const ct = phpRes.headers['content-type'] || '';
  if (phpRes.status >= 200 && phpRes.status < 300 && ct.includes('application/pdf')) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(Buffer.from(phpRes.data));
  }
  let detail = 'Erreur génération PDF';
  try { detail = JSON.parse(Buffer.from(phpRes.data).toString())?.error || detail; } catch { void 0; }
  return res.status(phpRes.status || 500).json({ error: detail });
}

// ─── ROUTER FACTORY ──────────────────────────────────────────
export function createConsignmentRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();
  ensureTables(db);
  const csrf = csrfProtection || ((req, res, next) => next());

  /**
   * Garde-fou trésorerie. La whitelist RBAC (roles-config.js) ouvre TOUT
   * /api/admin/consignments à gestionnaire_stock — acceptable tant que le module
   * ne touchait que SQLite, plus du tout depuis qu'il émet des factures
   * fournisseur et des règlements bancaires. Or ce rôle a explicitement
   * payments/accounting/invoices à « - » dans sa matrice : on refuse ici plutôt
   * que de lui accorder la trésorerie par effet de bord.
   */
  const FINANCE_ROLES = new Set(['super_admin', 'admin', 'comptable']);
  const requireFinance = (req, res, next) => {
    if (!FINANCE_ROLES.has(req.admin?.role)) {
      return res.status(403).json({ error: 'Action réservée à la direction et à la comptabilité' });
    }
    next();
  };

  // Génère une réf séquentielle préfixée + AAMM (transaction → pas de collision).
  function generateRef(prefix, table) {
    const now = new Date();
    const yymm = String(now.getFullYear() % 100).padStart(2, '0') + String(now.getMonth() + 1).padStart(2, '0');
    const full = `${prefix}${yymm}-`;
    const max = db.prepare(`SELECT MAX(ref) AS max FROM ${table} WHERE ref LIKE ?`).get(`${full}%`);
    let next = 1;
    if (max?.max) next = (parseInt(String(max.max).split('-')[1], 10) || 0) + 1;
    return `${full}${String(next).padStart(4, '0')}`;
  }

  function depositToDto(r) {
    let lines = [];
    try { lines = JSON.parse(r.lines_json) || []; } catch { lines = []; }
    return {
      id: r.id, ref: r.ref,
      consignorId: r.consignor_id,
      consignorName: r.consignor_name || null,
      warehouse: { id: r.warehouse_id, name: r.warehouse_name },
      depositDate: r.deposit_date,
      note: r.note,
      lines,
      status: r.status, statusLabel: DEP_STATUS[r.status] || r.status,
      stockMoved: !!r.stock_moved,
      totalQty: r.total_qty,
      totalValue: r.total_value,
      createdBy: r.created_by, createdAt: r.created_at,
      validatedBy: r.validated_by, validatedAt: r.validated_at,
    };
  }

  // Normalise les lignes d'un dépôt.
  function sanitizeLines(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map(l => ({
        product_id: l.product_id ? parseInt(l.product_id, 10) : null,
        isbn: normIsbn(l.isbn).slice(0, 20),
        label: String(l.label || '').trim().slice(0, 300),
        author: String(l.author || '').trim().slice(0, 200),
        qty: cleanQty(l.qty),
        sale_price_ttc: cleanPrice(l.sale_price_ttc),
        commission_rate: cleanRate(l.commission_rate),
        qty_returned: Math.max(0, parseInt(l.qty_returned, 10) || 0),
      }))
      .filter(l => l.label && l.qty > 0 && (l.product_id || validateISBN(l.isbn)));
  }

  const sumQty = (lines) => lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0);
  const sumValue = (lines) => lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0) * (parseFloat(l.sale_price_ttc) || 0), 0);

  // ═══════════════════════════════════════════════════════════
  // STATS / DASHBOARD
  // ═══════════════════════════════════════════════════════════
  router.get('/stats', auth, (req, res) => {
    try {
      const consignors = db.prepare('SELECT COUNT(*) AS n FROM consignors WHERE active = 1').get().n;
      const dep = db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS nb_draft,
        SUM(CASE WHEN status='validated' THEN 1 ELSE 0 END) AS nb_validated
        FROM consignment_deposits`).get();
      const settlements = db.prepare(`SELECT
        SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS nb_draft,
        SUM(CASE WHEN status='draft' THEN total_net_due ELSE 0 END) AS due_draft
        FROM consignment_settlements`).get();
      res.json({
        consignors,
        deposits: { total: Number(dep.total || 0), draft: Number(dep.nb_draft || 0), validated: Number(dep.nb_validated || 0) },
        settlements: { pending: Number(settlements.nb_draft || 0), pendingAmount: Number(settlements.due_draft || 0) },
      });
    } catch (err) {
      console.error('[CONSIGNMENT] stats error:', err.message);
      res.status(500).json({ error: 'Erreur chargement statistiques' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RESSOURCES (entrepôts, recherche produit) — avant /:id
  // ═══════════════════════════════════════════════════════════
  router.get('/warehouses', auth, async (req, res) => {
    try {
      // Note : depuis Dolibarr 7.0 la colonne `label` a été renommée `ref`
      // (migration 6.0.0-7.0.0). Le nom de l'entrepôt est donc dans `ref`.
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, lieu FROM llx_entrepot WHERE statut = 1 ORDER BY ref ASC`
      );
      res.json({ warehouses: rows.map(w => ({ id: w.id, name: w.ref || w.lieu || `Entrepôt ${w.id}`, location: w.lieu })) });
    } catch (err) {
      console.error('[CONSIGNMENT] warehouses error:', err.message);
      res.status(500).json({ error: 'Erreur chargement entrepôts' });
    }
  });

  // Recherche produit (par ISBN/réf/titre) pour pré-remplir une ligne.
  router.get('/products/search', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ products: [] });
      const pat = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, barcode, price_ttc
           FROM llx_product
          WHERE ref LIKE ? OR label LIKE ? OR barcode LIKE ?
          ORDER BY label ASC LIMIT 20`,
        [pat, pat, pat]
      );
      const ids = rows.map(r => r.id);
      const mapped = new Map();
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        for (const m of db.prepare(`SELECT product_id, consignor_id FROM consignment_products WHERE active=1 AND product_id IN (${ph})`).all(...ids)) {
          mapped.set(m.product_id, m.consignor_id);
        }
      }
      res.json({ products: rows.map(r => ({
        id: r.id, ref: r.ref, label: r.label, isbn: r.barcode || r.ref,
        price_ttc: Number(r.price_ttc) || 0,
        consigned_by: mapped.get(r.id) || null,
      })) });
    } catch (err) {
      console.error('[CONSIGNMENT] products search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche produit' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉPOSANTS (consignors)
  // ═══════════════════════════════════════════════════════════
  router.get('/consignors', auth, (req, res) => {
    try {
      const includeInactive = req.query.all === '1';
      const rows = db.prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM consignment_deposits d WHERE d.consignor_id = c.id) AS deposits_count,
           (SELECT COUNT(*) FROM consignment_products cp WHERE cp.consignor_id = c.id AND cp.active = 1) AS titles_count
         FROM consignors c
         ${includeInactive ? '' : 'WHERE c.active = 1'}
         ORDER BY c.name ASC`
      ).all();
      res.json({ consignors: rows });
    } catch (err) {
      console.error('[CONSIGNMENT] consignors list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement déposants' });
    }
  });

  // Recherche tiers Dolibarr pour rattacher un déposant existant.
  router.get('/consignors/search-tiers', auth, async (req, res) => {
    if (!dolibarrPool) return res.status(503).json({ error: 'Dolibarr indisponible' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    try {
      const pat = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, name_alias, code_fournisseur, email, phone, town
           FROM llx_societe
          WHERE status = 1 AND (nom LIKE ? OR name_alias LIKE ? OR email LIKE ? OR phone LIKE ?)
          ORDER BY nom ASC LIMIT 30`,
        [pat, pat, pat, pat]
      );
      const linked = new Set(
        db.prepare('SELECT fk_soc FROM consignors WHERE active = 1 AND fk_soc IS NOT NULL').all().map(r => String(r.fk_soc))
      );
      res.json({ results: rows.map(r => ({
        id: r.id, name: r.nom, alias: r.name_alias, email: r.email, phone: r.phone, town: r.town,
        already_consignor: linked.has(String(r.id)),
      })) });
    } catch (err) {
      console.error('[CONSIGNMENT] consignors search-tiers error:', err.message);
      res.status(500).json({ error: 'Erreur recherche tiers' });
    }
  });

  router.post('/consignors', auth, csrf, async (req, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'Nom du déposant requis' });
      let fkSoc = b.fk_soc ? parseInt(b.fk_soc, 10) : null;

      // Pose le flag fournisseur=1 dans Dolibarr si un tiers est rattaché.
      if (fkSoc && dolibarrPool) {
        try {
          const [[tier]] = await dolibarrPool.query('SELECT fournisseur FROM llx_societe WHERE rowid = ? AND status = 1', [fkSoc]);
          if (!tier) fkSoc = null;
          else if (!tier.fournisseur) await dolibarrPool.query('UPDATE llx_societe SET fournisseur = 1 WHERE rowid = ?', [fkSoc]);
        } catch (e) { console.warn('[CONSIGNMENT] flag fournisseur:', e.message); }
      }

      const r = db.prepare(
        `INSERT INTO consignors (fk_soc, name, contact_email, contact_phone, default_commission_rate, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        fkSoc, name,
        String(b.contact_email || '').trim().slice(0, 200) || null,
        String(b.contact_phone || '').trim().slice(0, 50) || null,
        cleanRate(b.default_commission_rate ?? 30),
        String(b.notes || '').trim().slice(0, 1000) || null,
      );
      res.status(201).json({ id: r.lastInsertRowid, success: true });
    } catch (err) {
      console.error('[CONSIGNMENT] consignor create error:', err.message);
      res.status(500).json({ error: 'Erreur création déposant' });
    }
  });

  router.put('/consignors/:id', auth, csrf, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const existing = db.prepare('SELECT id FROM consignors WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ error: 'Déposant introuvable' });
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 200);
      if (!name) return res.status(400).json({ error: 'Nom du déposant requis' });
      db.prepare(
        `UPDATE consignors SET name = ?, contact_email = ?, contact_phone = ?,
           default_commission_rate = ?, notes = ?, active = ? WHERE id = ?`
      ).run(
        name,
        String(b.contact_email || '').trim().slice(0, 200) || null,
        String(b.contact_phone || '').trim().slice(0, 50) || null,
        cleanRate(b.default_commission_rate ?? 30),
        String(b.notes || '').trim().slice(0, 1000) || null,
        b.active === undefined ? 1 : (b.active ? 1 : 0),
        id,
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[CONSIGNMENT] consignor update error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour déposant' });
    }
  });

  router.delete('/consignors/:id', auth, csrf, (req, res) => {
    try {
      db.prepare('UPDATE consignors SET active = 0 WHERE id = ?').run(parseInt(req.params.id, 10));
      res.json({ success: true });
    } catch (err) {
      console.error('[CONSIGNMENT] consignor delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression déposant' });
    }
  });

  // Détail déposant + titres consignés (avec stock courant Dolibarr).
  router.get('/consignors/:id', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const c = db.prepare('SELECT * FROM consignors WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ error: 'Déposant introuvable' });
      const maps = db.prepare('SELECT * FROM consignment_products WHERE consignor_id = ? AND active = 1').all(id);
      let titles = maps;
      if (maps.length && dolibarrPool) {
        try {
          const ids = maps.map(m => m.product_id);
          const ph = ids.map(() => '?').join(',');
          const [rows] = await dolibarrPool.query(
            `SELECT rowid AS id, ref, label, barcode, stock, price_ttc FROM llx_product WHERE rowid IN (${ph})`, ids
          );
          const pmap = new Map(rows.map(r => [r.id, r]));
          titles = maps.map(m => {
            const p = pmap.get(m.product_id) || {};
            return {
              product_id: m.product_id, commission_rate: m.commission_rate, sale_price_ttc: m.sale_price_ttc,
              ref: p.ref || null, label: p.label || null, isbn: p.barcode || p.ref || null,
              stock: p.stock ?? null, price_ttc: p.price_ttc ?? null,
            };
          });
        } catch (e) { console.warn('[CONSIGNMENT] consignor titles enrich:', e.message); }
      }
      const lastSettlement = db.prepare(
        "SELECT period_to FROM consignment_settlements WHERE consignor_id = ? AND status = 'paid' ORDER BY date(period_to) DESC LIMIT 1"
      ).get(id);
      res.json({ ...c, titles, lastSettlementTo: lastSettlement?.period_to || null });
    } catch (err) {
      console.error('[CONSIGNMENT] consignor detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement déposant' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉPÔTS (deposits)
  // ═══════════════════════════════════════════════════════════
  router.get('/deposits', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;
      const where = [];
      const params = [];
      if (req.query.status && DEP_STATUS[req.query.status]) { where.push('d.status = ?'); params.push(req.query.status); }
      if (req.query.consignor_id) { where.push('d.consignor_id = ?'); params.push(parseInt(req.query.consignor_id, 10)); }
      if (req.query.search) { where.push('(d.ref LIKE ? OR c.name LIKE ?)'); const p = `%${req.query.search}%`; params.push(p, p); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM consignment_deposits d LEFT JOIN consignors c ON c.id = d.consignor_id ${whereSql}`).get(...params).n;
      const rows = db.prepare(
        `SELECT d.*, c.name AS consignor_name FROM consignment_deposits d
         LEFT JOIN consignors c ON c.id = d.consignor_id
         ${whereSql} ORDER BY d.id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);
      res.json({ deposits: rows.map(depositToDto), total, page, pages: Math.max(1, Math.ceil(total / limit)) });
    } catch (err) {
      console.error('[CONSIGNMENT] deposits list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement dépôts' });
    }
  });

  router.post('/deposits', auth, csrf, (req, res) => {
    try {
      const b = req.body || {};
      const consignorId = parseInt(b.consignor_id, 10);
      const consignor = db.prepare('SELECT * FROM consignors WHERE id = ? AND active = 1').get(consignorId);
      if (!consignor) return res.status(400).json({ error: 'Déposant invalide' });
      const lines = sanitizeLines(b.lines);
      if (lines.length === 0) return res.status(400).json({ error: 'Au moins une ligne valide (ISBN/titre + quantité)' });
      // Applique le taux par défaut du déposant si une ligne n'en a pas.
      for (const l of lines) {
        if (!l.commission_rate) l.commission_rate = cleanRate(consignor.default_commission_rate);
      }

      const insert = db.transaction(() => {
        const ref = generateRef('DV', 'consignment_deposits');
        const r = db.prepare(
          `INSERT INTO consignment_deposits
             (ref, consignor_id, warehouse_id, warehouse_name, deposit_date, note, lines_json, status, total_qty, total_value, created_by)
           VALUES (?,?,?,?,?,?,?, 'draft', ?, ?, ?)`
        ).run(
          ref, consignorId,
          b.warehouse_id ? parseInt(b.warehouse_id, 10) : null,
          String(b.warehouse_name || '').trim().slice(0, 120) || null,
          String(b.deposit_date || todayISO()).slice(0, 10),
          String(b.note || '').trim().slice(0, 1000) || null,
          JSON.stringify(lines), sumQty(lines), sumValue(lines),
          req.admin?.username || 'admin',
        );
        return { id: r.lastInsertRowid, ref };
      });
      const out = insert();
      res.status(201).json(out);
    } catch (err) {
      console.error('[CONSIGNMENT] deposit create error:', err.message);
      res.status(500).json({ error: 'Erreur création dépôt' });
    }
  });

  router.get('/deposits/:id', auth, (req, res) => {
    try {
      const row = db.prepare(
        `SELECT d.*, c.name AS consignor_name FROM consignment_deposits d
         LEFT JOIN consignors c ON c.id = d.consignor_id WHERE d.id = ?`
      ).get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Dépôt introuvable' });
      res.json(depositToDto(row));
    } catch (err) {
      console.error('[CONSIGNMENT] deposit detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement dépôt' });
    }
  });

  router.put('/deposits/:id', auth, csrf, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM consignment_deposits WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Dépôt introuvable' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Seul un brouillon peut être modifié' });
      const b = req.body || {};
      const consignor = db.prepare('SELECT * FROM consignors WHERE id = ? AND active = 1').get(row.consignor_id);
      const lines = sanitizeLines(b.lines);
      if (lines.length === 0) return res.status(400).json({ error: 'Au moins une ligne valide' });
      for (const l of lines) if (!l.commission_rate) l.commission_rate = cleanRate(consignor?.default_commission_rate ?? 30);
      db.prepare(
        `UPDATE consignment_deposits SET warehouse_id = ?, warehouse_name = ?, deposit_date = ?, note = ?,
           lines_json = ?, total_qty = ?, total_value = ? WHERE id = ?`
      ).run(
        b.warehouse_id ? parseInt(b.warehouse_id, 10) : null,
        String(b.warehouse_name || '').trim().slice(0, 120) || null,
        String(b.deposit_date || row.deposit_date || todayISO()).slice(0, 10),
        String(b.note || '').trim().slice(0, 1000) || null,
        JSON.stringify(lines), sumQty(lines), sumValue(lines), id,
      );
      res.json({ success: true });
    } catch (err) {
      console.error('[CONSIGNMENT] deposit update error:', err.message);
      res.status(500).json({ error: 'Erreur mise à jour dépôt' });
    }
  });

  router.delete('/deposits/:id', auth, csrf, (req, res) => {
    try {
      const row = db.prepare('SELECT id, status FROM consignment_deposits WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Dépôt introuvable' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Seul un brouillon peut être supprimé' });
      db.prepare('DELETE FROM consignment_deposits WHERE id = ?').run(row.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[CONSIGNMENT] deposit delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression dépôt' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // VALIDATION DÉPÔT — crée/retrouve les produits, entrée de stock réelle,
  // pose le mapping produit → déposant.
  // ═══════════════════════════════════════════════════════════
  router.post('/deposits/:id/validate', auth, csrf, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM consignment_deposits WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Dépôt introuvable' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Ce dépôt est déjà validé' });
      if (!row.warehouse_id) return res.status(400).json({ error: "Entrepôt d'entrée requis pour valider le dépôt" });

      const consignorId = row.consignor_id;
      const lines = JSON.parse(row.lines_json) || [];
      const wh = parseInt(row.warehouse_id, 10);

      // Entrepôt valide
      const [[whRow]] = await dolibarrPool.query('SELECT rowid FROM llx_entrepot WHERE rowid = ? AND statut = 1', [wh]);
      if (!whRow) return res.status(400).json({ error: 'Entrepôt invalide ou inactif' });

      const moved = [];
      const conflicts = [];
      const failed = [];
      const resolvedLines = [];

      for (const l of lines) {
        try {
          let productId = l.product_id || null;
          const isbn = normIsbn(l.isbn);

          // 1) Résolution du produit
          if (!productId && isbn) {
            const [[found]] = await dolibarrPool.query(
              'SELECT rowid FROM llx_product WHERE barcode = ? OR ref = ? LIMIT 1', [isbn, isbn]
            );
            if (found) productId = found.rowid;
          }
          // 2) Création si introuvable
          if (!productId) {
            if (!validateISBN(isbn)) { failed.push({ label: l.label, error: 'ISBN invalide et produit introuvable' }); resolvedLines.push(l); continue; }
            const createRes = await adminApi.post('/products', {
              ref: isbn, label: l.label, barcode: isbn,
              price: l.sale_price_ttc || 0, price_ttc: l.sale_price_ttc || 0, tva_tx: 0,
              type: 0, status: 1, status_buy: 0,
              array_options: { options_auteur: l.author || '', options_editeur: '' },
            });
            productId = createRes.data;
          }

          // 3) Garde-fou attribution : un produit ne peut appartenir qu'à UN déposant.
          const existingMap = db.prepare('SELECT consignor_id FROM consignment_products WHERE product_id = ? AND active = 1').get(productId);
          if (existingMap && existingMap.consignor_id !== consignorId) {
            conflicts.push({ product_id: productId, label: l.label, owner: existingMap.consignor_id });
            resolvedLines.push({ ...l, product_id: productId });
            continue;
          }

          // 4) Entrée de stock réelle
          await adminApi.post('/stockmovements', {
            product_id: parseInt(productId, 10),
            warehouse_id: wh,
            qty: Math.abs(parseInt(l.qty, 10) || 0),
            movementcode: row.ref,
            movementlabel: `Dépôt-vente ${row.ref}`,
          });

          // 5) Mapping produit → déposant (commission verrouillée au dépôt)
          db.prepare(
            `INSERT INTO consignment_products (product_id, consignor_id, commission_rate, sale_price_ttc, first_deposit_id, active, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
             ON CONFLICT(product_id) DO UPDATE SET
               consignor_id = excluded.consignor_id, commission_rate = excluded.commission_rate,
               sale_price_ttc = excluded.sale_price_ttc, active = 1, updated_at = CURRENT_TIMESTAMP`
          ).run(productId, consignorId, cleanRate(l.commission_rate), l.sale_price_ttc || null, id);

          moved.push({ product_id: productId, qty: l.qty });
          resolvedLines.push({ ...l, product_id: productId });
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          console.error(`[CONSIGNMENT] line validate failed (${row.ref}):`, msg);
          failed.push({ label: l.label, error: msg });
          resolvedLines.push(l);
        }
      }

      const stockMoved = failed.length === 0 && conflicts.length === 0 && moved.length > 0 ? 1 : 0;
      db.prepare(
        `UPDATE consignment_deposits SET status = 'validated', stock_moved = ?, lines_json = ?, validated_by = ?, validated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(stockMoved, JSON.stringify(resolvedLines), req.admin?.username || 'admin', id);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'admin', 'consignment_validate', `Dépôt-vente ${row.ref} validé : ${moved.length} ligne(s) en stock`);

      res.json({ success: true, stock: { moved: moved.length, failed, conflicts } });
    } catch (err) {
      console.error('[CONSIGNMENT] deposit validate error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur validation dépôt' });
    }
  });

  // Bon de dépôt PDF — preuve de remise, signée par le déposant et L'Harmattan.
  router.get('/deposits/:id/pdf', auth, (req, res) => {
    try {
      const row = db.prepare(
        `SELECT d.*, c.name AS consignor_name, c.contact_email, c.contact_phone
           FROM consignment_deposits d
           LEFT JOIN consignors c ON c.id = d.consignor_id WHERE d.id = ?`
      ).get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Dépôt introuvable' });
      const dto = depositToDto(row);
      dto.consignor = { name: row.consignor_name, email: row.contact_email, phone: row.contact_phone };

      const buf = renderOdtPdf(`dv-${row.id}`, buildDepositContent(dto));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${dto.ref}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[CONSIGNMENT] deposit pdf error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RETOURS D'INVENDUS — sortie de stock + maj qty_returned
  // ═══════════════════════════════════════════════════════════
  router.post('/deposits/:id/return', auth, csrf, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const row = db.prepare('SELECT * FROM consignment_deposits WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Dépôt introuvable' });
      if (row.status === 'draft') return res.status(409).json({ error: 'Validez le dépôt avant de gérer les retours' });
      if (!row.warehouse_id) return res.status(400).json({ error: 'Entrepôt du dépôt inconnu' });

      const reqLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
      if (!reqLines.length) return res.status(400).json({ error: 'Aucune ligne de retour' });
      const wh = parseInt(row.warehouse_id, 10);
      const lines = JSON.parse(row.lines_json) || [];
      const moved = [];
      const failed = [];

      for (const rl of reqLines) {
        const pid = parseInt(rl.product_id, 10);
        const qty = parseInt(rl.qty, 10) || 0;
        if (!pid || qty < 1) continue;
        const idx = lines.findIndex(l => parseInt(l.product_id, 10) === pid);
        if (idx === -1) { failed.push({ product_id: pid, error: 'Ligne absente du dépôt' }); continue; }
        const line = lines[idx];
        const remaining = (parseInt(line.qty, 10) || 0) - (parseInt(line.qty_returned, 10) || 0);
        if (qty > remaining) { failed.push({ product_id: pid, error: `Retour > restant (${remaining})` }); continue; }
        try {
          await adminApi.post('/stockmovements', {
            product_id: pid, warehouse_id: wh,
            qty: -Math.abs(qty),
            movementcode: row.ref,
            movementlabel: `Retour dépôt-vente ${row.ref}`,
          });
          lines[idx] = { ...line, qty_returned: (parseInt(line.qty_returned, 10) || 0) + qty };
          moved.push({ product_id: pid, qty });
        } catch (e) {
          failed.push({ product_id: pid, error: e.response?.data?.error?.message || e.message });
        }
      }

      // Si tout est retourné, on clôture le dépôt.
      const allReturned = lines.every(l => (parseInt(l.qty_returned, 10) || 0) >= (parseInt(l.qty, 10) || 0));
      db.prepare('UPDATE consignment_deposits SET lines_json = ?, status = ? WHERE id = ?')
        .run(JSON.stringify(lines), allReturned ? 'closed' : row.status, id);

      res.json({ success: true, returned: moved, failed, closed: allReturned });
    } catch (err) {
      console.error('[CONSIGNMENT] deposit return error:', err.message);
      res.status(500).json({ error: 'Erreur traitement des retours' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CALCUL DES VENTES — pour le reversement
  // Attribue les ventes (llx_facturedet) aux produits consignés du déposant
  // sur une période. fk_statut >= 1 = facture validée ; les avoirs (qty/total
  // négatifs) nettent naturellement les retours déjà facturés.
  // ═══════════════════════════════════════════════════════════
  async function computeSales(consignorId, periodFrom, periodTo) {
    const maps = db.prepare('SELECT product_id, commission_rate, sale_price_ttc FROM consignment_products WHERE consignor_id = ? AND active = 1').all(consignorId);
    if (!maps.length) return { lines: [], totals: { qty: 0, sales: 0, commission: 0, net: 0 } };
    const rateMap = new Map(maps.map(m => [m.product_id, m]));
    const ids = maps.map(m => m.product_id);
    const ph = ids.map(() => '?').join(',');

    const [rows] = await dolibarrPool.query(
      `SELECT fd.fk_product AS product_id, p.ref, p.label, p.barcode,
              SUM(fd.qty) AS qty_sold, SUM(fd.total_ttc) AS sales_ttc
         FROM llx_facturedet fd
         JOIN llx_facture f ON f.rowid = fd.fk_facture
         LEFT JOIN llx_product p ON p.rowid = fd.fk_product
        WHERE fd.fk_product IN (${ph})
          AND f.fk_statut >= 1
          AND f.datef >= ? AND f.datef <= ?
        GROUP BY fd.fk_product
        HAVING SUM(fd.qty) <> 0`,
      [...ids, periodFrom, `${periodTo} 23:59:59`]
    );

    const lines = rows.map(r => {
      const m = rateMap.get(r.product_id) || { commission_rate: 0 };
      const sales = Math.round((Number(r.sales_ttc) || 0));
      const commission = Math.round(sales * (Number(m.commission_rate) || 0) / 100);
      const net = sales - commission;
      return {
        product_id: r.product_id, ref: r.ref, isbn: r.barcode || r.ref, label: r.label,
        qty_sold: Number(r.qty_sold) || 0,
        sale_total_ttc: sales,
        commission_rate: Number(m.commission_rate) || 0,
        commission_amount: commission,
        net_due: net,
      };
    }).sort((a, b) => b.net_due - a.net_due);

    const totals = lines.reduce((t, l) => ({
      qty: t.qty + l.qty_sold, sales: t.sales + l.sale_total_ttc,
      commission: t.commission + l.commission_amount, net: t.net + l.net_due,
    }), { qty: 0, sales: 0, commission: 0, net: 0 });

    return { lines, totals };
  }

  /**
   * Garantit que le déposant a un tiers Dolibarr FOURNISSEUR, et le retourne.
   *
   * Facturer suppose un tiers : un déposant créé sans rattachement (fk_soc NULL)
   * en obtient un ici, à la demande, plutôt que de bloquer l'utilisateur. Le
   * flag fournisseur=1 est indispensable — sans lui le tiers est invisible des
   * factures d'achat.
   *
   * ⚠️ Un tiers ARCHIVÉ (status=0) n'est pas un tiers absent : en recréer un
   * homonyme scinderait l'historique fournisseur du déposant sur deux fiches —
   * exactement le mal traité par la remise en ordre des tiers de 2026-05. On
   * remonte donc une erreur explicite. Seul un fk_soc vraiment introuvable
   * (fiche supprimée) justifie une création.
   */
  async function ensureConsignorTier(consignor) {
    if (consignor.fk_soc) {
      const [[t]] = await dolibarrPool.query(
        'SELECT rowid, fournisseur, status, code_fournisseur, nom FROM llx_societe WHERE rowid = ?', [consignor.fk_soc]
      );
      if (t && Number(t.status) !== 1) {
        throw new Error(`le tiers « ${t.nom} » rattaché à ce déposant est archivé dans Dolibarr — réactivez-le avant de facturer`);
      }
      if (t) {
        // Passe par l'API (et non un UPDATE brut) pour que Dolibarr attribue le
        // code fournisseur : Societe::update ne le génère que sur la valeur -1.
        if (!t.fournisseur || !t.code_fournisseur) {
          await adminApi.put(`/thirdparties/${consignor.fk_soc}`, {
            fournisseur: 1,
            ...(t.code_fournisseur ? {} : { code_fournisseur: -1 }),
          });
        }
        return Number(consignor.fk_soc);
      }
    }
    const created = await adminApi.post('/thirdparties', {
      name: consignor.name,
      email: consignor.contact_email || '',
      phone: consignor.contact_phone || '',
      client: 0,
      fournisseur: 1,
      code_fournisseur: -1, // -1 = laisser Dolibarr générer le code (cf. author-tier.js)
    });
    const socId = Number(created.data);
    db.prepare('UPDATE consignors SET fk_soc = ? WHERE id = ?').run(socId, consignor.id);
    return socId;
  }

  // ═══════════════════════════════════════════════════════════
  // REVERSEMENTS (settlements)
  // ═══════════════════════════════════════════════════════════

  // Aperçu (sans persistance). Suggère period_from = lendemain du dernier
  // reversement payé pour éviter tout double comptage.
  router.get('/settlements/preview', auth, async (req, res) => {
    try {
      const consignorId = parseInt(req.query.consignor_id, 10);
      const consignor = db.prepare('SELECT * FROM consignors WHERE id = ?').get(consignorId);
      if (!consignor) return res.status(400).json({ error: 'Déposant invalide' });

      const last = db.prepare("SELECT period_to FROM consignment_settlements WHERE consignor_id = ? AND status = 'paid' ORDER BY date(period_to) DESC LIMIT 1").get(consignorId);
      let periodFrom = req.query.period_from;
      if (!periodFrom) {
        if (last?.period_to) { const d = new Date(last.period_to + 'T00:00:00'); d.setDate(d.getDate() + 1); periodFrom = d.toISOString().slice(0, 10); }
        else periodFrom = '2000-01-01';
      }
      const periodTo = req.query.period_to || todayISO();

      const { lines, totals } = await computeSales(consignorId, periodFrom, periodTo);
      res.json({ consignor: { id: consignor.id, name: consignor.name }, periodFrom, periodTo, lines, totals, lastSettlementTo: last?.period_to || null });
    } catch (err) {
      console.error('[CONSIGNMENT] settlement preview error:', err.message);
      res.status(500).json({ error: 'Erreur calcul du reversement' });
    }
  });

  router.post('/settlements', auth, csrf, async (req, res) => {
    try {
      const b = req.body || {};
      const consignorId = parseInt(b.consignor_id, 10);
      const consignor = db.prepare('SELECT * FROM consignors WHERE id = ?').get(consignorId);
      if (!consignor) return res.status(400).json({ error: 'Déposant invalide' });
      const periodFrom = String(b.period_from || '').slice(0, 10);
      const periodTo = String(b.period_to || todayISO()).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(periodFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(periodTo)) {
        return res.status(400).json({ error: 'Période invalide' });
      }

      const { lines, totals } = await computeSales(consignorId, periodFrom, periodTo);
      if (lines.length === 0) return res.status(400).json({ error: 'Aucune vente sur cette période' });

      const insert = db.transaction(() => {
        const ref = generateRef('RV', 'consignment_settlements');
        const r = db.prepare(
          `INSERT INTO consignment_settlements
             (ref, consignor_id, period_from, period_to, total_qty, total_sales_ttc, total_commission, total_net_due, lines_json, status, created_by)
           VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?)`
        ).run(ref, consignorId, periodFrom, periodTo, totals.qty, totals.sales, totals.commission, totals.net, JSON.stringify(lines), req.admin?.username || 'admin');
        return { id: r.lastInsertRowid, ref };
      });
      const out = insert();
      res.status(201).json(out);
    } catch (err) {
      console.error('[CONSIGNMENT] settlement create error:', err.message);
      res.status(500).json({ error: 'Erreur création du reversement' });
    }
  });

  router.get('/settlements', auth, (req, res) => {
    try {
      const where = [];
      const params = [];
      if (req.query.status && SET_STATUS[req.query.status]) { where.push('s.status = ?'); params.push(req.query.status); }
      if (req.query.consignor_id) { where.push('s.consignor_id = ?'); params.push(parseInt(req.query.consignor_id, 10)); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const rows = db.prepare(
        `SELECT s.*, c.name AS consignor_name FROM consignment_settlements s
         LEFT JOIN consignors c ON c.id = s.consignor_id ${whereSql} ORDER BY s.id DESC LIMIT 200`
      ).all(...params);
      res.json({ settlements: rows.map(settlementToDto) });
    } catch (err) {
      console.error('[CONSIGNMENT] settlements list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement reversements' });
    }
  });

  function settlementToDto(r) {
    let lines = [];
    try { lines = JSON.parse(r.lines_json) || []; } catch { lines = []; }
    return {
      id: r.id, ref: r.ref, consignorId: r.consignor_id, consignorName: r.consignor_name || null,
      periodFrom: r.period_from, periodTo: r.period_to,
      totalQty: r.total_qty, totalSales: r.total_sales_ttc, totalCommission: r.total_commission, totalNetDue: r.total_net_due,
      lines, status: r.status, statusLabel: SET_STATUS[r.status] || r.status,
      paymentRef: r.payment_ref, paymentMode: r.payment_mode,
      paymentModeLabel: SETTLEMENT_PAYMENT_MODES[r.payment_mode]?.label || null,
      invoice: r.fk_facture_fourn ? { id: r.fk_facture_fourn, ref: r.facture_fourn_ref, paymentId: r.fk_paiement_fourn } : null,
      createdBy: r.created_by, createdAt: r.created_at, paidBy: r.paid_by, paidAt: r.paid_at,
    };
  }

  /**
   * Facture fournisseur du NET à reverser (autofacturation du dépôt-vente).
   *
   * Contrepartie comptable indispensable : la vente du livre en dépôt passe en
   * TOTALITÉ en produit chez L'Harmattan (facture client POS/web). Sans facture
   * d'achat pour le net reversé, le CA est gonflé du montant reversé au déposant.
   * Avec elle : CA vente − achat net = marge = exactement la commission retenue.
   *
   * Idempotent : une facture déjà rattachée est renvoyée telle quelle ; l'index
   * unique Dolibarr (ref_supplier, fk_soc) rattrape une création concurrente.
   */
  router.post('/settlements/:id/supplier-invoice', auth, requireFinance, csrf, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = db.prepare(
      `SELECT s.*, c.id AS c_id, c.name AS c_name, c.fk_soc, c.contact_email, c.contact_phone
         FROM consignment_settlements s
         LEFT JOIN consignors c ON c.id = s.consignor_id WHERE s.id = ?`
    ).get(id);
    if (!row) return res.status(404).json({ error: 'Reversement introuvable' });
    if (row.fk_facture_fourn) {
      return res.json({ ok: true, already: true, id: row.fk_facture_fourn, ref: row.facture_fourn_ref });
    }
    // Un reversement payé ne peut plus être soldé par /pay (il n'est plus en
    // brouillon) : lui créer une facture validée la rendrait impayable et
    // laisserait le déposant en dettes fournisseurs à vie.
    if (row.status === 'paid') {
      return res.status(409).json({ error: 'Ce reversement est déjà marqué payé : sa facture devait être créée avant le règlement' });
    }
    if (!row.c_id) return res.status(400).json({ error: 'Déposant introuvable' });
    const net = Math.round(Number(row.total_net_due) || 0);
    if (net <= 0) return res.status(400).json({ error: 'Aucun net à reverser sur ce reversement' });

    let invoiceId = null;
    let linked = false;
    try {
      const socId = await ensureConsignorTier({
        id: row.c_id, name: row.c_name, fk_soc: row.fk_soc,
        contact_email: row.contact_email, contact_phone: row.contact_phone,
      });

      // 1. Brouillon (ref provisoire ; la numérotation légale se fait à la validation).
      const createRes = await adminApi.post('/supplierinvoices', {
        socid: socId,
        type: 0,
        date: todayISO(),
        date_echeance: todayISO(),
        ref_supplier: row.ref, // unique par fournisseur : la réf du reversement
        libelle: `Dépôt-vente — reversement ${row.ref}`,
      });
      invoiceId = createRes.data;

      // 2. Ligne unique. TVA 0 : L'Harmattan Sénégal ne facture pas la TVA.
      await adminApi.post(`/supplierinvoices/${invoiceId}/lines`, {
        description: `Livres vendus en dépôt-vente — période du ${fmtDateFr(row.period_from)} au ${fmtDateFr(row.period_to)}`
          + ` — ${row.total_qty} exemplaire(s), ventes ${fmtFcfa(row.total_sales_ttc)}, commission retenue ${fmtFcfa(row.total_commission)}`,
        pu_ht: net,
        tva_tx: 0,
        qty: 1,
        product_type: 0,
        remise_percent: 0,
      });

      // 3. Validation → numérotation légale + triggers.
      await adminApi.post(`/supplierinvoices/${invoiceId}/validate`, {});

      let ref = `#${invoiceId}`;
      try {
        const detail = await adminApi.get(`/supplierinvoices/${invoiceId}`);
        ref = detail.data?.ref || ref;
      } catch { /* ref de repli */ }

      db.prepare('UPDATE consignment_settlements SET fk_facture_fourn = ?, facture_fourn_ref = ? WHERE id = ?')
        .run(invoiceId, ref, id);
      linked = true;
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'admin', 'consignment_supplier_invoice',
          `Facture fournisseur ${ref} créée pour le reversement ${row.ref} — ${row.c_name} : ${fmtFcfa(net)}`);
      res.json({ ok: true, id: invoiceId, ref });
    } catch (err) {
      const apiMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
      console.error('[CONSIGNMENT] supplier invoice create error:', apiMsg);
      // Nettoyage prudent. On ne supprime QUE si la facture est encore un
      // brouillon et qu'aucun lien local n'a été posé : FactureFournisseur::delete
      // ne refuse pas les factures validées, et en supprimer une trouerait la
      // numérotation légale. Un timeout sur validate() peut très bien masquer une
      // validation réussie — d'où la relecture du statut réel plutôt qu'un
      // delete aveugle.
      if (invoiceId && !linked) {
        try {
          const detail = await adminApi.get(`/supplierinvoices/${invoiceId}`);
          if (Number(detail.data?.statut ?? detail.data?.status) === 0) {
            await adminApi.delete(`/supplierinvoices/${invoiceId}`);
          } else {
            console.warn(`[CONSIGNMENT] facture fourn. #${invoiceId} validée malgré l'erreur — conservée, à rattacher manuellement`);
            return res.status(502).json({
              error: `La facture fournisseur #${invoiceId} a été créée mais n'a pas pu être rattachée (${apiMsg}). Vérifiez-la dans la comptabilité.`,
            });
          }
        } catch (e) {
          if (e.response?.status !== 404) console.warn('[CONSIGNMENT] nettoyage facture fourn. échoué:', e.message);
        }
      }
      res.status(502).json({ error: `Erreur création facture fournisseur : ${apiMsg}` });
    }
  });

  // PDF de la facture fournisseur (Dolibarr, modèle canelle).
  router.get('/settlements/:id/supplier-invoice/pdf', auth, async (req, res) => {
    try {
      const row = db.prepare('SELECT fk_facture_fourn, facture_fourn_ref FROM consignment_settlements WHERE id = ?')
        .get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Reversement introuvable' });
      if (!row.fk_facture_fourn) return res.status(404).json({ error: 'Aucune facture fournisseur rattachée à ce reversement' });
      await streamDolibarrPdf(res, {
        type: 'supplier_invoice',
        id: row.fk_facture_fourn,
        filename: `${row.facture_fourn_ref || row.fk_facture_fourn}.pdf`,
      });
    } catch (err) {
      console.error('[CONSIGNMENT] supplier invoice pdf error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    }
  });

  router.get('/settlements/:id', auth, (req, res) => {
    try {
      const row = db.prepare(
        `SELECT s.*, c.name AS consignor_name FROM consignment_settlements s
         LEFT JOIN consignors c ON c.id = s.consignor_id WHERE s.id = ?`
      ).get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Reversement introuvable' });
      res.json(settlementToDto(row));
    } catch (err) {
      console.error('[CONSIGNMENT] settlement detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement reversement' });
    }
  });

  /**
   * Marque le reversement payé et enregistre le règlement RÉEL de la facture
   * fournisseur dans Dolibarr (sortie de trésorerie tracée).
   *
   * ⚠️ Le statut local est RÉSERVÉ de façon atomique (draft → paid) AVANT
   * l'appel Dolibarr. C'est contre-intuitif mais c'est le seul ordre sûr :
   * PaiementFourn::create n'a aucun garde-fou anti-sur-paiement, donc deux
   * requêtes qui liraient « draft » en même temps (deux onglets, deux admins,
   * ou un simple retry après timeout) paieraient le déposant DEUX FOIS. Cf.
   * incident_pos_timeout_phantom_payment : un timeout à 30 s ne signifie pas
   * que Dolibarr n'a pas commité.
   *
   * En cas d'échec CERTAIN (Dolibarr a répondu une erreur → rien n'est commité)
   * la réservation est relâchée. En cas d'échec INDÉTERMINÉ (timeout, réseau)
   * elle est maintenue et l'admin est invité à vérifier avant tout retry :
   * mieux vaut un reversement à vérifier qu'un déposant payé deux fois.
   */
  router.post('/settlements/:id/pay', auth, requireFinance, csrf, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const admin = req.admin?.username || 'admin';
    let claimed = false;
    try {
      const row = db.prepare('SELECT * FROM consignment_settlements WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'Reversement introuvable' });
      if (row.status === 'paid') return res.status(409).json({ error: 'Reversement déjà marqué payé' });

      const payRef = String(req.body?.payment_ref || '').trim().slice(0, 120) || null;
      const modeKey = String(req.body?.payment_mode || '').toUpperCase();
      const mode = SETTLEMENT_PAYMENT_MODES[modeKey] || null;
      if (modeKey && !mode) return res.status(400).json({ error: 'Mode de règlement inconnu' });
      const net = Math.round(Number(row.total_net_due) || 0);
      // La facture est la contrepartie comptable du reversement : l'exiger avant
      // de payer évite la facture validée « impayable » (le /pay ne sait solder
      // qu'un reversement en brouillon).
      if (net > 0 && !row.fk_facture_fourn) {
        return res.status(409).json({ error: "Créez d'abord la facture fournisseur : elle est la contrepartie comptable du reversement" });
      }
      if (row.fk_facture_fourn && !mode) {
        return res.status(400).json({ error: 'Mode de règlement requis pour solder la facture fournisseur' });
      }

      const modeId = row.fk_facture_fourn ? await resolvePaymentId(dolibarrPool, mode.code) : null;
      if (row.fk_facture_fourn && !modeId) {
        return res.status(500).json({ error: `Mode de paiement Dolibarr introuvable (${mode.code})` });
      }

      // Réservation atomique : une seule requête peut passer draft → paid.
      const claim = db.prepare(
        `UPDATE consignment_settlements SET status = 'paid', payment_ref = ?, payment_mode = ?,
           paid_by = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`
      ).run(payRef, modeKey || null, admin, id);
      if (claim.changes === 0) return res.status(409).json({ error: 'Reversement déjà marqué payé' });
      claimed = true;

      let paymentId = null;
      if (row.fk_facture_fourn) {
        try {
          // Contrairement aux factures client, addPayment fournisseur RESPECTE
          // `amount` (api_supplier_invoices.class.php ~l.454) — pas de risque de
          // sur-paiement type bug_split_payment_overpay.
          const payRes = await adminApi.post(`/supplierinvoices/${row.fk_facture_fourn}/payments`, {
            datepaye: Math.floor(new Date(`${todayISO()}T12:00:00Z`).getTime() / 1000), // midi UTC : pas de dérive de fuseau
            payment_mode_id: modeId,
            closepaidinvoices: 'yes',
            accountid: mode.accountId,
            num_payment: payRef ? payRef.slice(0, 40) : undefined,
            comment: `Reversement dépôt-vente ${row.ref}`,
            amount: net,
            ...(mode.code === 'CHQ' ? { chqemetteur: EDITOR_NAME } : {}),
          });
          paymentId = payRes.data;
          // L'argent est parti : plus AUCUN relâchement automatique de la
          // réservation à partir d'ici. Sans cette ligne, un simple SQLITE_BUSY
          // sur une écriture suivante ferait repasser le reversement en brouillon
          // via le catch externe — et le clic suivant paierait une 2ᵉ fois.
          claimed = false;
        } catch (err) {
          const apiMsg = err.response?.data?.error?.message || err.response?.data?.error || err.message;
          console.error('[CONSIGNMENT] supplier payment error:', apiMsg);
          // 502/503/504 = la passerelle a renoncé, pas Dolibarr : le PHP peut très
          // bien avoir commité derrière. Seule une vraie réponse applicative
          // d'erreur prouve que rien n'a été enregistré.
          const gatewayGaveUp = [502, 503, 504].includes(err.response?.status);
          if (err.response && !gatewayGaveUp) {
            // Dolibarr a répondu une erreur → rien n'a été commité : on relâche.
            db.prepare("UPDATE consignment_settlements SET status='draft', paid_by=NULL, paid_at=NULL WHERE id=?").run(id);
            claimed = false;
            return res.status(502).json({ error: `Règlement Dolibarr refusé : ${apiMsg}` });
          }
          // Timeout / réseau / passerelle : le règlement a PEUT-ÊTRE été
          // enregistré. On garde la réservation pour interdire tout retry aveugle.
          claimed = false;
          db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
            .run(admin, 'consignment_settle_indeterminate',
              `Reversement ${row.ref} : règlement Dolibarr indéterminé (${apiMsg}) — vérifier la facture ${row.facture_fourn_ref || row.fk_facture_fourn}`);
          return res.status(502).json({
            error: `Règlement incertain (${apiMsg}). Le reversement est marqué payé par sécurité : vérifiez la facture ${row.facture_fourn_ref || `#${row.fk_facture_fourn}`} dans la comptabilité avant toute nouvelle tentative.`,
          });
        }
        db.prepare('UPDATE consignment_settlements SET fk_paiement_fourn = ? WHERE id = ?').run(paymentId, id);
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(admin, 'consignment_settle',
          `Reversement ${row.ref} marqué payé (${fmtFcfa(row.total_net_due)})${mode ? ` — ${mode.label}` : ''}${paymentId ? ` — paiement Dolibarr #${paymentId}` : ''}`);
      res.json({ success: true, paymentId });
    } catch (err) {
      console.error('[CONSIGNMENT] settlement pay error:', err.message);
      // `claimed` n'est vrai QUE tant qu'aucun euro n'a bougé : il est remis à
      // false dès que l'appel de règlement aboutit ou devient incertain. Ce
      // relâchement ne concerne donc que les échecs antérieurs au paiement.
      if (claimed) {
        try { db.prepare("UPDATE consignment_settlements SET status='draft', paid_by=NULL, paid_at=NULL WHERE id=?").run(id); }
        catch { /* best effort */ }
      }
      res.status(500).json({ error: 'Erreur enregistrement du paiement' });
    }
  });

  router.delete('/settlements/:id', auth, csrf, (req, res) => {
    try {
      const row = db.prepare('SELECT id, status, fk_facture_fourn, facture_fourn_ref FROM consignment_settlements WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Reversement introuvable' });
      if (row.status === 'paid') return res.status(409).json({ error: 'Un reversement payé ne peut être supprimé' });
      // Une facture fournisseur validée porte un numéro légal : la supprimer côté
      // Dolibarr n'est pas notre décision. On refuse plutôt que de laisser une
      // facture orpheline sans reversement d'origine.
      if (row.fk_facture_fourn) {
        return res.status(409).json({
          error: `Facture fournisseur ${row.facture_fourn_ref || `#${row.fk_facture_fourn}`} rattachée : annulez-la d'abord dans la comptabilité`,
        });
      }
      db.prepare('DELETE FROM consignment_settlements WHERE id = ?').run(row.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[CONSIGNMENT] settlement delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression reversement' });
    }
  });

  // PDF relevé de reversement (ODT → LibreOffice)
  router.get('/settlements/:id/pdf', auth, (req, res) => {
    try {
      const row = db.prepare(
        `SELECT s.*, c.name AS consignor_name, c.contact_email, c.contact_phone FROM consignment_settlements s
         LEFT JOIN consignors c ON c.id = s.consignor_id WHERE s.id = ?`
      ).get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Reversement introuvable' });
      const dto = settlementToDto(row);
      dto.consignor = { name: row.consignor_name, email: row.contact_email, phone: row.contact_phone };

      const buf = renderOdtPdf(`rv-${row.id}`, buildCvContent(dto));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${dto.ref}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[CONSIGNMENT] settlement pdf error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    }
  });

  return router;
}

// ─── GÉNÉRATION ODT (bon de dépôt, relevé de reversement) ────
function buildCvManifest(withLogo) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>${
   withLogo ? `\n <manifest:file-entry manifest:full-path="Pictures/logo.png" manifest:media-type="image/png"/>` : ''
 }
</manifest:manifest>`;
}

// Namespaces requis par le cadre d'image du logo, en plus des namespaces de base.
const CV_CONTENT_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';

// Style du cadre logo — automatique (content.xml) comme tous les styles non
// textuels, cf. le piège documenté sur buildCvStyles.
const CV_LOGO_AUTOSTYLE = `<style:style style:name="LogoFr" style:family="graphic"><style:graphic-properties style:vertical-pos="middle" style:vertical-rel="text" style:horizontal-pos="left" style:horizontal-rel="paragraph" style:wrap="none" fo:border="none"/></style:style>`;

/**
 * En-tête commun : logo L'Harmattan + baseline. Le logo porte déjà le nom de la
 * maison, on ne le redouble donc pas en texte. Un logo introuvable ne doit
 * JAMAIS empêcher l'émission du document (même principe que le filigrane des
 * contrats) : on retombe alors sur le nom en toutes lettres.
 */
function letterheadXml(tagline) {
  const head = hasLogo()
    ? `<text:p text:style-name="LogoP"><draw:frame draw:style-name="LogoFr" draw:name="Logo" text:anchor-type="as-char" svg:width="${LOGO_WIDTH_CM}cm" svg:height="${(LOGO_WIDTH_CM / LOGO_RATIO).toFixed(2)}cm"><draw:image xlink:href="Pictures/logo.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame></text:p>`
    : `<text:p text:style-name="Editor">${escXml(EDITOR_NAME)}</text:p>`;
  return `${head}
  <text:p text:style-name="Tag">${escXml(tagline)}</text:p>`;
}

const CV_PRIMARY = '#10531a';
const CV_MUTED = '#6b7280';

/**
 * Styles PARTAGÉS des documents dépôt-vente (styles.xml).
 *
 * ⚠️ N'y placer QUE des styles de paragraphe / texte / page. Les styles de
 * `table`, `table-column` et `table-cell` déclarés ici sont IGNORÉS au rendu :
 * LibreOffice ne les applique que depuis les styles automatiques de content.xml.
 * Le relevé de reversement en a longtemps fait les frais — en-tête de tableau en
 * texte blanc sur fond vert « perdu » (donc blanc sur blanc, invisible) et
 * largeurs de colonnes non appliquées. Chaque document déclare donc ses styles
 * de tableau dans son propre <office:automatic-styles>.
 */
export function buildCvStyles() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties fo:margin-bottom="0.15cm" fo:line-height="130%"/>
   <style:text-properties style:font-name="Liberation Sans" fo:font-size="10.5pt" fo:color="#1a1a1a" fo:language="fr" fo:country="FR"/>
  </style:default-style>
  <style:style style:name="Editor" style:family="paragraph"><style:text-properties fo:font-size="15pt" fo:font-weight="bold" fo:color="${CV_PRIMARY}"/></style:style>
  <style:style style:name="LogoP" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.15cm"/></style:style>
  <style:style style:name="Tag" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.4cm" fo:border-bottom="1pt solid ${CV_PRIMARY}" fo:padding-bottom="0.2cm"/><style:text-properties fo:font-size="8.5pt" fo:color="${CV_MUTED}" fo:letter-spacing="0.05cm"/></style:style>
  <style:style style:name="DocTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.2cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="20pt" fo:font-weight="bold" fo:letter-spacing="0.08cm" fo:color="${CV_PRIMARY}"/></style:style>
  <style:style style:name="DocRef" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.5cm"/><style:text-properties fo:font-size="11pt" fo:color="${CV_MUTED}"/></style:style>
  <style:style style:name="BlockTitle" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.3cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${CV_MUTED}"/></style:style>
  <style:style style:name="Box" style:family="paragraph"><style:paragraph-properties fo:background-color="#f0fdf4" fo:border-left="3pt solid ${CV_PRIMARY}" fo:padding="0.3cm 0.4cm" fo:margin-bottom="0.4cm"/></style:style>
  <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Muted" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.2cm"/><style:text-properties fo:font-size="9pt" fo:color="${CV_MUTED}"/></style:style>
  <style:style style:name="FooterLegal" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="7.5pt" fo:color="${CV_MUTED}"/></style:style>
  <style:style style:name="Total" style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="0.15cm"/><style:text-properties fo:font-size="10.5pt" fo:color="#1a1a1a"/></style:style>
  <style:style style:name="GrandTotal" style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="0.3cm" fo:border-top="1pt solid ${CV_PRIMARY}" fo:padding-top="0.2cm"/><style:text-properties fo:font-size="13pt" fo:font-weight="bold" fo:color="${CV_PRIMARY}"/></style:style>
  <style:style style:name="THeadP" style:family="paragraph"><style:text-properties fo:font-size="8.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPR" style:family="paragraph"><style:paragraph-properties fo:text-align="right"/><style:text-properties fo:font-size="8.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="TCellR" style:family="paragraph"><style:paragraph-properties fo:text-align="right"/><style:text-properties fo:font-size="9pt"/></style:style>
  <style:style style:name="TCellL" style:family="paragraph"><style:text-properties fo:font-size="9pt"/></style:style>
  <style:style style:name="Terms" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.5cm"/><style:text-properties fo:font-size="8pt" fo:color="${CV_MUTED}"/></style:style>
  <style:style style:name="SigName" style:family="paragraph"><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="SigHint" style:family="paragraph"><style:text-properties fo:font-size="7.5pt" fo:color="${CV_MUTED}"/></style:style>
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

/** Encadré déposant (nom + contacts), commun au bon de dépôt et au relevé. */
function consignorBoxXml(consignor) {
  let x = `<text:p text:style-name="Box"><text:span text:style-name="Bold">${escXml(consignor?.name || '—')}</text:span>`;
  if (consignor?.email) x += `<text:line-break/>${escXml(consignor.email)}`;
  if (consignor?.phone) x += `<text:line-break/>${escXml(consignor.phone)}`;
  return x + `</text:p>`;
}

/**
 * Bon de dépôt — preuve de remise des ouvrages, signée des deux parties.
 *
 * Les colonnes « Retourné / En dépôt » n'apparaissent que si des invendus ont
 * déjà été repris : un bon fraîchement imprimé n'a aucune raison de montrer des
 * colonnes à zéro, mais une réimpression après reprise doit refléter le réel.
 */
export function buildDepositContent(dto) {
  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const qtyOf = (l) => parseInt(l.qty, 10) || 0;
  const retOf = (l) => parseInt(l.qty_returned, 10) || 0;
  const hasReturns = dto.lines.some(l => retOf(l) > 0);

  // Largeurs calées sur le rendu réel (total = 16.6cm) : « Comm. » sous 1.6cm
  // casse son en-tête sur deux lignes, les colonnes montant tiennent « 150 000 FCFA ».
  const cols = hasReturns
    ? [['ColDIsbn', '2.6cm'], ['ColDLabel', '3.6cm'], ['ColDQty', '1.4cm'], ['ColDQty', '1.5cm'],
       ['ColDQty', '1.5cm'], ['ColDMoney', '2.1cm'], ['ColDMoney', '2.3cm'], ['ColDRate', '1.6cm']]
    : [['ColDIsbn', '2.9cm'], ['ColDLabel', '5.7cm'], ['ColDQty', '1.5cm'],
       ['ColDMoney', '2.4cm'], ['ColDMoney', '2.5cm'], ['ColDRate', '1.6cm']];
  const heads = hasReturns
    ? ['ISBN', 'Titre', 'Déposé', 'Retourné', 'En dépôt', 'Prix unit.', 'Valeur', 'Comm.']
    : ['ISBN', 'Titre', 'Déposé', 'Prix unit.', 'Valeur', 'Comm.'];

  // Largeurs de colonnes : styles automatiques (uniques par document car le jeu
  // de colonnes dépend de hasReturns) — d'où leur déclaration ici et non dans styles.xml.
  const colStyles = cols.map(([name, w], i) =>
    `<style:style style:name="${name}${i}" style:family="table-column"><style:table-column-properties style:column-width="${w}"/></style:style>`
  ).join('');
  const colDecls = cols.map(([name], i) => `<table:table-column table:style-name="${name}${i}"/>`).join('');

  const headCells = heads.map((h, i) =>
    `<table:table-cell table:style-name="DHead"><text:p text:style-name="${i <= 1 ? 'THeadP' : 'THeadPR'}">${escXml(h)}</text:p></table:table-cell>`
  ).join('');

  const rows = dto.lines.map(l => {
    const qty = qtyOf(l), ret = retOf(l);
    const price = Number(l.sale_price_ttc) || 0;
    const cells = [
      [escXml(l.isbn || '—'), 'TCellL'],
      [escXml(l.label || ''), 'TCellL'],
      [String(qty), 'TCellR'],
      ...(hasReturns ? [[String(ret), 'TCellR'], [String(qty - ret), 'TCellR']] : []),
      [escXml(fmtFcfa(price)), 'TCellR'],
      [escXml(fmtFcfa(qty * price)), 'TCellR'],
      [`${escXml(String(l.commission_rate ?? 0))} %`, 'TCellR'],
    ];
    return `<table:table-row>${cells.map(([v, s]) =>
      `<table:table-cell table:style-name="DCell"><text:p text:style-name="${s}">${v}</text:p></table:table-cell>`
    ).join('')}</table:table-row>`;
  }).join('');

  const totalQty = dto.lines.reduce((s, l) => s + qtyOf(l), 0);
  const totalRet = dto.lines.reduce((s, l) => s + retOf(l), 0);

  // Taux uniforme → mention lisible dans les conditions ; sinon renvoi au tableau.
  const rates = [...new Set(dto.lines.map(l => Number(l.commission_rate) || 0))];
  const rateText = rates.length === 1 ? `de ${rates[0]} %` : 'indiquée pour chaque titre ci-dessus';

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${CV_CONTENT_NS} office:version="1.2">
 <office:automatic-styles>
  ${CV_LOGO_AUTOSTYLE}
  ${colStyles}
  <style:style style:name="DTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.4cm" fo:margin-bottom="0.2cm"/></style:style>
  <style:style style:name="DHead" style:family="table-cell"><style:table-cell-properties fo:background-color="${CV_PRIMARY}" fo:padding="0.15cm 0.2cm"/></style:style>
  <style:style style:name="DCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm 0.2cm" fo:border-bottom="0.3pt solid #d1d5db"/></style:style>
  <style:style style:name="SigTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="1cm"/></style:style>
  <style:style style:name="ColSig" style:family="table-column"><style:table-column-properties style:column-width="8.3cm"/></style:style>
  <style:style style:name="SigCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.2cm 0.4cm 0.2cm 0" fo:border-top="0.5pt solid ${CV_MUTED}"/></style:style>
  <style:style style:name="SigSpacer" style:family="table-cell"><style:table-cell-properties fo:padding="0cm"/></style:style>
  <style:style style:name="SigRow" style:family="table-row"><style:table-row-properties style:min-row-height="2.2cm"/></style:style>
 </office:automatic-styles>
 <office:body><office:text>
  ${letterheadXml('ÉDITION · DIFFUSION · LIBRAIRIE — Dépôt-vente')}

  <text:p text:style-name="DocTitle">BON DE DÉPÔT</text:p>
  <text:p text:style-name="DocRef">N° <text:span text:style-name="Bold">${escXml(dto.ref)}</text:span> · ${escXml(today)}</text:p>

  <text:p text:style-name="BlockTitle">DÉPOSANT</text:p>
  ${consignorBoxXml(dto.consignor)}
  <text:p text:style-name="Muted">Date du dépôt : <text:span text:style-name="Bold">${escXml(fmtDateFr(dto.depositDate))}</text:span>${
    dto.warehouse?.name ? ` · Entrepôt d'entrée : <text:span text:style-name="Bold">${escXml(dto.warehouse.name)}</text:span>` : ''
  }</text:p>

  <table:table table:name="Lines" table:style-name="DTable">
   ${colDecls}
   <table:table-row>${headCells}</table:table-row>${rows}
  </table:table>

  <text:p text:style-name="Total">Total exemplaires déposés : <text:span text:style-name="Bold">${escXml(String(totalQty))}</text:span></text:p>
  ${hasReturns ? `<text:p text:style-name="Total">Repris par le déposant : ${escXml(String(totalRet))} · Restant en dépôt : <text:span text:style-name="Bold">${escXml(String(totalQty - totalRet))}</text:span></text:p>` : ''}
  <text:p text:style-name="GrandTotal">VALEUR DÉPOSÉE : ${escXml(fmtFcfa(dto.totalValue))}</text:p>
  ${dto.note ? `<text:p text:style-name="Muted">Note : ${escXml(dto.note)}</text:p>` : ''}

  <text:p text:style-name="Terms">Les ouvrages ci-dessus sont confiés en dépôt-vente : ils restent la propriété du déposant jusqu'à leur vente. ${escXml(EDITOR_NAME)} retient une commission ${escXml(rateText)} sur le prix de vente de chaque exemplaire vendu et reverse le solde au déposant sur présentation d'un relevé de reversement. Les invendus peuvent être repris par le déposant à tout moment. La valeur déposée indiquée ci-dessus est donnée à titre indicatif (prix de vente × quantité) et ne constitue pas une créance.</text:p>

  <table:table table:name="Signatures" table:style-name="SigTable">
   <table:table-column table:style-name="ColSig"/>
   <table:table-column table:style-name="ColSig"/>
   <table:table-row table:style-name="SigRow">
    <table:table-cell table:style-name="SigSpacer"><text:p text:style-name="SigName">Le déposant</text:p><text:p text:style-name="SigHint">Lu et approuvé — signature</text:p></table:table-cell>
    <table:table-cell table:style-name="SigSpacer"><text:p text:style-name="SigName">${escXml(EDITOR_NAME)}</text:p><text:p text:style-name="SigHint">Cachet et signature</text:p></table:table-cell>
   </table:table-row>
   <table:table-row>
    <table:table-cell table:style-name="SigCell"><text:p text:style-name="SigHint">Nom et date</text:p></table:table-cell>
    <table:table-cell table:style-name="SigCell"><text:p text:style-name="SigHint">Nom et date</text:p></table:table-cell>
   </table:table-row>
  </table:table>
 </office:text></office:body>
</office:document-content>`;
}

export function buildCvContent(dto) {
  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const fmtP = (s) => (s ? new Date(s + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '—');

  const consignorBox = consignorBoxXml(dto.consignor);

  const rows = dto.lines.map(l => `
   <table:table-row>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellL">${escXml(l.isbn || '—')}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellL">${escXml(l.label || '')}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(String(l.qty_sold))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(fmtFcfa(l.sale_total_ttc))}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(String(l.commission_rate))} %</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(fmtFcfa(l.net_due))}</text:p></table:table-cell>
   </table:table-row>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${CV_CONTENT_NS} office:version="1.2">
 <office:automatic-styles>
  ${CV_LOGO_AUTOSTYLE}
  <style:style style:name="CTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.4cm" fo:margin-bottom="0.2cm"/></style:style>
  <style:style style:name="ColIsbn" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>
  <style:style style:name="ColLabel" style:family="table-column"><style:table-column-properties style:column-width="6.6cm"/></style:style>
  <style:style style:name="ColNum" style:family="table-column"><style:table-column-properties style:column-width="1.6cm"/></style:style>
  <style:style style:name="ColMoney" style:family="table-column"><style:table-column-properties style:column-width="2.6cm"/></style:style>
  <style:style style:name="THead" style:family="table-cell"><style:table-cell-properties fo:background-color="${CV_PRIMARY}" fo:padding="0.15cm 0.2cm"/></style:style>
  <style:style style:name="TCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm 0.2cm" fo:border-bottom="0.3pt solid #d1d5db"/></style:style>
 </office:automatic-styles>
 <office:body><office:text>
  ${letterheadXml('ÉDITION · DIFFUSION · LIBRAIRIE — Dépôt-vente')}

  <text:p text:style-name="DocTitle">RELEVÉ DE REVERSEMENT</text:p>
  <text:p text:style-name="DocRef">N° <text:span text:style-name="Bold">${escXml(dto.ref)}</text:span> · ${escXml(today)}</text:p>

  <text:p text:style-name="BlockTitle">DÉPOSANT</text:p>
  ${consignorBox}
  <text:p text:style-name="Muted">Période concernée : du <text:span text:style-name="Bold">${escXml(fmtP(dto.periodFrom))}</text:span> au <text:span text:style-name="Bold">${escXml(fmtP(dto.periodTo))}</text:span></text:p>

  <table:table table:name="Lines" table:style-name="CTable">
   <table:table-column table:style-name="ColIsbn"/>
   <table:table-column table:style-name="ColLabel"/>
   <table:table-column table:style-name="ColNum"/>
   <table:table-column table:style-name="ColMoney"/>
   <table:table-column table:style-name="ColNum"/>
   <table:table-column table:style-name="ColMoney"/>
   <table:table-row>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">ISBN</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Titre</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Vendus</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Ventes</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Comm.</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Net dû</text:p></table:table-cell>
   </table:table-row>${rows}
  </table:table>

  <text:p text:style-name="Total">Total ventes : <text:span text:style-name="Bold">${escXml(fmtFcfa(dto.totalSales))}</text:span></text:p>
  <text:p text:style-name="Total">Commission ${escXml(EDITOR_NAME)} : ${escXml(fmtFcfa(dto.totalCommission))}</text:p>
  <text:p text:style-name="GrandTotal">NET À REVERSER : ${escXml(fmtFcfa(dto.totalNetDue))}</text:p>
 </office:text></office:body>
</office:document-content>`;
}
