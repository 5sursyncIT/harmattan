import { Router } from 'express';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FCFA_PER_EUR = 655.957;

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function numberToWordsFR(n) {
  n = Math.round(n);
  if (n === 0) return 'zéro';
  const units = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
    'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
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

export function createContractQuoteRouter({ db, csrfProtection }) {
  const router = Router();

  // Ensure table exists
  db.exec(`CREATE TABLE IF NOT EXISTS contract_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id INTEGER NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    recipient_title TEXT NOT NULL,
    recipient_name TEXT NOT NULL,
    book_title TEXT NOT NULL,
    book_pages INTEGER NOT NULL,
    book_format TEXT NOT NULL,
    book_interior TEXT NOT NULL,
    book_paper TEXT NOT NULL,
    book_cover TEXT NOT NULL,
    book_price_eur REAL NOT NULL,
    diffusion TEXT NOT NULL,
    items_json TEXT NOT NULL,
    total INTEGER NOT NULL,
    status TEXT DEFAULT 'draft',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_contract_quotes_contract ON contract_quotes(contract_id)`);

  const ALLOWED_ROLES = ['super_admin', 'admin', 'editor'];
  function auth(req, res, next) {
    const session = req.cookies?.admin_session;
    if (!session) return res.status(401).json({ error: 'Non authentifié' });
    const tokenHash = crypto.createHash('sha256').update(String(session)).digest('hex');
    const admin = db.prepare(
      "SELECT * FROM admin_users WHERE session_token = ? AND (session_expires_at IS NULL OR session_expires_at > datetime('now'))"
    ).get(tokenHash);
    if (!admin) return res.status(401).json({ error: 'Session invalide' });
    if (!ALLOWED_ROLES.includes(admin.role || 'admin')) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    req.admin = admin;
    next();
  }

  function generateRef() {
    const now = new Date();
    const yymm = String(now.getFullYear() % 100).padStart(2, '0') + String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `FICHEFAB${yymm}-`;
    const max = db.prepare('SELECT MAX(ref) AS max FROM contract_quotes WHERE ref LIKE ?').get(`${prefix}%`);
    let nextSeq = 1;
    if (max?.max) {
      const lastSeq = parseInt(String(max.max).split('-')[1]) || 0;
      nextSeq = lastSeq + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, '0')}`;
  }

  // POST /api/contracts/:contractId/quotes — create a quote
  router.post('/contracts/:contractId/quotes', auth, csrfProtection, (req, res) => {
    try {
      const contractId = parseInt(req.params.contractId);
      if (!contractId) return res.status(400).json({ error: 'Contrat invalide' });

      const {
        recipient_title, recipient_name, book_title, book_pages, book_format,
        book_interior, book_paper, book_cover, book_price_eur, diffusion, items,
      } = req.body;

      if (!recipient_name?.trim()) return res.status(400).json({ error: 'Nom du destinataire requis' });
      if (!book_title?.trim()) return res.status(400).json({ error: 'Titre de l\'ouvrage requis' });
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Au moins une ligne requise' });

      const sanitizedItems = items
        .map(i => ({ label: String(i.label || '').trim().slice(0, 200), price: Math.max(0, parseInt(i.price) || 0) }))
        .filter(i => i.label && i.price > 0);
      if (sanitizedItems.length === 0) return res.status(400).json({ error: 'Items invalides' });

      const total = sanitizedItems.reduce((s, i) => s + i.price, 0);
      const ref = generateRef();

      const r = db.prepare(`INSERT INTO contract_quotes (
        contract_id, ref, recipient_title, recipient_name, book_title, book_pages,
        book_format, book_interior, book_paper, book_cover, book_price_eur, diffusion,
        items_json, total, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        contractId, ref,
        String(recipient_title || 'Monsieur').slice(0, 20),
        recipient_name.trim().slice(0, 120),
        book_title.trim().slice(0, 300),
        Math.max(0, parseInt(book_pages) || 0),
        String(book_format || '13.5 cm sur 21.5 cm').slice(0, 60),
        String(book_interior || 'une couleur N & B').slice(0, 60),
        String(book_paper || 'bouffant 80 grammes').slice(0, 60),
        String(book_cover || 'cartonné, coucher brillant, quadrichromie avec pellicule').slice(0, 200),
        parseFloat(book_price_eur) || 0,
        String(diffusion || 'Paris, Dakar, dans les grandes capitales européennes et sur Internet').slice(0, 200),
        JSON.stringify(sanitizedItems),
        total,
        req.admin.username,
      );

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'create_quote', `Devis ${ref} (contrat #${contractId}) — total ${total} FCFA`);

      res.status(201).json({ id: r.lastInsertRowid, ref, total });
    } catch (err) {
      console.error('Create quote error:', err.message);
      res.status(500).json({ error: 'Erreur création devis' });
    }
  });

  // GET /api/contracts/:contractId/quotes — list quotes for a contract
  router.get('/contracts/:contractId/quotes', auth, (req, res) => {
    try {
      const contractId = parseInt(req.params.contractId);
      const quotes = db.prepare(
        `SELECT id, ref, recipient_name, book_title, total, status, created_at, created_by
         FROM contract_quotes WHERE contract_id = ? ORDER BY created_at DESC`,
      ).all(contractId);
      res.json(quotes);
    } catch (err) {
      console.error('List quotes error:', err.message);
      res.status(500).json({ error: 'Erreur liste devis' });
    }
  });

  // GET /api/quotes/:id — get full quote
  router.get('/quotes/:id', auth, (req, res) => {
    try {
      const quote = db.prepare('SELECT * FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
      quote.items = JSON.parse(quote.items_json);
      delete quote.items_json;
      res.json(quote);
    } catch (err) {
      console.error('Get quote error:', err.message);
      res.status(500).json({ error: 'Erreur lecture devis' });
    }
  });

  // GET /api/quotes/:id/pdf — render PDF
  router.get('/quotes/:id/pdf', auth, (req, res) => {
    let tmpDir;
    try {
      const quote = db.prepare('SELECT * FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

      const items = JSON.parse(quote.items_json);
      const templatePath = join(__dirname, 'templates', 'devis-contrat.odt');
      if (!existsSync(templatePath)) return res.status(500).json({ error: 'Template devis introuvable' });

      tmpDir = join('/tmp', `quote-${quote.id}-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      // Unzip template
      execSync(`cd ${tmpDir} && unzip -oq "${templatePath}"`);

      let content = readFileSync(join(tmpDir, 'content.xml'), 'utf-8');

      // Locale-aware date
      const dateStr = new Date(quote.created_at).toLocaleDateString('fr-FR');
      const replacements = {
        REF: quote.ref,
        DATE: dateStr,
        RECIPIENT_TITLE: quote.recipient_title,
        RECIPIENT_NAME: quote.recipient_name,
        BOOK_TITLE: quote.book_title,
        BOOK_PAGES: String(quote.book_pages),
        BOOK_FORMAT: quote.book_format,
        BOOK_INTERIOR: quote.book_interior,
        BOOK_PAPER: quote.book_paper,
        BOOK_COVER: quote.book_cover,
        BOOK_PRICE_EUR: Number(quote.book_price_eur).toFixed(2),
        DIFFUSION: quote.diffusion,
        TOTAL_AMOUNT: Number(quote.total).toLocaleString('fr-FR'),
        TOTAL_TEXT: numberToWordsFR(quote.total) + ' Francs CFA',
      };
      for (const [k, v] of Object.entries(replacements)) {
        content = content.split(`{${k}}`).join(escapeXml(v));
      }

      // Duplicate the item row for each item
      const rowRegex = /<table:table-row[^>]*>(?:(?!<table:table-row)[\s\S])*?\{ITEM_LABEL\}[\s\S]*?<\/table:table-row>/;
      const rowMatch = content.match(rowRegex);
      if (rowMatch) {
        const tpl = rowMatch[0];
        const rows = items.map(item => tpl
          .split('{ITEM_LABEL}').join(escapeXml(item.label))
          .split('{ITEM_PRICE}').join(escapeXml(parseInt(item.price).toLocaleString('fr-FR'))),
        ).join('');
        content = content.replace(tpl, rows);
      }

      writeFileSync(join(tmpDir, 'content.xml'), content);

      // Repack ODT (mimetype must be first, uncompressed). Inclut Pictures/ si présent
      // (le template embarque le logo PNG).
      const odtPath = join(tmpDir, 'output.odt');
      const hasPictures = existsSync(join(tmpDir, 'Pictures'));
      execSync(
        `cd ${tmpDir} && zip -q -X -0 "${odtPath}" mimetype && ` +
        `zip -q -r -X "${odtPath}" META-INF content.xml styles.xml meta.xml${hasPictures ? ' Pictures' : ''}`,
      );

      // Convert to PDF via LibreOffice headless.
      // --user-installation : nécessaire sous systemd ProtectHome=read-only, sinon soffice
      // tente d'écrire son profil dans $HOME/.config et plante "Unspecified Application Error".
      const sofficeProfile = join(tmpDir, 'soffice-profile');
      mkdirSync(sofficeProfile, { recursive: true });
      execSync(
        `soffice --headless --norestore --nologo --nofirststartwizard ` +
        `-env:UserInstallation=file://${sofficeProfile} ` +
        `--convert-to pdf --outdir "${tmpDir}" "${odtPath}"`,
        { stdio: 'pipe', timeout: 60000 },
      );
      const pdfPath = join(tmpDir, 'output.pdf');
      if (!existsSync(pdfPath)) throw new Error('Conversion PDF échouée');

      const pdfBuffer = readFileSync(pdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${quote.ref}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      console.error('Quote PDF error:', err.message);
      res.status(500).json({ error: 'Erreur génération PDF' });
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // DELETE /api/quotes/:id — draft only
  router.delete('/quotes/:id', auth, csrfProtection, (req, res) => {
    try {
      const quote = db.prepare('SELECT id, ref, status FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
      if (quote.status !== 'draft') return res.status(400).json({ error: 'Seuls les brouillons peuvent être supprimés' });

      db.prepare('DELETE FROM contract_quotes WHERE id = ?').run(quote.id);
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'delete_quote', `Devis ${quote.ref}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Delete quote error:', err.message);
      res.status(500).json({ error: 'Erreur suppression devis' });
    }
  });

  // GET /api/quotes/defaults?pages=70&price_eur=11&qty=50&color=0
  // Helper to compute suggested line items from contract data
  router.get('/quotes/defaults', auth, (req, res) => {
    const pages = Math.max(0, parseInt(req.query.pages) || 0);
    const priceEur = Math.max(0, parseFloat(req.query.price_eur) || 0);
    const qty = Math.max(0, parseInt(req.query.qty) || 50);
    const color = String(req.query.color) === '1';

    const items = [];
    if (pages > 0) {
      items.push({ key: 'relecture', label: '1 - Contribution au frais de relecture et au report de correction', price: pages * 1500 });
      items.push({ key: 'pao', label: '2 - Contribution à la mise en pages et réalisation du Prêt-à-clicher', price: pages * 1000 });
    }
    if (priceEur > 0 && qty > 0) {
      // ~32 % de remise sur le prix public converti en FCFA
      const achatPrice = Math.round(priceEur * qty * FCFA_PER_EUR * 0.68);
      items.push({ key: 'achat', label: `4 - Achat de ${qty} exemplaires contractuels`, price: achatPrice });
    }
    if (color) {
      // Prix fixe pour la contribution à l'impression couleur
      items.push({ key: 'couleur', label: '6 - Contribution à l\'impression Couleur', price: 852000 });
    }

    res.json({ items });
  });

  return router;
}
