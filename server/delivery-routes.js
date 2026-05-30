/**
 * Delivery Notes Routes — Bons de livraison natifs.
 *
 * Le bon de livraison (BL) est un document NATIF de senharmattan-shop : il est
 * stocké en base locale (SQLite, table delivery_notes), son PDF est généré
 * localement (ODT → LibreOffice), et sa validation peut décrémenter le stock
 * Dolibarr via l'API /stockmovements.
 *
 * Pourquoi natif : Dolibarr 20 n'expose AUCUNE API REST pour les « livraisons »
 * (llx_delivery), et l'API /shipments impose une commande d'origine. Un BL natif
 * donne le contrôle total du document et permet l'émission libre OU depuis une
 * facture/vente existante.
 *
 * Sécurité : monté sur /api/admin/deliveries, whitelist RBAC (super_admin, admin,
 * librarian) dans roles-config.js. Mutations protégées CSRF.
 */

import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';

// Client Dolibarr clé admin (mouvements de stock).
const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
if (!ADMIN_API_KEY) {
  console.warn('[DELIVERIES] DOLIBARR_ADMIN_API_KEY non définie — le décrément de stock échouera');
}
const adminApi = axios.create({
  baseURL: process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php',
  headers: { DOLAPIKEY: ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

const STATUS_LABELS = { draft: 'Brouillon', validated: 'Validé' };
const EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || "L'Harmattan Sénégal";
const FOOTER_LEGAL = "L'HARMATTAN SENEGAL SARL – 10 VDN Sicap amitié 3, Lotissement Cité Police, BP 45034 Dakar Fann, RC : SN DKR 2009-B-11.042 NINEA : 004067155";

// ─── HELPERS ─────────────────────────────────────────────────
function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    fk_soc INTEGER,
    client_name TEXT NOT NULL,
    client_address TEXT,
    client_zip TEXT,
    client_town TEXT,
    source_type TEXT NOT NULL DEFAULT 'blank',
    source_id INTEGER,
    source_ref TEXT,
    warehouse_id INTEGER,
    warehouse_name TEXT,
    note_public TEXT,
    lines_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    decrement_stock INTEGER NOT NULL DEFAULT 1,
    stock_moved INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    validated_by TEXT,
    validated_at DATETIME
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_delivery_notes_status ON delivery_notes(status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_delivery_notes_soc ON delivery_notes(fk_soc)');
  // Migration défensive (table préexistante sans la colonne).
  try { db.exec("ALTER TABLE delivery_notes ADD COLUMN decrement_stock INTEGER NOT NULL DEFAULT 1"); } catch { /* colonne déjà présente */ }
}

const escXml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

// Quantité entière positive bornée.
const cleanQty = (v) => Math.max(1, Math.min(100000, parseInt(v, 10) || 0));

// ─── ROUTER FACTORY ──────────────────────────────────────────
export function createDeliveryRouter({ db, dolibarrPool, auth, csrfProtection }) {
  const router = Router();
  ensureTable(db);
  const noCsrf = csrfProtection || ((req, res, next) => next());

  // Génère une réf BL{aamm}-{0001} (transaction → pas de collision UNIQUE).
  function generateRef() {
    const now = new Date();
    const yymm = String(now.getFullYear() % 100).padStart(2, '0') + String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `BL${yymm}-`;
    const max = db.prepare('SELECT MAX(ref) AS max FROM delivery_notes WHERE ref LIKE ?').get(`${prefix}%`);
    let next = 1;
    if (max?.max) next = (parseInt(String(max.max).split('-')[1], 10) || 0) + 1;
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  function rowToDto(r) {
    let lines = [];
    try { lines = JSON.parse(r.lines_json) || []; } catch { lines = []; }
    return {
      id: r.id, ref: r.ref,
      client: { id: r.fk_soc, name: r.client_name, address: r.client_address, zip: r.client_zip, town: r.client_town },
      source: { type: r.source_type, id: r.source_id, ref: r.source_ref },
      warehouse: { id: r.warehouse_id, name: r.warehouse_name },
      notePublic: r.note_public,
      lines,
      totalQty: lines.reduce((s, l) => s + (parseInt(l.qty, 10) || 0), 0),
      status: r.status, statusLabel: STATUS_LABELS[r.status] || r.status,
      decrementStock: !!r.decrement_stock,
      stockMoved: !!r.stock_moved,
      createdBy: r.created_by, createdAt: r.created_at,
      validatedBy: r.validated_by, validatedAt: r.validated_at,
    };
  }

  // Normalise les lignes du body : { product_id?, ref?, label, qty }.
  function sanitizeLines(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map(l => ({
        product_id: l.product_id ? parseInt(l.product_id, 10) : null,
        ref: String(l.ref || '').trim().slice(0, 60),
        label: String(l.label || '').trim().slice(0, 300),
        qty: cleanQty(l.qty),
      }))
      .filter(l => l.label && l.qty > 0);
  }

  // ═══════════════════════════════════════════════════════════
  // LISTE
  // ═══════════════════════════════════════════════════════════
  router.get('/', auth, (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;

      const where = [];
      const params = [];
      if (req.query.status && STATUS_LABELS[req.query.status]) { where.push('status = ?'); params.push(req.query.status); }
      if (req.query.search) {
        where.push('(ref LIKE ? OR client_name LIKE ?)');
        const pat = `%${req.query.search}%`;
        params.push(pat, pat);
      }
      if (req.query.date_from) { where.push('date(created_at) >= date(?)'); params.push(req.query.date_from); }
      if (req.query.date_to)   { where.push('date(created_at) <= date(?)'); params.push(req.query.date_to); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      const total = db.prepare(`SELECT COUNT(*) AS n FROM delivery_notes ${whereSql}`).get(...params).n;
      const rows = db.prepare(
        `SELECT * FROM delivery_notes ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      const kpis = db.prepare(`SELECT
        SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS nb_draft,
        SUM(CASE WHEN status='validated' THEN 1 ELSE 0 END) AS nb_validated
        FROM delivery_notes`).get();

      res.json({
        deliveries: rows.map(rowToDto),
        total, page, pages: Math.max(1, Math.ceil(total / limit)),
        kpis: { nb_draft: Number(kpis.nb_draft || 0), nb_validated: Number(kpis.nb_validated || 0) },
      });
    } catch (err) {
      console.error('[DELIVERIES] list error:', err.message);
      res.status(500).json({ error: 'Erreur chargement bons de livraison' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // RESSOURCES (avant /:id pour éviter la confusion de route)
  // ═══════════════════════════════════════════════════════════

  // Entrepôts Dolibarr (source du stock)
  router.get('/warehouses', auth, async (req, res) => {
    try {
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, lieu, label FROM llx_entrepot WHERE statut = 1 ORDER BY label ASC`
      );
      res.json({ warehouses: rows.map(w => ({ id: w.id, name: w.label || w.ref, location: w.lieu })) });
    } catch (err) {
      console.error('[DELIVERIES] warehouses error:', err.message);
      res.status(500).json({ error: 'Erreur chargement entrepôts' });
    }
  });

  // Recherche client (tiers)
  router.get('/clients/search', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ clients: [] });
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, nom, code_client, email, address, zip, town, phone
         FROM llx_societe
         WHERE status = 1 AND (nom LIKE ? OR code_client LIKE ? OR email LIKE ?)
         ORDER BY nom ASC LIMIT 20`,
        [`%${q}%`, `%${q}%`, `%${q}%`]
      );
      res.json({ clients: rows.map(r => ({
        id: r.id, name: r.nom, code: r.code_client, email: r.email,
        address: r.address, zip: r.zip, town: r.town, phone: r.phone,
      })) });
    } catch (err) {
      console.error('[DELIVERIES] clients search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche client' });
    }
  });

  // Recherche produit (livres) pour ajout manuel de lignes
  router.get('/products/search', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ products: [] });
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, barcode
         FROM llx_product
         WHERE tosell = 1 AND (ref LIKE ? OR label LIKE ? OR barcode LIKE ?)
         ORDER BY label ASC LIMIT 20`,
        [`%${q}%`, `%${q}%`, `%${q}%`]
      );
      res.json({ products: rows.map(r => ({ id: r.id, ref: r.ref, label: r.label, isbn: r.barcode })) });
    } catch (err) {
      console.error('[DELIVERIES] products search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche produit' });
    }
  });

  // Recherche facture (source possible d'un BL)
  router.get('/invoices/search', auth, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const where = ['f.fk_statut >= 1'];
      const params = [];
      if (q) {
        where.push('(f.ref LIKE ? OR s.nom LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      const [rows] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, DATE_FORMAT(f.datef,'%Y-%m-%d') AS datef,
                s.nom AS customer_name, f.total_ttc
         FROM llx_facture f LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE ${where.join(' AND ')}
         ORDER BY f.datef DESC, f.rowid DESC LIMIT 20`, params
      );
      res.json({ invoices: rows.map(r => ({
        id: r.id, ref: r.ref, date: r.datef, customer_name: r.customer_name || '—', total_ttc: Number(r.total_ttc),
      })) });
    } catch (err) {
      console.error('[DELIVERIES] invoices search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche facture' });
    }
  });

  // Pré-remplissage depuis une facture : client + lignes produit
  router.get('/from-invoice/:invoiceId', auth, async (req, res) => {
    try {
      const id = parseInt(req.params.invoiceId, 10);
      if (!id) return res.status(400).json({ error: 'Id facture invalide' });
      const [[inv]] = await dolibarrPool.query(
        `SELECT f.rowid AS id, f.ref, f.fk_soc, s.nom AS client_name, s.address, s.zip, s.town
         FROM llx_facture f LEFT JOIN llx_societe s ON s.rowid = f.fk_soc
         WHERE f.rowid = ?`, [id]
      );
      if (!inv) return res.status(404).json({ error: 'Facture introuvable' });
      const [lines] = await dolibarrPool.query(
        `SELECT fd.fk_product, p.ref AS product_ref, p.label AS product_label,
                fd.description, fd.qty
         FROM llx_facturedet fd
         LEFT JOIN llx_product p ON p.rowid = fd.fk_product
         WHERE fd.fk_facture = ? AND fd.product_type = 0 AND fd.qty > 0
         ORDER BY fd.rang ASC, fd.rowid ASC`, [id]
      );
      res.json({
        source: { type: 'invoice', id: inv.id, ref: inv.ref },
        client: { id: inv.fk_soc, name: inv.client_name || '', address: inv.address || '', zip: inv.zip || '', town: inv.town || '' },
        lines: lines.map(l => ({
          product_id: l.fk_product || null,
          ref: l.product_ref || '',
          label: l.product_label || l.description || 'Article',
          qty: cleanQty(l.qty),
        })),
      });
    } catch (err) {
      console.error('[DELIVERIES] from-invoice error:', err.message);
      res.status(500).json({ error: 'Erreur lecture facture' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // CRÉATION (brouillon)
  // ═══════════════════════════════════════════════════════════
  router.post('/', auth, noCsrf, (req, res) => {
    try {
      const b = req.body || {};
      const clientName = String(b.client_name || '').trim().slice(0, 200);
      if (!clientName) return res.status(400).json({ error: 'Client (destinataire) requis' });
      const lines = sanitizeLines(b.lines);
      if (lines.length === 0) return res.status(400).json({ error: 'Au moins une ligne avec une quantité > 0' });

      const sourceType = b.source_type === 'invoice' ? 'invoice' : 'blank';

      // ANTI DOUBLE-DÉCRÉMENT : sur cette instance Dolibarr, STOCK_CALCULATE_ON_BILL=1
      // → toute facture (POS + web) décrémente DÉJÀ le stock à sa validation. Donc un BL
      // issu d'une facture ne doit PAS re-décrémenter. Défaut sûr décidé côté serveur :
      //   - source 'invoice' → décrément OFF (la facture l'a déjà fait)
      //   - source 'blank'   → décrément ON (aucune autre sortie de stock)
      // Le client peut surcharger, mais ce défaut reste l'autorité.
      const defaultDecrement = sourceType === 'invoice' ? 0 : 1;
      const decrementStock = b.decrement_stock === undefined
        ? defaultDecrement
        : (b.decrement_stock ? 1 : 0);

      const insert = db.transaction(() => {
        const ref = generateRef();
        const r = db.prepare(`INSERT INTO delivery_notes (
          ref, fk_soc, client_name, client_address, client_zip, client_town,
          source_type, source_id, source_ref, warehouse_id, warehouse_name,
          note_public, lines_json, status, decrement_stock, created_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?)`).run(
          ref,
          b.fk_soc ? parseInt(b.fk_soc, 10) : null,
          clientName,
          String(b.client_address || '').trim().slice(0, 300) || null,
          String(b.client_zip || '').trim().slice(0, 30) || null,
          String(b.client_town || '').trim().slice(0, 120) || null,
          sourceType,
          b.source_id ? parseInt(b.source_id, 10) : null,
          String(b.source_ref || '').trim().slice(0, 60) || null,
          b.warehouse_id ? parseInt(b.warehouse_id, 10) : null,
          String(b.warehouse_name || '').trim().slice(0, 120) || null,
          String(b.note_public || '').trim().slice(0, 1000) || null,
          JSON.stringify(lines),
          decrementStock,
          req.admin?.username || 'admin',
        );
        return { id: r.lastInsertRowid, ref };
      });
      const { id, ref } = insert();
      res.status(201).json({ id, ref });
    } catch (err) {
      console.error('[DELIVERIES] create error:', err.message);
      res.status(500).json({ error: 'Erreur création bon de livraison' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // DÉTAIL
  // ═══════════════════════════════════════════════════════════
  router.get('/:id', auth, (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Bon de livraison introuvable' });
      res.json(rowToDto(row));
    } catch (err) {
      console.error('[DELIVERIES] detail error:', err.message);
      res.status(500).json({ error: 'Erreur chargement bon de livraison' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // VALIDATION — verrouille le BL et décrémente le stock Dolibarr
  // ═══════════════════════════════════════════════════════════
  router.post('/:id/validate', auth, noCsrf, async (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Bon de livraison introuvable' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Ce bon de livraison est déjà validé' });

      const lines = JSON.parse(row.lines_json) || [];
      const stockLines = lines.filter(l => l.product_id);

      // Le décrément n'a lieu que si le BL le demande (decrement_stock). Pour un BL
      // issu d'une facture, ce flag est OFF par défaut car la facture a déjà décrémenté
      // le stock (STOCK_CALCULATE_ON_BILL=1) — évite le double décrément.
      const shouldDecrement = !!row.decrement_stock;
      const moved = [];
      const failed = [];
      let skippedReason = null;

      if (shouldDecrement) {
        if (!row.warehouse_id) {
          return res.status(400).json({ error: 'Entrepôt de départ requis pour décrémenter le stock' });
        }
        // Un mouvement de sortie par ligne produit.
        for (const l of stockLines) {
          try {
            await adminApi.post('/stockmovements', {
              product_id: parseInt(l.product_id, 10),
              warehouse_id: parseInt(row.warehouse_id, 10),
              qty: -Math.abs(parseInt(l.qty, 10) || 0), // négatif = sortie de stock
              movementcode: row.ref,
              movementlabel: `Bon de livraison ${row.ref}`,
            });
            moved.push({ product_id: l.product_id, qty: l.qty });
          } catch (e) {
            const msg = e.response?.data?.error?.message || e.message;
            console.error(`[DELIVERIES] stock movement failed (BL ${row.ref}, product ${l.product_id}):`, msg);
            failed.push({ product_id: l.product_id, label: l.label, error: msg });
          }
        }
      } else {
        skippedReason = row.source_type === 'invoice'
          ? `Stock déjà décrémenté par la facture${row.source_ref ? ' ' + row.source_ref : ''} — aucun mouvement appliqué.`
          : 'Décrément de stock désactivé pour ce bon de livraison.';
      }

      const stockMoved = shouldDecrement && failed.length === 0 && stockLines.length > 0 ? 1 : 0;
      db.prepare(`UPDATE delivery_notes SET status='validated', stock_moved=?, validated_by=?, validated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(stockMoved, req.admin?.username || 'admin', row.id);

      res.json({
        success: true,
        stock: {
          decremented: shouldDecrement,
          skipped_reason: skippedReason,
          product_lines: stockLines.length,
          free_text_lines: lines.length - stockLines.length,
          moved: moved.length,
          failed,
        },
      });
    } catch (err) {
      console.error('[DELIVERIES] validate error:', err.message);
      res.status(500).json({ error: 'Erreur validation bon de livraison' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // SUPPRESSION (brouillon uniquement)
  // ═══════════════════════════════════════════════════════════
  router.delete('/:id', auth, noCsrf, (req, res) => {
    try {
      const row = db.prepare('SELECT id, status FROM delivery_notes WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Bon de livraison introuvable' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'Seul un brouillon peut être supprimé' });
      db.prepare('DELETE FROM delivery_notes WHERE id = ?').run(row.id);
      res.json({ success: true });
    } catch (err) {
      console.error('[DELIVERIES] delete error:', err.message);
      res.status(500).json({ error: 'Erreur suppression bon de livraison' });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // PDF — génération native (ODT → LibreOffice)
  // ═══════════════════════════════════════════════════════════
  router.get('/:id/pdf', auth, (req, res) => {
    let tmpDir;
    try {
      const row = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(parseInt(req.params.id, 10));
      if (!row) return res.status(404).json({ error: 'Bon de livraison introuvable' });
      const dto = rowToDto(row);

      tmpDir = join('/tmp', `bl-${row.id}-${Date.now()}`);
      mkdirSync(join(tmpDir, 'META-INF'), { recursive: true });
      writeFileSync(join(tmpDir, 'mimetype'), 'application/vnd.oasis.opendocument.text');
      writeFileSync(join(tmpDir, 'META-INF/manifest.xml'), DL_MANIFEST);
      writeFileSync(join(tmpDir, 'styles.xml'), buildBlStyles());
      writeFileSync(join(tmpDir, 'content.xml'), buildBlContent(dto));

      const odt = join(tmpDir, 'bl.odt');
      execFileSync('zip', ['-q', '-X', '-0', odt, 'mimetype'], { cwd: tmpDir });
      execFileSync('zip', ['-q', '-r', '-X', odt, 'META-INF', 'content.xml', 'styles.xml'], { cwd: tmpDir });

      const profile = join(tmpDir, 'profile');
      mkdirSync(profile, { recursive: true });
      execFileSync('soffice', [
        '--headless', '--norestore', '--nologo', '--nofirststartwizard',
        `-env:UserInstallation=file://${profile}`,
        '--convert-to', 'pdf', '--outdir', tmpDir, odt,
      ], { stdio: 'pipe', timeout: 60000 });

      const pdfPath = join(tmpDir, 'bl.pdf');
      if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée');
      const buf = readFileSync(pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${dto.ref}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[DELIVERIES] pdf error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  return router;
}

// ─── GÉNÉRATION ODT ──────────────────────────────────────────
const DL_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
 <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`;

const DL_PRIMARY = '#10531a';
const DL_MUTED = '#6b7280';

export function buildBlStyles() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:styles>
  <style:default-style style:family="paragraph">
   <style:paragraph-properties fo:margin-bottom="0.15cm" fo:line-height="130%"/>
   <style:text-properties style:font-name="Liberation Sans" fo:font-size="10.5pt" fo:color="#1a1a1a" fo:language="fr" fo:country="FR"/>
  </style:default-style>
  <style:style style:name="Editor" style:family="paragraph"><style:text-properties fo:font-size="15pt" fo:font-weight="bold" fo:color="${DL_PRIMARY}"/></style:style>
  <style:style style:name="Tag" style:family="paragraph"><style:paragraph-properties fo:margin-bottom="0.4cm" fo:border-bottom="1pt solid ${DL_PRIMARY}" fo:padding-bottom="0.2cm"/><style:text-properties fo:font-size="8.5pt" fo:color="${DL_MUTED}" fo:letter-spacing="0.05cm"/></style:style>
  <style:style style:name="DocTitle" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.2cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="20pt" fo:font-weight="bold" fo:letter-spacing="0.08cm" fo:color="${DL_PRIMARY}"/></style:style>
  <style:style style:name="DocRef" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.5cm"/><style:text-properties fo:font-size="11pt" fo:color="${DL_MUTED}"/></style:style>
  <style:style style:name="BlockTitle" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.3cm" fo:margin-bottom="0.1cm"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.06cm" fo:color="${DL_MUTED}"/></style:style>
  <style:style style:name="Box" style:family="paragraph"><style:paragraph-properties fo:background-color="#f0fdf4" fo:border-left="3pt solid ${DL_PRIMARY}" fo:padding="0.3cm 0.4cm" fo:margin-bottom="0.4cm"/></style:style>
  <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
  <style:style style:name="Muted" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.2cm"/><style:text-properties fo:font-size="9pt" fo:color="${DL_MUTED}"/></style:style>
  <style:style style:name="FooterLegal" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="7.5pt" fo:color="${DL_MUTED}"/></style:style>
  <style:style style:name="SignHead" style:family="paragraph"><style:paragraph-properties fo:margin-top="1cm" fo:text-align="center" fo:keep-with-next="always"/><style:text-properties fo:font-size="9pt" fo:font-weight="bold" fo:letter-spacing="0.1cm" fo:color="${DL_PRIMARY}"/></style:style>
  <style:style style:name="SignLine" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold"/></style:style>
  <style:style style:name="SignBox" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:border="0.3pt dashed ${DL_MUTED}" fo:padding="1.1cm 0.4cm" fo:margin-top="0.2cm"/><style:text-properties fo:font-size="8pt" fo:color="${DL_MUTED}"/></style:style>
  <style:style style:name="THead" style:family="table-cell"><style:table-cell-properties fo:background-color="${DL_PRIMARY}" fo:padding="0.15cm 0.25cm"/></style:style>
  <style:style style:name="TCell" style:family="table-cell"><style:table-cell-properties fo:padding="0.12cm 0.25cm" fo:border-bottom="0.3pt solid #d1d5db"/></style:style>
  <style:style style:name="THeadP" style:family="paragraph"><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="THeadPR" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="9.5pt" fo:font-weight="bold" fo:color="#ffffff"/></style:style>
  <style:style style:name="TCellR" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>
  <style:style style:name="Total" style:family="paragraph"><style:paragraph-properties fo:text-align="right" fo:margin-top="0.2cm"/><style:text-properties fo:font-size="11pt" fo:font-weight="bold" fo:color="${DL_PRIMARY}"/></style:style>
  <style:style style:name="DTable" style:family="table"><style:table-properties style:width="16.6cm" table:align="left" fo:margin-top="0.4cm" fo:margin-bottom="0.2cm"/></style:style>
  <style:style style:name="ColRef" style:family="table-column"><style:table-column-properties style:column-width="3cm"/></style:style>
  <style:style style:name="ColLabel" style:family="table-column"><style:table-column-properties style:column-width="11cm"/></style:style>
  <style:style style:name="ColQty" style:family="table-column"><style:table-column-properties style:column-width="2.6cm"/></style:style>
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

export function buildBlContent(dto) {
  const today = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const clientLines = [
    `<text:p text:style-name="Box"><text:span text:style-name="Bold">${escXml(dto.client.name)}</text:span></text:p>`,
  ];
  const addr = [dto.client.address, [dto.client.zip, dto.client.town].filter(Boolean).join(' ')].filter(Boolean);
  // On regroupe l'adresse dans une seule boîte visuelle.
  let clientBox = `<text:p text:style-name="Box"><text:span text:style-name="Bold">${escXml(dto.client.name)}</text:span>`;
  for (const a of addr) clientBox += `<text:line-break/>${escXml(a)}`;
  clientBox += `</text:p>`;

  const rows = dto.lines.map(l => `
   <table:table-row>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(l.ref || '—')}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p>${escXml(l.label)}</text:p></table:table-cell>
    <table:table-cell table:style-name="TCell"><text:p text:style-name="TCellR">${escXml(String(l.qty))}</text:p></table:table-cell>
   </table:table-row>`).join('');

  const sourceLine = dto.source.type === 'invoice' && dto.source.ref
    ? `<text:p text:style-name="Muted">Référence facture : <text:span text:style-name="Bold">${escXml(dto.source.ref)}</text:span></text:p>` : '';
  const noteLine = dto.notePublic
    ? `<text:p text:style-name="Muted">Note : ${escXml(dto.notePublic)}</text:p>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2">
 <office:automatic-styles/>
 <office:body><office:text>
  <text:p text:style-name="Editor">${escXml(EDITOR_NAME)}</text:p>
  <text:p text:style-name="Tag">ÉDITION · DIFFUSION · LIBRAIRIE — Faire revenir le livre dans le quotidien des Sénégalais</text:p>

  <text:p text:style-name="DocTitle">BON DE LIVRAISON</text:p>
  <text:p text:style-name="DocRef">N° <text:span text:style-name="Bold">${escXml(dto.ref)}</text:span> · ${escXml(today)}</text:p>

  <text:p text:style-name="BlockTitle">DESTINATAIRE</text:p>
  ${clientBox}
  ${sourceLine}

  <table:table table:name="Lines" table:style-name="DTable">
   <table:table-column table:style-name="ColRef"/>
   <table:table-column table:style-name="ColLabel"/>
   <table:table-column table:style-name="ColQty"/>
   <table:table-row>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Référence</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadP">Désignation</text:p></table:table-cell>
    <table:table-cell table:style-name="THead"><text:p text:style-name="THeadPR">Quantité</text:p></table:table-cell>
   </table:table-row>${rows}
  </table:table>

  <text:p text:style-name="Total">Total livré : ${escXml(String(dto.totalQty))} article(s)</text:p>
  ${noteLine}

  <text:p text:style-name="SignHead">RÉCEPTION DE LA MARCHANDISE</text:p>
  <table:table table:name="Sign" table:style-name="SignTable">
   <table:table-column table:style-name="SignCol"/>
   <table:table-column table:style-name="SignCol"/>
   <table:table-row>
    <table:table-cell table:style-name="SignCell">
     <text:p text:style-name="SignLine">L'ÉDITEUR / LE LIVREUR</text:p>
     <text:p text:style-name="SignBox">Nom, date et signature</text:p>
    </table:table-cell>
    <table:table-cell table:style-name="SignCell">
     <text:p text:style-name="SignLine">LE CLIENT</text:p>
     <text:p text:style-name="SignBox">Reçu le …… / Nom et signature précédés de « Reçu pour livraison conforme »</text:p>
    </table:table-cell>
   </table:table-row>
  </table:table>
 </office:text></office:body>
</office:document-content>`;
}
