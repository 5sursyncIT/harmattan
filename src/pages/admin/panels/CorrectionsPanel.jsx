import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiUpload, FiLink, FiTrash2 } from 'react-icons/fi';
import { manuscriptsApi } from '../../../api/manuscripts';
import { safeHttpUrl } from '../../../utils/safeUrl';
import useAdminRole from '../../../hooks/useAdminRole.js';
import './ManuscriptsWorkflow.css';

// Le document corrigé garde sa route dédiée (un seul fichier, il conditionne le
// passage en production). Il est présenté dans le même sélecteur que les pièces
// du dossier de production pour que l'admin n'ait qu'un seul point d'entrée.
const CORRECTION_KIND = 'correction';
const CORRECTION_OPTION = {
  value: CORRECTION_KIND,
  label: 'Version corrigée (document du correcteur)',
  accept: '.pdf,.doc,.docx,.odt',
  max_mb: 20,
};

function formatSize(bytes) {
  if (!bytes) return '';
  const mo = bytes / (1024 * 1024);
  return mo >= 1 ? `${mo.toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

export default function CorrectionsPanel() {
  const navigate = useNavigate();
  const role = useAdminRole();
  const isAdmin = role === 'super_admin' || role === 'admin';
  // Transmission à la Production éditoriale : mêmes rôles que le serveur
  // (POST /corrections/:id/to-editorial). Un correcteur voyait le bouton
  // mais récoltait un 403 + un dropdown vide (audit 09/07/2026).
  const canSendEditorial = ['super_admin', 'admin', 'editor', 'production'].includes(role);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // Dossier de production : type de pièce, lot de fichiers, dépôt par lien.
  const [kinds, setKinds] = useState([]);
  const [kind, setKind] = useState(CORRECTION_KIND);
  const [prodFiles, setProdFiles] = useState([]);
  const [linkUrl, setLinkUrl] = useState('');
  const [linkLabel, setLinkLabel] = useState('');
  const [existing, setExisting] = useState([]);
  // Transmission à la Production éditoriale
  const [editorialModal, setEditorialModal] = useState(null);
  const [editorialUsers, setEditorialUsers] = useState([]);
  const [selectedEditor, setSelectedEditor] = useState('');

  const load = () => {
    setLoading(true);
    manuscriptsApi.listCorrections()
      .then((res) => setRows(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // Types de pièces servis par le serveur : la liste ne vit qu'à un seul endroit.
  useEffect(() => {
    manuscriptsApi.productionFileKinds()
      .then((res) => setKinds(res.data || []))
      .catch(() => setKinds([]));
  }, []);

  const options = [CORRECTION_OPTION, ...kinds];
  const currentOption = options.find((o) => o.value === kind) || CORRECTION_OPTION;
  const isCorrection = kind === CORRECTION_KIND;

  const loadFiles = (manuscriptId) => {
    manuscriptsApi.listManuscriptFiles(manuscriptId)
      .then((res) => setExisting(res.data || []))
      .catch(() => setExisting([]));
  };

  const openUpload = (manuscriptId) => {
    setModal(manuscriptId);
    setFile(null);
    setProdFiles([]);
    setLinkUrl('');
    setLinkLabel('');
    setKind(CORRECTION_KIND);
    loadFiles(manuscriptId);
  };

  const upload = async () => {
    setSubmitting(true);
    try {
      if (isCorrection) {
        if (!file) return toast.error('Fichier requis');
        const fd = new FormData();
        fd.append('file', file);
        await manuscriptsApi.uploadCorrection(modal, fd);
        toast.success('Version corrigée uploadée');
      } else {
        if (!prodFiles.length) return toast.error('Sélectionnez au moins un fichier');
        const fd = new FormData();
        prodFiles.forEach((f) => fd.append('files', f));
        const res = await manuscriptsApi.uploadProductionFiles(modal, kind, fd);
        toast.success(`${res.data.uploaded} fichier(s) ajouté(s) au dossier de production`);
      }
      setFile(null);
      setProdFiles([]);
      loadFiles(modal);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  const addLink = async () => {
    if (!linkUrl.trim()) return toast.error('Lien requis');
    setSubmitting(true);
    try {
      await manuscriptsApi.addProductionLink(modal, { kind, url: linkUrl.trim(), label: linkLabel.trim() });
      toast.success('Lien ajouté au dossier de production');
      setLinkUrl('');
      setLinkLabel('');
      loadFiles(modal);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  const removeFile = async (fileId) => {
    if (!confirm('Retirer cette pièce du dossier de production ?')) return;
    try {
      await manuscriptsApi.removeProductionFile(modal, fileId);
      loadFiles(modal);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const sendToAuthor = async (id) => {
    if (!confirm('Envoyer ces corrections à l\'auteur pour validation ?')) return;
    try {
      await manuscriptsApi.submitCorrectionToAuthor(id);
      toast.success('Corrections envoyées à l\'auteur');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  // Validation de la correction par l'administration, à la place de l'auteur
  // (manuscrit resté « en attente de validation auteur »).
  const validateCorrection = async (id, decision) => {
    const msg = decision === 'approved'
      ? 'Valider la correction et transmettre à la Production éditoriale ? (Le document corrigé doit avoir été uploadé.)'
      : 'Renvoyer ce manuscrit en correction au nom de l\'auteur ?';
    if (!confirm(msg)) return;
    try {
      await manuscriptsApi.validateCorrection(id, decision);
      toast.success(decision === 'approved' ? 'Corrections validées — transmis à la Production éditoriale' : 'Renvoyé en correction');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const openEditorial = (id) => {
    setEditorialModal(id);
    setSelectedEditor('');
    manuscriptsApi.adminsByRole('editor')
      .then((res) => setEditorialUsers(res.data || []))
      .catch(() => setEditorialUsers([]));
  };

  const confirmEditorial = async () => {
    setSubmitting(true);
    try {
      await manuscriptsApi.sendCorrectionToEditorial(editorialModal, selectedEditor ? parseInt(selectedEditor, 10) : null);
      toast.success('Document transmis à la Production éditoriale');
      setEditorialModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setSubmitting(false); }
  };

  return (
    <div className="ms-panel">
      <h2>Corrections</h2>
      <p className="ms-subtitle">Manuscrits en correction ou en attente de validation auteur.</p>

      {loading ? <p>Chargement...</p> : !rows.length ? (
        <div className="ms-empty">Aucune correction en cours.</div>
      ) : (
        <table className="ms-table">
          <thead>
            <tr><th>Réf.</th><th>Titre</th><th>Auteur</th><th>Étape</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>{m.ref}</td>
                <td>{m.title}</td>
                <td>{m.author_name}</td>
                <td><span className={`ms-stage-badge ms-stage-${m.current_stage}`}>{m.stage_label}</span></td>
                <td>
                  <button className="ms-btn" onClick={() => navigate(`/admin/manuscripts/${m.id}`)}>Détail</button>
                  {m.current_stage === 'in_correction' && (
                    <>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => openUpload(m.id)}>
                        Documents
                      </button>
                      <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => sendToAuthor(m.id)}>
                        Envoyer à l'auteur
                      </button>
                      {isAdmin && (
                        <button className="ms-btn ms-btn-success" style={{ marginLeft: 6 }} onClick={() => validateCorrection(m.id, 'approved')}>
                          Valider la correction
                        </button>
                      )}
                      {canSendEditorial && (
                        <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => openEditorial(m.id)}>
                          → Production éditoriale
                        </button>
                      )}
                    </>
                  )}
                  {m.current_stage === 'correction_author_review' && isAdmin && (
                    <>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => openUpload(m.id)}>
                        Documents
                      </button>
                      <button className="ms-btn ms-btn-primary" style={{ marginLeft: 6 }} onClick={() => validateCorrection(m.id, 'approved')}>
                        Valider la correction
                      </button>
                      <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => validateCorrection(m.id, 'changes_requested')}>
                        Renvoyer en correction
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modal && (
        <div className="ms-modal-backdrop" onClick={() => setModal(null)}>
          <div className="ms-modal ms-modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>Documents du manuscrit</h3>
            <p className="ms-subtitle" style={{ marginTop: 0 }}>
              Version corrigée du correcteur, puis toutes les pièces dont la Production
              éditoriale a besoin : texte mis en page, couverture, illustrations, annexes.
            </p>

            <div className="form-group">
              <label>Type de document</label>
              <select value={kind} onChange={(e) => { setKind(e.target.value); setFile(null); setProdFiles([]); }}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label>
                {isCorrection ? 'Fichier' : 'Fichiers (plusieurs possibles)'}
                {' '}({(currentOption.accept || '').replace(/\./g, '').toUpperCase().replace(/,/g, ', ')}
                {' '}— max {currentOption.max_mb} Mo par fichier)
              </label>
              <label className="ms-upload-box">
                <FiUpload />
                {isCorrection
                  ? (file ? file.name : 'Sélectionner un fichier')
                  : (prodFiles.length ? `${prodFiles.length} fichier(s) sélectionné(s)` : 'Sélectionner des fichiers')}
                <input
                  type="file"
                  accept={currentOption.accept}
                  multiple={!isCorrection}
                  onChange={(e) => {
                    const picked = Array.from(e.target.files || []);
                    if (isCorrection) setFile(picked[0] || null);
                    else setProdFiles(picked);
                  }}
                />
              </label>
              {!isCorrection && prodFiles.length > 0 && (
                <ul className="ms-file-list" style={{ marginTop: 8 }}>
                  {prodFiles.map((f, i) => (
                    <li key={`${f.name}-${i}`}><div>{f.name} <small>{formatSize(f.size)}</small></div></li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ms-modal-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="ms-btn ms-btn-primary" onClick={upload}
                disabled={submitting || (isCorrection ? !file : !prodFiles.length)}>
                {submitting ? 'Envoi...' : 'Ajouter au dossier'}
              </button>
            </div>

            {/* Une maquette InDesign packagée ou un lot d'images HD dépasse vite la
                limite d'envoi : on accepte alors un lien de téléchargement. */}
            {!isCorrection && (
              <div className="form-group" style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
                <label>Ou déposer un lien (Drive, WeTransfer, Dropbox…)</label>
                <input type="url" placeholder="https://…" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} />
                <input type="text" placeholder="Intitulé (facultatif)" value={linkLabel}
                  onChange={(e) => setLinkLabel(e.target.value)} style={{ marginTop: 6 }} />
                <button className="ms-btn" style={{ marginTop: 8 }} onClick={addLink} disabled={submitting || !linkUrl.trim()}>
                  <FiLink /> Ajouter le lien
                </button>
              </div>
            )}

            <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 12 }}>
              <h4 style={{ margin: '0 0 8px' }}>Dossier constitué ({existing.length})</h4>
              {existing.length ? (
                <ul className="ms-file-list">
                  {existing.map((f) => (
                    <li key={f.id}>
                      <div>
                        <span className="ms-file-kind">{f.kind_label}</span>
                        {f.version > 1 && <strong>v{f.version}</strong>} {f.file_name}
                        {f.external_url && <em> (lien)</em>}
                        {f.file_size ? <small> · {formatSize(f.file_size)}</small> : null}
                      </div>
                      <div>
                        {safeHttpUrl(f.external_url) ? (
                          <a className="ms-btn" href={safeHttpUrl(f.external_url)} target="_blank" rel="noopener noreferrer">Ouvrir</a>
                        ) : (
                          <a className="ms-btn" href={manuscriptsApi.downloadUrl(modal, f.id)} target="_blank" rel="noopener noreferrer">
                            Télécharger
                          </a>
                        )}
                        {f.kind?.startsWith('production_') && (
                          <button className="ms-btn" style={{ marginLeft: 6 }} onClick={() => removeFile(f.id)} title="Retirer">
                            <FiTrash2 />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p style={{ color: '#6b7280' }}>Aucun document pour l'instant.</p>}
            </div>

            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setModal(null)} disabled={submitting}>Fermer</button>
            </div>
          </div>
        </div>
      )}

      {editorialModal && (
        <div className="ms-modal-backdrop" onClick={() => setEditorialModal(null)}>
          <div className="ms-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Transmettre à la Production éditoriale</h3>
            <p className="ms-subtitle" style={{ marginTop: 0 }}>
              Le document corrigé (renvoyé par le correcteur) doit avoir été <strong>uploadé</strong> au préalable.
              Cette action transmet le manuscrit à la Production éditoriale, sans relecture par l'auteur.
            </p>
            <div className="form-group">
              <label>Responsable de la production éditoriale (facultatif)</label>
              <select value={selectedEditor} onChange={(e) => setSelectedEditor(e.target.value)}>
                <option value="">Toute l'équipe de production éditoriale</option>
                {editorialUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.username} ({u.role})</option>
                ))}
              </select>
            </div>
            <div className="ms-modal-actions">
              <button className="ms-btn" onClick={() => setEditorialModal(null)} disabled={submitting}>Annuler</button>
              <button className="ms-btn ms-btn-primary" onClick={confirmEditorial} disabled={submitting}>
                {submitting ? 'Envoi...' : 'Transmettre'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
