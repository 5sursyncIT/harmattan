import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiUser, FiPlus, FiExternalLink, FiFileText, FiLink2, FiEdit3, FiUpload, FiSend, FiLock, FiUnlock, FiStar } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { manuscriptsApi, intervenantsApi } from '../../../api/manuscripts';
import { getContracts, signContractPhysical, validateContract } from '../../../api/contracts';
import useAdminRole from '../../../hooks/useAdminRole';
import { safeHttpUrl } from '../../../utils/safeUrl';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import ManuscriptTimeline from '../../../components/common/ManuscriptTimeline';
import ManuscriptPhaseBar from '../../../components/common/ManuscriptPhaseBar';
import './ManuscriptsWorkflow.css';

// Acteurs externes affectés depuis le carnet d'intervenants (colonnes *_contact_id).
// La Production éditoriale (validation éditoriale + couverture/BAT) reste un
// compte admin_users (assigned_editor_id) : fusion Éditeur + Infographiste.
const ASSIGN_ROWS = [
  'assigned_evaluator_contact_id',
  'assigned_corrector_contact_id',
  'assigned_editor_id',
  'assigned_printer_contact_id',
];
const ROLE_LABELS = {
  assigned_evaluator_contact_id: 'Évaluateur / lecteur',
  assigned_corrector_contact_id: 'Correcteur',
  assigned_editor_id: 'Production éditoriale',
  assigned_printer_contact_id: 'Imprimeur',
};
const ROLE_API = {
  assigned_evaluator_contact_id: 'evaluateur',
  assigned_corrector_contact_id: 'correcteur',
  assigned_editor_id: 'editor',
  assigned_printer_contact_id: 'imprimeur',
};
// Étapes où la correction est déjà validée : on peut alors, sur demande de
// l'auteur, lui envoyer la confirmation (le message n'est plus automatique).
const CORRECTION_VALIDATED_STAGES = [
  'in_editorial', 'editorial_validated', 'cover_design',
  'bat_author_review', 'print_preparation', 'printing', 'printed',
  'in_communication', 'published',
];
// Ancienne colonne (historique admin_users) associée à chaque ligne, pour rappel en lecture seule.
const LEGACY_COL = {
  assigned_evaluator_contact_id: 'assigned_evaluator_id',
  assigned_corrector_contact_id: 'assigned_corrector_id',
  assigned_printer_contact_id: 'assigned_printer_id',
};

export default function ManuscriptDetailPanel() {
  const { id } = useParams();
  // Actions « éditeur » (affecter des intervenants, créer/rattacher/signer un
  // contrat, confirmer un paiement) : réservées côté backend à super_admin/admin/
  // editor (editorOnly). Les autres profils qui ouvrent cette fiche (Production
  // éditoriale, évaluateur, correcteur, imprimeur) la consultent en lecture seule
  // — on masque donc ces boutons pour eux (sinon ils s'affichent mais renvoient 403).
  const role = useAdminRole();
  const canEditWorkflow = ['super_admin', 'admin', 'editor'].includes(role);
  const isAdmin = ['super_admin', 'admin'].includes(role);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [assignModal, setAssignModal] = useState(null); // col name
  const [adminUsers, setAdminUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState('');
  const [applyToSeries, setApplyToSeries] = useState(false);
  // Création d'un intervenant directement depuis la fenêtre d'affectation.
  const [showNewIntervenant, setShowNewIntervenant] = useState(false);
  const [newIntervenant, setNewIntervenant] = useState({ nom: '', email: '' });
  const [creatingIntervenant, setCreatingIntervenant] = useState(false);
  // Contrat : création / rattachement / signature manuelle
  const [contractBusy, setContractBusy] = useState(false);
  const [linkModal, setLinkModal] = useState(false);
  const [contractQuery, setContractQuery] = useState('');
  const [contractResults, setContractResults] = useState([]);
  const [contractSearching, setContractSearching] = useState(false);
  const [signModal, setSignModal] = useState(false);
  const [signForm, setSignForm] = useState({ file: null, signed_date: '', signer_name: '' });
  const [signBusy, setSignBusy] = useState(false);
  // Notification « corrections validées » à l'auteur — sur sa demande uniquement.
  const [notifyBusy, setNotifyBusy] = useState(false);
  // Correction manuelle de l'état (erreur matérielle) — admin uniquement.
  const [stageOptions, setStageOptions] = useState({ stages: [], labels: {} });
  const [overrideModal, setOverrideModal] = useState(false);
  const [overrideForm, setOverrideForm] = useState({ to_stage: '', reason: '' });
  const [overrideBusy, setOverrideBusy] = useState(false);
  // Micro-corrections de la fiche (fautes de frappe : titre, sous-titre, genre, synopsis).
  const [editModal, setEditModal] = useState(false);
  const [editForm, setEditForm] = useState({ title: '', subtitle: '', genre: '', synopsis: '' });
  const [editBusy, setEditBusy] = useState(false);
  // Versionnage du fichier manuscrit : dépôt d'une nouvelle version (toute étape),
  // demande de révision à l'auteur (lien de dépôt), version définitive.
  const [versionModal, setVersionModal] = useState(false);
  const [versionForm, setVersionForm] = useState({ file: null, note: '' });
  const [versionBusy, setVersionBusy] = useState(false);
  const [revisionModal, setRevisionModal] = useState(false);
  const [revisionMessage, setRevisionMessage] = useState('');
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [unlockModal, setUnlockModal] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');
  const [finalBusy, setFinalBusy] = useState(false);

  const load = () => {
    setLoading(true);
    manuscriptsApi.get(id)
      .then((res) => setData(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load();   }, [id]);

  // Liste des états possibles pour le sélecteur de correction manuelle (admin).
  useEffect(() => {
    if (!isAdmin) return;
    manuscriptsApi.stages()
      .then((res) => setStageOptions({ stages: res.data?.stages || [], labels: res.data?.labels || {} }))
      .catch(() => {});
  }, [isAdmin]);

  const openAssign = (col) => {
    setAssignModal(col);
    setSelectedUser('');
    setApplyToSeries(false);
    setShowNewIntervenant(false);
    setNewIntervenant({ nom: '', email: '' });
    manuscriptsApi.adminsByRole(ROLE_API[col])
      .then((res) => setAdminUsers(res.data))
      .catch(() => setAdminUsers([]));
  };

  // Crée un intervenant (carnet) pour le métier du modal courant, puis le sélectionne.
  const createIntervenant = async () => {
    const nom = newIntervenant.nom.trim();
    const email = newIntervenant.email.trim();
    if (!nom) return toast.error('Nom requis');
    if (!EMAIL_RE.test(email)) return toast.error('Email invalide');
    setCreatingIntervenant(true);
    try {
      const res = await intervenantsApi.create({ nom, email, metier: ROLE_API[assignModal] });
      const created = res.data;
      // Même forme {id, username, role} que adminsByRole pour réutiliser le select.
      setAdminUsers((prev) => [...prev, { id: created.id, username: created.nom, role: created.metier }]);
      setSelectedUser(String(created.id));
      setShowNewIntervenant(false);
      setNewIntervenant({ nom: '', email: '' });
      toast.success(`« ${created.nom} » ajouté et sélectionné`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setCreatingIntervenant(false);
    }
  };

  const confirmAssign = async () => {
    try {
      const res = await manuscriptsApi.assign(id, ROLE_API[assignModal], selectedUser ? parseInt(selectedUser, 10) : null, applyToSeries);
      const count = res.data?.count || 1;
      toast.success(applyToSeries && count > 1 ? `Assignation appliquée à ${count} tomes` : 'Assignation mise à jour');
      setAssignModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const markPaid = async () => {
    if (!confirm('Confirmer le paiement reçu et lancer la phase de correction ?')) return;
    try {
      await manuscriptsApi.markPaid(id, 'Paiement confirmé');
      toast.success('Paiement confirmé');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // Le paiement du devis n'est pas obligatoire : on peut lancer la correction sans.
  const startCorrection = async () => {
    if (!confirm('Démarrer la correction sans attendre le paiement du devis ?')) return;
    try {
      await manuscriptsApi.startCorrection(id);
      toast.success('Correction démarrée');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // Prolongement de la frise après l'impression : relais commercial (Parutions).
  // Ces passages sont aussi automatiques via la checklist du panneau Parutions
  // (première action de lancement → « En communication » ; 17/17 → « Paru »).
  const startCommunication = async () => {
    if (!confirm('Passer cet ouvrage « En communication » (lancement commercial démarré) ?')) return;
    try {
      await manuscriptsApi.transition(id, 'in_communication', 'Lancement commercial démarré (passage manuel)');
      toast.success('Ouvrage en communication');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const markPublished = async () => {
    if (!confirm('Marquer cet ouvrage comme « Paru » ? Cette étape clôture le suivi du manuscrit.')) return;
    try {
      await manuscriptsApi.transition(id, 'published', 'Ouvrage paru — lancement commercial déroulé');
      toast.success('Ouvrage marqué comme paru');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // Après un verdict « À retravailler » : relance un cycle d'évaluation dès que
  // l'auteur a renvoyé sa version retravaillée (transition légale → in_evaluation).
  const relaunchEvaluation = async () => {
    if (!confirm('Relancer l\'évaluation de ce manuscrit (version retravaillée reçue) ?')) return;
    try {
      await manuscriptsApi.transition(id, 'in_evaluation', 'Version retravaillée reçue — nouvelle évaluation');
      toast.success('Évaluation relancée');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // Notifie l'auteur que ses corrections sont validées. L'envoi n'est plus
  // automatique à la validation (choix Direction) : on ne prévient l'auteur que
  // lorsqu'il en fait la demande.
  const notifyAuthor = async () => {
    if (!confirm('Envoyer à l\'auteur le message confirmant que ses corrections sont validées ?')) return;
    setNotifyBusy(true);
    try {
      await manuscriptsApi.notifyAuthorCorrectionValidated(id);
      toast.success('Auteur notifié (email + espace auteur)');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setNotifyBusy(false); }
  };

  // ── Micro-corrections de la fiche (faute de frappe) — admin/éditeur ──
  const openEdit = () => {
    const m = data?.manuscript || {};
    setEditForm({ title: m.title || '', subtitle: m.subtitle || '', genre: m.genre || '', synopsis: m.synopsis || '' });
    setEditModal(true);
  };
  const confirmEdit = async () => {
    if (!editForm.title.trim()) return toast.error('Le titre ne peut pas être vide');
    setEditBusy(true);
    try {
      await manuscriptsApi.updateDetails(id, {
        title: editForm.title,
        subtitle: editForm.subtitle,
        genre: editForm.genre,
        synopsis: editForm.synopsis,
      });
      toast.success('Fiche corrigée (modification tracée dans la frise)');
      setEditModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setEditBusy(false); }
  };

  // ── Correction manuelle de l'état (erreur matérielle) — admin only ──
  const openOverride = () => {
    setOverrideForm({ to_stage: data?.manuscript?.current_stage || '', reason: '' });
    setOverrideModal(true);
  };
  const confirmOverride = async () => {
    if (!overrideForm.to_stage || overrideForm.to_stage === data?.manuscript?.current_stage) {
      return toast.error('Choisissez un état différent de l\'état actuel');
    }
    if (overrideForm.reason.trim().length < 3) {
      return toast.error('Indiquez le motif de la correction');
    }
    setOverrideBusy(true);
    try {
      await manuscriptsApi.overrideStage(id, overrideForm.to_stage, overrideForm.reason.trim());
      toast.success('État du manuscrit corrigé');
      setOverrideModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setOverrideBusy(false); }
  };

  // ── Versionnage du fichier manuscrit ──
  const confirmVersionUpload = async () => {
    if (!versionForm.file) return toast.error('Choisissez le fichier de la nouvelle version');
    setVersionBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', versionForm.file);
      if (versionForm.note.trim()) fd.append('note', versionForm.note.trim());
      const res = await manuscriptsApi.uploadManuscriptVersion(id, fd);
      toast.success(`Version v${res.data?.version} enregistrée — c'est désormais la version courante`);
      setVersionModal(false);
      setVersionForm({ file: null, note: '' });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors du dépôt');
    } finally { setVersionBusy(false); }
  };

  const confirmRevisionRequest = async () => {
    setRevisionBusy(true);
    try {
      const res = await manuscriptsApi.requestAuthorRevision(id, revisionMessage.trim() || null);
      toast.success(`Lien de dépôt envoyé à l'auteur (valable ${res.data?.expires_days || 14} jours)`);
      setRevisionModal(false);
      setRevisionMessage('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setRevisionBusy(false); }
  };

  const markFinal = async (file) => {
    if (!confirm(`Arrêter la v${file.version} comme VERSION DÉFINITIVE ?\nPlus aucun dépôt ne sera possible (admin ou auteur) sans déverrouillage, et les liens de dépôt actifs seront révoqués.`)) return;
    setFinalBusy(true);
    try {
      await manuscriptsApi.markFileFinal(id, file.id);
      toast.success(`v${file.version} arrêtée comme version définitive`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setFinalBusy(false); }
  };

  const confirmUnlockFinal = async (file) => {
    if (unlockReason.trim().length < 3) return toast.error('Indiquez le motif du déverrouillage');
    setFinalBusy(true);
    try {
      await manuscriptsApi.unlockFileFinal(id, file.id, unlockReason.trim());
      toast.success('Version définitive déverrouillée — les dépôts sont rouverts');
      setUnlockModal(false);
      setUnlockReason('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setFinalBusy(false); }
  };

  const toggleMilestone = async (file) => {
    try {
      await manuscriptsApi.setFileMilestone(id, file.id, file.is_milestone ? 0 : 1);
      toast.success(file.is_milestone ? `v${file.version} retirée des jalons` : `v${file.version} marquée jalon (protégée de la purge)`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // ── Contrat : créer / rattacher / signer manuellement ──
  const createContract = async () => {
    if (!confirm('Créer un contrat brouillon Dolibarr et le rattacher à ce manuscrit ?')) return;
    setContractBusy(true);
    try {
      await manuscriptsApi.createContract(id);
      toast.success('Contrat créé et rattaché');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setContractBusy(false); }
  };

  // Sans terme : liste récente. Avec terme : recherche côté serveur (réf / titre /
  // auteur en parallèle, fusion par id) — la liste récente est plafonnée à 50, un
  // contrat ancien n'y figure pas et le filtre client seul ne le trouverait jamais.
  const loadContracts = async (query = '') => {
    setContractSearching(true);
    try {
      const q = query.trim();
      let list;
      if (q) {
        const results = await Promise.allSettled([
          getContracts({ ref: q, limit: 50 }),
          getContracts({ title: q, limit: 50 }),
          getContracts({ author: q, limit: 50 }),
        ]);
        const seen = new Map();
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const items = Array.isArray(r.value.data) ? r.value.data : (r.value.data?.contracts || r.value.data?.items || []);
          for (const c of items) if (!seen.has(c.id)) seen.set(c.id, c);
        }
        list = [...seen.values()];
      } else {
        const res = await getContracts({ limit: 50, sort: 'date', order: 'DESC' });
        list = Array.isArray(res.data) ? res.data : (res.data?.contracts || res.data?.items || []);
      }
      setContractResults(list);
    } catch { setContractResults([]); }
    finally { setContractSearching(false); }
  };
  useEffect(() => {
    if (!linkModal) return;
    const t = setTimeout(() => loadContracts(contractQuery), 300);
    return () => clearTimeout(t);
  }, [linkModal, contractQuery]);
  const openLinkModal = () => { setLinkModal(true); setContractQuery(''); };
  const confirmLink = async (contractId) => {
    setContractBusy(true);
    try {
      await manuscriptsApi.linkContract(id, contractId);
      toast.success('Contrat rattaché');
      setLinkModal(false);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setContractBusy(false); }
  };

  const openSignModal = () => {
    setSignForm({ file: null, signed_date: new Date().toISOString().slice(0, 10), signer_name: '' });
    setSignModal(true);
  };
  const confirmSign = async () => {
    if (!signForm.file) return toast.error('Le scan du contrat signé est requis');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(signForm.signed_date)) return toast.error('Date de signature requise');
    const contract = data?.contract;
    const cid = contract?.id || data?.manuscript?.contract_id;
    if (!cid) return toast.error('Aucun contrat rattaché');
    setSignBusy(true);
    try {
      // Un contrat doit être validé avant d'enregistrer une signature : on valide
      // automatiquement s'il est encore en brouillon.
      if (contract && Number(contract.statut) < 1) {
        await validateContract(cid);
      }
      const fd = new FormData();
      fd.append('scan', signForm.file);
      fd.append('signed_date', signForm.signed_date);
      if (signForm.signer_name.trim()) fd.append('signer_name', signForm.signer_name.trim());
      await signContractPhysical(cid, fd);
      toast.success('Signature manuelle enregistrée — contrat signé');
      setSignModal(false);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur'); }
    finally { setSignBusy(false); }
  };

  if (loading) return <p>Chargement...</p>;
  if (!data) return null;
  const { manuscript, stages, files, evaluations, validations, series } = data;
  const seriesTomes = Array.isArray(series) ? series : [];
  const isSeries = Boolean(manuscript.series_ref) && seriesTomes.length > 1;

  // Chaîne de versions du texte du manuscrit (kind 'original') : la plus récente
  // est LA version courante. Les autres kinds restent listés à part.
  const textVersions = (files || [])
    .filter((f) => f.kind === 'original')
    .sort((a, b) => (b.version - a.version) || (b.id - a.id));
  const currentVersion = textVersions[0] || null;
  const finalVersion = textVersions.find((f) => f.is_final) || null;
  const otherFiles = (files || []).filter((f) => f.kind !== 'original');
  const depositRequest = data.deposit_request || null;
  const fmtSize = (bytes) => {
    if (!bytes) return '';
    return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  };
  const uploaderLabel = (f) => ({
    author: 'l\'auteur', admin: 'l\'administration', super_admin: 'l\'administration',
    editor: 'l\'équipe éditoriale', production: 'la production',
  }[f.uploaded_by_role] || f.uploaded_by_role || '—');

  return (
    <div className="ms-panel">
      <Link to="/admin/manuscripts" className="back-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 16, color: '#10531a', textDecoration: 'none' }}>
        <FiArrowLeft /> Retour à la liste
      </Link>
      <h2>{manuscript.title}</h2>
      {manuscript.subtitle && (
        <p style={{ margin: '-6px 0 8px', fontSize: '1.05rem', fontStyle: 'italic', color: '#475569' }}>{manuscript.subtitle}</p>
      )}
      <p className="ms-subtitle">
        Référence <strong>{manuscript.ref}</strong> ·
        <span className={`ms-stage-badge ms-stage-${manuscript.current_stage}`} style={{ marginLeft: 8 }}>
          {manuscript.stage_label}
        </span>
        {canEditWorkflow && (
          <button
            type="button" className="ms-btn" onClick={openEdit}
            title="Micro-corrections de la fiche (faute de frappe : titre, sous-titre, genre, synopsis)"
            style={{ marginLeft: 10, fontSize: '0.78rem', padding: '2px 10px', verticalAlign: 'middle' }}
          >
            <FiEdit3 style={{ verticalAlign: 'middle', marginRight: 4 }} /> Modifier la fiche
          </button>
        )}
        {isAdmin && (
          <button
            type="button" className="ms-btn" onClick={openOverride}
            title="Corriger l'état en cas d'erreur (ex. manuscrit rejeté par erreur)"
            style={{ marginLeft: 8, fontSize: '0.78rem', padding: '2px 10px', verticalAlign: 'middle' }}
          >
            <FiEdit3 style={{ verticalAlign: 'middle', marginRight: 4 }} /> Corriger l'état
          </button>
        )}
      </p>

      {isSeries && (
        <div className="ms-series-banner">
          <div className="ms-series-banner-head">
            <span>
              Fait partie de la série <strong>« {manuscript.series_title || manuscript.title} »</strong>
              {manuscript.tome_number ? ` — Tome ${manuscript.tome_number} sur ${manuscript.tome_total || seriesTomes.length}` : ''}
            </span>
          </div>
          <div className="ms-series-tomes">
            {seriesTomes.map((t) => (
              t.id === manuscript.id ? (
                <span key={t.id} className="ms-series-tome current" title={t.title}>
                  Tome {t.tome_number || '?'} (ce dossier)
                </span>
              ) : (
                <Link key={t.id} to={`/admin/manuscripts/${t.id}`} className="ms-series-tome" title={t.title}>
                  Tome {t.tome_number || '?'} — {t.stage_label}
                </Link>
              )
            ))}
          </div>
        </div>
      )}

      {manuscript.current_stage === 'evaluation_rework' && canEditWorkflow && (
        <div className="ms-action-banner">
          <h4>Manuscrit à retravailler</h4>
          <p>
            Le comité a demandé à l&apos;auteur de <strong>retravailler son manuscrit</strong>.
            L&apos;auteur peut déposer la nouvelle version depuis son espace
            (transition automatique vers « En évaluation »). Vous pouvez aussi
            relancer manuellement l&apos;évaluation si le fichier a été reçu hors portail.
          </p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={relaunchEvaluation}>Relancer l&apos;évaluation</button>
          </div>
        </div>
      )}

      {['contract_signed', 'payment_pending'].includes(manuscript.current_stage) && canEditWorkflow && (
        <div className="ms-action-banner">
          <h4>Prêt pour la correction</h4>
          <p>Le paiement du devis <strong>n'est pas obligatoire</strong> pour démarrer la correction : vous pouvez la lancer dès la signature du contrat. L'encaissement du devis reste un acte comptable distinct.</p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={startCorrection}>Démarrer la correction</button>
            {isAdmin && manuscript.current_stage === 'payment_pending' && (
              <button type="button" className="ms-btn" onClick={markPaid}>Confirmer le paiement</button>
            )}
          </div>
        </div>
      )}

      {CORRECTION_VALIDATED_STAGES.includes(manuscript.current_stage) && canEditWorkflow && (
        <div className="ms-action-banner">
          <h4>Notifier l'auteur de la validation des corrections</h4>
          <p>
            L'auteur n'est <strong>pas prévenu automatiquement</strong> que ses corrections sont validées.
            Envoyez-lui le message (email + espace auteur) <strong>uniquement s'il en fait la demande</strong>.
          </p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={notifyAuthor} disabled={notifyBusy}>
              {notifyBusy ? 'Envoi…' : 'Notifier l\'auteur'}
            </button>
          </div>
        </div>
      )}

      {manuscript.current_stage === 'printed' && canEditWorkflow && (
        <div className="ms-action-banner">
          <h4>Impression terminée — place à la communication</h4>
          <p>
            Le suivi continue jusqu'à la parution : passez l'ouvrage <strong>« En communication »</strong> pour
            suivre le lancement commercial (checklist du panneau Parutions). Le passage est aussi
            <strong> automatique</strong> dès la première action de lancement cochée dans Parutions.
          </p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={startCommunication}>Démarrer la communication</button>
          </div>
        </div>
      )}

      {manuscript.current_stage === 'in_communication' && canEditWorkflow && (
        <div className="ms-action-banner">
          <h4>Lancement commercial en cours</h4>
          <p>
            Déroulez la checklist de parution dans le panneau Parutions (l'ouvrage passera
            <strong> automatiquement</strong> à « Paru » quand elle sera complète), ou marquez-le
            paru manuellement.
          </p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={markPublished}>Marquer comme paru</button>
          </div>
        </div>
      )}

      {manuscript.current_stage === 'contract_pending' && canEditWorkflow && (
        <div className="ms-action-banner">
          <h4>Contrat à signer</h4>
          <p>Si le contrat a été signé sur papier, enregistrez la <strong>signature manuelle</strong> (scan du contrat signé obligatoire) pour valider l'état « Contrat signé ».</p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={openSignModal} disabled={!data.contract}>
              <FiEdit3 style={{ verticalAlign: 'middle', marginRight: 6 }} />Signature manuelle
            </button>
          </div>
          {!data.contract && <small style={{ color: '#9ca3af' }}>Rattachez d'abord un contrat à ce manuscrit (carte « Contrat &amp; Devis »).</small>}
        </div>
      )}

      {/* Frise résumé du parcours (9 phases, du dépôt à la parution) —
          complément visuel de l'historique détaillé plus bas. */}
      <ManuscriptPhaseBar
        currentStage={manuscript.current_stage}
        stageLabel={manuscript.stage_label}
        history={stages}
      />

      <div className="ms-detail-layout">
        <div>
          <div className="ms-card">
            <h3>Informations</h3>
            <dl className="ms-meta-grid">
              <div>
                <dt>Auteur</dt>
                <dd><FiUser style={{ verticalAlign: 'middle' }} /> {manuscript.author_name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{manuscript.author_email}</dd>
              </div>
              <div>
                <dt>Genre</dt>
                <dd>{manuscript.genre || '—'}</dd>
              </div>
              <div>
                <dt>ISBN</dt>
                <dd>{manuscript.isbn || '—'}</dd>
              </div>
              <div>
                <dt>Tirage prévu</dt>
                <dd>{manuscript.print_qty || '—'}</dd>
              </div>
              <div>
                <dt>Contrat Dolibarr</dt>
                <dd>{manuscript.contract_id ? `#${manuscript.contract_id}` : '—'}</dd>
              </div>
              <div>
                <dt>Ordre d'impression</dt>
                <dd>{manuscript.dolibarr_mo_ref || '—'}</dd>
              </div>
            </dl>
            {manuscript.synopsis && (
              <>
                <h3 style={{ marginTop: 16 }}>Synopsis</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{manuscript.synopsis}</p>
              </>
            )}
          </div>

          <div className="ms-card">
            <h3><FiFileText style={{ verticalAlign: 'middle', marginRight: 6 }} />Contrat &amp; Devis</h3>
            {data.contract ? (
              <>
                <dl className="ms-meta-grid">
                  <div><dt>Contrat</dt><dd>{data.contract.ref} <span style={{ color: '#9ca3af' }}>(#{data.contract.id})</span></dd></div>
                  <div><dt>Statut</dt><dd>{data.contract.status_label}</dd></div>
                  <div><dt>Signature</dt><dd>{data.contract.signed_label}{data.contract.signer_name ? ` — ${data.contract.signer_name}` : ''}{data.contract.signed_date ? ` (${data.contract.signed_date})` : ''}</dd></div>
                  {data.contract.book_isbn && <div><dt>ISBN</dt><dd>{data.contract.book_isbn}</dd></div>}
                </dl>
                {data.contract.quotes?.length ? (
                  <>
                    <h4 style={{ margin: '12px 0 6px' }}>Devis ({data.contract.quotes.length})</h4>
                    <ul className="ms-file-list">
                      {data.contract.quotes.map((q) => (
                        <li key={q.id}>
                          <div>
                            <span className="ms-file-kind">{q.status}</span> {q.ref} — {Number(q.total || 0).toLocaleString('fr-FR')} FCFA
                            {q.invoice_ref ? <span style={{ color: '#6b7280' }}> · {q.invoice_ref}</span> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : <p style={{ color: '#6b7280', marginTop: 10 }}>Aucun devis sur ce contrat.</p>}
              </>
            ) : (
              <>
                <p style={{ color: '#6b7280' }}>Aucun contrat rattaché à ce manuscrit.</p>
                {['submitted', 'in_evaluation', 'evaluation_rework', 'evaluation_negative'].includes(manuscript.current_stage) ? (
                  <small style={{ color: '#9ca3af' }}>Un contrat se crée après une évaluation favorable.</small>
                ) : canEditWorkflow ? (
                  <div className="ms-actions">
                    {manuscript.current_stage === 'evaluation_positive' && (
                      <button type="button" className="ms-btn ms-btn-primary" onClick={createContract} disabled={contractBusy}>
                        <FiPlus style={{ verticalAlign: 'middle', marginRight: 6 }} />Créer le contrat
                      </button>
                    )}
                    <button type="button" className="ms-btn" onClick={openLinkModal} disabled={contractBusy}>
                      <FiLink2 style={{ verticalAlign: 'middle', marginRight: 6 }} />Rattacher un contrat existant
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* ── Fichier manuscrit : UNE version courante, historique replié ── */}
          <div className="ms-card">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <FiFileText style={{ verticalAlign: 'middle' }} />Fichier manuscrit
              {finalVersion && (
                <span style={{ background: '#10531a', color: '#fff', borderRadius: 12, padding: '2px 10px', fontSize: '0.7rem', letterSpacing: 0.5 }}>
                  <FiLock style={{ verticalAlign: 'middle', marginRight: 4 }} />DÉFINITIVE — v{finalVersion.version}
                </span>
              )}
            </h3>
            {currentVersion ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      v{currentVersion.version} — {currentVersion.file_name}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>
                      Déposée par {uploaderLabel(currentVersion)} le {new Date(currentVersion.uploaded_at).toLocaleString('fr-FR')}
                      {currentVersion.file_size ? ` · ${fmtSize(currentVersion.file_size)}` : ''}
                    </div>
                    {currentVersion.note && (
                      <div style={{ fontSize: '0.8rem', color: '#4b5563', marginTop: 2, fontStyle: 'italic' }}>« {currentVersion.note} »</div>
                    )}
                  </div>
                  {!currentVersion.binary_purged && (
                    <a href={manuscriptsApi.downloadUrl(manuscript.id, currentVersion.id)}
                      target="_blank" rel="noopener noreferrer" className="ms-btn">
                      <FiDownload /> Télécharger
                    </a>
                  )}
                </div>

                {depositRequest && !finalVersion && (
                  <p style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', fontSize: '0.82rem', color: '#854d0e', margin: '10px 0 0' }}>
                    <FiSend style={{ verticalAlign: 'middle', marginRight: 6 }} />
                    Lien de dépôt actif envoyé à l&apos;auteur — expire le {new Date(depositRequest.expires_at).toLocaleDateString('fr-FR')}
                    {' '}(dépôts restants : {Math.max(0, depositRequest.max_uses - depositRequest.used_count)}).
                    Renvoyer une demande génère un nouveau lien et révoque celui-ci.
                  </p>
                )}

                {canEditWorkflow && (
                  <div className="ms-actions" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                    {finalVersion ? (
                      isAdmin && (
                        <button type="button" className="ms-btn" onClick={() => { setUnlockReason(''); setUnlockModal(true); }} disabled={finalBusy}>
                          <FiUnlock style={{ verticalAlign: 'middle', marginRight: 6 }} />Déverrouiller la version définitive
                        </button>
                      )
                    ) : (
                      <>
                        <button type="button" className="ms-btn ms-btn-primary" onClick={() => { setVersionForm({ file: null, note: '' }); setVersionModal(true); }}>
                          <FiUpload style={{ verticalAlign: 'middle', marginRight: 6 }} />Déposer une nouvelle version
                        </button>
                        <button type="button" className="ms-btn" onClick={() => { setRevisionMessage(''); setRevisionModal(true); }}>
                          <FiSend style={{ verticalAlign: 'middle', marginRight: 6 }} />Demander une révision à l&apos;auteur
                        </button>
                        {isAdmin && (
                          <button type="button" className="ms-btn" onClick={() => markFinal(currentVersion)} disabled={finalBusy}>
                            <FiLock style={{ verticalAlign: 'middle', marginRight: 6 }} />Arrêter comme version définitive
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}

                {textVersions.length > 1 && (
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: 'pointer', color: '#10531a', fontSize: '0.85rem' }}>
                      Historique des versions ({textVersions.length})
                    </summary>
                    <ul className="ms-file-list" style={{ marginTop: 8 }}>
                      {textVersions.map((f) => (
                        <li key={f.id}>
                          <div style={{ minWidth: 0 }}>
                            <strong>v{f.version}</strong> {f.file_name}
                            {!!f.is_final && <span style={{ color: '#10531a', fontSize: '0.72rem', marginLeft: 6 }}><FiLock style={{ verticalAlign: 'middle' }} /> définitive</span>}
                            {!!f.is_milestone && !f.is_final && <span style={{ color: '#b45309', fontSize: '0.72rem', marginLeft: 6 }}><FiStar style={{ verticalAlign: 'middle' }} /> jalon</span>}
                            {!!f.binary_purged && <span style={{ color: '#9ca3af', fontSize: '0.72rem', marginLeft: 6 }}>archivée (fichier purgé)</span>}
                            <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>
                              {uploaderLabel(f)} · {new Date(f.uploaded_at).toLocaleString('fr-FR')}
                              {f.note ? ` · « ${f.note} »` : ''}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            {canEditWorkflow && !f.binary_purged && !f.is_final && (
                              <button
                                type="button" className="ms-btn"
                                title={f.is_milestone ? 'Retirer le jalon (la version redevient purgeable)' : 'Marquer jalon : cette version ne sera jamais purgée'}
                                onClick={() => toggleMilestone(f)}
                              >
                                <FiStar style={{ verticalAlign: 'middle', color: f.is_milestone ? '#b45309' : undefined }} />
                              </button>
                            )}
                            {!f.binary_purged && (
                              <a href={manuscriptsApi.downloadUrl(manuscript.id, f.id)}
                                target="_blank" rel="noopener noreferrer" className="ms-btn">
                                <FiDownload />
                              </a>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                    <p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '6px 0 0' }}>
                      Rétention automatique : la première version, les deux plus récentes et les jalons restent téléchargeables ;
                      les fichiers des versions intermédiaires sont purgés (métadonnées et empreinte conservées).
                    </p>
                  </details>
                )}
              </>
            ) : <p style={{ color: '#6b7280' }}>Aucun fichier manuscrit.</p>}
          </div>

          <div className="ms-card">
            <h3>Autres documents ({otherFiles.length})</h3>
            {otherFiles.length ? (
              <ul className="ms-file-list">
                {otherFiles.map((f) => (
                  <li key={f.id}>
                    <div>
                      <span className="ms-file-kind">{f.kind_label || f.kind}</span>
                      {f.version > 1 && <strong>v{f.version}</strong>} {f.file_name}
                      {!!f.binary_purged && <span style={{ color: '#9ca3af', fontSize: '0.72rem', marginLeft: 6 }}>archivé (fichier purgé)</span>}
                    </div>
                    {safeHttpUrl(f.external_url) ? (
                      <a href={safeHttpUrl(f.external_url)}
                        target="_blank" rel="noopener noreferrer"
                        className="ms-btn">
                        <FiExternalLink /> Ouvrir le lien
                      </a>
                    ) : !f.binary_purged ? (
                      <a href={manuscriptsApi.downloadUrl(manuscript.id, f.id)}
                        target="_blank" rel="noopener noreferrer"
                        className="ms-btn">
                        <FiDownload /> Télécharger
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : <p style={{ color: '#6b7280' }}>Aucun autre document.</p>}
          </div>

          {evaluations?.length > 0 && (
            <div className="ms-card">
              <h3>Évaluations ({evaluations.length})</h3>
              {evaluations.map((ev) => (
                <div key={ev.id} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <strong style={{ color: ev.verdict === 'positive' ? '#10531a' : ev.verdict === 'rework' ? '#d97706' : '#dc2626' }}>
                    {ev.verdict === 'positive' ? 'Avis favorable' : ev.verdict === 'rework' ? 'À retravailler' : 'Avis défavorable'}
                  </strong>
                  {ev.recommendation && <span> · {ev.recommendation}</span>}
                  {ev.note && <p style={{ color: '#4b5563', margin: '4px 0 0' }}>{ev.note}</p>}
                  <small style={{ color: '#6b7280' }}>{new Date(ev.created_at).toLocaleString('fr-FR')}</small>
                </div>
              ))}
            </div>
          )}

          {validations?.length > 0 && (
            <div className="ms-card">
              <h3>Validations auteur ({validations.length})</h3>
              {validations.map((v) => (
                <div key={v.id} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <strong>{v.kind === 'bat' ? 'BAT' : 'Correction'}</strong> · {v.decision === 'approved' ? '✓ Validé' : '✗ Modifications demandées'}
                  {v.comment && <p style={{ color: '#4b5563', margin: '4px 0 0' }}>{v.comment}</p>}
                  <small style={{ color: '#6b7280' }}>{new Date(v.created_at).toLocaleString('fr-FR')}</small>
                </div>
              ))}
            </div>
          )}
        </div>

        <aside>
          <div className="ms-card">
            <h3>Assignations</h3>
            {ASSIGN_ROWS.map((col) => {
              const legacyCol = LEGACY_COL[col];
              const legacyVal = legacyCol ? manuscript[legacyCol] : null;
              return (
                <div key={col} style={{ marginBottom: 10, fontSize: '0.88rem' }}>
                  <div style={{ color: '#6b7280', fontSize: '0.78rem' }}>{ROLE_LABELS[col]}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{manuscript[col] ? (manuscript[`${col}_name`] || `#${manuscript[col]}`) : <em style={{ color: '#6b7280' }}>non assigné</em>}</span>
                    {canEditWorkflow && <button type="button" className="ms-btn" onClick={() => openAssign(col)}>Modifier</button>}
                  </div>
                  {legacyVal && (
                    <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 2 }}>
                      Ancien (historique) : {manuscript[`${legacyCol}_name`] || `#${legacyVal}`}
                    </div>
                  )}
                  {col === 'assigned_editor_id' && manuscript.assigned_infographist_contact_id && (
                    <div style={{ fontSize: '0.72rem', color: '#9ca3af', marginTop: 2 }}>
                      Ancien infographiste : {manuscript.assigned_infographist_contact_id_name || `#${manuscript.assigned_infographist_contact_id}`}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ms-card">
            <h3>Historique</h3>
            <ManuscriptTimeline stages={stages} showFullJournalToggle />
          </div>
        </aside>
      </div>

      {assignModal && (
        <div className="ms-modal-backdrop" onClick={() => setAssignModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Assigner : {ROLE_LABELS[assignModal]}</h3>
            <div className="form-group">
              <label>Destinataire</label>
              <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                <option value="">— Aucun —</option>
                {adminUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username}</option>
                ))}
              </select>

              {/* Création inline d'un intervenant (uniquement pour les acteurs externes du carnet). */}
              {assignModal !== 'assigned_editor_id' && (
                showNewIntervenant ? (
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, marginTop: 10 }}>
                    <div style={{ fontSize: '0.8rem', color: '#6b7280', marginBottom: 8 }}>
                      Nouvel intervenant — {ROLE_LABELS[assignModal]}
                    </div>
                    <input
                      type="text" placeholder="Nom" value={newIntervenant.nom}
                      onChange={(e) => setNewIntervenant({ ...newIntervenant, nom: e.target.value })}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 8 }}
                    />
                    <input
                      type="email" placeholder="Email" value={newIntervenant.email}
                      onChange={(e) => setNewIntervenant({ ...newIntervenant, email: e.target.value })}
                      style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', marginBottom: 10 }}
                    />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button type="button" className="ms-btn" onClick={() => { setShowNewIntervenant(false); setNewIntervenant({ nom: '', email: '' }); }}>Annuler</button>
                      <button type="button" className="ms-btn ms-btn-primary" onClick={createIntervenant} disabled={creatingIntervenant}>
                        {creatingIntervenant ? 'Ajout…' : 'Ajouter & sélectionner'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button" className="ms-btn"
                    onClick={() => setShowNewIntervenant(true)}
                    style={{ marginTop: 8, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}
                  >
                    <FiPlus /> Nouvel intervenant
                  </button>
                )
              )}
            </div>
            {isSeries && (
              <label className="ms-series-apply">
                <input
                  type="checkbox"
                  checked={applyToSeries}
                  onChange={(e) => setApplyToSeries(e.target.checked)}
                />
                <span>Appliquer à toute la série ({seriesTomes.length} tomes)</span>
              </label>
            )}
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setAssignModal(null)}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmAssign}>Confirmer</button>
            </div>
          </div>
        </div>
      )}

      {linkModal && (
        <div className="ms-modal-backdrop" onClick={() => setLinkModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rattacher un contrat existant</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              Choisissez un contrat Dolibarr déjà créé. Il sera lié à ce manuscrit et son historique (validation, devis) apparaîtra sur la frise.
            </p>
            <div className="form-group">
              <input
                type="search" placeholder="Filtrer (réf, titre, auteur)…"
                value={contractQuery}
                onChange={(e) => setContractQuery(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
              />
            </div>
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 8 }}>
              {(() => {
                if (contractSearching) return <p style={{ padding: 12, color: '#6b7280', margin: 0 }}>Chargement…</p>;
                const ql = contractQuery.trim().toLowerCase();
                const filtered = ql
                  ? contractResults.filter((c) => [c.ref, c.title, c.author?.name].filter(Boolean).some((v) => String(v).toLowerCase().includes(ql)))
                  : contractResults;
                if (!filtered.length) return <p style={{ padding: 12, color: '#6b7280', margin: 0 }}>Aucun contrat trouvé.</p>;
                return filtered.map((c) => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid #f3f4f6' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {c.ref || `#${c.id}`}
                        {c.statusLabel ? <span style={{ fontWeight: 400, fontSize: '0.75rem', color: '#6b7280' }}> · {c.statusLabel}</span> : null}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(c.title || '—')}{c.author?.name ? ` · ${c.author.name}` : ''}
                      </div>
                    </div>
                    <button type="button" className="ms-btn ms-btn-primary" disabled={contractBusy} onClick={() => confirmLink(c.id)}>Rattacher</button>
                  </div>
                ));
              })()}
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setLinkModal(false)}>Fermer</button>
            </div>
          </div>
        </div>
      )}

      {signModal && (
        <div className="ms-modal-backdrop" onClick={() => !signBusy && setSignModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Signature manuelle du contrat</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              Enregistre la signature papier : le scan du contrat signé est archivé (empreinte SHA-256) et le manuscrit passe à « Contrat signé ».
            </p>
            <div className="form-group">
              <label>Scan du contrat signé (PDF, JPG ou PNG) *</label>
              <input
                type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                onChange={(e) => setSignForm({ ...signForm, file: e.target.files?.[0] || null })}
              />
            </div>
            <div className="form-group">
              <label>Date de signature *</label>
              <input
                type="date" value={signForm.signed_date}
                onChange={(e) => setSignForm({ ...signForm, signed_date: e.target.value })}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
              />
            </div>
            <div className="form-group">
              <label>Nom du signataire (facultatif — auteur par défaut)</label>
              <input
                type="text" placeholder="Nom du signataire" value={signForm.signer_name}
                onChange={(e) => setSignForm({ ...signForm, signer_name: e.target.value })}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db' }}
              />
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setSignModal(false)} disabled={signBusy}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmSign} disabled={signBusy}>
                {signBusy ? 'Enregistrement…' : 'Enregistrer la signature'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editModal && (
        <div className="ms-modal-backdrop" onClick={() => !editBusy && setEditModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Modifier la fiche du manuscrit</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              Pour les <strong>micro-corrections de forme</strong> (faute de frappe de l'auteur
              dans le titre, le genre, le synopsis…). Le fichier du manuscrit et son état dans le
              workflow ne sont pas modifiés. Chaque changement est <strong>tracé dans la frise</strong>
              (ancienne → nouvelle valeur), aucun email n'est envoyé.
            </p>
            <div className="form-group">
              <label>Titre *</label>
              <input
                type="text"
                value={editForm.title}
                onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Sous-titre</label>
              <input
                type="text"
                value={editForm.subtitle}
                onChange={(e) => setEditForm({ ...editForm, subtitle: e.target.value })}
                placeholder="Facultatif"
              />
            </div>
            <div className="form-group">
              <label>Genre</label>
              <input
                type="text"
                value={editForm.genre}
                onChange={(e) => setEditForm({ ...editForm, genre: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>Synopsis</label>
              <textarea
                rows={5}
                value={editForm.synopsis}
                onChange={(e) => setEditForm({ ...editForm, synopsis: e.target.value })}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical' }}
              />
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setEditModal(false)} disabled={editBusy}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmEdit} disabled={editBusy}>
                {editBusy ? 'Enregistrement…' : 'Enregistrer les corrections'}
              </button>
            </div>
          </div>
        </div>
      )}

      {versionModal && (
        <div className="ms-modal-backdrop" onClick={() => !versionBusy && setVersionModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Déposer une nouvelle version du manuscrit</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              La nouvelle version devient <strong>la version courante</strong> (v{(currentVersion?.version || 0) + 1}) —
              possible à n&apos;importe quelle étape du workflow. Un fichier identique à la version
              actuelle est refusé (anti-doublon). Le dépôt est tracé dans la frise.
            </p>
            <div className="form-group">
              <label>Fichier (PDF, DOC, DOCX, ODT ou RTF — max 20 Mo) *</label>
              <input
                type="file" accept=".pdf,.doc,.docx,.odt,.rtf"
                onChange={(e) => setVersionForm({ ...versionForm, file: e.target.files?.[0] || null })}
              />
            </div>
            <div className="form-group">
              <label>Commentaire (facultatif — ex. « version reçue par email le 21/07 »)</label>
              <textarea
                rows={2}
                value={versionForm.note}
                onChange={(e) => setVersionForm({ ...versionForm, note: e.target.value })}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical' }}
              />
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setVersionModal(false)} disabled={versionBusy}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmVersionUpload} disabled={versionBusy}>
                {versionBusy ? 'Dépôt…' : 'Déposer la version'}
              </button>
            </div>
          </div>
        </div>
      )}

      {revisionModal && (
        <div className="ms-modal-backdrop" onClick={() => !revisionBusy && setRevisionModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Demander une révision à l&apos;auteur</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              L&apos;auteur reçoit par email un <strong>lien de dépôt personnel</strong> (valable 14 jours, sans connexion) :
              il y télécharge la version courante et y dépose sa version révisée, qui devient
              automatiquement la version courante. Plus d&apos;aller-retour de pièces jointes par email.
            </p>
            <div className="form-group">
              <label>Message à l&apos;auteur (facultatif — consignes de révision)</label>
              <textarea
                rows={4}
                placeholder="Ex. : merci d'intégrer les corrections du chapitre 3 et de renvoyer votre version."
                value={revisionMessage}
                onChange={(e) => setRevisionMessage(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical' }}
              />
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setRevisionModal(false)} disabled={revisionBusy}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmRevisionRequest} disabled={revisionBusy}>
                {revisionBusy ? 'Envoi…' : 'Envoyer le lien de dépôt'}
              </button>
            </div>
          </div>
        </div>
      )}

      {unlockModal && finalVersion && (
        <div className="ms-modal-backdrop" onClick={() => !finalBusy && setUnlockModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Déverrouiller la version définitive</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              La v{finalVersion.version} a été arrêtée comme définitive. La déverrouiller
              <strong> rouvre les dépôts</strong> (admin et auteur). Le motif est obligatoire et tracé dans la frise.
            </p>
            <div className="form-group">
              <label>Motif du déverrouillage *</label>
              <textarea
                rows={3}
                placeholder="Ex. : coquille découverte au chapitre 5 après l'arrêt du texte."
                value={unlockReason}
                onChange={(e) => setUnlockReason(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical' }}
              />
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setUnlockModal(false)} disabled={finalBusy}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={() => confirmUnlockFinal(finalVersion)} disabled={finalBusy}>
                {finalBusy ? 'Déverrouillage…' : 'Déverrouiller'}
              </button>
            </div>
          </div>
        </div>
      )}

      {overrideModal && (
        <div className="ms-modal-backdrop" onClick={() => !overrideBusy && setOverrideModal(false)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Corriger l'état du manuscrit</h3>
            <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: 0 }}>
              Réservé aux <strong>erreurs matérielles</strong> (ex. un manuscrit rejeté ou
              classé par erreur). Cette correction <strong>contourne le déroulé normal</strong> du
              workflow, <strong>n'envoie aucun email</strong> à l'auteur, et reste tracée dans la frise
              avec son motif.
            </p>
            <div className="form-group">
              <label>Nouvel état *</label>
              <select
                value={overrideForm.to_stage}
                onChange={(e) => setOverrideForm({ ...overrideForm, to_stage: e.target.value })}
              >
                {stageOptions.stages.map((s) => (
                  <option key={s} value={s}>
                    {(stageOptions.labels[s] || s)}{s === data?.manuscript?.current_stage ? ' (état actuel)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Motif de la correction *</label>
              <textarea
                rows={3}
                placeholder="Ex. : rejet enregistré par erreur, l'évaluation était en réalité favorable."
                value={overrideForm.reason}
                onChange={(e) => setOverrideForm({ ...overrideForm, reason: e.target.value })}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #d1d5db', resize: 'vertical' }}
              />
            </div>
            <div className="ms-modal-actions">
              <button type="button" className="ms-btn" onClick={() => setOverrideModal(false)} disabled={overrideBusy}>Annuler</button>
              <button type="button" className="ms-btn ms-btn-primary" onClick={confirmOverride} disabled={overrideBusy}>
                {overrideBusy ? 'Correction…' : 'Corriger l\'état'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
