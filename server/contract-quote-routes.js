import { Router } from 'express';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { logManuscriptEvent } from './manuscript-workflow.js';
import { makeAdminAuth } from './admin-auth.js';
import { adminApi } from './dolibarr-admin-client.js';
import { recordInvoicePayment, resolvePaymentId } from './dolibarr-payments.js';

const execFile = promisify(execFileCb);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Une seule conversion soffice à la fois : chaque instance headless pèse
// plusieurs centaines de Mo ; des rendus concurrents pourraient saturer la RAM
// du serveur. Les appels suivants attendent leur tour sans bloquer l'event loop.
let sofficeQueue = Promise.resolve();
function enqueueSoffice(task) {
  const run = sofficeQueue.then(task, task);
  sofficeQueue = run.catch(() => {});
  return run;
}

const FCFA_PER_EUR = 655.957;
const DEFAULT_AUTHOR_DISCOUNT = 30;  // remise auteur par défaut (%) si non renseignée au contrat

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
    // Millions / milliards : indispensable car les devis dépassent fréquemment 1 M FCFA
    // (sans ça, le PDF affichait le total « en lettres » sous forme de chiffres bruts).
    if (num < 1000000000) {
      const m = Math.floor(num / 1000000);
      const rest = num % 1000000;
      const millionWord = m === 1 ? 'un million' : chunk(m) + ' millions';
      return millionWord + (rest === 0 ? '' : ' ' + chunk(rest));
    }
    const b = Math.floor(num / 1000000000);
    const rest = num % 1000000000;
    const billionWord = b === 1 ? 'un milliard' : chunk(b) + ' milliards';
    return billionWord + (rest === 0 ? '' : ' ' + chunk(rest));
  }
  return chunk(n);
}

export function createContractQuoteRouter({ db, dolibarrPool, csrfProtection }) {
  const router = Router();

  // Vérifie qu'un contrat parent existe réellement dans Dolibarr avant d'y
  // rattacher un devis. Évite la création de devis orphelins (contract_id fantôme).
  async function contractExists(contractId) {
    if (!dolibarrPool) return true; // pas de pool injecté → on ne bloque pas (dégradé)
    const [rows] = await dolibarrPool.query('SELECT rowid FROM llx_contrat WHERE rowid = ? LIMIT 1', [contractId]);
    return rows.length > 0;
  }

  // Remonte du contrat (Dolibarr rowid) vers le manuscrit lié, s'il existe, afin
  // de tracer les évènements devis sur la frise du manuscrit (best-effort).
  function manuscriptIdForContract(contractId) {
    try {
      return db.prepare('SELECT id FROM manuscripts WHERE contract_id = ?').get(contractId)?.id || null;
    } catch (e) { void e; return null; }
  }

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
  // Migration : lien vers la facture Dolibarr générée lors de l'encaissement,
  // et remise auteur (%) retenue pour ce devis (traçabilité / réimpression).
  for (const col of ['dolibarr_invoice_id INTEGER', 'invoice_ref TEXT', 'discount_pct REAL']) {
    try { db.exec(`ALTER TABLE contract_quotes ADD COLUMN ${col}`); } catch { /* déjà présente */ }
  }

  // Le comptable a l'accès complet aux contrats (cf. contract-routes.js) : il peut
  // donc créer/consulter, encaisser ET supprimer les devis de contribution, au même
  // titre que les profils éditoriaux.
  const ALLOWED_ROLES = ['super_admin', 'admin', 'editor', 'comptable'];
  const QUOTE_DELETE_ROLES = ['super_admin', 'admin', 'editor', 'comptable'];
  // L'encaissement (écriture comptable : facture + règlement) est réservé aux profils financiers.
  const QUOTE_PAY_ROLES = ['super_admin', 'admin', 'comptable'];
  const auth = makeAdminAuth(db, ALLOWED_ROLES);
  const authDelete = makeAdminAuth(db, QUOTE_DELETE_ROLES);
  const authPay = makeAdminAuth(db, QUOTE_PAY_ROLES);

  const PAYMENT_METHODS_ALLOWED = new Set(['LIQ', 'CB', 'CHQ', 'WAVE', 'OM', 'VIR']);

  // Tiers (auteur) à facturer = fk_soc du contrat parent.
  async function contractSoc(contractId) {
    if (!dolibarrPool) return null;
    const [rows] = await dolibarrPool.query('SELECT fk_soc FROM llx_contrat WHERE rowid = ? LIMIT 1', [contractId]);
    return rows[0]?.fk_soc ? Number(rows[0].fk_soc) : null;
  }

  // Total / déjà payé / reste à payer d'une facture Dolibarr (lecture directe).
  async function invoicePaidInfo(invoiceId) {
    const [[inv]] = await dolibarrPool.query('SELECT total_ttc, paye FROM llx_facture WHERE rowid = ?', [invoiceId]);
    if (!inv) return null;
    const [[p]] = await dolibarrPool.query(
      'SELECT COALESCE(SUM(amount), 0) AS paid FROM llx_paiement_facture WHERE fk_facture = ?', [invoiceId]
    );
    const total = Number(inv.total_ttc);
    const paid = Math.round(Number(p.paid) * 100) / 100;
    return { total, paid, remaining: Math.round((total - paid) * 100) / 100, paye: Number(inv.paye) };
  }

  // Statut « paiement » dérivé pour l'affichage (au-delà de draft/sent stockés).
  function payStatus(remaining, total) {
    if (remaining <= 0.01) return 'paid';
    if (remaining < total - 0.01) return 'partial';
    return 'invoiced';
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
  router.post('/contracts/:contractId/quotes', auth, csrfProtection, async (req, res) => {
    try {
      const contractId = parseInt(req.params.contractId);
      if (!contractId) return res.status(400).json({ error: 'Contrat invalide' });

      if (!(await contractExists(contractId))) {
        return res.status(404).json({ error: 'Contrat parent introuvable' });
      }

      const {
        recipient_title, recipient_name, book_title, book_pages, book_format,
        book_interior, book_paper, book_cover, book_price_eur, diffusion, items, discount_pct,
        copies_qty,
      } = req.body;

      // Nombre d'exemplaires contractuels retenu par la direction pour ce devis.
      // `undefined` (anciens clients) → on ne touche pas au contrat ; sinon on borne
      // à un entier >= 0 et on persiste plus bas (extrafield author_purchase_qty).
      const copiesQty = copies_qty === undefined
        ? null
        : Math.max(0, parseInt(copies_qty) || 0);

      // Remise auteur (%) retenue pour ce devis : bornée [0,100], repli sur le défaut
      // si absente/invalide. Stockée pour mémoire — la ligne 4 encode déjà le prix remisé.
      const rawDiscount = parseFloat(discount_pct);
      const discountPct = Number.isFinite(rawDiscount)
        ? Math.min(100, Math.max(0, rawDiscount))
        : DEFAULT_AUTHOR_DISCOUNT;

      if (!recipient_name?.trim()) return res.status(400).json({ error: 'Nom du destinataire requis' });
      if (!book_title?.trim()) return res.status(400).json({ error: 'Titre de l\'ouvrage requis' });
      if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Au moins une ligne requise' });

      const sanitizedItems = items
        .map(i => ({ label: String(i.label || '').trim().slice(0, 200), price: Math.max(0, parseInt(i.price) || 0) }))
        .filter(i => i.label && i.price > 0);
      if (sanitizedItems.length === 0) return res.status(400).json({ error: 'Items invalides' });

      const total = sanitizedItems.reduce((s, i) => s + i.price, 0);

      // Génération de référence + insertion dans une seule transaction : sans ça,
      // deux créations concurrentes le même mois calculent le même MAX(ref) et
      // violent la contrainte UNIQUE(ref). La transaction sérialise le calcul.
      const insertQuote = db.transaction(() => {
        const ref = generateRef();
        const r = db.prepare(`INSERT INTO contract_quotes (
          contract_id, ref, recipient_title, recipient_name, book_title, book_pages,
          book_format, book_interior, book_paper, book_cover, book_price_eur, diffusion,
          items_json, total, discount_pct, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
          String(diffusion || 'Dakar, en Afrique de l\'Ouest, à Paris et sur Internet').slice(0, 200),
          JSON.stringify(sanitizedItems),
          total,
          discountPct,
          req.admin.username,
        );
        return { id: r.lastInsertRowid, ref };
      });
      const { id, ref } = insertQuote();

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'create_quote', `Devis ${ref} (contrat #${contractId}) — total ${total} FCFA`);

      // Persiste le nombre d'exemplaires contractuels choisi sur le contrat Dolibarr
      // (extrafield author_purchase_qty) afin de pré-remplir les prochains devis.
      // qty > 0 active aussi la clause d'achat ; qty = 0 la désactive. Best-effort :
      // un échec de persistance ne doit pas casser la création du devis déjà enregistré.
      if (copiesQty !== null) {
        try {
          await adminApi.put(`/contracts/${contractId}`, {
            array_options: {
              options_author_purchase_qty: copiesQty,
              options_author_purchase_enabled: copiesQty > 0 ? 1 : 0,
            },
          });
        } catch (e) {
          console.warn('Persist author_purchase_qty warning:', e.response?.data?.error || e.message);
        }
      }

      // Trace sur la frise du manuscrit lié (ne bloque pas la création du devis)
      try {
        const msId = manuscriptIdForContract(contractId);
        if (msId) {
          logManuscriptEvent(db, msId, 'quote_created',
            { role: req.admin.role || 'admin', id: req.admin.id, label: req.admin.username },
            `Devis ${ref} — ${total.toLocaleString('fr-FR')} FCFA`);
        }
      } catch (e) { console.warn('Manuscript event (quote_created) warning:', e.message); }

      res.status(201).json({ id, ref, total });
    } catch (err) {
      console.error('Create quote error:', err.message);
      res.status(500).json({ error: 'Erreur création devis' });
    }
  });

  // GET /api/contracts/:contractId/quotes — list quotes for a contract
  router.get('/contracts/:contractId/quotes', auth, async (req, res) => {
    try {
      const contractId = parseInt(req.params.contractId);
      const quotes = db.prepare(
        `SELECT id, ref, recipient_name, book_title, total, status, created_at, created_by,
                dolibarr_invoice_id, invoice_ref
         FROM contract_quotes WHERE contract_id = ? ORDER BY created_at DESC`,
      ).all(contractId);

      // Enrichit les devis facturés du reste à payer live (best-effort : un échec
      // de lecture Dolibarr ne casse pas la liste, on garde le statut stocké).
      for (const q of quotes) {
        if (q.dolibarr_invoice_id && dolibarrPool) {
          try {
            const info = await invoicePaidInfo(q.dolibarr_invoice_id);
            if (info) {
              q.paid = info.paid;
              q.remaining = info.remaining;
              q.payment_status = payStatus(info.remaining, info.total);
            }
          } catch (e) { void e; }
        }
      }
      res.json(quotes);
    } catch (err) {
      console.error('List quotes error:', err.message);
      res.status(500).json({ error: 'Erreur liste devis' });
    }
  });

  // GET /api/quotes/banks — comptes bancaires ouverts (pour l'encaissement).
  // Sous la même whitelist que les devis : évite de coupler le module devis à la
  // RBAC du module factures (l'éditeur n'a pas accès à /api/admin/invoices).
  router.get('/quotes/banks', auth, async (req, res) => {
    try {
      const [rows] = await dolibarrPool.query(
        `SELECT rowid AS id, ref, label, currency_code
         FROM llx_bank_account WHERE clos = 0 ORDER BY label ASC`
      );
      res.json({ accounts: rows });
    } catch (err) {
      console.error('Quote banks error:', err.message);
      res.status(500).json({ error: 'Erreur chargement comptes' });
    }
  });

  // GET /api/quotes/defaults?pages=70&price_eur=11&qty=50&color=0&discount=30
  // Helper to compute suggested line items from contract data.
  // IMPORTANT : doit être déclarée AVANT /quotes/:id, sinon Express matche
  // « defaults » comme un :id (NaN) et la route renvoie 404 systématiquement.
  router.get('/quotes/defaults', auth, (req, res) => {
    const pages = Math.max(0, parseInt(req.query.pages) || 0);
    const priceEur = Math.max(0, parseFloat(req.query.price_eur) || 0);
    const qty = Math.max(0, parseInt(req.query.qty) || 50);
    const color = String(req.query.color) === '1';
    // Remise auteur (%) issue du contrat ; repli sur le défaut si absente/invalide.
    const rawDiscount = parseFloat(req.query.discount);
    const discountPct = Number.isFinite(rawDiscount) && rawDiscount >= 0 && rawDiscount <= 100
      ? rawDiscount
      : DEFAULT_AUTHOR_DISCOUNT;

    const items = [];
    if (pages > 0) {
      items.push({ key: 'relecture', label: '1 - Contribution au frais de relecture et au report de correction', price: pages * 1500 });
      items.push({ key: 'pao', label: '2 - Contribution à la mise en pages et réalisation du Prêt-à-clicher', price: pages * 1000 });
    }
    if (priceEur > 0 && qty > 0) {
      // L'auteur paie (100 − remise) % du prix public converti en FCFA.
      const achatPrice = Math.round(priceEur * qty * FCFA_PER_EUR * (1 - discountPct / 100));
      items.push({ key: 'achat', label: `4 - Achat de ${qty} exemplaires contractuels`, price: achatPrice });
    }
    if (color) {
      // Prix fixe pour la contribution à l'impression couleur
      items.push({ key: 'couleur', label: '6 - Contribution à l\'impression Couleur', price: 852000 });
    }

    res.json({ items });
  });

  // GET /api/quotes/:id — get full quote
  router.get('/quotes/:id', auth, async (req, res) => {
    try {
      const quote = db.prepare('SELECT * FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
      quote.items = JSON.parse(quote.items_json);
      delete quote.items_json;
      if (quote.dolibarr_invoice_id && dolibarrPool) {
        try {
          const info = await invoicePaidInfo(quote.dolibarr_invoice_id);
          if (info) {
            quote.paid = info.paid;
            quote.remaining = info.remaining;
            quote.payment_status = payStatus(info.remaining, info.total);
          }
        } catch (e) { void e; }
      }
      res.json(quote);
    } catch (err) {
      console.error('Get quote error:', err.message);
      res.status(500).json({ error: 'Erreur lecture devis' });
    }
  });

  // GET /api/quotes/:id/pdf — render PDF
  router.get('/quotes/:id/pdf', auth, async (req, res) => {
    let tmpDir;
    try {
      const quote = db.prepare('SELECT * FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });

      const items = JSON.parse(quote.items_json);
      const templatePath = join(__dirname, 'templates', 'devis-contrat.odt');
      if (!existsSync(templatePath)) return res.status(500).json({ error: 'Template devis introuvable' });

      tmpDir = join('/tmp', `quote-${quote.id}-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      // Unzip template — execFile (pas de shell) : aucun risque d'injection
      // même si un chemin venait à contenir des métacaractères shell.
      // Asynchrone : la conversion peut durer plusieurs secondes, l'event loop
      // doit rester disponible (POS, paiements…).
      await execFile('unzip', ['-oq', templatePath], { cwd: tmpDir });

      let content = readFileSync(join(tmpDir, 'content.xml'), 'utf-8');

      // Locale-aware date
      const dateStr = new Date(quote.created_at).toLocaleDateString('fr-FR');

      // Remise auteur : affichée uniquement si une valeur > 0 a été enregistrée.
      // Les anciens devis (colonne NULL) ou une remise à 0 % font disparaître la
      // puce entière du document pour ne pas afficher « Remise : 0 % ».
      const disc = Number(quote.discount_pct);
      const hasDiscount = Number.isFinite(disc) && disc > 0;
      const discountStr = hasDiscount
        ? (Number.isInteger(disc) ? String(disc) : disc.toFixed(1).replace('.', ','))
        : '';
      if (!hasDiscount) {
        content = content.replace(/\s*<text:p text:style-name="SpecBullet">- Remise auteur[^<]*<\/text:p>/, '');
      }

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
        DISCOUNT_PCT: discountStr,
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
        const rows = items.map((item, i) => {
          let row = tpl
            .split('{ITEM_LABEL}').join(escapeXml(item.label))
            .split('{ITEM_PRICE}').join(escapeXml(parseInt(item.price).toLocaleString('fr-FR')));
          // Zébrage : une ligne sur deux bascule sur le style à fond vert très pâle.
          // (Le remplacement cible le style de cellule "QuoteCell" sans toucher
          //  "QuoteCellText"/"QuoteCellPrice" grâce aux guillemets englobants.)
          if (i % 2 === 1) row = row.split('"QuoteCell"').join('"QuoteCellAlt"');
          return row;
        }).join('');
        content = content.replace(tpl, rows);
      }

      writeFileSync(join(tmpDir, 'content.xml'), content);

      // Repack ODT (mimetype must be first, uncompressed). Inclut Pictures/ si présent
      // (le template embarque le logo PNG).
      const odtPath = join(tmpDir, 'output.odt');
      const hasPictures = existsSync(join(tmpDir, 'Pictures'));
      // mimetype d'abord, non compressé (-0), puis le reste — sans shell.
      await execFile('zip', ['-q', '-X', '-0', odtPath, 'mimetype'], { cwd: tmpDir });
      await execFile('zip', [
        '-q', '-r', '-X', odtPath,
        'META-INF', 'content.xml', 'styles.xml', 'meta.xml',
        ...(hasPictures ? ['Pictures'] : []),
      ], { cwd: tmpDir });

      // Convert to PDF via LibreOffice headless.
      // --user-installation : nécessaire sous systemd ProtectHome=read-only, sinon soffice
      // tente d'écrire son profil dans $HOME/.config et plante "Unspecified Application Error".
      const sofficeProfile = join(tmpDir, 'soffice-profile');
      mkdirSync(sofficeProfile, { recursive: true });
      await enqueueSoffice(() => execFile('soffice', [
        '--headless', '--norestore', '--nologo', '--nofirststartwizard',
        `-env:UserInstallation=file://${sofficeProfile}`,
        '--convert-to', 'pdf', '--outdir', tmpDir, odtPath,
      ], { timeout: 60000 }));
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

  // POST /api/quotes/:id/send — marque le devis comme envoyé à l'auteur.
  // (Il n'y a pas d'envoi email automatique : le PDF est transmis manuellement ;
  //  ce clic enregistre l'envoi sur la frise du manuscrit.)
  router.post('/quotes/:id/send', auth, csrfProtection, (req, res) => {
    try {
      const quote = db.prepare('SELECT id, ref, contract_id, status FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
      // On ne « renvoie » qu'un brouillon ou un devis déjà envoyé : ne jamais
      // écraser un statut comptable (facturé/acompte/payé).
      if (!['draft', 'sent'].includes(quote.status)) {
        return res.status(409).json({ error: 'Ce devis est déjà facturé — statut non modifiable' });
      }

      db.prepare("UPDATE contract_quotes SET status = 'sent' WHERE id = ?").run(quote.id);
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'send_quote', `Devis ${quote.ref} marqué envoyé`);

      try {
        const msId = manuscriptIdForContract(quote.contract_id);
        if (msId) {
          logManuscriptEvent(db, msId, 'quote_sent',
            { role: req.admin.role || 'admin', id: req.admin.id, label: req.admin.username },
            `Devis ${quote.ref} envoyé à l'auteur`);
        }
      } catch (e) { console.warn('Manuscript event (quote_sent) warning:', e.message); }

      res.json({ success: true, status: 'sent' });
    } catch (err) {
      console.error('Send quote error:', err.message);
      res.status(500).json({ error: 'Erreur envoi devis' });
    }
  });

  // POST /api/quotes/:id/pay — encaisse le devis (compta complète).
  // 1) crée+valide une facture client Dolibarr depuis les lignes du devis (une
  //    seule fois ; lignes en services, TVA=0 → aucun impact stock) ;
  // 2) enregistre le(s) règlement(s) via paymentsdistributed (montant exact) ;
  // 3) solde la facture si entièrement payée. Acomptes : appels successifs.
  // Body : { bank_account, date?, reason?, splits:[{method,amount,num_payment?}] }
  //        (ou { method, amount } mono-méthode).
  router.post('/quotes/:id/pay', authPay, csrfProtection, async (req, res) => {
    try {
      const quoteId = parseInt(req.params.id);
      const quote = db.prepare('SELECT * FROM contract_quotes WHERE id = ?').get(quoteId);
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
      if (!dolibarrPool) return res.status(503).json({ error: 'Connexion Dolibarr indisponible' });

      const bankAccount = parseInt(req.body?.bank_account);
      if (!bankAccount) return res.status(400).json({ error: 'Compte bancaire requis' });

      const dateRaw = req.body?.date || new Date().toISOString().split('T')[0];
      const datepUnix = Math.floor(new Date(`${dateRaw}T12:00:00Z`).getTime() / 1000);
      if (!Number.isFinite(datepUnix)) return res.status(400).json({ error: 'Date invalide' });

      // Normalisation splits (multi-méthode ou mono-méthode).
      const rawSplits = Array.isArray(req.body?.splits) && req.body.splits.length
        ? req.body.splits
        : [{ method: req.body?.method, amount: req.body?.amount, num_payment: req.body?.num_payment }];
      const splits = rawSplits
        .map(s => ({
          method: String(s?.method || '').toUpperCase(),
          amount: Math.round(Number(s?.amount) * 100) / 100,
          num_payment: String(s?.num_payment || '').slice(0, 64),
        }))
        .filter(s => s.method && s.amount > 0);
      if (!splits.length) return res.status(400).json({ error: 'Au moins une ligne de paiement requise' });
      for (const s of splits) {
        if (!PAYMENT_METHODS_ALLOWED.has(s.method)) return res.status(400).json({ error: `Méthode de paiement invalide : ${s.method}` });
      }
      const totalSplit = Math.round(splits.reduce((sum, s) => sum + s.amount, 0) * 100) / 100;

      // ── 1. S'assurer qu'une facture existe (création idempotente) ──
      let invoiceId = quote.dolibarr_invoice_id;
      let invoiceRef = quote.invoice_ref;
      if (!invoiceId) {
        const socid = await contractSoc(quote.contract_id);
        if (!socid) return res.status(400).json({ error: "Le contrat n'a pas de tiers auteur associé — facturation impossible" });

        const items = JSON.parse(quote.items_json);
        const createRes = await adminApi.post('/invoices', {
          socid,
          date: dateRaw,
          type: 0,
          note_public: `Devis de contribution ${quote.ref} — ${quote.book_title}`,
          note_private: `Facturation du devis ${quote.ref} (contrat #${quote.contract_id}) par ${req.admin.username}`,
          // Lignes en SERVICES (product_type=1, sans fk_product) → la validation ne
          // décrémente aucun stock. TVA=0 (L'Harmattan SN ne facture pas la TVA).
          lines: items.map(it => ({
            desc: String(it.label || '').slice(0, 250),
            subprice: Number(it.price) || 0,
            qty: 1,
            tva_tx: 0,
            product_type: 1,
          })),
        });
        invoiceId = createRes.data;
        // Validation sans idwarehouse → aucun mouvement de stock.
        await adminApi.post(`/invoices/${invoiceId}/validate`);
        try {
          const inv = await adminApi.get(`/invoices/${invoiceId}`);
          invoiceRef = inv.data?.ref || null;
        } catch (e) { void e; }
        db.prepare('UPDATE contract_quotes SET dolibarr_invoice_id = ?, invoice_ref = ?, status = ? WHERE id = ?')
          .run(invoiceId, invoiceRef, 'invoiced', quoteId);
      }

      // ── 2. Contrôle du reste à payer ──
      const before = await invoicePaidInfo(invoiceId);
      if (!before) return res.status(404).json({ error: 'Facture liée introuvable' });
      if (before.remaining <= 0.01) {
        return res.status(409).json({ error: 'Facture déjà soldée', invoice_ref: invoiceRef });
      }
      if (totalSplit > before.remaining + 0.01) {
        return res.status(400).json({ error: `Montant (${totalSplit}) supérieur au reste à payer (${before.remaining})` });
      }

      // ── 3. Enregistrement du/des règlement(s) ──
      const willSolde = Math.abs(before.remaining - totalSplit) < 0.01;
      const comment = `Encaissement devis ${quote.ref}`;
      const paymentIds = [];
      for (let i = 0; i < splits.length; i++) {
        const s = splits[i];
        const paymentId = await resolvePaymentId(dolibarrPool, s.method);
        if (!paymentId) return res.status(400).json({ error: `Code paiement inconnu dans Dolibarr : ${s.method}` });
        const pid = await recordInvoicePayment(adminApi, {
          invoiceId,
          amount: s.amount,
          paymentId,
          accountId: bankAccount,
          datepaye: datepUnix,
          isLast: willSolde && i === splits.length - 1,
          numPayment: s.num_payment,
          comment,
        });
        paymentIds.push(pid);
      }

      // ── 4. Solde + statut ──
      const after = await invoicePaidInfo(invoiceId);
      const solded = after && after.remaining <= 0.01;
      if (solded) {
        try { await adminApi.post(`/invoices/${invoiceId}/settopaid`); } catch (e) { void e; }
      }
      const newStatus = solded ? 'paid' : 'partial';
      db.prepare('UPDATE contract_quotes SET status = ? WHERE id = ?').run(newStatus, quoteId);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'pay_quote',
          `Devis ${quote.ref} → facture ${invoiceRef || invoiceId} : encaissé ${totalSplit.toLocaleString('fr-FR')} FCFA (${solded ? 'soldé' : 'acompte'})`);

      try {
        const msId = manuscriptIdForContract(quote.contract_id);
        if (msId) {
          logManuscriptEvent(db, msId, 'quote_paid',
            { role: req.admin.role || 'admin', id: req.admin.id, label: req.admin.username },
            `Devis ${quote.ref} — encaissé ${totalSplit.toLocaleString('fr-FR')} FCFA (${solded ? 'soldé' : 'acompte'})`);
        }
      } catch (e) { console.warn('Manuscript event (quote_paid) warning:', e.message); }

      res.json({
        success: true,
        invoice_id: invoiceId,
        invoice_ref: invoiceRef,
        paid: after?.paid,
        remaining: after?.remaining,
        status: newStatus,
        payment_ids: paymentIds,
      });
    } catch (err) {
      const msg = err.response?.data?.error?.message || err.message;
      console.error('Pay quote error:', msg);
      res.status(500).json({ error: 'Erreur encaissement du devis', detail: msg });
    }
  });

  // DELETE /api/quotes/:id — draft only (rôles éditoriaux : contrôle en middleware)
  router.delete('/quotes/:id', authDelete, csrfProtection, (req, res) => {
    try {
      const quote = db.prepare('SELECT id, ref, contract_id, status FROM contract_quotes WHERE id = ?').get(parseInt(req.params.id));
      if (!quote) return res.status(404).json({ error: 'Devis introuvable' });
      if (quote.status !== 'draft') return res.status(400).json({ error: 'Seuls les brouillons peuvent être supprimés' });

      db.prepare('DELETE FROM contract_quotes WHERE id = ?').run(quote.id);
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'delete_quote', `Devis ${quote.ref}`);

      try {
        const msId = manuscriptIdForContract(quote.contract_id);
        if (msId) {
          logManuscriptEvent(db, msId, 'quote_deleted',
            { role: req.admin.role || 'admin', id: req.admin.id, label: req.admin.username },
            `Devis ${quote.ref} supprimé`);
        }
      } catch (e) { console.warn('Manuscript event (quote_deleted) warning:', e.message); }

      res.json({ success: true });
    } catch (err) {
      console.error('Delete quote error:', err.message);
      res.status(500).json({ error: 'Erreur suppression devis' });
    }
  });

  return router;
}
