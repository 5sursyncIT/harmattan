/**
 * Renvoie au comptable la notification « Contrat & Devis » d'un manuscrit, avec
 * le manuscrit en pièce jointe + lien de téléchargement sécurisé.
 *
 * Utile pour les manuscrits évalués AVANT la mise en place de la pièce jointe
 * (le comptable avait reçu la notification sans le texte), ou pour tout renvoi
 * à la demande. Trace l'envoi sur la frise.
 *
 * Usage : node scripts/resend-accountant-manuscript.mjs MS-2606-0044 [--dry-run]
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { sendAccountantEvaluationEmail } from '../server/manuscript-emails.js';
import { logManuscriptEvent } from '../server/manuscript-workflow.js';
import { createFileToken, pickFileForActor, ensureFileTokensSchema } from '../server/manuscript-file-tokens.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ref = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!ref) {
  console.error('Usage : node scripts/resend-accountant-manuscript.mjs <REF_MANUSCRIT> [--dry-run]');
  process.exit(1);
}

const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;
const TTL_DAYS = 30;

const db = new Database(join(__dirname, '..', 'newsletter.sqlite'));
ensureFileTokensSchema(db);

const manuscript = db.prepare('SELECT * FROM manuscripts WHERE ref = ?').get(ref);
if (!manuscript) { console.error(`Manuscrit ${ref} introuvable.`); process.exit(1); }
const author = db.prepare('SELECT firstname, lastname FROM authors WHERE id = ?').get(manuscript.author_id);
const authorName = author ? `${author.firstname || ''} ${author.lastname || ''}`.trim() : '';

const accountantEmail = process.env.MANUSCRIPT_ACCOUNTANT_EMAIL || 'issa.ndiaye@senharmattan.com';
const accountantName = process.env.MANUSCRIPT_ACCOUNTANT_NAME || 'Issa NDIAYE';
const siteUrl = process.env.SITE_URL || 'https://senharmattan.com';

// Le fichier attendu est celui de l'évaluation favorable (l'original), même si
// le manuscrit a depuis avancé dans le pipeline — d'où le stage forcé.
const file = pickFileForActor(db, manuscript.id, 'evaluation_positive');
if (!file) { console.error('Aucun fichier « original » pour ce manuscrit.'); process.exit(1); }

let attachments = null;
const size = existsSync(file.file_path) ? statSync(file.file_path).size : 0;
if (size > 0 && size <= MAX_EMAIL_ATTACHMENT_BYTES) {
  attachments = [{ filename: file.file_name || 'manuscrit', path: file.file_path }];
} else {
  console.warn(`[!] Pièce jointe écartée (${size} octets) — lien seul.`);
}

console.log(`Manuscrit  : ${manuscript.ref} — « ${manuscript.title} »`);
console.log(`Auteur     : ${authorName}`);
console.log(`Étape      : ${manuscript.current_stage}`);
console.log(`Fichier    : ${file.file_name} (${(size / 1024 / 1024).toFixed(2)} Mo)`);
console.log(`Destinataire : ${accountantName} <${accountantEmail}>`);
console.log(`Pièce jointe : ${attachments ? 'oui' : 'non (lien seul)'}`);
if (dryRun) { console.log('\n--dry-run : aucun email envoyé, aucun token créé.'); process.exit(0); }

const token = createFileToken(db, {
  manuscriptId: manuscript.id, fileId: file.id, ttlHours: TTL_DAYS * 24, maxUses: 10,
});
const downloadUrl = `${siteUrl}/api/files/manuscript/${token}/download`;

// Même transporter que le serveur (.env), y compris l'override MAIL_FROM :
// sans lui, le From: noreply@ casse la signature DKIM du relais.
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: (parseInt(process.env.SMTP_PORT) || 587) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
const mailFrom = process.env.MAIL_FROM?.trim();
if (mailFrom) {
  const original = transporter.sendMail.bind(transporter);
  transporter.sendMail = (opts) => original({ ...opts, from: mailFrom });
}

const info = await sendAccountantEvaluationEmail(transporter, {
  manuscript, authorName, accountantEmail, accountantName, siteUrl,
  downloadUrl, downloadTtlDays: TTL_DAYS, attachments,
});
if (!info) { console.error('\n✗ Envoi échoué (voir erreur SMTP ci-dessus). Aucune trace ajoutée à la frise.'); process.exit(1); }

console.log(`\n✓ Email envoyé — id: ${info.messageId}`);
logManuscriptEvent(db, manuscript.id, 'email_sent', { role: 'system', label: 'Renvoi manuel' },
  `Renvoi contrat & devis → comptable (${accountantEmail}) — ${attachments ? 'manuscrit joint' : 'lien de téléchargement'}`);
console.log('✓ Frise mise à jour');
console.log(`Lien valable ${TTL_DAYS} jours : ${downloadUrl}`);
