/**
 * Versionnage du fichier manuscrit — chaîne de versions sans doublons.
 *
 * Problème adressé : les allers-retours direction ↔ auteur se faisaient par
 * email ; les versions révisées ne rentraient pas dans le système (fichier
 * courant périmé) ou s'accumulaient en doublons. Ici :
 *   • une seule chaîne de versions par kind (le texte = kind 'original') —
 *     chaque dépôt est la version N+1, jamais un fichier « à côté » ;
 *   • anti-doublon par empreinte SHA-256 (re-dépôt du même fichier refusé) ;
 *   • rétention automatique : on garde sur disque la v1 (soumission), les
 *     2 dernières versions et les versions jalon/définitive ; les binaires
 *     intermédiaires sont purgés (la ligne garde métadonnées + empreinte,
 *     la frise reste complète) ;
 *   • version définitive (is_final) : la chaîne est verrouillée, plus aucun
 *     dépôt possible sans déverrouillage par un admin ;
 *   • dépôt auteur par lien tokenisé (sans connexion) : la direction demande
 *     une révision, l'auteur reçoit un lien où télécharger la version courante
 *     et déposer sa version révisée. Même principe de hash que les tokens de
 *     téléchargement intervenants (manuscript-file-tokens.js).
 */

import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { existsSync, mkdirSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { logManuscriptEvent, STAGE_LABELS } from './manuscript-workflow.js';
import { sendManuscriptDepositEmail } from './manuscript-emails.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANUSCRIPTS_DIR = join(__dirname, '..', 'manuscripts');

// Kinds soumis à la rétention automatique (chaînes de texte qui s'allongent au
// fil des allers-retours). Les autres kinds (couverture, BAT, print_ready…)
// restent intégralement sur disque : peu de versions, fichiers de production.
const RETENTION_KINDS = ['original', 'correction'];
// Versions conservées sur disque en plus de la v1 et des jalons/définitive.
const KEEP_LATEST = 2;

// ─── SCHÉMA ─────────────────────────────────────────────────
export function ensureVersioningSchema(db) {
  // SQLite ne connaît pas ADD COLUMN IF NOT EXISTS : try/catch par colonne.
  const columns = [
    "ALTER TABLE manuscript_files ADD COLUMN sha256 TEXT",
    "ALTER TABLE manuscript_files ADD COLUMN note TEXT",
    "ALTER TABLE manuscript_files ADD COLUMN is_milestone INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE manuscript_files ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE manuscript_files ADD COLUMN binary_purged INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of columns) {
    try { db.exec(sql); } catch (e) { void e; /* colonne déjà présente */ }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_deposit_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    manuscript_id INTEGER NOT NULL,
    created_by_id INTEGER,
    message TEXT,
    expires_at DATETIME NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 3,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_deposit_tokens_hash ON manuscript_deposit_tokens(token_hash)'); } catch (e) { void e; }
}

// ─── EMPREINTE & DÉDUP ──────────────────────────────────────
export function sha256File(path) {
  try {
    return crypto.createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (e) {
    console.warn('[VERSIONS] sha256 error:', e.message);
    return null;
  }
}

/** Dernière version (toute disponibilité) d'une chaîne. */
export function latestVersion(db, manuscriptId, kind = 'original') {
  return db.prepare(
    `SELECT * FROM manuscript_files WHERE manuscript_id = ? AND kind = ?
     ORDER BY version DESC, id DESC LIMIT 1`
  ).get(manuscriptId, kind);
}

/** Dernière version dont le binaire est encore téléchargeable. */
export function latestAvailableVersion(db, manuscriptId, kind = 'original') {
  const rows = db.prepare(
    `SELECT * FROM manuscript_files WHERE manuscript_id = ? AND kind = ?
       AND (binary_purged IS NULL OR binary_purged = 0)
     ORDER BY version DESC, id DESC`
  ).all(manuscriptId, kind);
  return rows.find((r) => r.external_url || (r.file_path && existsSync(r.file_path))) || null;
}

/** Version marquée définitive sur la chaîne du manuscrit (verrouille les dépôts). */
export function getFinalVersion(db, manuscriptId, kind = 'original') {
  return db.prepare(
    `SELECT * FROM manuscript_files WHERE manuscript_id = ? AND kind = ? AND is_final = 1
     ORDER BY version DESC, id DESC LIMIT 1`
  ).get(manuscriptId, kind);
}

// ─── RÉTENTION ──────────────────────────────────────────────
/**
 * Purge les binaires des versions intermédiaires d'une chaîne. Conservés sur
 * disque : la v1 (soumission d'origine), les KEEP_LATEST dernières versions,
 * les jalons et la définitive. Les lignes purgées restent en base (métadonnées
 * + empreinte SHA-256) : la frise et l'audit ne perdent rien.
 * Un binaire partagé par une autre ligne non purgée (ex. author_final promu
 * depuis correction, même file_path) n'est jamais supprimé.
 * @returns {number} binaires purgés
 */
export function purgeObsoleteBinaries(db, manuscriptId, kind) {
  if (!RETENTION_KINDS.includes(kind)) return 0;
  const rows = db.prepare(
    `SELECT * FROM manuscript_files WHERE manuscript_id = ? AND kind = ?
       AND external_url IS NULL AND (binary_purged IS NULL OR binary_purged = 0)
     ORDER BY version DESC, id DESC`
  ).all(manuscriptId, kind);
  let purged = 0;
  rows.forEach((r, i) => {
    if (i < KEEP_LATEST || r.version === 1 || r.is_milestone || r.is_final) return;
    if (r.file_path) {
      const shared = db.prepare(
        `SELECT 1 FROM manuscript_files WHERE file_path = ? AND id <> ?
           AND (binary_purged IS NULL OR binary_purged = 0) LIMIT 1`
      ).get(r.file_path, r.id);
      if (shared) return; // binaire encore référencé ailleurs : on n'y touche pas
      if (existsSync(r.file_path)) {
        try { unlinkSync(r.file_path); } catch (e) {
          console.warn('[VERSIONS] purge unlink error:', e.message);
          return;
        }
      }
    }
    db.prepare('UPDATE manuscript_files SET binary_purged = 1 WHERE id = ?').run(r.id);
    purged += 1;
  });
  if (purged) console.log(`[VERSIONS] ${purged} binaire(s) obsolète(s) purgé(s) (manuscrit #${manuscriptId}, ${kind})`);
  return purged;
}

// ─── DÉPÔT D'UNE NOUVELLE VERSION ───────────────────────────
/**
 * Enregistre une nouvelle version d'une chaîne (par défaut le texte du
 * manuscrit, kind 'original') : empreinte, anti-doublon, insertion, frise,
 * purge de rétention. Lève une erreur code DUPLICATE_VERSION si le fichier est
 * identique à la version courante (le fichier uploadé est alors supprimé).
 *
 * @param {*} db better-sqlite3
 * @param {{ manuscriptId:number, kind?:string, file:{path,originalname,size,mimetype},
 *           actor:{role,id,label}, uploadedByRole?:string, uploadedById?:number,
 *           note?:string|null, eventNote?:string|((version:number)=>string)|null }} opts
 * @returns {{ id:number, version:number }}
 */
export function addManuscriptVersion(db, {
  manuscriptId, kind = 'original', file, actor,
  uploadedByRole = null, uploadedById = null, note = null, eventNote = null,
}) {
  const hash = sha256File(file.path);
  const latest = latestVersion(db, manuscriptId, kind);
  if (hash && latest?.sha256 && latest.sha256 === hash) {
    try { unlinkSync(file.path); } catch (e) { void e; }
    const err = new Error(`Ce fichier est identique à la version actuelle (v${latest.version}) — dépôt ignoré.`);
    err.code = 'DUPLICATE_VERSION';
    throw err;
  }
  const version = (latest?.version || 0) + 1;
  const info = db.prepare(
    `INSERT INTO manuscript_files
       (manuscript_id, kind, version, file_path, file_name, file_size, mime_type,
        uploaded_by_role, uploaded_by_id, sha256, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    manuscriptId, kind, version,
    file.path, file.originalname || 'fichier', file.size || null, file.mimetype || null,
    uploadedByRole || actor?.role || 'system', uploadedById ?? actor?.id ?? null,
    hash, note,
  );
  const resolvedEventNote = typeof eventNote === 'function' ? eventNote(version) : eventNote;
  logManuscriptEvent(db, manuscriptId, 'file_uploaded', actor,
    resolvedEventNote || `Manuscrit v${version} — ${file.originalname}${note ? ` · ${note}` : ''}`);
  purgeObsoleteBinaries(db, manuscriptId, kind);
  return { id: info.lastInsertRowid, version };
}

// ─── TOKENS DE DÉPÔT AUTEUR ─────────────────────────────────
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Crée un lien de dépôt pour l'auteur (révoque au passage les liens encore
 * actifs du manuscrit : un seul lien vivant à la fois, celui du dernier email).
 * @returns {string} token brut (à mettre dans l'URL)
 */
export function createDepositToken(db, { manuscriptId, createdById = null, message = null, ttlDays = 14, maxUses = 3 }) {
  revokeDepositTokens(db, manuscriptId);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO manuscript_deposit_tokens
       (token_hash, manuscript_id, created_by_id, message, expires_at, max_uses)
     VALUES (?, ?, ?, ?, datetime('now', ?), ?)`
  ).run(hashToken(token), manuscriptId, createdById, message, `+${ttlDays} days`, maxUses);
  return token;
}

/** Révoque les liens de dépôt actifs d'un manuscrit (marquage définitif, nouveau lien…). */
export function revokeDepositTokens(db, manuscriptId) {
  const r = db.prepare(
    `UPDATE manuscript_deposit_tokens SET expires_at = datetime('now')
     WHERE manuscript_id = ? AND expires_at > datetime('now')`
  ).run(manuscriptId);
  return r.changes;
}

/** Lien de dépôt encore actif d'un manuscrit (pour l'affichage fiche admin). */
export function getActiveDepositToken(db, manuscriptId) {
  return db.prepare(
    `SELECT id, manuscript_id, message, expires_at, max_uses, used_count, created_at
     FROM manuscript_deposit_tokens
     WHERE manuscript_id = ? AND expires_at > datetime('now') AND used_count < max_uses
     ORDER BY id DESC LIMIT 1`
  ).get(manuscriptId);
}

// ─── ROUTER PUBLIC DE DÉPÔT (auteur, sans connexion) ────────
const DEPOSIT_PATTERN = /\.(pdf|doc|docx|odt|rtf)$/i;
const DEPOSIT_SIZE_MB = 20;

const depositUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const id = String(req.depositManuscript?.id || '');
      // Anti path traversal : id strictement numérique (cf. createManuscriptMulter).
      if (!/^\d+$/.test(id)) return cb(new Error('Lien de dépôt invalide'));
      const dir = join(MANUSCRIPTS_DIR, id, 'original');
      try { mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'fichier').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: DEPOSIT_SIZE_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, DEPOSIT_PATTERN.test(file.originalname || '')),
});

/**
 * Router PUBLIC (sans authentification, rate-limité) pour le dépôt auteur par
 * lien tokenisé. À monter hors /api/admin (ex: /api/deposit).
 */
export function createDepositRouter({ db, downloadLimiter, uploadLimiter, csrfProtection, transporter, siteUrl }) {
  const router = Router();

  // Résout le token → req.depositToken / req.depositManuscript, ou 410.
  const resolveToken = (req, res, next) => {
    const row = db.prepare(
      `SELECT * FROM manuscript_deposit_tokens
       WHERE token_hash = ? AND expires_at > datetime('now')`
    ).get(hashToken(req.params.token));
    if (!row) {
      return res.status(410).json({ error: 'Lien de dépôt expiré ou invalide. Contactez la maison d\'édition pour recevoir un nouveau lien.' });
    }
    const manuscript = db.prepare(
      `SELECT m.*, a.firstname || ' ' || a.lastname AS author_name, a.email AS author_email
       FROM manuscripts m JOIN authors a ON a.id = m.author_id WHERE m.id = ?`
    ).get(row.manuscript_id);
    if (!manuscript) return res.status(404).json({ error: 'Manuscrit introuvable' });
    req.depositToken = row;
    req.depositManuscript = manuscript;
    next();
  };

  // Infos affichées sur la page publique de dépôt.
  router.get('/:token', downloadLimiter, resolveToken, (req, res) => {
    const m = req.depositManuscript;
    const t = req.depositToken;
    const current = latestAvailableVersion(db, m.id, 'original');
    const final = getFinalVersion(db, m.id, 'original');
    res.json({
      manuscript: {
        ref: m.ref,
        title: m.title,
        subtitle: m.subtitle || null,
        author_name: m.author_name,
        stage_label: STAGE_LABELS[m.current_stage] || m.current_stage,
      },
      message: t.message || null,
      current: current ? {
        version: current.version,
        file_name: current.file_name,
        file_size: current.file_size,
        uploaded_at: current.uploaded_at,
      } : null,
      locked: !!final,
      remaining_uploads: Math.max(0, t.max_uses - t.used_count),
      expires_at: t.expires_at,
      max_mb: DEPOSIT_SIZE_MB,
    });
  });

  // Téléchargement de la version courante (pour travailler sur la bonne base).
  router.get('/:token/download', downloadLimiter, resolveToken, (req, res) => {
    const current = latestAvailableVersion(db, req.depositManuscript.id, 'original');
    if (!current) return res.status(404).json({ error: 'Aucun fichier téléchargeable' });
    if (current.external_url) return res.redirect(current.external_url);
    res.download(current.file_path, current.file_name);
  });

  // Dépôt de la version révisée : nouvelle version de la chaîne 'original'.
  router.post('/:token/upload',
    ...(uploadLimiter ? [uploadLimiter] : []),
    ...(csrfProtection ? [csrfProtection] : []),
    resolveToken,
    (req, res, next) => {
      if (req.depositToken.used_count >= req.depositToken.max_uses) {
        return res.status(410).json({ error: 'Ce lien a atteint son nombre maximum de dépôts. Contactez la maison d\'édition.' });
      }
      if (getFinalVersion(db, req.depositManuscript.id, 'original')) {
        return res.status(409).json({ error: 'La version définitive de ce manuscrit a été arrêtée : plus aucun dépôt n\'est possible.' });
      }
      depositUpload.single('file')(req, res, (err) => {
        if (!err) return next();
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `Fichier trop volumineux (max ${DEPOSIT_SIZE_MB} Mo)`
          : (err.message || 'Fichier invalide');
        return res.status(400).json({ error: msg });
      });
    },
    (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'Fichier requis (PDF, DOC, DOCX, ODT ou RTF)' });
      const m = req.depositManuscript;
      const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
      const actor = { role: 'author', id: m.author_id, label: m.author_name };
      let result;
      try {
        result = addManuscriptVersion(db, {
          manuscriptId: m.id,
          file: req.file,
          actor,
          uploadedByRole: 'author',
          uploadedById: m.author_id,
          note,
          eventNote: (v) => `Manuscrit v${v} déposé par l'auteur via le lien de révision — ${req.file.originalname}${note ? ` · ${note}` : ''}`,
        });
      } catch (err) {
        if (err.code === 'DUPLICATE_VERSION') return res.status(409).json({ error: err.message });
        console.error('[VERSIONS] deposit error:', err.message);
        return res.status(500).json({ error: 'Erreur lors du dépôt' });
      }
      db.prepare('UPDATE manuscript_deposit_tokens SET used_count = used_count + 1 WHERE id = ?').run(req.depositToken.id);

      // Notifier la direction : l'email remplace l'aller-retour de pièces jointes.
      try {
        const adminEmail = global.__siteConfigFallback?.contact?.emails?.[0];
        if (transporter && adminEmail) {
          sendManuscriptDepositEmail(transporter, m, {
            by: m.author_name,
            version: result.version,
            fileName: req.file.originalname,
            note,
          }, adminEmail, siteUrl);
        }
      } catch (err) { console.warn('[VERSIONS] deposit notify error:', err.message); }

      res.json({ success: true, version: result.version });
    });

  return router;
}
