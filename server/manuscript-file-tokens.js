/**
 * Liens de téléchargement sécurisés pour les intervenants externes.
 *
 * Les acteurs du workflow (correcteur, infographiste, imprimeur, évaluateur)
 * n'ayant plus de compte, ils reçoivent par email un lien tokenisé à usage et
 * durée limités pour récupérer le fichier à traiter. On ne stocke que le HASH
 * du token (même principe que les sessions et les password-resets) : en cas de
 * fuite de la base, les tokens ne sont pas rejouables.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { existsSync } from 'fs';

// Fichier que l'intervenant doit récupérer selon l'étape atteinte, par ordre de
// préférence (on prend le dernier fichier disponible du premier kind trouvé).
const ACTOR_FILE_KINDS = {
  in_evaluation: ['original'],
  in_correction: ['correction', 'original'],
  cover_design: ['author_final', 'correction', 'original'],
  printing: ['print_ready', 'bat_cover', 'author_final'],
};

export function ensureFileTokensSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS manuscript_file_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    manuscript_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    intervenant_id INTEGER,
    expires_at DATETIME NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 5,
    used_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_file_tokens_hash ON manuscript_file_tokens(token_hash)'); } catch (e) { void e; }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Sélectionne le fichier le plus pertinent à transmettre à l'intervenant pour
 * l'étape `toStage`. Retourne la ligne `manuscript_files` ou null.
 */
export function pickFileForActor(db, manuscriptId, toStage) {
  const kinds = ACTOR_FILE_KINDS[toStage];
  if (!kinds) return null;
  for (const kind of kinds) {
    const file = db.prepare(
      `SELECT * FROM manuscript_files WHERE manuscript_id = ? AND kind = ?
       ORDER BY version DESC, uploaded_at DESC LIMIT 1`
    ).get(manuscriptId, kind);
    if (file) return file;
  }
  return null;
}

/**
 * Crée un token de téléchargement et renvoie le token brut (à mettre dans l'URL).
 * @returns {string} token brut
 */
export function createFileToken(db, { manuscriptId, fileId, intervenantId = null, ttlHours = 168, maxUses = 5 }) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO manuscript_file_tokens
       (token_hash, manuscript_id, file_id, intervenant_id, expires_at, max_uses)
     VALUES (?, ?, ?, ?, datetime('now', ?), ?)`
  ).run(hashToken(token), manuscriptId, fileId, intervenantId, `+${ttlHours} hours`, maxUses);
  return token;
}

/**
 * Router PUBLIC (sans authentification) pour le téléchargement par lien tokenisé.
 * À monter sur un préfixe hors `/api/admin` (ex: `/api/files`) et à rate-limiter.
 */
export function createPublicFileRouter({ db, limiter }) {
  const router = Router();
  const mws = limiter ? [limiter] : [];

  router.get('/manuscript/:token/download', ...mws, (req, res) => {
    const row = db.prepare(
      `SELECT * FROM manuscript_file_tokens
       WHERE token_hash = ? AND expires_at > datetime('now') AND used_count < max_uses`
    ).get(hashToken(req.params.token));
    if (!row) {
      return res.status(410).json({ error: 'Lien expiré ou invalide. Demandez un nouveau lien à l\'éditeur.' });
    }
    const file = db.prepare('SELECT * FROM manuscript_files WHERE id = ?').get(row.file_id);
    if (!file || !existsSync(file.file_path)) {
      return res.status(404).json({ error: 'Fichier introuvable sur le serveur' });
    }
    db.prepare('UPDATE manuscript_file_tokens SET used_count = used_count + 1 WHERE id = ?').run(row.id);
    res.download(file.file_path, file.file_name);
  });

  return router;
}
