#!/usr/bin/env node
/**
 * Migration « workflow d'édition semi-automatique ».
 *
 * Fait passer le workflow manuscrit d'un mode entièrement automatisé (acteurs =
 * comptes admin_users connectés) à un mode semi-automatique (acteurs = carnet
 * d'intervenants notifiés par email, éditeur pilote unique).
 *
 * Étapes (idempotentes, exécutées dans UNE transaction) :
 *   1. Crée la table `intervenants`, `manuscript_file_tokens` et les colonnes
 *      `assigned_*_contact_id` sur `manuscripts`.
 *   2. Peuple le carnet (liste correcteurs historique + admin_users métier).
 *   3. Migre les affectations des manuscrits NON TERMINÉS : assigned_*_id (admin)
 *      → assigned_*_contact_id (carnet), via correspondance d'email.
 *   4. Désactive les comptes admin_users des 4 rôles métier (login impossible).
 *
 * En DRY-RUN, toute la transaction est annulée (ROLLBACK) : la base n'est pas
 * modifiée, seul le plan est affiché.
 *
 * Usage :
 *   node scripts/migrate-semi-auto.mjs            # dry-run (n'écrit rien)
 *   node scripts/migrate-semi-auto.mjs --apply    # applique réellement
 *
 * IMPORTANT : exécuter service Node ARRÊTÉ, après backup de newsletter.sqlite,
 * puis REDÉMARRER le service.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CORRECTEURS } from '../server/correcteurs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'newsletter.sqlite');
const APPLY = process.argv.includes('--apply');

const ACTOR_ROLES = ['evaluateur', 'correcteur', 'infographiste', 'imprimeur'];
// admin_users.assigned_*_id  →  { contact col, métier carnet }
const ROLE_MAP = [
  { admin: 'assigned_evaluator_id', contact: 'assigned_evaluator_contact_id', metier: 'evaluateur' },
  { admin: 'assigned_corrector_id', contact: 'assigned_corrector_contact_id', metier: 'correcteur' },
  { admin: 'assigned_infographist_id', contact: 'assigned_infographist_contact_id', metier: 'infographiste' },
  { admin: 'assigned_printer_id', contact: 'assigned_printer_contact_id', metier: 'imprimeur' },
];

const log = (...a) => console.log(...a);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

log(`\n=== Migration workflow semi-automatique (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
log(`DB: ${DB_PATH}\n`);

function ensureSchema() {
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
  for (const { contact } of ROLE_MAP) {
    try { db.exec(`ALTER TABLE manuscripts ADD COLUMN ${contact} INTEGER`); } catch (e) { void e; }
  }
}

function seedCarnet() {
  const existsByEmailMetier = db.prepare('SELECT id FROM intervenants WHERE LOWER(email) = LOWER(?) AND metier = ?');
  const insert = db.prepare('INSERT INTO intervenants (nom, email, metier, is_active) VALUES (?, ?, ?, 1)');
  let added = 0;
  for (const c of CORRECTEURS) {
    if (!c.email) continue;
    if (!existsByEmailMetier.get(c.email, 'correcteur')) { insert.run(c.name, c.email, 'correcteur'); added++; }
  }
  let legacy = [];
  try {
    legacy = db.prepare(
      `SELECT username, email, role FROM admin_users
       WHERE role IN ('evaluateur','correcteur','infographiste','imprimeur')
         AND email IS NOT NULL AND TRIM(email) <> ''`
    ).all();
  } catch (e) { void e; }
  for (const u of legacy) {
    if (!existsByEmailMetier.get(u.email, u.role)) { insert.run(u.username, u.email, u.role); added++; }
  }
  return added;
}

function migrateAssignments() {
  const manuscripts = db.prepare(
    `SELECT * FROM manuscripts WHERE current_stage NOT IN ('printed','evaluation_negative')`
  ).all();
  const findIntervenant = db.prepare('SELECT id FROM intervenants WHERE LOWER(email) = LOWER(?) AND metier = ?');
  const updates = [];
  let skipped = 0;
  for (const m of manuscripts) {
    for (const { admin, contact, metier } of ROLE_MAP) {
      if (!m[admin] || m[contact]) continue;
      const au = db.prepare('SELECT email FROM admin_users WHERE id = ?').get(m[admin]);
      if (!au?.email) { skipped++; continue; }
      const inter = findIntervenant.get(au.email, metier);
      if (!inter) { skipped++; continue; }
      db.prepare(`UPDATE manuscripts SET ${contact} = ? WHERE id = ?`).run(inter.id, m.id);
      updates.push({ ref: m.ref, contact, value: inter.id });
    }
  }
  return { updates, skipped };
}

function deactivateAccounts() {
  const targets = db.prepare(
    `SELECT id, username, role FROM admin_users WHERE role IN (${ACTOR_ROLES.map(() => '?').join(',')}) AND is_active = 1`
  ).all(...ACTOR_ROLES);
  db.prepare(
    `UPDATE admin_users SET is_active = 0, session_token = NULL, session_expires_at = NULL
     WHERE role IN (${ACTOR_ROLES.map(() => '?').join(',')})`
  ).run(...ACTOR_ROLES);
  return targets;
}

try {
  db.exec('BEGIN');

  ensureSchema();
  const beforeCarnet = db.prepare('SELECT COUNT(*) AS c FROM intervenants').get().c;
  const added = seedCarnet();
  const afterCarnet = db.prepare('SELECT COUNT(*) AS c FROM intervenants').get().c;
  log(`[1] Schéma : tables + colonnes assigned_*_contact_id en place.`);
  log(`[2] Carnet : ${added} intervenant(s) ajouté(s) (avant ${beforeCarnet} → après ${afterCarnet}).`);

  const { updates, skipped } = migrateAssignments();
  log(`[3] Affectations migrées : ${updates.length} (non résolues : ${skipped}).`);
  for (const u of updates.slice(0, 20)) log(`     - ${u.ref}: ${u.contact} → intervenant #${u.value}`);
  if (updates.length > 20) log(`     … (+${updates.length - 20})`);

  const deactivated = deactivateAccounts();
  log(`[4] Comptes acteurs désactivés : ${deactivated.length}.`);
  for (const u of deactivated) log(`     - ${u.username} (${u.role})`);

  if (APPLY) {
    db.exec('COMMIT');
    log('\n✓ Migration APPLIQUÉE. Redémarrez le service Node.\n');
  } else {
    db.exec('ROLLBACK');
    log('\n(DRY-RUN) Transaction annulée — aucune écriture. Relancer avec --apply pour appliquer.\n');
  }
} catch (err) {
  try { db.exec('ROLLBACK'); } catch (e) { void e; }
  console.error('\n✗ Erreur migration :', err.message);
  process.exitCode = 1;
} finally {
  db.close();
}
