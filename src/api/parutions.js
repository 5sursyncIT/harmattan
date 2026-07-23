import api from './dolibarr';

// Parutions — relais commercial post-impression (checklist + kit de lancement).
export const listParutions = () => api.get('/admin/parutions');
export const toggleParutionItem = (manuscriptId, itemKey, done) =>
  api.post(`/admin/parutions/${manuscriptId}/checklist/${itemKey}`, { done });

// Téléchargements directs (cookie de session) — à utiliser dans un href/window.open.
export const parutionKitFicheUrl = (manuscriptId) => `/api/admin/parutions/${manuscriptId}/kit/fiche`;
export const parutionKitCoverUrl = (manuscriptId) => `/api/admin/parutions/${manuscriptId}/kit/cover`;

// Phase 3 — newsletter « Nouvelle parution » + pack visuels réseaux.
export const getParutionNewsletterPreview = (manuscriptId) =>
  api.get(`/admin/parutions/${manuscriptId}/newsletter/preview`);
export const sendParutionNewsletterTest = (manuscriptId, email) =>
  api.post(`/admin/parutions/${manuscriptId}/newsletter/test`, { email });
export const sendParutionNewsletter = (manuscriptId, force = false) =>
  api.post(`/admin/parutions/${manuscriptId}/newsletter/send`, { force });
// format : 'square' (1080×1080) ou 'og' (1200×628)
export const parutionSocialUrl = (manuscriptId, format) =>
  `/api/admin/parutions/${manuscriptId}/kit/social/${format}`;
