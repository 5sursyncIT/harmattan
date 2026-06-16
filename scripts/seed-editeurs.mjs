/**
 * Création des comptes « Éditeur » (fabricants / éditeurs) transmis par la direction.
 *
 * Idempotent : un compte déjà présent (même username OU même email, insensible à
 * la casse) est ignoré — JAMAIS écrasé. Réplique exactement la logique de la route
 * POST /api/admin/users : bcrypt 12 tours, role=editor, must_change_password=1.
 *
 * Un snapshot cohérent de la base est pris avant toute écriture.
 * Usage :  node scripts/seed-editeurs.mjs           (dry-run, n'écrit rien)
 *          node scripts/seed-editeurs.mjs --apply    (crée réellement)
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, '..', 'newsletter.sqlite');
const APPLY = process.argv.includes('--apply');

// Les 4 comptes à créer (les 2 déjà existants — Issa Ndiaye/Comptable, Abdoulaye
// Diallo/Admin — sont volontairement EXCLUS sur décision de la direction).
const EDITEURS = [
  { username: 'bachir.coly',  nom: 'Bachir Coly',      email: 'bachir.coly@senharmattan.com' },
  { username: 'birame.diop',  nom: 'Mame Birame Diop', email: 'biramame.harmattan@gmail.com' },
  { username: 'dame.bathily', nom: 'Dame Bathily',     email: 'dame.harmattan@gmail.com' },
  { username: 'sally.coly',   nom: 'Mme Sally Coly',   email: 'colysalimatou4@gmail.com' },
];

// Mot de passe temporaire conforme à la politique (>=8, 1 majuscule, 1 chiffre).
function genTempPassword() {
  const rand = crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x');
  return 'E' + rand + (10 + crypto.randomInt(89)); // 'E' (maj) + alphanum + 2 chiffres
}

const db = new Database(dbPath);
const findByUser  = db.prepare('SELECT id, username, role FROM admin_users WHERE LOWER(username) = LOWER(?)');
const findByEmail = db.prepare('SELECT id, username, role FROM admin_users WHERE email IS NOT NULL AND LOWER(email) = LOWER(?)');
const insert = db.prepare(
  "INSERT INTO admin_users (username, password, role, email, is_active, must_change_password, password_changed_at) " +
  "VALUES (?, ?, 'editor', ?, 1, 1, datetime('now'))"
);

// Snapshot cohérent avant écriture.
if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snap = `${dbPath}.bak-editeurs-${stamp}`;
  try { db.exec(`VACUUM INTO '${snap}'`); console.log(`📦 Snapshot base : ${snap}\n`); }
  catch (e) { console.error('⚠️  Snapshot échoué (on continue) :', e.message); }
}

const created = [];
const skipped = [];
for (const u of EDITEURS) {
  const clashUser = findByUser.get(u.username);
  const clashEmail = findByEmail.get(u.email);
  if (clashUser || clashEmail) {
    const c = clashUser || clashEmail;
    skipped.push({ ...u, reason: `existe déjà → #${c.id} ${c.username} (${c.role})` });
    continue;
  }
  const pwd = genTempPassword();
  if (APPLY) {
    const r = insert.run(u.username, bcrypt.hashSync(pwd, 12), u.email);
    created.push({ ...u, id: r.lastInsertRowid, password: pwd });
  } else {
    created.push({ ...u, id: '(dry-run)', password: pwd });
  }
}

console.log(APPLY ? '✅ COMPTES CRÉÉS (rôle Éditeur, mot de passe à changer à la 1ʳᵉ connexion) :' : '🔎 DRY-RUN — seraient créés :');
for (const c of created) {
  console.log(`   #${c.id}  ${c.username.padEnd(14)} | ${c.email.padEnd(34)} | mdp temporaire : ${c.password}`);
}
if (skipped.length) {
  console.log('\n⏭️  IGNORÉS (non écrasés) :');
  for (const s of skipped) console.log(`   ${s.nom.padEnd(18)} | ${s.email.padEnd(34)} | ${s.reason}`);
}
if (!APPLY) console.log('\n(Aucune écriture. Relancer avec --apply pour créer réellement.)');
db.close();
