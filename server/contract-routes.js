import { Router } from 'express';
import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

// ─── Shared admin Dolibarr API client ────────────────────
const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
const DOLIBARR_URL = process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php';
const adminApi = axios.create({
  baseURL: DOLIBARR_URL,
  headers: { 'DOLAPIKEY': ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

// ─── Business configuration ──────────────────────────────
// Nouveaux types (v2) + anciens types conservés pour retro-compat
const TEMPLATE_MAP = {
  // v2 — templates enrichis (charte Harmattan, page de garde, pagination)
  edition_simple: 'template_edition_simple',
  edition_numerique: 'template_edition_numerique',
  edition_complete: 'template_edition_complete',
  // Legacy — contrats existants continuent de pointer vers les anciens templates
  harmattan_2024: 'template_harmattan_2024',
  harmattan_dll: 'template_harmattan_dll',
  tamarinier: 'template_tamarinier',
};

const STATUS_LABELS = { 0: 'Brouillon', 1: 'Actif', 2: 'Clos' };
const TYPE_LABELS = {
  edition_simple: 'Édition · papier',
  edition_numerique: 'Édition · papier & numérique',
  edition_complete: 'Édition · complète (papier, numérique, adaptations)',
  harmattan_2024: 'Harmattan 2024 (ancien)',
  harmattan_dll: 'Harmattan DLL (ancien)',
  tamarinier: 'Le Tamarinier (ancien)',
};

const DEFAULTS_BY_TYPE = {
  edition_simple:    { royalty_rate_print: 8,  royalty_rate_digital: 0,  royalty_threshold: 500, free_author_copies: 10, tirage_initial: 100, format_ouvrage: '15 × 21 cm', prix_public_previsionnel: 8000, nombre_pages_estime: 200, exemplaires_sp: 5 },
  edition_numerique: { royalty_rate_print: 8,  royalty_rate_digital: 15, royalty_threshold: 500, free_author_copies: 10, tirage_initial: 100, format_ouvrage: '15 × 21 cm', prix_public_previsionnel: 8000, nombre_pages_estime: 200, exemplaires_sp: 5 },
  edition_complete:  { royalty_rate_print: 8,  royalty_rate_digital: 15, royalty_threshold: 500, free_author_copies: 10, tirage_initial: 100, format_ouvrage: '15 × 21 cm', prix_public_previsionnel: 8000, nombre_pages_estime: 200, exemplaires_sp: 5 },
  harmattan_2024:    { royalty_rate_print: 10, royalty_rate_digital: 10, royalty_threshold: 500, free_author_copies: 5 },
  harmattan_dll:     { royalty_rate_print: 8,  royalty_rate_digital: 8,  royalty_threshold: 300, free_author_copies: 10 },
  tamarinier:        { royalty_rate_print: 10, royalty_rate_digital: 10, royalty_threshold: 500, free_author_copies: 5 },
};

// Types v2 activement proposés à la création (les anciens restent compatibles mais masqués)
export const ACTIVE_CONTRACT_TYPES = ['edition_simple', 'edition_numerique', 'edition_complete'];

// Signataire éditeur par défaut (surchargeable par contrat)
const DEFAULT_EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || '';
const DEFAULT_EDITOR_TITLE = process.env.CONTRACT_EDITOR_SIGNATORY_TITLE || 'Directeur général';

const COMMERCIAL_SIGNATURE_ID = process.env.CONTRACT_COMMERCIAL_SIGNATURE_ID || '1';
const COMMERCIAL_SUIVI_ID = process.env.CONTRACT_COMMERCIAL_SUIVI_ID || '1';

// ─── Dolibarr online signature URL generator ─────────────
// Ces variables DOIVENT être fournies par l'environnement (.env) — aucun fallback embarqué.
const DOLIBARR_INSTANCE_KEY = process.env.DOLIBARR_INSTANCE_KEY || '';
const DOLIBARR_SIGN_TOKEN_ENCRYPTED = process.env.DOLIBARR_SIGN_TOKEN || '';
const DOLIBARR_PUBLIC_URL = process.env.DOLIBARR_PUBLIC_URL || '';

// ─── Dolibarr builddoc helper (custom module endpoint) ───
const DOLIBARR_WEBHOOK_SECRET = process.env.DOLIBARR_WEBHOOK_SECRET || '';
const BUILDDOC_URL = 'http://localhost/dolibarr/htdocs/custom/senharmattansync/contract-builddoc.php';

async function rebuildContractDocument(contractId) {
  if (!DOLIBARR_WEBHOOK_SECRET) throw new Error('DOLIBARR_WEBHOOK_SECRET non configuré');
  const { data } = await axios.post(BUILDDOC_URL, { contract_id: contractId }, {
    headers: { 'X-Dolibarr-Secret': DOLIBARR_WEBHOOK_SECRET, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return data;
}

if (!DOLIBARR_INSTANCE_KEY || !DOLIBARR_SIGN_TOKEN_ENCRYPTED || !DOLIBARR_PUBLIC_URL) {
  console.warn('[CONTRACTS] DOLIBARR_INSTANCE_KEY, DOLIBARR_SIGN_TOKEN et DOLIBARR_PUBLIC_URL manquants — la signature en ligne sera désactivée');
}

function decryptDolcrypt(encrypted, key) {
  const parts = encrypted.split(':');
  if (parts.length < 4 || parts[0] !== 'dolcrypt') return encrypted;
  const iv = Buffer.from(parts[2].padEnd(16, '\0').slice(0, 16));
  const data = Buffer.from(parts[3], 'base64');
  const keyBuf = Buffer.from(key.padEnd(32, '\0').slice(0, 32));
  const decipher = crypto.createDecipheriv('aes-256-ctr', keyBuf, iv);
  return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
}

let _signSeed = null;
function getSignSeed() {
  if (!DOLIBARR_INSTANCE_KEY || !DOLIBARR_SIGN_TOKEN_ENCRYPTED) {
    throw new Error('Secrets de signature non configurés (DOLIBARR_INSTANCE_KEY, DOLIBARR_SIGN_TOKEN)');
  }
  if (!_signSeed) _signSeed = decryptDolcrypt(DOLIBARR_SIGN_TOKEN_ENCRYPTED, DOLIBARR_INSTANCE_KEY);
  return _signSeed;
}

export function generateSignatureUrl(ref) {
  if (!DOLIBARR_PUBLIC_URL) {
    throw new Error('DOLIBARR_PUBLIC_URL non configurée — impossible de générer le lien de signature');
  }
  const seed = getSignSeed();
  const chain = seed + 'contract' + ref;
  let hash = bcrypt.hashSync(chain, 10);
  hash = hash.replace(/^\$2b\$/, '$2y$'); // PHP compatibility
  return `${DOLIBARR_PUBLIC_URL}/public/onlinesign/newonlinesign.php?source=contract&ref=${encodeURIComponent(ref)}&securekey=${encodeURIComponent(hash)}`;
}

// ─── Validation helpers ──────────────────────────────────
function validateISBN(isbn) {
  if (!isbn) return true; // optional
  const clean = isbn.replace(/[-\s]/g, '');
  return /^(97[89]\d{10}|\d{10})$/.test(clean);
}

function validateContractData(data) {
  const errors = [];
  if (!data.thirdparty_id || isNaN(parseInt(data.thirdparty_id))) errors.push('Auteur invalide');
  if (!data.contract_type || !TEMPLATE_MAP[data.contract_type]) errors.push('Type de contrat invalide');
  if (!data.book_title?.trim()) errors.push('Titre de l\'ouvrage requis');
  if (data.book_isbn && !validateISBN(data.book_isbn)) errors.push('Format ISBN invalide (10 ou 13 chiffres)');

  const rp = parseFloat(data.royalty_rate_print);
  if (isNaN(rp) || rp < 0 || rp > 50) errors.push('Taux royalties print entre 0 et 50%');
  const rd = parseFloat(data.royalty_rate_digital);
  if (isNaN(rd) || rd < 0 || rd > 50) errors.push('Taux royalties digital entre 0 et 50%');

  const threshold = parseInt(data.royalty_threshold);
  if (isNaN(threshold) || threshold < 0) errors.push('Seuil exemplaires doit être positif');
  const copies = parseInt(data.free_author_copies);
  if (isNaN(copies) || copies < 0 || copies > 100) errors.push('Exemplaires gratuits entre 0 et 100');

  return errors;
}

export function createContractRouter({ db, dolibarrPool, csrfProtection }) {
  const router = Router();

  // Admin auth middleware — vérifie session + rôle autorisé pour les contrats
  const CONTRACT_ALLOWED_ROLES = ['super_admin', 'admin', 'editor'];
  function auth(req, res, next) {
    const session = req.cookies?.admin_session;
    if (!session) return res.status(401).json({ error: 'Non authentifié' });
    const admin = db.prepare('SELECT * FROM admin_users WHERE session_token = ?').get(session);
    if (!admin) return res.status(401).json({ error: 'Session invalide' });
    if (!CONTRACT_ALLOWED_ROLES.includes(admin.role || 'admin')) {
      return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
    }
    req.admin = admin;
    next();
  }

  // SQL filter sanitizer
  function safeSql(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/'/g, "''").replace(/[()]/g, '').slice(0, 200);
  }

  // ═══════════════════════════════════════════════════════
  // DASHBOARD STATS
  // ═══════════════════════════════════════════════════════

  router.get('/stats', auth, async (req, res) => {
    try {
      const [[byStatus]] = await dolibarrPool.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN c.statut = 0 THEN 1 ELSE 0 END) as draft,
          SUM(CASE WHEN c.statut = 1 THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN c.statut = 2 THEN 1 ELSE 0 END) as closed
        FROM llx_contrat c
      `);

      const [byType] = await dolibarrPool.query(`
        SELECT ce.contract_type as type, COUNT(*) as count
        FROM llx_contrat c
        JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
        WHERE ce.contract_type IS NOT NULL AND ce.contract_type != ''
        GROUP BY ce.contract_type
      `);

      const [[expiring]] = await dolibarrPool.query(`
        SELECT COUNT(DISTINCT c.rowid) as count
        FROM llx_contratdet cd
        JOIN llx_contrat c ON c.rowid = cd.fk_contrat
        WHERE cd.date_fin_validite BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 90 DAY)
          AND cd.statut IN (0, 4)
      `);

      const [recent] = await dolibarrPool.query(`
        SELECT c.rowid as id, c.ref, c.statut, c.date_contrat,
               s.nom as author_name,
               ce.book_title, ce.contract_type
        FROM llx_contrat c
        LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
        LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
        ORDER BY c.rowid DESC LIMIT 5
      `);

      res.json({
        total: byStatus.total,
        draft: byStatus.draft,
        active: byStatus.active,
        closed: byStatus.closed,
        byType: byType.map(t => ({ type: t.type, label: TYPE_LABELS[t.type] || t.type, count: t.count })),
        expiringSoon: expiring.count,
        recent: recent.map(c => ({
          id: c.id, ref: c.ref, status: c.statut, statusLabel: STATUS_LABELS[c.statut],
          date: c.date_contrat, author: c.author_name, title: c.book_title,
          type: c.contract_type, typeLabel: TYPE_LABELS[c.contract_type] || c.contract_type,
        })),
      });
    } catch (err) {
      console.error('Contract stats error:', err.message);
      res.status(500).json({ error: 'Erreur statistiques contrats' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // LIST CONTRACTS
  // ═══════════════════════════════════════════════════════

  router.get('/list', auth, async (req, res) => {
    try {
      const { status, type, author, ref, title, isbn, date_from, date_to, page = 1, limit = 20, sort, order } = req.query;
      const pageInt = Math.max(1, parseInt(page));
      const limitInt = Math.min(50, parseInt(limit) || 20);
      const offset = (pageInt - 1) * limitInt;

      const sortMap = { date: 'c.date_contrat', ref: 'c.ref', author: 's.nom', status: 'c.statut', title: 'ce.book_title', type: 'ce.contract_type' };
      const sortCol = sortMap[sort] || 'c.rowid';
      const sortDir = order === 'ASC' ? 'ASC' : 'DESC';

      let where = 'WHERE 1=1';
      const params = [];

      if (status !== undefined && status !== '') {
        where += ' AND c.statut = ?';
        params.push(parseInt(status));
      }
      if (type) {
        where += ' AND ce.contract_type = ?';
        params.push(type);
      }
      if (author) {
        where += ' AND s.nom LIKE ?';
        params.push(`%${safeSql(author)}%`);
      }
      if (ref) {
        where += ' AND c.ref LIKE ?';
        params.push(`%${safeSql(ref)}%`);
      }
      if (title) {
        where += ' AND ce.book_title LIKE ?';
        params.push(`%${safeSql(title)}%`);
      }
      if (isbn) {
        where += ' AND ce.book_isbn LIKE ?';
        params.push(`%${safeSql(isbn)}%`);
      }
      if (date_from) {
        where += ' AND c.date_contrat >= ?';
        params.push(date_from);
      }
      if (date_to) {
        where += ' AND c.date_contrat <= ?';
        params.push(date_to + ' 23:59:59');
      }

      const [[{ total }]] = await dolibarrPool.query(
        `SELECT COUNT(*) as total FROM llx_contrat c
         LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
         ${where}`, params
      );

      const [rows] = await dolibarrPool.query(
        `SELECT c.rowid as id, c.ref, c.statut, c.date_contrat, c.fin_validite,
                s.nom as author_name, s.email as author_email, s.rowid as author_id,
                ce.book_title, ce.book_isbn, ce.contract_type,
                ce.royalty_rate_print, ce.royalty_rate_digital,
                ce.royalty_threshold, ce.free_author_copies
         FROM llx_contrat c
         LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
         ${where}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limitInt, offset]
      );

      res.json({
        contracts: rows.map(c => ({
          id: c.id, ref: c.ref, status: c.statut, statusLabel: STATUS_LABELS[c.statut],
          date: c.date_contrat, expiry: c.fin_validite,
          author: { id: c.author_id, name: c.author_name, email: c.author_email },
          title: c.book_title, isbn: c.book_isbn,
          type: c.contract_type, typeLabel: TYPE_LABELS[c.contract_type] || c.contract_type,
          royaltyPrint: c.royalty_rate_print, royaltyDigital: c.royalty_rate_digital,
          threshold: c.royalty_threshold, freeCopies: c.free_author_copies,
        })),
        total,
        page: pageInt,
        pages: Math.ceil(total / limitInt),
      });
    } catch (err) {
      console.error('Contract list error:', err.message);
      res.status(500).json({ error: 'Erreur liste contrats' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // EXPIRING CONTRACTS
  // ═══════════════════════════════════════════════════════

  router.get('/expiring', auth, async (req, res) => {
    try {
      const days = Math.min(365, parseInt(req.query.days) || 90);
      const [rows] = await dolibarrPool.query(`
        SELECT DISTINCT c.rowid as id, c.ref, c.statut,
               s.nom as author_name,
               ce.book_title, ce.contract_type,
               MIN(cd.date_fin_validite) as earliest_expiry
        FROM llx_contratdet cd
        JOIN llx_contrat c ON c.rowid = cd.fk_contrat
        LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
        LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
        WHERE cd.date_fin_validite BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? DAY)
          AND cd.statut IN (0, 4)
        GROUP BY c.rowid
        ORDER BY earliest_expiry ASC`, [days]
      );

      res.json(rows.map(c => ({
        id: c.id, ref: c.ref, status: c.statut,
        author: c.author_name, title: c.book_title,
        type: c.contract_type, typeLabel: TYPE_LABELS[c.contract_type] || '',
        expiryDate: c.earliest_expiry,
      })));
    } catch (err) {
      console.error('Expiring contracts error:', err.message);
      res.status(500).json({ error: 'Erreur contrats expirants' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // EXPORT CONTRACTS (CSV)
  // ═══════════════════════════════════════════════════════

  router.get('/export/csv', auth, async (req, res) => {
    try {
      const { status, type, author, date_from, date_to } = req.query;
      let where = 'WHERE 1=1';
      const params = [];
      if (status !== undefined && status !== '') { where += ' AND c.statut = ?'; params.push(parseInt(status)); }
      if (type) { where += ' AND ce.contract_type = ?'; params.push(type); }
      if (author) { where += ' AND s.nom LIKE ?'; params.push(`%${safeSql(author)}%`); }
      if (date_from) { where += ' AND c.date_contrat >= ?'; params.push(date_from); }
      if (date_to) { where += ' AND c.date_contrat <= ?'; params.push(date_to + ' 23:59:59'); }

      const [rows] = await dolibarrPool.query(
        `SELECT c.ref, c.statut, c.date_contrat,
                s.nom AS author_name, s.email AS author_email,
                ce.book_title, ce.book_isbn, ce.contract_type,
                ce.royalty_rate_print, ce.royalty_rate_digital,
                ce.royalty_threshold, ce.free_author_copies
         FROM llx_contrat c
         LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         LEFT JOIN llx_societe s ON s.rowid = c.fk_soc
         ${where}
         ORDER BY c.date_contrat DESC`, params
      );

      const escCsv = (v) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
      const header = 'Référence,Statut,Date,Auteur,Email auteur,Titre,ISBN,Type,Royalties print %,Royalties digital %,Seuil,Ex. gratuits';
      const lines = rows.map(r =>
        [r.ref, STATUS_LABELS[r.statut], r.date_contrat ? new Date(r.date_contrat).toLocaleDateString('fr-FR') : '',
         r.author_name, r.author_email, r.book_title, r.book_isbn,
         TYPE_LABELS[r.contract_type] || r.contract_type,
         r.royalty_rate_print, r.royalty_rate_digital, r.royalty_threshold, r.free_author_copies
        ].map(escCsv).join(',')
      );
      const csv = '\uFEFF' + header + '\n' + lines.join('\n'); // BOM for Excel UTF-8

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'export_contracts', `Export CSV — ${rows.length} contrats`);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contrats-${new Date().toISOString().split('T')[0]}.csv"`);
      res.send(csv);
    } catch (err) {
      console.error('Contract export error:', err.message);
      res.status(500).json({ error: 'Erreur export contrats' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // CONTRACT DETAIL
  // ═══════════════════════════════════════════════════════

  router.get('/:id', auth, async (req, res) => {
    try {
      const id = req.params.id;
      const contractRes = await adminApi.get(`/contracts/${id}`);
      const contract = contractRes.data;

      // Fetch author details
      let author = null;
      if (contract.socid) {
        try {
          const authorRes = await adminApi.get(`/thirdparties/${contract.socid}`);
          author = { id: authorRes.data.id, name: authorRes.data.name, email: authorRes.data.email, phone: authorRes.data.phone, address: authorRes.data.address };
        } catch (authorErr) {
          console.warn('Author fetch warning:', authorErr.response?.data || authorErr.message);
        }
      }

      // Fetch documents
      let documents = [];
      try {
        const docsRes = await adminApi.get('/documents', { params: { modulepart: 'contract', id } });
        documents = (docsRes.data || []).map(d => ({ name: d.name, size: d.size, date: d.date, relativename: d.relativename, level1name: d.level1name }));
      } catch (docsErr) {
        console.warn('Contract documents warning:', docsErr.response?.data || docsErr.message);
      }

      res.json({
        id: contract.id,
        ref: contract.ref,
        status: parseInt(contract.statut),
        statusLabel: STATUS_LABELS[parseInt(contract.statut)],
        date: contract.date_contrat,
        notePrivate: contract.note_private,
        notePublic: contract.note_public,
        author,
        extrafields: {
          contractType: contract.array_options?.options_contract_type,
          bookTitle: contract.array_options?.options_book_title,
          bookIsbn: contract.array_options?.options_book_isbn,
          royaltyPrint: contract.array_options?.options_royalty_rate_print,
          royaltyDigital: contract.array_options?.options_royalty_rate_digital,
          royaltyThreshold: contract.array_options?.options_royalty_threshold,
          freeCopies: contract.array_options?.options_free_author_copies,
        },
        lines: (contract.lines || []).map(l => ({
          id: l.id, description: l.description || l.product_label, qty: l.qty,
          price: parseFloat(l.subprice), total: parseFloat(l.total_ttc),
          dateStart: l.date_start, dateEnd: l.date_end, status: l.statut,
          productRef: l.product_ref, productLabel: l.product_label,
        })),
        documents,
      });
    } catch (err) {
      console.error('Contract detail error:', err.response?.data || err.message);
      res.status(err.response?.status || 500).json({ error: 'Erreur détail contrat' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // CREATE CONTRACT
  // ═══════════════════════════════════════════════════════

  router.post('/', auth, csrfProtection, async (req, res) => {
    try {
      const data = req.body;

      // Strict validation
      const errors = validateContractData(data);
      if (errors.length > 0) return res.status(400).json({ error: errors.join('. ') });

      // Verify author exists in Dolibarr
      try {
        await adminApi.get(`/thirdparties/${data.thirdparty_id}`);
      } catch {
        return res.status(400).json({ error: 'Auteur non trouvé dans Dolibarr' });
      }

      const defaults = DEFAULTS_BY_TYPE[data.contract_type];
      const templateFile = TEMPLATE_MAP[data.contract_type];
      const modelPdf = `generic_contract_odt:/var/www/html/dolibarr/documents/doctemplates/contracts/${templateFile}.odt`;

      const arrayOptions = {
        options_contract_type: data.contract_type,
        options_book_title: data.book_title.trim(),
        options_book_isbn: (data.book_isbn || '').replace(/[-\s]/g, ''),
        options_royalty_rate_print: parseFloat(data.royalty_rate_print) || defaults.royalty_rate_print,
        options_royalty_rate_digital: parseFloat(data.royalty_rate_digital) || defaults.royalty_rate_digital,
        options_royalty_threshold: parseInt(data.royalty_threshold) || defaults.royalty_threshold,
        options_free_author_copies: parseInt(data.free_author_copies) || defaults.free_author_copies,
      };

      // Nouvelles variables v2 (templates edition_*)
      if (ACTIVE_CONTRACT_TYPES.includes(data.contract_type)) {
        arrayOptions.options_tirage_initial = parseInt(data.tirage_initial) || defaults.tirage_initial;
        arrayOptions.options_format_ouvrage = (data.format_ouvrage || defaults.format_ouvrage).trim();
        arrayOptions.options_prix_public_previsionnel = parseInt(data.prix_public_previsionnel) || defaults.prix_public_previsionnel;
        arrayOptions.options_nombre_pages_estime = parseInt(data.nombre_pages_estime) || defaults.nombre_pages_estime;
        arrayOptions.options_exemplaires_sp = parseInt(data.exemplaires_sp) || defaults.exemplaires_sp;
        if (data.date_signature) arrayOptions.options_date_signature = data.date_signature;
        arrayOptions.options_editeur_signataire_nom = (data.editeur_signataire_nom || DEFAULT_EDITOR_NAME).trim();
        arrayOptions.options_editeur_signataire_qualite = (data.editeur_signataire_qualite || DEFAULT_EDITOR_TITLE).trim();
      }

      const contractRes = await adminApi.post('/contracts', {
        socid: parseInt(data.thirdparty_id),
        date_contrat: Math.floor(Date.now() / 1000),
        commercial_signature_id: COMMERCIAL_SIGNATURE_ID,
        commercial_suivi_id: COMMERCIAL_SUIVI_ID,
        model_pdf: modelPdf,
        note_private: data.note_private || '',
        array_options: arrayOptions,
      });

      const contractId = contractRes.data;

      // Create contract line with dates (for expiration tracking)
      if (data.service_start || data.service_end) {
        try {
          const lineData = {
            description: `Droits d'édition — ${data.book_title.trim()}`,
            subprice: 0,
            qty: 1,
            product_type: 1, // service
            tva_tx: 0,
          };
          if (data.service_start) lineData.date_start = Math.floor(new Date(data.service_start).getTime() / 1000);
          if (data.service_end) lineData.date_end = Math.floor(new Date(data.service_end).getTime() / 1000);

          await adminApi.post(`/contracts/${contractId}/lines`, lineData);
        } catch (lineErr) {
          console.error('Contract line creation warning:', lineErr.response?.data || lineErr.message);
        }
      }

      // Log activity
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'create_contract', `Contrat créé pour "${data.book_title}" (${TYPE_LABELS[data.contract_type]})`);

      // Store manuscript link if provided
      if (data.manuscript_id) {
        try {
          db.exec(`CREATE TABLE IF NOT EXISTS contract_manuscript_links (
            contract_id INTEGER, manuscript_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (contract_id, manuscript_id)
          )`);
          db.prepare('INSERT OR IGNORE INTO contract_manuscript_links (contract_id, manuscript_id) VALUES (?, ?)').run(contractId, data.manuscript_id);
        } catch (linkErr) {
          console.warn('Contract manuscript link warning:', linkErr.message);
        }
      }

      res.json({ id: contractId });
    } catch (err) {
      console.error('Create contract error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur création contrat' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // UPDATE CONTRACT (draft only)
  // ═══════════════════════════════════════════════════════

  router.put('/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = req.params.id;

      // Check contract is still a draft
      const existing = await adminApi.get(`/contracts/${id}`);
      if (parseInt(existing.data.statut) !== 0) {
        return res.status(400).json({ error: 'Seuls les brouillons peuvent être modifiés' });
      }

      const data = req.body;
      const updates = {};

      // Update note if provided
      if (data.note_private !== undefined) updates.note_private = data.note_private;

      // Update extrafields if provided
      const arrayOptions = {};
      if (data.contract_type && TEMPLATE_MAP[data.contract_type]) {
        arrayOptions.options_contract_type = data.contract_type;
        updates.model_pdf = `generic_contract_odt:/var/www/html/dolibarr/documents/doctemplates/contracts/${TEMPLATE_MAP[data.contract_type]}.odt`;
      }
      if (data.book_title) arrayOptions.options_book_title = data.book_title.trim();
      if (data.book_isbn !== undefined) {
        if (data.book_isbn && !validateISBN(data.book_isbn)) return res.status(400).json({ error: 'Format ISBN invalide' });
        arrayOptions.options_book_isbn = (data.book_isbn || '').replace(/[-\s]/g, '');
      }
      if (data.royalty_rate_print !== undefined) {
        const v = parseFloat(data.royalty_rate_print);
        if (v < 0 || v > 50) return res.status(400).json({ error: 'Taux royalties print entre 0 et 50%' });
        arrayOptions.options_royalty_rate_print = v;
      }
      if (data.royalty_rate_digital !== undefined) {
        const v = parseFloat(data.royalty_rate_digital);
        if (v < 0 || v > 50) return res.status(400).json({ error: 'Taux royalties digital entre 0 et 50%' });
        arrayOptions.options_royalty_rate_digital = v;
      }
      if (data.royalty_threshold !== undefined) arrayOptions.options_royalty_threshold = parseInt(data.royalty_threshold);
      if (data.free_author_copies !== undefined) arrayOptions.options_free_author_copies = parseInt(data.free_author_copies);

      // Nouvelles variables v2
      if (data.tirage_initial !== undefined) arrayOptions.options_tirage_initial = parseInt(data.tirage_initial);
      if (data.format_ouvrage !== undefined) arrayOptions.options_format_ouvrage = (data.format_ouvrage || '').trim();
      if (data.prix_public_previsionnel !== undefined) arrayOptions.options_prix_public_previsionnel = parseInt(data.prix_public_previsionnel);
      if (data.nombre_pages_estime !== undefined) arrayOptions.options_nombre_pages_estime = parseInt(data.nombre_pages_estime);
      if (data.exemplaires_sp !== undefined) arrayOptions.options_exemplaires_sp = parseInt(data.exemplaires_sp);
      if (data.date_signature !== undefined) arrayOptions.options_date_signature = data.date_signature || null;
      if (data.editeur_signataire_nom !== undefined) arrayOptions.options_editeur_signataire_nom = (data.editeur_signataire_nom || '').trim();
      if (data.editeur_signataire_qualite !== undefined) arrayOptions.options_editeur_signataire_qualite = (data.editeur_signataire_qualite || '').trim();

      if (Object.keys(arrayOptions).length > 0) updates.array_options = arrayOptions;

      await adminApi.put(`/contracts/${id}`, updates);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'update_contract', `Contrat #${id} modifié`);

      res.json({ success: true });
    } catch (err) {
      console.error('Update contract error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur modification contrat' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // VALIDATE CONTRACT
  // ═══════════════════════════════════════════════════════

  router.post('/:id/validate', auth, csrfProtection, async (req, res) => {
    try {
      await adminApi.post(`/contracts/${req.params.id}/validate`);
      const detail = await adminApi.get(`/contracts/${req.params.id}`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'validate_contract', `Contrat ${detail.data.ref} validé`);

      res.json({ success: true, ref: detail.data.ref });
    } catch (err) {
      console.error('Validate contract error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur validation contrat' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // DELETE CONTRACT (draft only)
  // ═══════════════════════════════════════════════════════

  router.delete('/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = req.params.id;
      const existing = await adminApi.get(`/contracts/${id}`);
      if (parseInt(existing.data.statut) !== 0) {
        return res.status(400).json({ error: 'Seuls les brouillons peuvent être supprimés' });
      }

      await adminApi.delete(`/contracts/${id}`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'delete_contract', `Contrat brouillon #${id} supprimé`);

      res.json({ success: true });
    } catch (err) {
      console.error('Delete contract error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur suppression contrat' });
    }
  });

  // CLOSE CONTRACT
  // ═══════════════════════════════════════════════════════

  router.post('/:id/close', auth, csrfProtection, async (req, res) => {
    try {
      await adminApi.post(`/contracts/${req.params.id}/close`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'close_contract', `Contrat ${req.params.id} clôturé`);

      res.json({ success: true });
    } catch (err) {
      console.error('Close contract error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur clôture contrat' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════
  // SIGNATURE
  // ═══════════════════════════════════════════════════════

  // Get signature URL for a contract
  router.get('/:id/signature-url', auth, async (req, res) => {
    try {
      const contract = await adminApi.get(`/contracts/${req.params.id}`);
      const ref = contract.data.ref;
      if (!ref || ref.startsWith('(PROV')) return res.status(400).json({ error: 'Le contrat doit être validé avant de pouvoir être signé' });

      const url = generateSignatureUrl(ref);
      res.json({ url, ref });
    } catch (err) {
      console.error('Signature URL error:', err.message);
      res.status(500).json({ error: 'Erreur génération lien de signature' });
    }
  });

  // Send signature link by email to author
  router.post('/:id/send-signature', auth, csrfProtection, async (req, res) => {
    try {
      const contract = await adminApi.get(`/contracts/${req.params.id}`);
      const ref = contract.data.ref;
      if (!ref || ref.startsWith('(PROV')) return res.status(400).json({ error: 'Le contrat doit être validé' });

      const socid = contract.data.socid;
      const authorRes = await adminApi.get(`/thirdparties/${socid}`);
      const email = authorRes.data.email;
      if (!email) return res.status(400).json({ error: "L'auteur n'a pas d'email" });

      const url = generateSignatureUrl(ref);
      const bookTitle = contract.data.array_options?.options_book_title || '';

      // Send email via the transporter passed via dolibarrPool context (use nodemailer from index.js)
      // Since we don't have transporter here, use a direct approach
      const nodemailer = (await import('nodemailer')).default;
      const transporter = nodemailer.createTransport({ host: '127.0.0.1', port: 1025, ignoreTLS: true });

      await transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <direction@senharmattan.com>',
        to: email,
        subject: `Contrat d'édition ${ref} — Signature en ligne`,
        html: `
          <p>Bonjour ${authorRes.data.name},</p>
          <p>Votre contrat d'édition pour l'ouvrage <strong>« ${bookTitle} »</strong> (réf. ${ref}) est prêt pour signature.</p>
          <p>Veuillez cliquer sur le lien ci-dessous pour signer le contrat en ligne :</p>
          <p><a href="${url}" style="display:inline-block;background:#10531a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Signer le contrat</a></p>
          <p>Ce lien est personnel et sécurisé.</p>
          <p>Cordialement,<br>L'équipe éditoriale de L'Harmattan Sénégal</p>
        `,
      });

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'send_signature', `Lien de signature envoyé pour ${ref} à ${email}`);

      res.json({ success: true, email });
    } catch (err) {
      console.error('Send signature error:', err.message);
      res.status(500).json({ error: 'Erreur envoi lien de signature' });
    }
  });

  // Get signature status
  router.get('/:id/signature-status', auth, async (req, res) => {
    try {
      const [rows] = await dolibarrPool.query(
        `SELECT c.signed_status, c.online_sign_ip, c.online_sign_name, c.tms AS signed_tms,
                ce.signature_auteur_nom, ce.signature_auteur_date
         FROM llx_contrat c
         LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
         WHERE c.rowid = ?`,
        [req.params.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Contrat non trouvé' });
      const c = rows[0];
      const labels = { 0: 'Non signé', 1: 'Signé par l\'éditeur', 2: 'Signé par l\'auteur', 9: 'Signé par tous' };
      const status = c.signed_status || 0;
      res.json({
        status,
        label: labels[status],
        signedBy: c.online_sign_name,
        signedIp: c.online_sign_ip,
        signedAt: c.signed_tms,
        // Les extrafields sont renseignés après régénération du PDF signé
        certifiedInPdf: !!c.signature_auteur_nom && !!c.signature_auteur_date,
        pdfSignerName: c.signature_auteur_nom,
        pdfSignerDate: c.signature_auteur_date,
      });
    } catch (err) {
      console.error('Signature status error:', err.message);
      res.status(500).json({ error: 'Erreur statut signature' });
    }
  });

  // Regenerate contract PDF after signature
  // Copie online_sign_* vers les extrafields signature_auteur_* puis régénère le document
  router.post('/:id/regenerate-signed', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID invalide' });

      const result = await rebuildContractDocument(id);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'regenerate_contract_signed',
          `Régénération PDF ${result.ref} (signed=${result.signed_status}, signer=${result.signer_name || '-'})`);

      res.json({ success: true, ...result });
    } catch (err) {
      const dolErr = err.response?.data;
      console.error('Regenerate signed contract error:', dolErr || err.message);
      res.status(500).json({ error: 'Erreur régénération document', details: dolErr || err.message });
    }
  });

  // DOWNLOAD DOCUMENT
  // ═══════════════════════════════════════════════════════

  router.get('/:id/document', auth, async (req, res) => {
    try {
      const id = req.params.id;

      // Auto-régénération : si le contrat est signé mais que les extrafields signature
      // ne sont pas encore remplis, on régénère le PDF avant de le servir.
      try {
        const [sigRows] = await dolibarrPool.query(
          `SELECT c.signed_status, c.online_sign_name, ce.signature_auteur_nom
           FROM llx_contrat c
           LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
           WHERE c.rowid = ?`, [id]
        );
        const sig = sigRows[0];
        if (sig && sig.signed_status > 0 && sig.online_sign_name && !sig.signature_auteur_nom) {
          await rebuildContractDocument(parseInt(id));
        }
      } catch (autoErr) {
        console.warn('Auto-regenerate warning:', autoErr.response?.data || autoErr.message);
      }

      const docsRes = await adminApi.get('/documents', { params: { modulepart: 'contract', id } });
      const docs = docsRes.data || [];
      const doc = docs.find(d => d.name.endsWith('.pdf')) || docs.find(d => d.name.endsWith('.odt')) || docs[0];

      if (!doc) return res.status(404).json({ error: 'Aucun document trouvé' });

      const filePath = doc.level1name ? `${doc.level1name}/${doc.name}` : doc.relativename || doc.name;
      const dlRes = await adminApi.get('/documents/download', {
        params: { modulepart: 'contract', original_file: filePath },
      });

      const buffer = Buffer.from(dlRes.data.content, 'base64');
      const ext = doc.name.split('.').pop();
      const mime = ext === 'pdf' ? 'application/pdf' : 'application/vnd.oasis.opendocument.text';

      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${doc.name}"`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'download_contract', `Téléchargement ${doc.name}`);

      res.send(buffer);
    } catch (err) {
      console.error('Contract document error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur téléchargement document' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // SEARCH AUTHORS (thirdparties)
  // ═══════════════════════════════════════════════════════

  router.get('/thirdparties/search', auth, async (req, res) => {
    try {
      const q = safeSql(String(req.query.q || '').trim());
      if (q.length < 2) return res.json([]);

      const response = await adminApi.get('/thirdparties', {
        params: { sqlfilters: `(t.nom:like:'%${q}%') OR (t.email:like:'%${q}%')`, limit: 10 },
      });

      res.json((response.data || []).map(t => ({
        id: t.id, name: t.name || t.nom, email: t.email, phone: t.phone,
      })));
    } catch (err) {
      if (err.response?.status === 404) return res.json([]);
      console.error('Thirdparty search error:', err.message);
      res.status(500).json({ error: 'Erreur recherche' });
    }
  });

  return router;
}
