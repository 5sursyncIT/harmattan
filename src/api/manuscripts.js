import api from './dolibarr';

export const manuscriptsApi = {
  // Vue globale
  list: (params = {}) => api.get('/admin/manuscripts/v2', { params }),
  get: (id) => api.get(`/admin/manuscripts/v2/${id}`),
  stages: () => api.get('/admin/manuscripts/v2/stages'),
  assignedToMe: () => api.get('/admin/manuscripts/assigned'),
  assign: (id, role, userId, applyToSeries = false) =>
    api.post(`/admin/manuscripts/v2/${id}/assign`, { role, user_id: userId, apply_to_series: applyToSeries }),
  // Transition normale (machine à états respectée). Pour corriger une erreur
  // matérielle d'état, utiliser overrideStage (admin + motif) — le serveur
  // n'honore plus de flag `force` sur cette route.
  transition: (id, toStage, note) =>
    api.post(`/admin/manuscripts/v2/${id}/transition`, { to_stage: toStage, note }),
  // Correction manuelle de l'état (erreur matérielle) — admin only, motif obligatoire,
  // aucun email envoyé, tracée dans la frise.
  overrideStage: (id, toStage, reason) =>
    api.post(`/admin/manuscripts/v2/${id}/override-stage`, { to_stage: toStage, reason }),
  markPaid: (id, note) => api.post(`/admin/manuscripts/v2/${id}/mark-paid`, { note }),
  // Démarrer la correction sans attendre le paiement du devis (équipe éditoriale).
  startCorrection: (id, note) => api.post(`/admin/manuscripts/v2/${id}/start-correction`, { note }),
  createContract: (id) => api.post(`/admin/manuscripts/v2/${id}/create-contract`),
  linkContract: (id, contractId) => api.post(`/admin/manuscripts/v2/${id}/link-contract`, { contract_id: contractId }),
  downloadUrl: (manuscriptId, fileId) =>
    `/api/admin/manuscripts/v2/${manuscriptId}/files/${fileId}/download`,
  adminsByRole: (role) =>
    api.get('/admin/admin-users/by-role', { params: { role } }),

  // Évaluations
  listEvaluations: () => api.get('/admin/evaluations'),
  submitEvaluation: (manuscriptId, formData) =>
    api.post(`/admin/evaluations/${manuscriptId}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  // Corrections
  listCorrections: () => api.get('/admin/corrections'),
  uploadCorrection: (manuscriptId, formData) =>
    api.post(`/admin/corrections/${manuscriptId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  submitCorrectionToAuthor: (manuscriptId) =>
    api.post(`/admin/corrections/${manuscriptId}/submit-to-author`),
  // Validation de la correction par l'administration, à la place de l'auteur.
  // decision : 'approved' (→ Production éditoriale) | 'changes_requested' (→ correction)
  validateCorrection: (manuscriptId, decision, comment = '') =>
    api.post(`/admin/corrections/${manuscriptId}/validate`, { decision, comment }),
  sendCorrectionToEditorial: (manuscriptId, editorId = null) =>
    api.post(`/admin/corrections/${manuscriptId}/to-editorial`, { editor_id: editorId }),
  // Notifie l'auteur que ses corrections sont validées — UNIQUEMENT sur sa demande
  // (l'envoi n'est plus automatique à la validation, choix Direction).
  notifyAuthorCorrectionValidated: (manuscriptId) =>
    api.post(`/admin/corrections/${manuscriptId}/notify-author`),

  // Éditorial
  listEditorial: () => api.get('/admin/editorial'),
  editorialValidate: (manuscriptId, note) =>
    api.post(`/admin/editorial/${manuscriptId}/validate`, { note }),
  editorialReturn: (manuscriptId, note) =>
    api.post(`/admin/editorial/${manuscriptId}/return-to-correction`, { note }),
  editorialAdvanceToCover: (manuscriptId) =>
    api.post(`/admin/editorial/${manuscriptId}/advance-to-cover`),

  // Couvertures
  listCovers: () => api.get('/admin/covers'),
  uploadCoverArtwork: (manuscriptId, formData) =>
    api.post(`/admin/covers/${manuscriptId}/artwork`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  submitBat: (manuscriptId, formData) =>
    api.post(`/admin/covers/${manuscriptId}/submit-bat`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),

  // Impression
  listPrinting: () => api.get('/admin/printing'),
  preparePrint: (manuscriptId, printQty, isbn) =>
    api.post(`/admin/printing/${manuscriptId}/prepare`, { print_qty: printQty, isbn }),
  markPrinted: (manuscriptId, note) =>
    api.post(`/admin/printing/${manuscriptId}/mark-printed`, { note }),
};

// Carnet d'intervenants (acteurs externes du workflow, notifiés par email, sans compte)
export const intervenantsApi = {
  list: (params = {}) => api.get('/admin/intervenants', { params }),
  get: (id) => api.get(`/admin/intervenants/${id}`),
  create: (payload) => api.post('/admin/intervenants', payload),
  update: (id, payload) => api.put(`/admin/intervenants/${id}`, payload),
  setActive: (id, isActive) => api.patch(`/admin/intervenants/${id}/active`, { is_active: isActive }),
  remove: (id) => api.delete(`/admin/intervenants/${id}`),
};

// « infographiste » retiré : la couverture est désormais conçue en interne par
// la Production éditoriale (fusion Éditeur/Infographiste). Les intervenants
// infographistes existants restent affichés via un libellé de repli.
export const INTERVENANT_METIERS = [
  { value: 'evaluateur', label: 'Évaluateur / lecteur' },
  { value: 'correcteur', label: 'Correcteur' },
  { value: 'imprimeur', label: 'Imprimeur' },
];
