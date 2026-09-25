/**
 * Renvoi des e-mails perdus pendant la panne SMTP du 25/08 → 04/09/2026.
 *
 * L'authentification SMTP était refusée (535) : 177 envois uniques ont échoué
 * sans file d'attente ni reprise — nodemailer échoue, on journalise, et c'est
 * tout. Ce script rejoue ce qui est ENCORE utile, en repartant de l'état actuel
 * de la base et non du message d'origine : un manuscrit passé depuis « Reçu » à
 * « Rejeté » ne doit pas recevoir dix jours plus tard un « en cours
 * d'évaluation » qui n'est plus vrai.
 *
 * Entrée : un TSV « email <TAB> sujet » extrait du journal systemd.
 * Usage  : node scripts/resend-failed-emails.mjs <fichier.tsv> [--send]
 *          (sans --send : simulation, aucun envoi)
 *
 * Volontairement écartés :
 *  - réinitialisations de mot de passe : le jeton est stocké haché et a expiré
 *    (1 h) — le lien d'origine est irrécupérable, et en fabriquer un nouveau
 *    non sollicité serait pire que le silence ;
 *  - notifications de formulaire de contact : ce sont des alertes internes, et
 *    les messages sont déjà consultables dans l'écran Contacts — rien n'est perdu.
 */
import 'dotenv/config';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { sendTransitionEmail, notifyIntervenantTask } from '../server/manuscript-emails.js';
import { logManuscriptEvent, STAGE_LABELS } from '../server/manuscript-workflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, '..', 'newsletter.sqlite'));
const SITE_URL = process.env.SITE_URL || 'https://senharmattan.com';
const SEND = process.argv.includes('--send');
const TSV = process.argv[2];
if (!TSV || TSV.startsWith('--')) {
  console.error('usage: node scripts/resend-failed-emails.mjs <fichier.tsv> [--send]');
  process.exit(1);
}

// Pause entre deux envois : le serveur mutualisé coupe la connexion au-delà
// d'une certaine cadence, et ces messages portent des pièces jointes.
const DELAY_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: (parseInt(process.env.SMTP_PORT) || 587) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  pool: true, maxConnections: 1, maxMessages: 50,
});
const MAIL_FROM = process.env.MAIL_FROM?.trim();
if (MAIL_FROM) {
  const orig = transporter.sendMail.bind(transporter);
  transporter.sendMail = (o, cb) => orig({ ...o, from: MAIL_FROM }, cb);
}

const unescapeHtml = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ─── Lecture du journal des échecs ────────────────────────────
const failures = readFileSync(TSV, 'utf-8').trim().split('\n')
  .map((l) => { const [email, ...rest] = l.split('\t'); return { email, subject: unescapeHtml(rest.join('\t')) }; })
  .filter((f) => f.email && f.subject);

const actor = { role: 'system', id: null, label: 'Rattrapage panne SMTP' };
const plan = { eval: [], author: [], activation: [], newsletter: [] };
const skipped = [];

// ─── 1. Convocations d'évaluateur ─────────────────────────────
// Ne concerne que les manuscrits ENCORE en évaluation : ailleurs, le dossier a
// avancé sans l'e-mail, la convocation n'a plus d'objet.
for (const f of failures.filter((x) => x.subject.startsWith('[évaluateur]'))) {
  const title = f.subject.replace('[évaluateur]', '').trim();
  const row = db.prepare(
    `SELECT m.*, i.id AS iid, i.nom, i.email AS iemail, i.metier
       FROM manuscripts m JOIN intervenants i ON i.id = m.assigned_evaluator_contact_id
      WHERE m.current_stage = 'in_evaluation' AND m.duplicate_of IS NULL AND i.email = ?`
  ).all(f.email).find((r) => norm(r.title) === norm(title));
  if (!row) { skipped.push(`[évaluateur] ${title} — dossier avancé ou réaffecté`); continue; }
  if (plan.eval.some((p) => p.manuscript.id === row.id)) continue;
  plan.eval.push({ manuscript: row, intervenant: { id: row.iid, nom: row.nom, email: row.iemail, metier: row.metier } });
}

// ─── 2. Notifications aux auteurs (accusé de réception + workflow) ───
// Un seul e-mail par manuscrit, à son étape ACTUELLE. Un auteur dont trois
// notifications ont été perdues n'en reçoit qu'une, qui dit où en est vraiment
// son texte — plutôt que trois messages contradictoires venus du passé.
const authorSubjects = failures.filter((f) => (
  f.subject.startsWith('Confirmation de réception')
  || (/ — /.test(f.subject) && !f.subject.startsWith('[') && !f.subject.startsWith('Confirmez')
      && !f.subject.startsWith('Activez') && !f.subject.startsWith('Réinitialisation'))
));
for (const f of authorSubjects) {
  const title = f.subject.startsWith('Confirmation de réception')
    ? f.subject.replace(/^Confirmation de réception\s*—\s*/, '').replace(/^"|"$/g, '').trim()
    : f.subject.replace(/\s+—\s+[^—]*$/, '').trim();
  const row = db.prepare(
    `SELECT m.*, a.email AS aemail, a.firstname, a.lastname
       FROM manuscripts m JOIN authors a ON a.id = m.author_id
      WHERE a.email = ? AND m.duplicate_of IS NULL`
  ).all(f.email).find((r) => norm(r.title) === norm(title) || norm(r.title).includes(norm(title)));
  if (!row) { skipped.push(`[auteur] ${title} (${f.email}) — manuscrit introuvable ou marqué doublon`); continue; }
  if (plan.author.some((p) => p.manuscript.id === row.id)) continue;
  plan.author.push({ manuscript: row, email: row.aemail, firstname: row.firstname, stage: row.current_stage });
}

// ─── 3. Liens d'activation d'espace auteur ────────────────────
// Uniquement pour les comptes toujours sans mot de passe : les autres ont
// activé leur espace entre-temps par un autre chemin.
for (const f of failures.filter((x) => x.subject.startsWith('Activez votre espace auteur'))) {
  const a = db.prepare(
    "SELECT id, email, firstname, lastname, password FROM authors WHERE email = ?"
  ).get(f.email);
  if (!a) { skipped.push(`[activation] ${f.email} — auteur introuvable`); continue; }
  if (a.password) { skipped.push(`[activation] ${f.email} — espace déjà activé`); continue; }
  if (plan.activation.some((p) => p.email === a.email)) continue;
  const ms = db.prepare(
    "SELECT ref, title FROM manuscripts WHERE author_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(a.id);
  plan.activation.push({ ...a, manuscript: ms });
}

// ─── 4. Confirmations d'inscription à la newsletter ───────────
// Le jeton n'expire pas : le lien d'origine reste valable, on le renvoie tel quel.
for (const f of failures.filter((x) => x.subject.startsWith('Confirmez votre inscription'))) {
  const s = db.prepare('SELECT email, token, confirmed FROM newsletter WHERE email = ?').get(f.email);
  if (!s) { skipped.push(`[newsletter] ${f.email} — inscription retirée`); continue; }
  if (s.confirmed) { skipped.push(`[newsletter] ${f.email} — déjà confirmée`); continue; }
  if (plan.newsletter.some((p) => p.email === s.email)) continue;
  plan.newsletter.push(s);
}

// ─── Compte rendu ─────────────────────────────────────────────
const total = plan.eval.length + plan.author.length + plan.activation.length + plan.newsletter.length;
console.log(`\n${SEND ? '=== ENVOI RÉEL ===' : '=== SIMULATION (ajouter --send pour envoyer) ==='}`);
console.log(`échecs relevés dans le journal : ${failures.length}`);
console.log(`à renvoyer : ${total}`);
console.log(`  convocations évaluateur : ${plan.eval.length}`);
console.log(`  notifications auteur    : ${plan.author.length}`);
console.log(`  activations d'espace    : ${plan.activation.length}`);
console.log(`  confirmations newsletter: ${plan.newsletter.length}`);
console.log(`sans objet aujourd'hui     : ${skipped.length}`);

if (!SEND) {
  console.log('\n— convocations évaluateur —');
  for (const p of plan.eval) console.log(`   ${p.manuscript.ref}  ${p.manuscript.title.slice(0, 40).padEnd(42)} → ${p.intervenant.nom}`);
  console.log('\n— notifications auteur (étape actuelle) —');
  for (const p of plan.author) console.log(`   ${p.manuscript.ref}  ${(STAGE_LABELS[p.stage] || p.stage).padEnd(26)} → ${p.email}`);
  console.log('\n— activations —');
  for (const p of plan.activation) console.log(`   ${p.email}  (${p.manuscript?.ref || 'sans manuscrit'})`);
  console.log('\n— newsletter —');
  for (const p of plan.newsletter) console.log(`   ${p.email}`);
  console.log('\n— écarté —');
  for (const s of skipped) console.log(`   ${s}`);
  process.exit(0);
}

// ─── Envoi ────────────────────────────────────────────────────
let ok = 0; let ko = 0;
const report = [];
const attempt = async (label, fn) => {
  try {
    const info = await fn();
    if (info === null || info === undefined) throw new Error('envoi non confirmé par le serveur');
    ok++; report.push(`OK   ${label}`);
    console.log(`  ✓ ${label}`);
  } catch (e) {
    ko++; report.push(`ÉCHEC ${label} — ${e.message}`);
    console.log(`  ✗ ${label} — ${e.message}`);
  }
  await sleep(DELAY_MS);
};

console.log('\n— convocations évaluateur —');
for (const p of plan.eval) {
  await attempt(`${p.manuscript.ref} → ${p.intervenant.nom}`, () => notifyIntervenantTask(db, transporter, {
    manuscript: p.manuscript, toStage: 'in_evaluation', intervenant: p.intervenant,
    siteUrl: SITE_URL, actor, noteSuffix: ' (renvoi après panne SMTP)',
  }));
}

console.log('\n— notifications auteur —');
for (const p of plan.author) {
  await attempt(`${p.manuscript.ref} (${STAGE_LABELS[p.stage] || p.stage}) → ${p.email}`, async () => {
    const info = await sendTransitionEmail(transporter, p.manuscript, p.stage,
      { type: 'author', email: p.email, firstname: p.firstname }, SITE_URL);
    if (info) {
      try {
        logManuscriptEvent(db, p.manuscript.id, 'email_sent', actor,
          `« ${STAGE_LABELS[p.stage] || p.stage} » → auteur (${p.email}) — renvoi après panne SMTP`);
      } catch (e) { console.warn('   (frise non mise à jour :', e.message, ')'); }
    }
    return info;
  });
}

console.log("\n— activations d'espace auteur —");
for (const p of plan.activation) {
  await attempt(`${p.email}`, () => {
    // Même mécanique que la soumission publique : jeton neuf, 90 jours.
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('INSERT OR REPLACE INTO author_password_resets (email, token, expires_at) VALUES (?, ?, ?)')
      .run(p.email, token, expiresAt);
    const url = `${SITE_URL}/auteur/activer?token=${token}&email=${encodeURIComponent(p.email)}`;
    const ref = p.manuscript ? ` (référence <strong>${p.manuscript.ref}</strong>)` : '';
    return transporter.sendMail({
      to: p.email,
      subject: "Activez votre espace auteur — L'Harmattan Sénégal",
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">
        <h2 style="color:#10531a">Bonjour ${p.firstname || ''},</h2>
        <p>Votre manuscrit est bien arrivé chez nous${ref}. Un incident technique sur notre
        messagerie a retardé cet envoi, veuillez nous en excuser.</p>
        <p>Pour suivre l'avancement du projet, valider les corrections et le BAT, télécharger les
        fichiers et échanger avec notre équipe, activez votre espace auteur :</p>
        <p><a href="${url}" style="background:#10531a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">Activer mon espace auteur</a></p>
        <p style="color:#666;font-size:0.85em">Ce lien est valable 90 jours. Vous pourrez ensuite vous connecter à tout moment sur ${SITE_URL}/auteur/connexion.</p>
        <p style="color:#666;font-size:0.9em;margin-top:24px">L'équipe éditoriale — L'Harmattan Sénégal</p>
      </div>`,
    });
  });
}

console.log('\n— confirmations newsletter —');
for (const p of plan.newsletter) {
  await attempt(`${p.email}`, () => transporter.sendMail({
    to: p.email,
    subject: 'Confirmez votre inscription à la newsletter',
    html: `<p>Bonjour,</p><p>Merci de vous être inscrit à notre newsletter. Un incident technique
      a retardé ce message ; votre inscription est toujours en attente de confirmation :</p>
      <p><a href="${SITE_URL}/api/newsletter/confirm?token=${p.token}">Confirmer mon inscription</a></p>`,
  }));
}

console.log(`\n=== TERMINÉ : ${ok} envoyé(s), ${ko} en échec ===`);
transporter.close();
process.exit(ko ? 1 : 0);
