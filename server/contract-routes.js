import { Router } from 'express';
import 'dotenv/config';
import axios from 'axios';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { transition as wfTransition, logManuscriptEvent } from './manuscript-workflow.js';
import { findExistingTier, validateTierIdentity, buildTierName, TYPENT_PARTICULIER } from './tier-dedup.js';

// ─── Shared admin Dolibarr API client ────────────────────
const ADMIN_API_KEY = process.env.DOLIBARR_ADMIN_API_KEY;
const DOLIBARR_URL = process.env.DOLIBARR_URL || 'http://localhost/dolibarr/htdocs/api/index.php';
const adminApi = axios.create({
  baseURL: DOLIBARR_URL,
  headers: { 'DOLAPIKEY': ADMIN_API_KEY, 'Content-Type': 'application/json' },
  timeout: 30000,
});

// ─── Business configuration ──────────────────────────────
const CONTRACT_MODELS = {
  harmattan_2024: { label: 'Harmattan · classique', defaults: { royalty_rate_print: 10, royalty_threshold: 500, free_author_copies: 5 } },
  harmattan_dll: { label: 'Harmattan · DLL', defaults: { royalty_rate_print: 15, royalty_threshold: 1000, free_author_copies: 55 } },
  tamarinier: { label: 'Le Tamarinier', defaults: { royalty_rate_print: 10, royalty_threshold: 500, free_author_copies: 5 } },
};

const RIGHTS_SCOPES = {
  edition_simple: { label: 'papier seul', defaults: { royalty_rate_digital: 0 } },
  edition_numerique: { label: 'papier + numérique', defaults: { royalty_rate_digital: 10 } },
  edition_complete: { label: 'complète', defaults: { royalty_rate_digital: 10 } },
};

const COMBINED_CONTRACT_TYPES = Object.fromEntries(
  Object.keys(CONTRACT_MODELS).flatMap(model =>
    Object.keys(RIGHTS_SCOPES).map(scope => {
      const key = `${model}_${scope}`;
      return [key, { model, scope }];
    })
  )
);

const LEGACY_TYPE_ALIASES = {
  harmattan_2024: { model: 'harmattan_2024', scope: 'edition_complete' },
  harmattan_dll: { model: 'harmattan_dll', scope: 'edition_complete' },
  tamarinier: { model: 'tamarinier', scope: 'edition_complete' },
  edition_simple: { model: 'harmattan_2024', scope: 'edition_simple' },
  edition_numerique: { model: 'harmattan_2024', scope: 'edition_numerique' },
  edition_complete: { model: 'harmattan_2024', scope: 'edition_complete' },
};

const resolveContractType = (type) => COMBINED_CONTRACT_TYPES[type] || LEGACY_TYPE_ALIASES[type] || null;

const TEMPLATE_MAP = Object.fromEntries(
  Object.keys(COMBINED_CONTRACT_TYPES).map(type => [type, `template_${type}`])
);
Object.assign(TEMPLATE_MAP, {
  // Legacy — contrats existants continuent de pointer vers les anciens templates
  harmattan_2024: 'template_harmattan_2024',
  harmattan_dll: 'template_harmattan_dll',
  tamarinier: 'template_tamarinier',
  edition_simple: 'template_edition_simple',
  edition_numerique: 'template_edition_numerique',
  edition_complete: 'template_edition_complete',
});

// Répertoire des templates ODT de contrats (côté Dolibarr)
const CONTRACT_TEMPLATE_DIR = '/var/www/html/dolibarr/documents/doctemplates/contracts';

// Construit la valeur model_pdf attendue par Dolibarr pour un type de contrat.
// Renvoie null si le type est inconnu (pas de template associé).
function buildModelPdf(contractType) {
  const templateFile = TEMPLATE_MAP[contractType];
  if (!templateFile) return null;
  return `generic_contract_odt:${CONTRACT_TEMPLATE_DIR}/${templateFile}.odt`;
}

const STATUS_LABELS = { 0: 'Brouillon', 1: 'Actif', 2: 'Clos' };
const TYPE_LABELS = Object.fromEntries(
  Object.entries(COMBINED_CONTRACT_TYPES).map(([type, cfg]) => [
    type,
    `${CONTRACT_MODELS[cfg.model].label} · ${RIGHTS_SCOPES[cfg.scope].label}`,
  ])
);
Object.assign(TYPE_LABELS, {
  edition_simple: 'Édition · papier',
  edition_numerique: 'Édition · papier & numérique',
  edition_complete: 'Édition · complète (papier, numérique, adaptations)',
  harmattan_2024: 'Harmattan classique',
  harmattan_dll: 'Harmattan DLL',
  tamarinier: 'Le Tamarinier',
});

function getDefaultsForType(type) {
  const resolved = resolveContractType(type);
  if (!resolved) return null;
  return {
    royalty_rate_print: CONTRACT_MODELS[resolved.model].defaults.royalty_rate_print,
    royalty_rate_digital: RIGHTS_SCOPES[resolved.scope].defaults.royalty_rate_digital,
    royalty_threshold: CONTRACT_MODELS[resolved.model].defaults.royalty_threshold,
    free_author_copies: CONTRACT_MODELS[resolved.model].defaults.free_author_copies,
    tirage_initial: 100,
    format_ouvrage: '15 × 21 cm',
    prix_public_previsionnel: 15,
    nombre_pages_estime: 200,
    exemplaires_sp: 5,
  };
}

// Types activement proposés à la création
export const ACTIVE_CONTRACT_TYPES = Object.keys(COMBINED_CONTRACT_TYPES);

// Signataire éditeur par défaut (surchargeable par contrat ou par variables d'env)
const DEFAULT_EDITOR_NAME = process.env.CONTRACT_EDITOR_SIGNATORY_NAME || 'Dr Abdoulaye DIALLO';
const DEFAULT_EDITOR_TITLE = process.env.CONTRACT_EDITOR_SIGNATORY_TITLE || 'Administrateur Général';

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

// Numeric coercion qui PRÉSERVE les zéros volontaires (un taux 0 % ne doit pas
// être écrasé par le défaut). `x || default` traiterait 0 comme falsy — bug.
function numOr(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}
function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// Convertit une date (ISO "YYYY-MM-DD", Date, timestamp…) en epoch secondes.
// L'API Dolibarr v21 exige un epoch entier pour les extrafields de type `date` ;
// envoyer une chaîne ISO provoque un rejet/une perte silencieuse (régression v13→v21).
function toEpochDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

// Normalise une erreur Dolibarr : propage le code HTTP réel pour les erreurs
// métier (4xx) au lieu de tout écraser en 500, et expose le message Dolibarr
// uniquement pour les 4xx (validation métier — sûr à montrer à un admin),
// jamais pour les 5xx (risque de fuite de détails internes).
function dolibarrError(err, genericMessage) {
  const upstream = err.response?.status;
  const isClientError = Number.isInteger(upstream) && upstream >= 400 && upstream < 500;
  const dolMsg = err.response?.data?.error?.message || err.response?.data?.message;
  return {
    status: isClientError ? upstream : 500,
    body: { error: isClientError && dolMsg ? `${genericMessage} : ${dolMsg}` : genericMessage },
  };
}

function validateContractData(data) {
  const errors = [];
  if (!data.thirdparty_id || isNaN(parseInt(data.thirdparty_id))) errors.push('Auteur invalide');
  if (!data.contract_type || !resolveContractType(data.contract_type) || !TEMPLATE_MAP[data.contract_type]) errors.push('Type de contrat invalide');
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

export function createContractRouter({ db, dolibarrPool, csrfProtection, transporter }) {
  const router = Router();

  // Admin auth middleware — vérifie session + rôle autorisé pour les contrats
  const CONTRACT_ALLOWED_ROLES = ['super_admin', 'admin', 'editor'];
  // Le comptable peut CRÉER et MODIFIER un contrat, ainsi que le VALIDER et
  // TÉLÉCHARGER son PDF. Il n'a PAS les actions de cycle de vie sensibles
  // (clôture, suppression, envoi en signature, export CSV) qui restent
  // réservées aux profils éditoriaux via `auth`.
  const CONTRACT_WRITE_ROLES = [...CONTRACT_ALLOWED_ROLES, 'comptable'];
  // Validation + téléchargement du PDF : profils éditoriaux + comptable.
  const CONTRACT_VALIDATE_ROLES = [...CONTRACT_ALLOWED_ROLES, 'comptable'];
  // Lecture de navigation (fiches + devis de contribution) : inclut aussi le comptable.
  const CONTRACT_READ_ROLES = [...CONTRACT_ALLOWED_ROLES, 'comptable'];
  function makeAuth(allowedRoles) {
    return function (req, res, next) {
      const session = req.cookies?.admin_session;
      if (!session) return res.status(401).json({ error: 'Non authentifié' });
      // Le token brut du cookie est haché avant lookup — la base stocke sha256(token).
      const tokenHash = crypto.createHash('sha256').update(String(session)).digest('hex');
      const admin = db.prepare(
        "SELECT * FROM admin_users WHERE session_token = ? AND (session_expires_at IS NULL OR session_expires_at > datetime('now'))"
      ).get(tokenHash);
      if (!admin) return res.status(401).json({ error: 'Session invalide' });
      if (!allowedRoles.includes(admin.role || 'admin')) {
        return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
      }
      req.admin = admin;
      next();
    };
  }
  const auth = makeAuth(CONTRACT_ALLOWED_ROLES);    // cycle de vie sensible (clôture, suppression, signature, export)
  const authWrite = makeAuth(CONTRACT_WRITE_ROLES); // création + modification (inclut le comptable)
  const authValidate = makeAuth(CONTRACT_VALIDATE_ROLES); // validation + téléchargement PDF (inclut le comptable)
  const authRead = makeAuth(CONTRACT_READ_ROLES);   // lecture de navigation (inclut le comptable)

  // SQL filter sanitizer
  function safeSql(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/'/g, "''").replace(/[()]/g, '').slice(0, 200);
  }

  // Liste les documents Dolibarr d'un contrat. Dolibarr renvoie une 404 quand
  // aucun document n'existe encore — on la traite comme une liste vide plutôt
  // que comme une erreur (un brouillon sans PDF n'est pas un cas d'erreur).
  async function listContractDocuments(id) {
    try {
      const docsRes = await adminApi.get('/documents', { params: { modulepart: 'contract', id } });
      return docsRes.data || [];
    } catch (err) {
      if (err.response?.status === 404) return [];
      throw err;
    }
  }

  // Garantit que model_pdf est renseigné en base (Dolibarr::create/update ne le
  // persistent pas). Le déduit du contract_type si absent. Renvoie le model ou null.
  async function ensureContractModel(id) {
    const [rows] = await dolibarrPool.query(
      `SELECT c.model_pdf, ce.contract_type
         FROM llx_contrat c
         LEFT JOIN llx_contrat_extrafields ce ON ce.fk_object = c.rowid
        WHERE c.rowid = ?`, [id]
    );
    if (!rows.length) return null;
    if (rows[0].model_pdf) return rows[0].model_pdf;
    const model = buildModelPdf(rows[0].contract_type);
    if (!model) return null;
    await dolibarrPool.query('UPDATE llx_contrat SET model_pdf = ? WHERE rowid = ?', [model, id]);
    return model;
  }

  // ═══════════════════════════════════════════════════════
  // DASHBOARD STATS
  // ═══════════════════════════════════════════════════════

  router.get('/stats', authRead, async (req, res) => {
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

  router.get('/list', authRead, async (req, res) => {
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

  router.get('/expiring', authRead, async (req, res) => {
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

  router.get('/:id', authRead, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Identifiant de contrat invalide' });
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
          bookSubtitle: contract.array_options?.options_book_subtitle,
          bookIsbn: contract.array_options?.options_book_isbn,
          royaltyPrint: contract.array_options?.options_royalty_rate_print,
          royaltyDigital: contract.array_options?.options_royalty_rate_digital,
          royaltyThreshold: contract.array_options?.options_royalty_threshold,
          royaltyDigitalThresholdFcfa: contract.array_options?.options_royalty_digital_threshold_fcfa,
          freeCopies: contract.array_options?.options_free_author_copies,
          authorPurchaseEnabled: contract.array_options?.options_author_purchase_enabled,
          authorPurchaseQty: contract.array_options?.options_author_purchase_qty,
          authorPurchaseDiscount: contract.array_options?.options_author_purchase_discount,
          // Production / fabrication (utilisés par le formulaire de devis)
          tirageInitial: contract.array_options?.options_tirage_initial,
          formatOuvrage: contract.array_options?.options_format_ouvrage,
          nombrePagesEstime: contract.array_options?.options_nombre_pages_estime,
          prixPublicPrevisionnel: contract.array_options?.options_prix_public_previsionnel,
          exemplairesSp: contract.array_options?.options_exemplaires_sp,
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

  router.post('/', authWrite, csrfProtection, async (req, res) => {
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

      const defaults = getDefaultsForType(data.contract_type);
      const modelPdf = buildModelPdf(data.contract_type);

      const arrayOptions = {
        options_contract_type: data.contract_type,
        options_book_title: data.book_title.trim(),
        options_book_subtitle: (data.book_subtitle || '').trim(),
        options_book_isbn: (data.book_isbn || '').replace(/[-\s]/g, ''),
        options_royalty_rate_print: numOr(data.royalty_rate_print, defaults.royalty_rate_print),
        options_royalty_rate_digital: numOr(data.royalty_rate_digital, defaults.royalty_rate_digital),
        options_royalty_threshold: intOr(data.royalty_threshold, defaults.royalty_threshold),
        options_royalty_digital_threshold_fcfa: intOr(data.royalty_digital_threshold_fcfa, 20000),
        options_free_author_copies: intOr(data.free_author_copies, defaults.free_author_copies),
        options_author_purchase_enabled: data.author_purchase_enabled ? 1 : 0,
        options_author_purchase_qty: data.author_purchase_enabled ? intOr(data.author_purchase_qty, 0) : 0,
        options_author_purchase_discount: data.author_purchase_enabled ? numOr(data.author_purchase_discount, 0) : 0,
      };

      // Nouvelles variables v2 (templates edition_*)
      if (ACTIVE_CONTRACT_TYPES.includes(data.contract_type)) {
        arrayOptions.options_tirage_initial = intOr(data.tirage_initial, defaults.tirage_initial);
        arrayOptions.options_format_ouvrage = (data.format_ouvrage || defaults.format_ouvrage).trim();
        arrayOptions.options_prix_public_previsionnel = numOr(data.prix_public_previsionnel, defaults.prix_public_previsionnel);
        arrayOptions.options_nombre_pages_estime = intOr(data.nombre_pages_estime, defaults.nombre_pages_estime);
        arrayOptions.options_exemplaires_sp = intOr(data.exemplaires_sp, defaults.exemplaires_sp);
        // v21 : extrafield de type `date` → epoch entier obligatoire (cf. toEpochDate)
        const sigEpoch = toEpochDate(data.date_signature);
        if (sigEpoch !== null) arrayOptions.options_date_signature = sigEpoch;
        arrayOptions.options_editeur_signataire_nom = (data.editeur_signataire_nom || DEFAULT_EDITOR_NAME).trim();
        arrayOptions.options_editeur_signataire_qualite = (data.editeur_signataire_qualite || DEFAULT_EDITOR_TITLE).trim();
      }

      const contractRes = await adminApi.post('/contracts', {
        socid: parseInt(data.thirdparty_id, 10),
        date_contrat: Math.floor(Date.now() / 1000),
        // v21 : ids commerciaux attendus en entier (sinon FK ignorée silencieusement)
        commercial_signature_id: parseInt(COMMERCIAL_SIGNATURE_ID, 10) || 1,
        commercial_suivi_id: parseInt(COMMERCIAL_SUIVI_ID, 10) || 1,
        model_pdf: modelPdf,
        note_private: data.note_private || '',
        array_options: arrayOptions,
      });

      const contractId = contractRes.data;

      // Dolibarr::Contrat::create() N'ENREGISTRE PAS le champ model_pdf (absent
      // de son INSERT) — sans lui, la génération du document échoue ensuite
      // (« contract has no model_pdf set »). On le persiste donc nous-mêmes.
      if (modelPdf) {
        try {
          await dolibarrPool.query('UPDATE llx_contrat SET model_pdf = ? WHERE rowid = ?', [modelPdf, contractId]);
        } catch (modelErr) {
          console.warn('[CONTRACTS] Persist model_pdf warning:', modelErr.message);
        }
      }

      // Log activity
      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'create_contract', `Contrat créé pour "${data.book_title}" (${TYPE_LABELS[data.contract_type]})`);

      // Store manuscript link if provided + propage l'avancement workflow.
      // Sans cette propagation, un contrat créé depuis l'écran "Contrats" restait
      // visible en table annexe (contract_manuscript_links) mais le manuscrit
      // restait bloqué dans son stage précédent (typiquement evaluation_done),
      // alors que le hook auto fait bien la transition vers contract_pending.
      if (data.manuscript_id) {
        try {
          db.exec(`CREATE TABLE IF NOT EXISTS contract_manuscript_links (
            contract_id INTEGER, manuscript_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (contract_id, manuscript_id)
          )`);
          // Atomicité : le lien + le contract_id sur le manuscrit doivent être
          // écrits ensemble (tout ou rien) pour ne pas laisser d'état incohérent
          // si l'un des deux échoue.
          db.transaction(() => {
            db.prepare('INSERT OR IGNORE INTO contract_manuscript_links (contract_id, manuscript_id) VALUES (?, ?)').run(contractId, data.manuscript_id);
            db.prepare('UPDATE manuscripts SET contract_id = ? WHERE id = ?').run(contractId, data.manuscript_id);
          })();

          // Avance vers contract_pending si la transition est autorisée depuis le
          // stage courant. La fonction est idempotente (no-op si déjà au stage cible)
          // et lève si la transition n'est pas légale — dans ce cas on log et on
          // continue : le contrat a bien été créé, c'est juste l'avancement qui n'est pas applicable.
          try {
            wfTransition(db, parseInt(data.manuscript_id, 10), 'contract_pending',
              { role: req.admin?.role || 'admin', id: req.admin?.id, label: req.admin?.username },
              { note: `Contrat manuel #${contractId} créé (${TYPE_LABELS[data.contract_type] || data.contract_type})` }
            );
          } catch (wfErr) {
            console.warn('[CONTRACTS] Transition manuscrit ignorée:', wfErr.message);
          }
        } catch (linkErr) {
          console.warn('Contract manuscript link warning:', linkErr.message);
        }
      }

      res.json({ id: contractId });
    } catch (err) {
      console.error('Create contract error:', err.response?.data || err.message);
      const { status, body } = dolibarrError(err, 'Erreur création contrat');
      res.status(status).json(body);
    }
  });

  // ═══════════════════════════════════════════════════════
  // UPDATE CONTRACT (draft only)
  // ═══════════════════════════════════════════════════════

  router.put('/:id', authWrite, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Identifiant de contrat invalide' });

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
        updates.model_pdf = buildModelPdf(data.contract_type);
      }
      if (data.book_title) arrayOptions.options_book_title = data.book_title.trim();
      if (data.book_subtitle !== undefined) arrayOptions.options_book_subtitle = (data.book_subtitle || '').trim();
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
      if (data.royalty_digital_threshold_fcfa !== undefined) arrayOptions.options_royalty_digital_threshold_fcfa = parseInt(data.royalty_digital_threshold_fcfa);
      if (data.free_author_copies !== undefined) arrayOptions.options_free_author_copies = parseInt(data.free_author_copies);
      if (data.author_purchase_enabled !== undefined) arrayOptions.options_author_purchase_enabled = data.author_purchase_enabled ? 1 : 0;
      if (data.author_purchase_qty !== undefined) arrayOptions.options_author_purchase_qty = parseInt(data.author_purchase_qty) || 0;
      if (data.author_purchase_discount !== undefined) arrayOptions.options_author_purchase_discount = parseFloat(data.author_purchase_discount) || 0;

      // Nouvelles variables v2
      if (data.tirage_initial !== undefined) arrayOptions.options_tirage_initial = parseInt(data.tirage_initial);
      if (data.format_ouvrage !== undefined) arrayOptions.options_format_ouvrage = (data.format_ouvrage || '').trim();
      if (data.prix_public_previsionnel !== undefined) arrayOptions.options_prix_public_previsionnel = parseFloat(data.prix_public_previsionnel);
      if (data.nombre_pages_estime !== undefined) arrayOptions.options_nombre_pages_estime = parseInt(data.nombre_pages_estime);
      if (data.exemplaires_sp !== undefined) arrayOptions.options_exemplaires_sp = parseInt(data.exemplaires_sp);
      if (data.date_signature !== undefined) arrayOptions.options_date_signature = toEpochDate(data.date_signature);
      if (data.editeur_signataire_nom !== undefined) arrayOptions.options_editeur_signataire_nom = (data.editeur_signataire_nom || '').trim();
      if (data.editeur_signataire_qualite !== undefined) arrayOptions.options_editeur_signataire_qualite = (data.editeur_signataire_qualite || '').trim();

      if (Object.keys(arrayOptions).length > 0) updates.array_options = arrayOptions;

      await adminApi.put(`/contracts/${id}`, updates);

      // Idem create : Dolibarr::update() n'enregistre pas model_pdf → on le persiste.
      if (updates.model_pdf) {
        try {
          await dolibarrPool.query('UPDATE llx_contrat SET model_pdf = ? WHERE rowid = ?', [updates.model_pdf, id]);
        } catch (modelErr) {
          console.warn('[CONTRACTS] Persist model_pdf (update) warning:', modelErr.message);
        }
      }

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'update_contract', `Contrat #${id} modifié`);

      res.json({ success: true });
    } catch (err) {
      console.error('Update contract error:', err.response?.data || err.message);
      const { status, body } = dolibarrError(err, 'Erreur modification contrat');
      res.status(status).json(body);
    }
  });

  // ═══════════════════════════════════════════════════════
  // VALIDATE CONTRACT
  // ═══════════════════════════════════════════════════════

  router.post('/:id/validate', authValidate, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Identifiant de contrat invalide' });

      // Garde de transition : seul un brouillon (statut 0) peut être validé.
      // Évite un appel Dolibarr inutile et clarifie l'erreur en cas de double-clic.
      const existing = await adminApi.get(`/contracts/${id}`);
      if (parseInt(existing.data.statut) !== 0) {
        return res.status(409).json({ error: 'Ce contrat n\'est pas un brouillon (déjà validé ou clôturé)' });
      }

      await adminApi.post(`/contracts/${id}/validate`);
      const detail = await adminApi.get(`/contracts/${id}`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'validate_contract', `Contrat ${detail.data.ref} validé`);

      // Génération automatique du document ODT+PDF juste après validation.
      // Bloquant (attendu avant la réponse) pour que le front trouve le document
      // dès le rechargement de la fiche. L'échec est logué mais ne fait pas échouer la validation.
      let docGenerated = false;
      try {
        await ensureContractModel(id);
        await rebuildContractDocument(id);
        docGenerated = true;
      } catch (genErr) {
        console.warn(`Auto-generate document after validate (contract ${id}):`, genErr.response?.data || genErr.message);
      }

      res.json({ success: true, ref: detail.data.ref, docGenerated });
    } catch (err) {
      console.error('Validate contract error:', err.response?.data || err.message);
      const { status, body } = dolibarrError(err, 'Erreur validation contrat');
      res.status(status).json(body);
    }
  });

  // ═══════════════════════════════════════════════════════
  // DELETE CONTRACT (draft only)
  // ═══════════════════════════════════════════════════════

  router.delete('/:id', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Identifiant de contrat invalide' });
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
      const { status, body } = dolibarrError(err, 'Erreur suppression contrat');
      res.status(status).json(body);
    }
  });

  // CLOSE CONTRACT
  // ═══════════════════════════════════════════════════════

  router.post('/:id/close', auth, csrfProtection, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Identifiant de contrat invalide' });

      // Garde de transition : seul un contrat actif (statut 1) peut être clôturé.
      const existing = await adminApi.get(`/contracts/${id}`);
      if (parseInt(existing.data.statut) !== 1) {
        return res.status(409).json({ error: 'Seul un contrat actif peut être clôturé' });
      }

      await adminApi.post(`/contracts/${id}/close`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'close_contract', `Contrat ${id} clôturé`);

      res.json({ success: true });
    } catch (err) {
      console.error('Close contract error:', err.response?.data || err.message);
      const { status, body } = dolibarrError(err, 'Erreur clôture contrat');
      res.status(status).json(body);
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

      // Utilise le transporter SMTP partagé (configuré dans index.js, respecte MAIL_FROM).
      if (!transporter) return res.status(503).json({ error: 'Service email indisponible' });

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
      // On loggue le détail Dolibarr côté serveur uniquement — jamais renvoyé au
      // client (évite la fuite de chemins/structure du module custom).
      console.error('Regenerate signed contract error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur régénération document' });
    }
  });

  // DOWNLOAD DOCUMENT
  // ═══════════════════════════════════════════════════════

  router.get('/:id/document', authValidate, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ error: 'Identifiant de contrat invalide' });

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
          await rebuildContractDocument(id);
        }
      } catch (autoErr) {
        console.warn('Auto-regenerate warning:', autoErr.response?.data || autoErr.message);
      }

      const pickDoc = (docs) =>
        docs.find(d => d.name.endsWith('.pdf')) || docs.find(d => d.name.endsWith('.odt')) || docs[0];

      let docs = await listContractDocuments(id);
      let doc = pickDoc(docs);

      // Aucun document encore généré (cas d'un contrat dont le PDF n'a jamais été
      // construit — Dolibarr::create n'enregistre pas model_pdf, donc la génération
      // n'a jamais eu lieu). On le construit à la volée puis on relit la liste.
      if (!doc) {
        try {
          const model = await ensureContractModel(id);
          if (!model) {
            return res.status(404).json({ error: 'Aucun modèle de document associé à ce contrat (type inconnu)' });
          }
          await rebuildContractDocument(id);
          docs = await listContractDocuments(id);
          doc = pickDoc(docs);
        } catch (genErr) {
          console.error('Contract document generation error:', genErr.response?.data || genErr.message);
          return res.status(502).json({ error: 'Le document n\'a pas pu être généré' });
        }
      }

      if (!doc) return res.status(404).json({ error: 'Aucun document trouvé' });

      const filePath = doc.level1name ? `${doc.level1name}/${doc.name}` : doc.relativename || doc.name;
      const dlRes = await adminApi.get('/documents/download', {
        params: { modulepart: 'contract', original_file: filePath },
      });

      const buffer = Buffer.from(dlRes.data.content, 'base64');
      const ext = (doc.name.split('.').pop() || '').toLowerCase();
      const MIME_BY_EXT = {
        pdf: 'application/pdf',
        odt: 'application/vnd.oasis.opendocument.text',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
      const mime = MIME_BY_EXT[ext] || 'application/octet-stream';

      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${doc.name}"`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin.username, 'download_contract', `Téléchargement ${doc.name}`);

      // Trace « document de contrat envoyé » sur la frise du manuscrit lié, une
      // seule fois : la route est appelée à chaque consultation du PDF, on ne
      // veut pas répéter l'évènement à chaque ouverture.
      try {
        const ms = db.prepare('SELECT id FROM manuscripts WHERE contract_id = ?').get(id);
        if (ms) {
          const already = db.prepare(
            "SELECT 1 FROM manuscript_stages WHERE manuscript_id = ? AND event = 'contract_doc_sent' LIMIT 1"
          ).get(ms.id);
          if (!already) {
            logManuscriptEvent(db, ms.id, 'contract_doc_sent',
              { role: req.admin?.role || 'admin', id: req.admin?.id, label: req.admin?.username },
              `Document ${doc.name}`);
          }
        }
      } catch (e) { console.warn('Manuscript event (contract_doc_sent) warning:', e.message); }

      res.send(buffer);
    } catch (err) {
      console.error('Contract document error:', err.response?.data || err.message);
      res.status(500).json({ error: 'Erreur téléchargement document' });
    }
  });

  // ═══════════════════════════════════════════════════════
  // SEARCH AUTHORS (thirdparties)
  // ═══════════════════════════════════════════════════════

  router.get('/thirdparties/search', authWrite, async (req, res) => {
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

  // CREATE AUTHOR (Dolibarr thirdparty) — inline depuis le wizard de contrat
  router.post('/thirdparties', authWrite, csrfProtection, async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const firstname = String(req.body.firstname || '').trim();
      const email = String(req.body.email || '').trim();
      const phone = String(req.body.phone || '').trim();
      const address = String(req.body.address || '').trim();

      // Un auteur est un particulier : nom + prénom + email OBLIGATOIRE (nécessaire
      // pour l'envoi du contrat à signer). Le téléphone reste optionnel.
      if (!email) return res.status(400).json({ error: "L'adresse email est obligatoire pour créer un auteur" });
      const vErr = validateTierIdentity({ name, firstname, email, phone, isCompany: false });
      if (vErr) return res.status(400).json({ error: vErr });

      // Doublon : on rapproche par identité fiable (email puis téléphone), JAMAIS
      // par le nom (patronymes communs = personnes distinctes). Si un tier actif
      // correspond, on le réutilise plutôt que d'en créer un doublon.
      try {
        const existing = await findExistingTier(dolibarrPool, { email, phone });
        if (existing) {
          return res.status(200).json({
            created: false,
            id: existing.id, name: existing.name, email: existing.email, phone: existing.phone,
            matchedBy: existing.matchedBy,
          });
        }
      } catch (dupErr) {
        console.warn('Thirdparty dedup check warning:', dupErr.message);
      }

      const createRes = await adminApi.post('/thirdparties', {
        name: buildTierName({ name, firstname, isCompany: false }),
        email: email || '',
        phone: phone || '',
        address: address || '',
        client: 1,
        code_client: -1,
        typent_id: TYPENT_PARTICULIER,
      });

      const newId = createRes.data;
      const detail = await adminApi.get(`/thirdparties/${newId}`);

      db.prepare('INSERT INTO admin_activity_log (admin_username, action, details) VALUES (?, ?, ?)')
        .run(req.admin?.username || 'unknown', 'contract_author_create', `#${detail.data.id} ${name}`);

      res.status(201).json({
        created: true,
        id: detail.data.id,
        name: detail.data.name || detail.data.nom,
        email: detail.data.email,
        phone: detail.data.phone,
      });
    } catch (err) {
      const status = err.response?.status;
      const dolErr = err.response?.data?.error?.message || err.response?.data?.message;
      console.error('Contract author create error:', dolErr || err.message);
      if (status === 409 || /already exists|exists already|déjà/i.test(dolErr || '')) {
        return res.status(409).json({ error: 'Un tiers avec ce nom existe déjà' });
      }
      res.status(500).json({ error: dolErr || 'Erreur création auteur' });
    }
  });

  return router;
}
