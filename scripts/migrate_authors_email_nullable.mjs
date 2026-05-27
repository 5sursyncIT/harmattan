#!/usr/bin/env node
/**
 * Migration : authors.email NOT NULL → NULLABLE.
 *
 * Permet de "supprimer" les emails placeholder @senharmattan.local
 * sans forcer une valeur factice. SQLite ne supporte pas ALTER COLUMN,
 * on doit recréer la table.
 *
 * Effets :
 *  - Recrée la table authors avec email TEXT UNIQUE (sans NOT NULL)
 *  - Copie toutes les données existantes
 *  - Restaure l'index unique sur slug
 *  - UPDATE: tous les emails @senharmattan.local → NULL
 *
 * Usage :
 *   node scripts/migrate_authors_email_nullable.mjs --dry-run
 *   node scripts/migrate_authors_email_nullable.mjs --apply
 */

import 'dotenv/config';
import Db from 'better-sqlite3';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run');
if (!apply && !dryRun) {
  console.error('Usage: --dry-run | --apply');
  process.exit(1);
}

const PATH = '/var/www/html/senharmattan-shop/newsletter.sqlite';
const PLACEHOLDER = '%@senharmattan.local';

const db = new Db(PATH, { readonly: !apply });

const before = db.prepare(`SELECT COUNT(*) AS n FROM authors`).get().n;
const placeholders = db.prepare(`SELECT COUNT(*) AS n FROM authors WHERE email LIKE ?`).get(PLACEHOLDER).n;
const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='authors'`).get().sql;

console.log('Avant migration :');
console.log('  Auteurs total            :', before);
console.log('  Avec email placeholder   :', placeholders);
console.log('  Schéma actuel détecté    :', schema.includes('NOT NULL') ? 'email NOT NULL' : 'email déjà NULLABLE');
console.log();

if (!schema.includes('email TEXT UNIQUE NOT NULL')) {
  console.log('La table semble déjà migrée (email NULLABLE). Rien à faire pour le schéma.');
  if (apply && placeholders > 0) {
    const r = db.prepare(`UPDATE authors SET email = NULL WHERE email LIKE ?`).run(PLACEHOLDER);
    console.log(`✓ ${r.changes} emails placeholder remis à NULL.`);
  }
  process.exit(0);
}

if (!apply) {
  console.log('Dry-run — ce qui serait fait avec --apply :');
  console.log('  1. CREATE TABLE authors_new (... email TEXT UNIQUE, sans NOT NULL ...)');
  console.log('  2. INSERT INTO authors_new SELECT * FROM authors');
  console.log('  3. DROP TABLE authors');
  console.log('  4. ALTER TABLE authors_new RENAME TO authors');
  console.log('  5. CREATE UNIQUE INDEX idx_authors_slug ON authors(slug) WHERE slug IS NOT NULL');
  console.log(`  6. UPDATE authors SET email = NULL WHERE email LIKE '${PLACEHOLDER}'  (${placeholders} rows)`);
  process.exit(0);
}

// ─── Apply ───
console.log('Application de la migration…');
db.exec('PRAGMA foreign_keys = OFF');

const migrate = db.transaction(() => {
  // 1. Crée la nouvelle table (mêmes colonnes, email TEXT UNIQUE sans NOT NULL)
  db.exec(`
    CREATE TABLE authors_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      firstname TEXT NOT NULL,
      lastname TEXT NOT NULL,
      phone TEXT,
      dolibarr_thirdparty_id INTEGER,
      email_verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      notification_prefs TEXT,
      bio TEXT,
      slug TEXT,
      display_name TEXT,
      photo_url TEXT,
      website TEXT,
      social_twitter TEXT,
      social_instagram TEXT,
      social_linkedin TEXT,
      social_facebook TEXT,
      public_listed INTEGER NOT NULL DEFAULT 0
    )
  `);

  // 2. Copie les données
  db.exec(`
    INSERT INTO authors_new (
      id, email, password, firstname, lastname, phone, dolibarr_thirdparty_id,
      email_verified, created_at, notification_prefs, bio, slug, display_name,
      photo_url, website, social_twitter, social_instagram, social_linkedin,
      social_facebook, public_listed
    )
    SELECT id, email, password, firstname, lastname, phone, dolibarr_thirdparty_id,
           email_verified, created_at, notification_prefs, bio, slug, display_name,
           photo_url, website, social_twitter, social_instagram, social_linkedin,
           social_facebook, public_listed
    FROM authors
  `);

  // 3. Swap les tables
  db.exec(`DROP TABLE authors`);
  db.exec(`ALTER TABLE authors_new RENAME TO authors`);

  // 4. Restaure l'index unique partiel sur slug
  db.exec(`CREATE UNIQUE INDEX idx_authors_slug ON authors(slug) WHERE slug IS NOT NULL`);

  // 5. Mise à NULL des placeholders
  const r = db.prepare(`UPDATE authors SET email = NULL WHERE email LIKE ?`).run(PLACEHOLDER);
  return r.changes;
});

const nNulled = migrate();
db.exec('PRAGMA foreign_keys = ON');

const after = db.prepare(`SELECT COUNT(*) AS n FROM authors`).get().n;
const stillPlaceholders = db.prepare(`SELECT COUNT(*) AS n FROM authors WHERE email LIKE ?`).get(PLACEHOLDER).n;
const withNull = db.prepare(`SELECT COUNT(*) AS n FROM authors WHERE email IS NULL`).get().n;

console.log('\n✓ Migration terminée.');
console.log('  Auteurs total            :', after, before === after ? '(inchangé)' : `(était ${before})`);
console.log('  Emails remis à NULL      :', nNulled);
console.log('  Placeholders restants    :', stillPlaceholders, stillPlaceholders === 0 ? '✓' : '⚠');
console.log('  Auteurs sans email (NULL):', withNull);
console.log('\nL\'UI affichera "—" pour ces auteurs et le bouton "Réinit MDP" sera désactivé tant qu\'aucun email n\'a été saisi.');
