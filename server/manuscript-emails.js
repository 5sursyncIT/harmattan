/**
 * Notifications workflow éditorial :
 *  - email transactionnel à l'auteur + à l'acteur métier suivant (si email connu)
 *  - notification in-app persistée dans `author_notifications` pour affichage
 *    dans la cloche du portail auteur (lecture / non lue / historique).
 *
 * Chaque transition déclenche, dans l'ordre :
 *   1. sendTransitionEmail() vers l'auteur
 *   2. createAuthorNotification() en DB
 *   3. sendTransitionEmail() vers l'acteur métier suivant (si connu)
 */

import { existsSync, statSync } from 'fs';
import { STAGE_LABELS } from './manuscript-workflow.js';
import { createFileToken, pickFileForActor } from './manuscript-file-tokens.js';

// Plafond raisonnable pour joindre un fichier directement à un email (les
// fournisseurs SMTP rejettent généralement au-delà de ~25 Mo). Au-delà, on se
// rabat sur le seul lien de téléchargement sécurisé.
const MAX_EMAIL_ATTACHMENT_BYTES = 18 * 1024 * 1024;

// Stages dits "terminaux" pour l'auteur — on ne génère pas de notification car
// l'utilisateur n'a plus d'action à mener ou ce sont des états techniques internes.
const SKIP_AUTHOR_NOTIFICATION = new Set([]);

// Stages où l'auteur DOIT agir (validation) — on les marque comme "action requise"
// pour pouvoir afficher un badge spécifique dans la cloche.
const ACTION_REQUIRED_STAGES = new Set([
  'correction_author_review',
  'bat_author_review',
]);

/**
 * Crée la table `author_notifications` si absente + colonne `notification_prefs` sur authors.
 * À appeler une fois au démarrage.
 */
export function ensureNotificationsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS author_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL,
    manuscript_id INTEGER,
    manuscript_ref TEXT,
    manuscript_title TEXT,
    stage TEXT,
    title TEXT NOT NULL,
    message TEXT,
    action_url TEXT,
    action_required INTEGER NOT NULL DEFAULT 0,
    is_read INTEGER NOT NULL DEFAULT 0,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_author_notif_author ON author_notifications(author_id, is_read, created_at DESC)'); } catch (e) { void e; }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_author_notif_manuscript ON author_notifications(manuscript_id)'); } catch (e) { void e; }
  // Préférences email (opt-out par catégorie). Colonne TEXT JSON, NULL = tous les emails actifs.
  try { db.exec('ALTER TABLE authors ADD COLUMN notification_prefs TEXT'); } catch (e) { void e; }
  // Biographie auteur — soumise via les formulaires manuscrit, partagée entre tous les manuscrits.
  try { db.exec('ALTER TABLE authors ADD COLUMN bio TEXT'); } catch (e) { void e; }
  // Biographie spécifique au manuscrit (telle que soumise à ce moment-là).
  try { db.exec('ALTER TABLE manuscripts ADD COLUMN biography TEXT'); } catch (e) { void e; }
}

// Catégorisation des stages workflow pour les opt-out
const STAGE_CATEGORY = {
  submitted: 'workflow', in_evaluation: 'workflow', evaluation_positive: 'workflow',
  evaluation_negative: 'workflow', in_correction: 'workflow', correction_author_review: 'workflow',
  in_editorial: 'workflow', editorial_validated: 'workflow',
  contract_pending: 'critical', contract_signed: 'critical', payment_pending: 'critical',
  cover_design: 'cover', bat_author_review: 'cover',
  print_preparation: 'print', printing: 'print', printed: 'print',
};

/**
 * Charge les préférences notification d'un auteur. Tout est ON par défaut.
 * 'critical' est toujours ON (contrats, paiements) — non configurable.
 */
export function getAuthorPreferences(db, authorId) {
  let prefs = {};
  try {
    const row = db.prepare('SELECT notification_prefs FROM authors WHERE id = ?').get(authorId);
    if (row?.notification_prefs) {
      prefs = JSON.parse(row.notification_prefs) || {};
    }
  } catch (e) { void e; }
  return {
    workflow: prefs.workflow !== false,
    cover: prefs.cover !== false,
    print: prefs.print !== false,
    reminders: prefs.reminders !== false,
    critical: true, // toujours actif
  };
}

/**
 * Décide si on envoie un email auteur pour ce stage, selon ses préférences.
 * Les notifications in-app sont créées dans tous les cas (l'auteur peut les masquer mais
 * elles persistent dans l'historique).
 */
export function shouldEmailAuthor(db, authorId, toStage) {
  const category = STAGE_CATEGORY[toStage] || 'workflow';
  if (category === 'critical') return true;
  const prefs = getAuthorPreferences(db, authorId);
  return !!prefs[category];
}

/**
 * Construit le couple (titre, message) court pour la cloche, dérivé du stage.
 * Volontairement distinct des templates email — plus dense, sans HTML.
 */
function buildNotificationCopy(manuscript, toStage) {
  const title = manuscript?.title || 'votre manuscrit';
  const stageLabel = STAGE_LABELS[toStage] || toStage;
  switch (toStage) {
    case 'submitted':
      return { title: 'Manuscrit bien reçu', message: `« ${title} » est enregistré. Suivez son évolution depuis votre espace.` };
    case 'in_evaluation':
      return { title: 'Évaluation en cours', message: `Votre manuscrit « ${title} » a été transmis au comité éditorial.` };
    case 'evaluation_positive':
      return { title: 'Évaluation favorable', message: `Bonne nouvelle : « ${title} » a reçu une évaluation favorable.` };
    case 'evaluation_negative':
      return { title: 'Décision éditoriale', message: `Le comité n'a pas retenu « ${title} » pour publication.` };
    case 'contract_pending':
      return { title: 'Contrat à signer', message: `Votre contrat pour « ${title} » est prêt à la signature.` };
    case 'contract_signed':
      return { title: 'Contrat signé', message: `Contrat de « ${title} » signé. Prochaine étape : le règlement.` };
    case 'payment_pending':
      return { title: 'Paiement en attente', message: `Règlement attendu pour démarrer la correction de « ${title} ».` };
    case 'in_correction':
      return { title: 'En correction', message: `« ${title} » est entre les mains du correcteur.` };
    case 'correction_author_review':
      return { title: 'Corrections à valider', message: `Les corrections de « ${title} » sont prêtes pour votre relecture.` };
    case 'in_editorial':
      return { title: 'Validation éditoriale', message: `Vos corrections de « ${title} » ont été validées. Phase éditoriale en cours.` };
    case 'editorial_validated':
      return { title: 'Validé par l\'éditeur', message: `« ${title} » est validé. La conception de la couverture va démarrer.` };
    case 'cover_design':
      return { title: 'Couverture en conception', message: `L'infographiste prépare la couverture de « ${title} ».` };
    case 'bat_author_review':
      return { title: 'BAT couverture à valider', message: `Le bon à tirer de « ${title} » attend votre validation.` };
    case 'print_preparation':
      return { title: 'Préparation impression', message: `BAT validé — « ${title} » entre en préparation pour l'impression.` };
    case 'printing':
      return { title: 'En impression', message: `« ${title} » est désormais en impression.` };
    case 'printed':
      return { title: 'Votre livre est prêt !', message: `L'impression de « ${title} » est terminée. Nous vous recontactons pour la suite.` };
    default:
      return { title: stageLabel, message: `Nouvelle étape pour « ${title} » : ${stageLabel}.` };
  }
}

/**
 * Insère une notification in-app pour l'auteur.
 * Idempotent par (manuscript_id, stage, author_id) sur l'heure du jour pour éviter les doublons
 * en cas de double-transition (ex: cron qui retrigger).
 */
export function createAuthorNotification(db, manuscript, toStage, author, siteUrl) {
  if (!author?.id) return null;
  if (SKIP_AUTHOR_NOTIFICATION.has(toStage)) return null;
  try {
    // Anti-doublon : si une notif pour le même couple (auteur, manuscrit, stage) existe créée il y a moins d'1h, on saute
    const recent = db.prepare(
      `SELECT id FROM author_notifications
       WHERE author_id = ? AND manuscript_id IS ? AND stage = ?
         AND created_at > datetime('now', '-1 hour')
       LIMIT 1`
    ).get(author.id, manuscript?.id || null, toStage);
    if (recent) return recent.id;

    const { title, message } = buildNotificationCopy(manuscript, toStage);
    const actionUrl = manuscript?.id ? `${siteUrl || ''}/auteur/manuscrits/${manuscript.id}` : null;
    const info = db.prepare(
      `INSERT INTO author_notifications
        (author_id, manuscript_id, manuscript_ref, manuscript_title, stage, title, message, action_url, action_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      author.id,
      manuscript?.id || null,
      manuscript?.ref || null,
      manuscript?.title || null,
      toStage,
      title,
      message,
      actionUrl,
      ACTION_REQUIRED_STAGES.has(toStage) ? 1 : 0,
    );
    return info.lastInsertRowid;
  } catch (err) {
    console.error('[NOTIF] createAuthorNotification error:', err.message);
    return null;
  }
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SIGNATURE = `<p style="color:#666;font-size:0.9em;margin-top:24px">L'équipe éditoriale — L'Harmattan Sénégal</p>`;

function btn(label, url) {
  return `<p><a href="${url}" style="background:#10531a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>`;
}

function header(title) {
  return `<h2 style="color:#10531a">${escapeHtml(title)}</h2>`;
}

/**
 * Envoie un email de transition à un destinataire.
 * recipient = { type: 'author'|'admin', email, role?, firstname?, label? }
 * attachments = pièces jointes nodemailer optionnelles ([{ filename, path }]).
 */
export function sendTransitionEmail(transporter, manuscript, toStage, recipient, siteUrl, attachments = null) {
  if (!transporter || !recipient?.email) return Promise.resolve();

  const msTitle = escapeHtml(manuscript.title || 'votre manuscrit');
  const msRef = escapeHtml(manuscript.ref || '');
  const msSubtitle = manuscript.subtitle ? escapeHtml(manuscript.subtitle) : '';
  const subtitleLine = msSubtitle
    ? `<p style="color:#475569;font-style:italic;margin:-6px 0 10px">Sous-titre : « ${msSubtitle} »</p>`
    : '';
  const authorUrl = `${siteUrl}/auteur/manuscrits/${manuscript.id}`;
  const adminUrl = (tab) => `${siteUrl}/admin/${tab}`;

  let subject = '';
  let body = '';

  if (recipient.type === 'author') {
    const greeting = `<p>Bonjour ${escapeHtml(recipient.firstname || '')},</p>`;
    const stageLabel = STAGE_LABELS[toStage] || toStage;
    switch (toStage) {
      case 'submitted':
        subject = `Confirmation de réception — ${msTitle}`;
        body = header('Manuscrit bien reçu')
          + greeting
          + `<p>Nous avons bien reçu votre manuscrit <strong>« ${msTitle} »</strong> (référence ${msRef}).</p>`
          + subtitleLine
          + `<p>Vous pouvez suivre son évolution à tout moment depuis votre espace auteur.</p>`
          + btn('Accéder à mon espace', authorUrl);
        break;
      case 'in_evaluation':
        subject = `${msTitle} — En cours d'évaluation`;
        body = header('Évaluation en cours')
          + greeting
          + `<p>Votre manuscrit <strong>« ${msTitle} »</strong> a été transmis à notre comité éditorial pour évaluation.</p>`
          + btn('Suivre mon manuscrit', authorUrl);
        break;
      case 'evaluation_positive':
        subject = `${msTitle} — Évaluation favorable`;
        body = header('Bonne nouvelle !')
          + greeting
          + `<p>Votre manuscrit <strong>« ${msTitle} »</strong> a reçu une évaluation favorable. Nous préparons votre contrat d'édition.</p>`
          + (attachments && attachments.length
            ? `<p>Vous trouverez <strong>ci-joint le rapport de lecture</strong> de votre manuscrit.</p>`
            : '')
          + btn('Accéder à mon espace', authorUrl);
        break;
      case 'evaluation_negative':
        subject = `${msTitle} — Décision éditoriale`;
        body = header('Décision du comité éditorial')
          + greeting
          + `<p>Après examen attentif, notre comité n'a pas retenu votre manuscrit <strong>« ${msTitle} »</strong> pour publication.</p>`
          + `<p>Vous pouvez consulter l'avis détaillé du comité depuis votre espace auteur.</p>`
          + `<p>Nous vous remercions de votre confiance et vous encourageons à persévérer.</p>`
          + btn('Consulter l\'avis', authorUrl);
        break;
      case 'contract_pending':
        subject = `${msTitle} — Contrat à signer`;
        body = header('Votre contrat d\'édition est prêt')
          + greeting
          + `<p>Votre contrat d'édition pour <strong>« ${msTitle} »</strong> est disponible à la signature.</p>`
          + `<p>Vous recevrez prochainement un lien de signature en ligne.</p>`
          + btn('Voir mon manuscrit', authorUrl);
        break;
      case 'contract_signed':
        subject = `${msTitle} — Contrat signé`;
        body = header('Contrat signé')
          + greeting
          + `<p>Le contrat pour <strong>« ${msTitle} »</strong> est signé. Prochaine étape : le règlement pour déclencher la phase de correction.</p>`
          + btn('Suivre le manuscrit', authorUrl);
        break;
      case 'payment_pending':
        subject = `${msTitle} — Paiement en attente`;
        body = header('Règlement attendu')
          + greeting
          + `<p>Le paiement pour <strong>« ${msTitle} »</strong> est en attente de confirmation.</p>`
          + btn('Consulter mon espace', authorUrl);
        break;
      case 'in_correction':
        subject = `${msTitle} — En correction`;
        body = header('Phase de correction')
          + greeting
          + `<p>Votre manuscrit <strong>« ${msTitle} »</strong> est maintenant pris en charge par notre correcteur.</p>`
          + btn('Suivre la correction', authorUrl);
        break;
      case 'correction_author_review':
        subject = `${msTitle} — Corrections à valider`;
        body = header('Corrections soumises à votre validation')
          + greeting
          + `<p>Les corrections apportées à <strong>« ${msTitle} »</strong> sont prêtes pour votre relecture.</p>`
          + `<p>Merci de les valider ou de demander des modifications depuis votre espace auteur.</p>`
          + btn('Valider les corrections', authorUrl);
        break;
      case 'in_editorial':
        subject = `${msTitle} — Validation éditoriale en cours`;
        body = header('Phase éditoriale')
          + greeting
          + `<p>Les corrections de votre manuscrit <strong>« ${msTitle} »</strong> sont finalisées. Il est maintenant en validation éditoriale finale.</p>`
          + btn('Suivre le manuscrit', authorUrl);
        break;
      case 'editorial_validated':
        subject = `${msTitle} — Validation éditoriale terminée`;
        body = header('Étape franchie !')
          + greeting
          + `<p>Votre manuscrit <strong>« ${msTitle} »</strong> a été validé par l'éditeur. La conception de la couverture va commencer.</p>`
          + btn('Suivre le manuscrit', authorUrl);
        break;
      case 'cover_design':
        subject = `${msTitle} — Couverture en conception`;
        body = header('Conception de la couverture')
          + greeting
          + `<p>Notre infographiste travaille sur la couverture de <strong>« ${msTitle} »</strong>. Vous recevrez prochainement un BAT à valider.</p>`;
        break;
      case 'bat_author_review':
        subject = `${msTitle} — BAT couverture à valider`;
        body = header('Bon à tirer (BAT) couverture')
          + greeting
          + `<p>Le BAT de la couverture pour <strong>« ${msTitle} »</strong> est prêt. Merci de le valider depuis votre espace auteur.</p>`
          + btn('Valider le BAT', authorUrl);
        break;
      case 'print_preparation':
        subject = `${msTitle} — Préparation de l'impression`;
        body = header('Préparation de l\'impression')
          + greeting
          + `<p>BAT validé — votre ouvrage entre en préparation pour l'impression.</p>`;
        break;
      case 'printing':
        subject = `${msTitle} — En impression`;
        body = header('Impression lancée')
          + greeting
          + `<p>Votre ouvrage <strong>« ${msTitle} »</strong> est maintenant en impression.</p>`;
        break;
      case 'printed':
        subject = `${msTitle} — Impression terminée`;
        body = header('Votre livre est prêt !')
          + greeting
          + `<p>L'impression de <strong>« ${msTitle} »</strong> est terminée. Nous vous contacterons pour la suite.</p>`;
        break;
      default:
        subject = `${msTitle} — Mise à jour : ${stageLabel}`;
        body = header('Mise à jour')
          + greeting
          + `<p>Nouvelle étape pour votre manuscrit <strong>« ${msTitle} »</strong> : ${escapeHtml(stageLabel)}.</p>`
          + btn('Accéder à mon espace', authorUrl);
    }
  } else {
    // recipient.type === 'admin'
    const greeting = `<p>Bonjour ${escapeHtml(recipient.label || recipient.firstname || 'cher collègue')},</p>`;
    switch (toStage) {
      case 'submitted':
        subject = `[Manuscrit] Nouvelle soumission — ${msTitle}`;
        body = header('Nouvelle soumission')
          + greeting
          + `<p>Un nouveau manuscrit <strong>« ${msTitle} »</strong> (réf. ${msRef}) vient d'être soumis.</p>`
          + subtitleLine
          + btn('Voir dans l\'admin', adminUrl('manuscripts'));
        break;
      case 'in_evaluation':
        subject = `[Évaluation] ${msTitle}`;
        body = header('Manuscrit à évaluer')
          + greeting
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> vous a été confié pour évaluation.</p>`
          + btn('Démarrer l\'évaluation', adminUrl('evaluations'));
        break;
      case 'evaluation_positive':
        subject = `[Contrat] ${msTitle} — Évaluation favorable`;
        body = header('Évaluation favorable')
          + greeting
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> a été évalué favorablement. Préparez le contrat.</p>`
          + btn('Créer le contrat', adminUrl('contracts'));
        break;
      case 'payment_pending':
        subject = `[Paiement] ${msTitle} — Contrat signé`;
        body = header('Paiement à confirmer')
          + greeting
          + `<p>Le contrat pour <strong>« ${msTitle} »</strong> est signé. Merci de confirmer le paiement reçu.</p>`
          + btn('Gérer les paiements', adminUrl('payments'));
        break;
      case 'in_correction':
        subject = `[Correction] ${msTitle}`;
        body = header('Manuscrit à corriger')
          + greeting
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> vous a été confié pour correction.</p>`
          + btn('Accéder aux corrections', adminUrl('corrections'));
        break;
      case 'in_editorial':
        subject = `[Éditorial] ${msTitle} — Validation à faire`;
        body = header('Validation éditoriale à faire')
          + greeting
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> est prêt pour la validation éditoriale finale (corrections finalisées).</p>`
          + btn('Valider', adminUrl('editorial'));
        break;
      case 'cover_design':
        subject = `[Couverture] ${msTitle} — Conception`;
        body = header('Conception de couverture')
          + greeting
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> est prêt pour la conception de la couverture.</p>`
          + btn('Voir les couvertures', adminUrl('covers'));
        break;
      case 'print_preparation':
        subject = `[Impression] ${msTitle} — BAT validé`;
        body = header('Prêt pour impression')
          + greeting
          + `<p>Le BAT du manuscrit <strong>« ${msTitle} »</strong> a été validé par l'auteur. Préparez l'ordre d'impression (MO).</p>`
          + btn('Préparer l\'impression', adminUrl('printing'));
        break;
      default:
        subject = `[${STAGE_LABELS[toStage] || toStage}] ${msTitle}`;
        body = header('Étape workflow')
          + greeting
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> est passé à l'étape : <strong>${escapeHtml(STAGE_LABELS[toStage] || toStage)}</strong>.</p>`
          + btn('Voir dans l\'admin', adminUrl('manuscripts'));
    }
  }

  const mail = {
    from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
    to: recipient.email,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
  };
  if (attachments && attachments.length) mail.attachments = attachments;
  return transporter.sendMail(mail).catch((err) => console.error('[WORKFLOW] Email error:', err.message));
}

/**
 * Notifie le comptable (par défaut Issa NDIAYE) lorsqu'un manuscrit reçoit une
 * évaluation favorable, afin qu'il élabore le contrat d'édition et le devis.
 * opts = { manuscript, authorName, accountantEmail, accountantName, siteUrl }
 */
export function sendAccountantEvaluationEmail(transporter, { manuscript, authorName, accountantEmail, accountantName, siteUrl }) {
  if (!transporter || !accountantEmail) return Promise.resolve();

  const msTitle = escapeHtml(manuscript.title || 'le manuscrit');
  const msRef = escapeHtml(manuscript.ref || '');
  const author = escapeHtml(authorName || '');
  const contractsUrl = `${siteUrl || ''}/admin/contracts`;

  const subject = `[Contrat & Devis] ${msTitle} — Évaluation favorable`;
  const body = header('Évaluation favorable — contrat & devis à élaborer')
    + `<p>Bonjour ${escapeHtml(accountantName || 'cher collègue')},</p>`
    + `<p>Le manuscrit <strong>« ${msTitle} »</strong>${msRef ? ` (réf. ${msRef})` : ''}${author ? `, de <strong>${author}</strong>,` : ''} vient de recevoir une <strong>évaluation favorable</strong>.</p>`
    + `<p>Merci de bien vouloir procéder à l'<strong>élaboration du contrat d'édition et du devis</strong> correspondants.</p>`
    + btn('Élaborer le contrat', contractsUrl);

  return transporter.sendMail({
    from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
    to: accountantEmail,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
  }).catch((err) => console.error('[WORKFLOW] Accountant email error:', err.message));
}

const ROLE_LABELS = {
  evaluateur: { label: 'évaluateur', task: "à évaluer", adminTab: 'evaluations' },
  correcteur: { label: 'correcteur', task: "à corriger", adminTab: 'corrections' },
  editor: { label: 'éditeur', task: "à valider éditorialement", adminTab: 'editorial' },
  infographiste: { label: 'infographiste', task: "dont la couverture est à concevoir", adminTab: 'covers' },
  imprimeur: { label: 'imprimeur', task: "à préparer à l'impression", adminTab: 'printing' },
};

/**
 * Notifie un admin métier nouvellement (ré)assigné à un manuscrit.
 *  - kind = 'assigned' : on lui annonce qu'il a un nouveau dossier
 *  - kind = 'unassigned' : on lui annonce qu'on lui a retiré le dossier
 */
export function sendAssignmentEmail(transporter, manuscript, role, recipient, siteUrl, kind = 'assigned') {
  if (!transporter || !recipient?.email) return Promise.resolve();
  const roleInfo = ROLE_LABELS[role] || { label: role, task: 'à traiter', adminTab: 'manuscripts' };
  const msTitle = escapeHtml(manuscript?.title || 'un manuscrit');
  const msRef = escapeHtml(manuscript?.ref || '');
  const greeting = `<p>Bonjour ${escapeHtml(recipient.label || recipient.firstname || 'cher collègue')},</p>`;
  const adminUrl = `${siteUrl || ''}/admin/${roleInfo.adminTab}`;

  let subject, body;
  if (kind === 'unassigned') {
    subject = `[Workflow] ${msTitle} — désassignation`;
    body = header('Manuscrit retiré')
      + greeting
      + `<p>Le manuscrit <strong>« ${msTitle} »</strong> (${msRef}) ne vous est plus assigné comme ${roleInfo.label}. Vous n'avez plus d'action à mener dessus.</p>`;
  } else {
    subject = `[Workflow] ${msTitle} — nouveau dossier ${roleInfo.label}`;
    body = header('Nouveau manuscrit assigné')
      + greeting
      + `<p>Le manuscrit <strong>« ${msTitle} »</strong> (${msRef}) vous est confié en tant que <strong>${roleInfo.label}</strong>. Il sera ${roleInfo.task} dès qu'il atteindra l'étape correspondante.</p>`
      + btn('Accéder à mes dossiers', adminUrl);
  }

  return transporter.sendMail({
    to: recipient.email,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
  }).catch((err) => console.error('[WORKFLOW] Assignment email error:', err.message));
}

/**
 * Email de tâche à un intervenant externe (sans compte). Décrit le travail
 * attendu et fournit un lien de téléchargement sécurisé du fichier à traiter.
 * Le retour du travail se fait par réponse email à l'équipe éditoriale.
 * recipient = { nom, email, metier }
 */
export function sendIntervenantTaskEmail(transporter, manuscript, toStage, recipient, downloadUrl, siteUrl, attachments = null) {
  if (!transporter || !recipient?.email) return Promise.resolve();
  void siteUrl;
  const roleInfo = ROLE_LABELS[recipient.metier] || { label: recipient.metier || 'intervenant' };
  const msTitle = escapeHtml(manuscript?.title || 'un manuscrit');
  const msRef = escapeHtml(manuscript?.ref || '');
  const greeting = `<p>Bonjour ${escapeHtml(recipient.nom || 'cher collègue')},</p>`;

  const TASK_COPY = {
    in_evaluation: { subject: 'Manuscrit à évaluer', intro: `Nous sollicitons votre évaluation du manuscrit <strong>« ${msTitle} »</strong>`, fileLabel: 'Télécharger le manuscrit' },
    in_correction: { subject: 'Manuscrit à corriger', intro: `Le manuscrit <strong>« ${msTitle} »</strong> vous est confié pour correction`, fileLabel: 'Télécharger le fichier à corriger' },
    cover_design: { subject: 'Couverture à concevoir', intro: `Merci de concevoir la couverture du manuscrit <strong>« ${msTitle} »</strong>`, fileLabel: 'Télécharger le texte final' },
    printing: { subject: "Ouvrage à imprimer", intro: `L'ouvrage <strong>« ${msTitle} »</strong> est prêt pour l'impression`, fileLabel: "Télécharger le fichier d'impression" },
  };
  const copy = TASK_COPY[toStage] || { subject: 'Nouvelle tâche', intro: `Une tâche vous est confiée pour <strong>« ${msTitle} »</strong>`, fileLabel: 'Télécharger le fichier' };

  const hasAttachment = !!(attachments && attachments.length);

  let body = header(copy.subject)
    + greeting
    + `<p>${copy.intro} (référence ${msRef}).</p>`;
  if (hasAttachment) {
    body += `<p>Vous trouverez <strong>le fichier à traiter en pièce jointe</strong> de cet email.</p>`;
    if (downloadUrl) {
      body += `<p>Il reste également téléchargeable via ce lien sécurisé (valable 7 jours) :</p>`
        + btn(copy.fileLabel, downloadUrl);
    }
  } else if (downloadUrl) {
    body += `<p>Le fichier à traiter est disponible via ce lien sécurisé (valable 7 jours) :</p>`
      + btn(copy.fileLabel, downloadUrl);
  } else {
    body += `<p>L'éditeur vous transmettra le fichier à traiter.</p>`;
  }
  body += `<p style="color:#555">Une fois votre travail terminé, merci de le renvoyer par retour d'email à l'équipe éditoriale.</p>`;

  const mail = {
    from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
    to: recipient.email,
    subject: `[${roleInfo.label}] ${manuscript?.title || 'Manuscrit'}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
  };
  if (hasAttachment) mail.attachments = attachments;
  return transporter.sendMail(mail).catch((err) => console.error('[WORKFLOW] Intervenant email error:', err.message));
}

/**
 * Soumission d'un ouvrage en plusieurs tomes (chaque tome = un manuscrit lié
 * en série). Au lieu de N notifications « submitted », on envoie :
 *   - une notification in-app par tome (chaque dossier est suivi séparément) ;
 *   - UN seul email de confirmation à l'auteur, récapitulant tous les tomes ;
 *   - UN seul email aux admins.
 */
export function notifySeriesSubmission(db, transporter, manuscripts, author, seriesTitle, siteUrl) {
  if (!Array.isArray(manuscripts) || manuscripts.length === 0) return;

  // 1. Notification in-app par tome (toujours, même sans transporter)
  if (author?.id) {
    for (const m of manuscripts) createAuthorNotification(db, m, 'submitted', author, siteUrl);
  }
  if (!transporter) return;

  const work = escapeHtml(seriesTitle || manuscripts[0]?.title || 'votre ouvrage');
  const count = manuscripts.length;
  const tomesList = manuscripts
    .map((m) => `<li><strong>${escapeHtml(m.title || '')}</strong> — réf. ${escapeHtml(m.ref || '')}</li>`)
    .join('');

  // 2. Confirmation auteur — un seul email groupé (selon préférences)
  if (author?.email && shouldEmailAuthor(db, author.id, 'submitted')) {
    const authorUrl = `${siteUrl || ''}/auteur`;
    const body = header('Manuscrits bien reçus')
      + `<p>Bonjour ${escapeHtml(author.firstname || '')},</p>`
      + `<p>Nous avons bien reçu votre ouvrage <strong>« ${work} »</strong> en <strong>${count} tomes</strong> :</p>`
      + `<ul>${tomesList}</ul>`
      + `<p>Chaque tome suit son propre parcours éditorial. Vous pouvez en suivre l'évolution depuis votre espace auteur.</p>`
      + btn('Accéder à mon espace', authorUrl);
    transporter.sendMail({
      from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
      to: author.email,
      subject: `Confirmation de réception — ${work} (${count} tomes)`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
    }).catch((err) => console.error('[WORKFLOW] series author email error:', err.message));
  }

  // 3. Admin général — un seul email groupé
  try {
    const fs = global.__siteConfigFallback;
    const configEmail = fs?.contact?.emails?.[0];
    if (configEmail) {
      const adminUrl = `${siteUrl || ''}/admin/manuscripts`;
      const body = header('Nouvelle soumission multi-tomes')
        + `<p>Bonjour,</p>`
        + `<p>Un nouvel ouvrage en <strong>${count} tomes</strong> vient d'être soumis : <strong>« ${work} »</strong>.</p>`
        + `<ul>${tomesList}</ul>`
        + `<p>Chaque tome est un dossier distinct (ISBN, contrat et impression propres).</p>`
        + btn('Voir dans l\'admin', adminUrl);
      transporter.sendMail({
        from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
        to: configEmail,
        subject: `[Manuscrit] Nouvelle soumission multi-tomes — ${work}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
      }).catch((err) => console.error('[WORKFLOW] series admin email error:', err.message));
    }
  } catch (err) { void err; }
}

/**
 * Résout la liste des destinataires pour une transition, envoie les mails
 * et crée une notification in-app pour l'auteur.
 */
export function notifyTransition(db, transporter, manuscript, toStage, actor, siteUrl, opts = {}) {
  // 1. Auteur : notification in-app (toujours) + email (selon préférences)
  const author = db.prepare('SELECT id, email, firstname, lastname FROM authors WHERE id = ?').get(manuscript.author_id);
  if (author?.id) {
    // Notification in-app — toujours créée, même sans transporter et même si email opt-out
    createAuthorNotification(db, manuscript, toStage, author, siteUrl);

    // Email — uniquement si transporter dispo, email connu, ET préférence active pour la catégorie
    if (transporter && author.email && shouldEmailAuthor(db, author.id, toStage)) {
      // Pièce jointe optionnelle : le rapport de lecture, joint à l'email
      // d'acceptation lorsque l'évaluateur l'a explicitement demandé.
      let authorAttachments = null;
      if (opts.attachEvaluationReport && toStage === 'evaluation_positive') {
        try {
          const report = db.prepare(
            `SELECT file_path, file_name FROM manuscript_files
             WHERE manuscript_id = ? AND kind = 'evaluation_report'
             ORDER BY version DESC, uploaded_at DESC LIMIT 1`
          ).get(manuscript.id);
          if (report?.file_path && existsSync(report.file_path)) {
            authorAttachments = [{ filename: report.file_name || 'rapport-de-lecture', path: report.file_path }];
          } else {
            console.warn('[WORKFLOW] Rapport de lecture introuvable — email d\'acceptation envoyé sans pièce jointe (manuscrit', manuscript.id, ')');
          }
        } catch (err) { console.warn('[WORKFLOW] Erreur pièce jointe rapport de lecture:', err.message); }
      }
      sendTransitionEmail(transporter, manuscript, toStage, {
        type: 'author',
        email: author.email,
        firstname: author.firstname,
      }, siteUrl, authorAttachments);
    }
  }

  if (!transporter) return;

  // 2. Prochain acteur métier EXTERNE : email + lien de téléchargement sécurisé,
  //    résolu depuis le carnet d'intervenants (plus de compte connecté).
  const roleToContact = {
    in_evaluation: 'assigned_evaluator_contact_id',
    in_correction: 'assigned_corrector_contact_id',
    printing: 'assigned_printer_contact_id',
  };
  // Couverture : désormais conçue en interne par la Production éditoriale
  // (assigned_editor_id, notifié plus bas). On ne sollicite l'ancien
  // intervenant externe « infographiste » que pour un manuscrit hérité dépourvu
  // d'éditeur interne assigné.
  if (toStage === 'cover_design' && !manuscript.assigned_editor_id) {
    roleToContact.cover_design = 'assigned_infographist_contact_id';
  }
  const contactCol = roleToContact[toStage];
  let notifiedContact = false;
  if (contactCol && manuscript[contactCol]) {
    try {
      const intervenant = db.prepare(
        'SELECT id, nom, email, metier FROM intervenants WHERE id = ? AND is_active = 1'
      ).get(manuscript[contactCol]);
      if (intervenant?.email) {
        let downloadUrl = null;
        let attachments = null;
        const file = pickFileForActor(db, manuscript.id, toStage);
        if (file) {
          const token = createFileToken(db, { manuscriptId: manuscript.id, fileId: file.id, intervenantId: intervenant.id });
          downloadUrl = `${siteUrl || ''}/api/files/manuscript/${token}/download`;
          // En plus du lien, on joint le fichier directement à l'email pour le
          // confort de l'intervenant (ex. correcteur), tant qu'il reste sous le
          // plafond raisonnable des pièces jointes. Sinon, le lien suffit.
          try {
            if (file.file_path && existsSync(file.file_path)) {
              const size = statSync(file.file_path).size;
              if (size > 0 && size <= MAX_EMAIL_ATTACHMENT_BYTES) {
                attachments = [{ filename: file.file_name || 'manuscrit', path: file.file_path }];
              } else {
                console.warn('[WORKFLOW] Fichier trop volumineux pour pièce jointe — lien seul (manuscrit', manuscript.id, ',', size, 'octets)');
              }
            }
          } catch (err) { console.warn('[WORKFLOW] Erreur pièce jointe intervenant:', err.message); }
        }
        sendIntervenantTaskEmail(transporter, manuscript, toStage, intervenant, downloadUrl, siteUrl, attachments);
        notifiedContact = true;
      }
    } catch (err) {
      console.warn('[WORKFLOW] intervenant notify error:', err.message);
    }
  }

  // 2b. Production éditoriale interne (compte admin_users) : validation
  //     éditoriale ET conception de la couverture (fusion Éditeur/Infographiste).
  if ((toStage === 'in_editorial' || toStage === 'cover_design') && manuscript.assigned_editor_id) {
    try {
      const admin = db.prepare('SELECT username, role, email FROM admin_users WHERE id = ?').get(manuscript.assigned_editor_id);
      if (admin?.email) {
        sendTransitionEmail(transporter, manuscript, toStage, {
          type: 'admin', email: admin.email, role: admin.role, label: admin.username,
        }, siteUrl);
        notifiedContact = true;
      }
    } catch (err) { console.warn('[WORKFLOW] editor notify error:', err.message); }
  }

  // 2c. Repli historique : manuscrits affectés via l'ancien système (admin_users)
  //     avant la migration. On notifie l'ancien assigné uniquement si aucun
  //     intervenant du carnet n'a déjà été notifié pour cette étape.
  const legacyRoleToColumn = {
    in_evaluation: 'assigned_evaluator_id',
    in_correction: 'assigned_corrector_id',
    cover_design: 'assigned_infographist_id',
    print_preparation: 'assigned_printer_id',
    printing: 'assigned_printer_id',
  };
  const legacyCol = legacyRoleToColumn[toStage];
  if (!notifiedContact && legacyCol && manuscript[legacyCol]) {
    try {
      const admin = db.prepare('SELECT username, role, email FROM admin_users WHERE id = ?').get(manuscript[legacyCol]);
      if (admin?.email) {
        sendTransitionEmail(transporter, manuscript, toStage, {
          type: 'admin', email: admin.email, role: admin.role, label: admin.username,
        }, siteUrl);
      }
    } catch (err) { console.warn('[WORKFLOW] legacy assignee notify error:', err.message); }
  }

  // 3. Admins généraux sur transitions clés (nouvelle soumission, paiement attendu,
  //    évaluation positive, contrat signé, éditorial validé — étapes qui nécessitent
  //    une action humaine côté équipe ou un suivi rapproché)
  const adminEmailStages = ['submitted', 'evaluation_positive', 'payment_pending', 'editorial_validated', 'contract_signed'];
  if (adminEmailStages.includes(toStage)) {
    try {
      const fs = global.__siteConfigFallback;
      const configEmail = fs?.contact?.emails?.[0];
      if (configEmail) {
        sendTransitionEmail(transporter, manuscript, toStage, {
          type: 'admin',
          email: configEmail,
          role: 'admin',
          label: 'Administrateur',
        }, siteUrl);
      }
    } catch (err) { /* fallback silencieux */ void err; }
  }

  // 4. Comptable : élaboration du contrat et du devis dès l'évaluation favorable.
  //    Destinataire configurable, par défaut Issa NDIAYE (demande direction).
  if (toStage === 'evaluation_positive') {
    const accountantEmail = process.env.MANUSCRIPT_ACCOUNTANT_EMAIL || 'issa.ndiaye@senharmattan.com';
    const accountantName = process.env.MANUSCRIPT_ACCOUNTANT_NAME || 'Issa NDIAYE';
    if (accountantEmail) {
      try {
        const authorName = author ? `${author.firstname || ''} ${author.lastname || ''}`.trim() : '';
        sendAccountantEvaluationEmail(transporter, {
          manuscript, authorName, accountantEmail, accountantName, siteUrl,
        });
      } catch (err) { console.warn('[WORKFLOW] accountant notify error:', err.message); }
    }
  }
}
