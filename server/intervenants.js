/**
 * Carnet d'intervenants éditoriaux (workflow « semi-automatique »).
 *
 * Les acteurs métier du workflow manuscrit (évaluateur/lecteur, correcteur,
 * infographiste, imprimeur) ne disposent PLUS de compte connectable. Ils sont
 * désormais de simples contacts d'un carnet d'adresses : on les affecte à un
 * manuscrit et on les NOTIFIE PAR EMAIL (avec un lien de téléchargement sécurisé).
 * C'est l'éditeur interne qui pilote le workflow dans l'application.
 *
 * Ce module remplace l'ancien `correcteurs.js` (qui créait des `admin_users`
 * désactivés). La liste statique historique y est réimportée pour le seed.
 */

import { CORRECTEURS } from './correcteurs.js';

// Métiers gérés par le carnet (acteurs externes notifiés par email, sans compte).
// « infographiste » a été retiré : la couverture est désormais conçue en interne
// par la Production éditoriale (fusion Éditeur/Infographiste). Les intervenants
// infographistes déjà en base restent valides (contrainte CHECK inchangée) pour
// l'historique des anciens manuscrits.
export const INTERVENANT_METIERS = ['evaluateur', 'correcteur', 'imprimeur'];

/**
 * Crée la table `intervenants` si absente. À appeler une fois au démarrage.
 * @param {*} db better-sqlite3
 */
export function ensureIntervenantsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS intervenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    email TEXT NOT NULL,
    metier TEXT NOT NULL CHECK (metier IN ('evaluateur','correcteur','infographiste','imprimeur')),
    is_active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_intervenants_metier ON intervenants(metier, is_active)'); } catch (e) { void e; }
}

/**
 * Peuple le carnet à partir des données héritées, de façon idempotente :
 *  1. la liste statique `CORRECTEURS` (metier = correcteur) ;
 *  2. les comptes `admin_users` des 4 rôles métier ayant un email.
 * Déduplication par couple (email, metier) — on ne crée jamais de doublon.
 * @param {*} db better-sqlite3
 */
export function seedIntervenants(db) {
  const existsByEmailMetier = db.prepare(
    'SELECT id FROM intervenants WHERE LOWER(email) = LOWER(?) AND metier = ?'
  );
  const insert = db.prepare(
    'INSERT INTO intervenants (nom, email, metier, is_active) VALUES (?, ?, ?, 1)'
  );

  const tx = db.transaction(() => {
    // 1. Liste historique des correcteurs.
    for (const c of CORRECTEURS) {
      if (!c.email) continue;
      if (!existsByEmailMetier.get(c.email, 'correcteur')) {
        insert.run(c.name, c.email, 'correcteur');
      }
    }

    // 2. Anciens comptes admin_users des 4 rôles métier (avec email connu).
    let legacy = [];
    try {
      legacy = db.prepare(
        `SELECT username, email, role FROM admin_users
         WHERE role IN ('evaluateur','correcteur','infographiste','imprimeur')
           AND email IS NOT NULL AND TRIM(email) <> ''`
      ).all();
    } catch (e) { void e; /* table/colonne absente sur très vieilles bases */ }
    for (const u of legacy) {
      if (!existsByEmailMetier.get(u.email, u.role)) {
        insert.run(u.username, u.email, u.role);
      }
    }
  });
  tx();
}
