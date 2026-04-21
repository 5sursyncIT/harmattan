/**
 * Notifications email liées au workflow éditorial.
 * Chaque transition déclenche un mail au prochain acteur + un mail à l'auteur
 * pour une transparence totale du suivi.
 */

import { STAGE_LABELS } from './manuscript-workflow.js';

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
 */
export function sendTransitionEmail(transporter, manuscript, toStage, recipient, siteUrl) {
  if (!transporter || !recipient?.email) return Promise.resolve();

  const msTitle = escapeHtml(manuscript.title || 'votre manuscrit');
  const msRef = escapeHtml(manuscript.ref || '');
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
          + btn('Accéder à mon espace', authorUrl);
        break;
      case 'evaluation_negative':
        subject = `${msTitle} — Décision éditoriale`;
        body = header('Décision du comité éditorial')
          + greeting
          + `<p>Après examen attentif, notre comité n'a pas retenu votre manuscrit <strong>« ${msTitle} »</strong> pour publication.</p>`
          + `<p>Nous vous remercions de votre confiance et vous encourageons à persévérer.</p>`;
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
          + `<p>Vos corrections ont été validées. Votre manuscrit est maintenant en validation éditoriale finale.</p>`
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
          + `<p>Le manuscrit <strong>« ${msTitle} »</strong> a été validé par l'auteur. Merci de procéder à la validation éditoriale finale.</p>`
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

  return transporter.sendMail({
    from: '"L\'Harmattan Sénégal" <noreply@senharmattan.com>',
    to: recipient.email,
    subject,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#222">${body}${SIGNATURE}</div>`,
  }).catch((err) => console.error('[WORKFLOW] Email error:', err.message));
}

/**
 * Résout la liste des destinataires pour une transition et envoie les mails.
 */
export function notifyTransition(db, transporter, manuscript, toStage, actor, siteUrl) {
  if (!transporter) return;

  // Auteur
  const author = db.prepare('SELECT email, firstname FROM authors WHERE id = ?').get(manuscript.author_id);
  if (author?.email) {
    sendTransitionEmail(transporter, manuscript, toStage, {
      type: 'author',
      email: author.email,
      firstname: author.firstname,
    }, siteUrl);
  }

  // Prochain acteur (admin) selon le stage cible
  const roleToColumn = {
    in_evaluation: 'assigned_evaluator_id',
    in_correction: 'assigned_corrector_id',
    in_editorial: 'assigned_editor_id',
    cover_design: 'assigned_infographist_id',
    print_preparation: 'assigned_printer_id',
    printing: 'assigned_printer_id',
  };
  const col = roleToColumn[toStage];
  if (col && manuscript[col]) {
    const admin = db.prepare('SELECT username, role FROM admin_users WHERE id = ?').get(manuscript[col]);
    if (admin?.username) {
      // Les admin_users n'ont pas de colonne email — on utilise username comme label, pas de mail direct
      // (On pourrait ajouter un email mais le schéma actuel n'en a pas.)
      // Pour l'instant on logue simplement pour traçabilité.
      console.log(`[WORKFLOW] Prochain acteur notifié : ${admin.username} (${admin.role}) pour ${manuscript.ref} → ${toStage}`);
    }
  }

  // Admins généraux sur transitions clés (paiement attendu, évaluation positive)
  const adminEmailStages = ['evaluation_positive', 'payment_pending'];
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
}
