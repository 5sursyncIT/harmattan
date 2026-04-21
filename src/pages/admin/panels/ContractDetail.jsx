import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getContract, validateContract, closeContract, deleteContract,
  downloadContractDocument, updateContract, getSignatureUrl,
  sendSignatureEmail, getSignatureStatus, regenerateSignedContract,
} from '../../../api/contracts';
import {
  FiArrowLeft, FiCheckCircle, FiXCircle, FiDownload, FiUser, FiBook,
  FiPercent, FiFileText, FiCalendar, FiCopy, FiExternalLink, FiEdit3, FiSave, FiAlertCircle, FiRefreshCw,
} from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import toast from 'react-hot-toast';
import './Contracts.css';

const STATUS_LABELS = { 0: 'Brouillon', 1: 'Actif', 2: 'Clos' };
const TYPE_LABELS = { harmattan_2024: 'Harmattan 2024', harmattan_dll: 'Harmattan DLL', tamarinier: 'Le Tamarinier' };
const TYPE_COLORS = { harmattan_2024: '#10531a', harmattan_dll: '#0284c7', tamarinier: '#7c3aed' };

function InfoRow({ icon, label, value, mono = false }) {
  return (
    <div className="ct-info-row">
      <span className="ct-info-icon">{icon}</span>
      <span className="ct-info-label">{label}</span>
      <span className={`ct-info-value ${mono ? 'mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel = 'Confirmer', danger = false, onConfirm, onCancel }) {
  return (
    <div className="ct-modal-overlay" onClick={onCancel}>
      <div className="ct-modal" onClick={e => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div className="ct-modal-actions">
          <button className="ct-btn ct-btn-outline" onClick={onCancel}>Annuler</button>
          <button className={`ct-btn ${danger ? 'ct-btn-danger' : 'ct-btn-primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export default function ContractDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(true);
  const [signStatus, setSignStatus] = useState(null);
  const [signUrl, setSignUrl] = useState(null);
  const [sendingSign, setSendingSign] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [confirmAction, setConfirmAction] = useState(null);

  const load = () => {
    setLoading(true);
    getContract(id)
      .then(r => {
        setContract(r.data);
        if (r.data) {
          const ef = r.data.extrafields || {};
          setEditForm({
            contract_type: ef.contractType || 'harmattan_2024',
            book_title: ef.bookTitle || '',
            book_isbn: ef.bookIsbn || '',
            royalty_rate_print: ef.royaltyPrint ?? 10,
            royalty_rate_digital: ef.royaltyDigital ?? 10,
            royalty_threshold: ef.royaltyThreshold ?? 500,
            free_author_copies: ef.freeCopies ?? 5,
            note_private: r.data.notePrivate || '',
          });
        }
      })
      .catch(() => toast.error('Contrat introuvable'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    getContract(id)
      .then(r => { if (!cancelled) { setContract(r.data); const ef = r.data?.extrafields || {}; setEditForm({ contract_type: ef.contractType || 'harmattan_2024', book_title: ef.bookTitle || '', book_isbn: ef.bookIsbn || '', royalty_rate_print: ef.royaltyPrint ?? 10, royalty_rate_digital: ef.royaltyDigital ?? 10, royalty_threshold: ef.royaltyThreshold ?? 500, free_author_copies: ef.freeCopies ?? 5, note_private: r.data?.notePrivate || '' }); } })
      .catch(() => { if (!cancelled) toast.error('Contrat introuvable'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (contract?.status >= 1) {
      getSignatureStatus(id).then(r => setSignStatus(r.data)).catch(() => {});
      getSignatureUrl(id).then(r => setSignUrl(r.data.url)).catch(() => setSignUrl(null));
    }
  }, [id, contract?.status]);

  const handleSendSignature = async () => {
    setSendingSign(true);
    try {
      const res = await sendSignatureEmail(id);
      toast.success(`Lien de signature envoyé à ${res.data.email}`);
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur envoi'); }
    finally { setSendingSign(false); }
  };

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const res = await regenerateSignedContract(id);
      toast.success(`PDF régénéré (${res.data.ref})`);
      getSignatureStatus(id).then(r => setSignStatus(r.data)).catch(() => {});
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur régénération');
    } finally { setRegenerating(false); }
  };

  const handleValidate = async () => {
    setConfirmAction(null);
    try {
      const res = await validateContract(id);
      toast.success(`Contrat validé : ${res.data.ref}`);
      load();
    } catch { toast.error('Erreur validation'); }
  };

  const handleClose = async () => {
    setConfirmAction(null);
    try { await closeContract(id); toast.success('Contrat clôturé'); load(); }
    catch { toast.error('Erreur clôture'); }
  };

  const handleDownload = async () => {
    try {
      const res = await downloadContractDocument(id);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contrat-${contract.ref || id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Aucun document disponible'); }
  };

  const handleDelete = async () => {
    setConfirmAction(null);
    try { await deleteContract(id); toast.success('Contrat supprimé'); navigate('/admin/contracts/list'); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur suppression'); }
  };

  const handleUpdate = async () => {
    try { await updateContract(id, editForm); toast.success('Contrat mis à jour'); setIsEditing(false); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur lors de la mise à jour'); }
  };

  const copyRef = () => { navigator.clipboard?.writeText(contract.ref); toast.success('Référence copiée'); };

  if (loading) return <Loader />;
  if (!contract) return <div className="ct-empty"><FiAlertCircle size={48} className="ct-empty-icon" /><h3>Contrat introuvable</h3></div>;

  const ef = contract.extrafields || {};
  const typeColor = TYPE_COLORS[ef.contractType] || '#888';
  const statusClass = contract.status === 0 ? 'ct-badge-draft' : contract.status === 1 ? 'ct-badge-active' : 'ct-badge-closed';

  const formatDate = (ts) => {
    if (!ts) return '—';
    const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  };

  return (
    <div className="admin-panel">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <div>
          <Link to="/admin/contracts/list" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: '0.85rem', marginBottom: 8, textDecoration: 'none' }}>
            <FiArrowLeft size={14} /> Retour aux contrats
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: '1.4rem', color: '#0f172a' }}>{contract.ref || `Contrat #${id}`}</h2>
            <button onClick={copyRef} className="ct-btn-ghost" title="Copier la référence"><FiCopy size={14} /></button>
            <span className={`ct-badge ${statusClass}`} style={{ padding: '4px 12px', borderRadius: 8, fontSize: '0.82rem' }}>
              {STATUS_LABELS[contract.status]}
            </span>
          </div>
          {ef.bookTitle && <p style={{ margin: '4px 0 0', fontSize: '1rem', color: '#475569' }}>{ef.bookTitle}</p>}
        </div>

        <div className="ct-detail-actions">
          {contract.status === 0 && (
            isEditing ? (
              <>
                <button onClick={handleUpdate} className="ct-btn ct-btn-blue"><FiSave size={14} /> Enregistrer</button>
                <button onClick={() => { setIsEditing(false); load(); }} className="ct-btn ct-btn-outline"><FiXCircle size={14} /> Annuler</button>
              </>
            ) : (
              <>
                <button onClick={() => setIsEditing(true)} className="ct-btn ct-btn-blue"><FiEdit3 size={14} /> Modifier</button>
                <button onClick={() => setConfirmAction('validate')} className="ct-btn ct-btn-success"><FiCheckCircle size={14} /> Valider</button>
              </>
            )
          )}
          {contract.status === 1 && (
            <button onClick={() => setConfirmAction('close')} className="ct-btn ct-btn-outline"><FiXCircle size={14} /> Clôturer</button>
          )}
          <button onClick={handleDownload} className="ct-btn ct-btn-dark"><FiDownload size={14} /> Télécharger PDF</button>
          {contract.status === 0 && (
            <button onClick={() => setConfirmAction('delete')} className="ct-btn ct-btn-danger"><FiXCircle size={14} /> Supprimer</button>
          )}
        </div>
      </div>

      {/* Main grid */}
      <div className="ct-detail-grid">
        {/* Left column */}
        <div className="ct-detail-col">
          {/* Author card */}
          <div className="ct-section">
            <h3 className="ct-section-title"><FiUser size={16} /> Auteur</h3>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>{contract.author?.name || '—'}</div>
            {contract.author?.email && <a href={`mailto:${contract.author.email}`} style={{ fontSize: '0.85rem', color: '#3b82f6' }}>{contract.author.email}</a>}
            {contract.author?.phone && <div style={{ fontSize: '0.85rem', color: '#64748b', marginTop: 2 }}>{contract.author.phone}</div>}
          </div>

          {/* Book details */}
          <div className="ct-section">
            <h3 className="ct-section-title"><FiBook size={16} /> Ouvrage</h3>
            {isEditing ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="ct-field"><label>Titre</label><input type="text" value={editForm.book_title} onChange={e => setEditForm({ ...editForm, book_title: e.target.value })} /></div>
                <div className="ct-field"><label>ISBN</label><input type="text" value={editForm.book_isbn} onChange={e => setEditForm({ ...editForm, book_isbn: e.target.value })} /></div>
                <div className="ct-field"><label>Type de contrat</label>
                  <select value={editForm.contract_type} onChange={e => setEditForm({ ...editForm, contract_type: e.target.value })}>
                    <option value="harmattan_2024">Harmattan 2024</option>
                    <option value="harmattan_dll">Harmattan DLL</option>
                    <option value="tamarinier">Le Tamarinier</option>
                  </select>
                </div>
              </div>
            ) : (
              <>
                <InfoRow icon={<FiBook size={14} />} label="Titre" value={ef.bookTitle} />
                <InfoRow icon={<FiFileText size={14} />} label="ISBN" value={ef.bookIsbn} mono />
                <InfoRow icon={<FiCalendar size={14} />} label="Date contrat" value={formatDate(contract.date)} />
                <InfoRow icon={<FiExternalLink size={14} />} label="Type" value={
                  ef.contractType ? <span className="ct-badge" style={{ padding: '2px 10px', background: `${typeColor}10`, color: typeColor }}>{TYPE_LABELS[ef.contractType]}</span> : '—'
                } />
              </>
            )}
          </div>

          {/* Contract lines */}
          {contract.lines?.length > 0 && (
            <div className="ct-section">
              <h3 className="ct-section-title">Lignes du contrat</h3>
              <div className="admin-table-container">
                <table className="admin-table" style={{ fontSize: '0.85rem' }}>
                  <thead><tr><th>Description</th><th>Qté</th><th>Prix</th><th>Total</th></tr></thead>
                  <tbody>
                    {contract.lines.map(l => (
                      <tr key={l.id}>
                        <td>{l.productLabel || l.description}</td>
                        <td>{l.qty}</td>
                        <td>{parseFloat(l.price).toLocaleString('fr-FR')} F</td>
                        <td style={{ fontWeight: 700 }}>{parseFloat(l.total).toLocaleString('fr-FR')} F</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="ct-detail-col">
          {/* Royalties */}
          <div className="ct-section">
            <h3 className="ct-section-title"><FiPercent size={16} /> Conditions</h3>
            {isEditing ? (
              <div className="ct-royalty-grid">
                <div className="ct-field"><label>Royalties print (%)</label><input type="number" value={editForm.royalty_rate_print} onChange={e => setEditForm({ ...editForm, royalty_rate_print: e.target.value })} min={0} max={50} /></div>
                <div className="ct-field"><label>Royalties digital (%)</label><input type="number" value={editForm.royalty_rate_digital} onChange={e => setEditForm({ ...editForm, royalty_rate_digital: e.target.value })} min={0} max={50} /></div>
                <div className="ct-field"><label>Seuil paiement</label><input type="number" value={editForm.royalty_threshold} onChange={e => setEditForm({ ...editForm, royalty_threshold: e.target.value })} min={0} /></div>
                <div className="ct-field"><label>Ex. gratuits</label><input type="number" value={editForm.free_author_copies} onChange={e => setEditForm({ ...editForm, free_author_copies: e.target.value })} min={0} /></div>
              </div>
            ) : (
              <div className="ct-royalty-grid">
                {[
                  { label: 'Royalties print', value: `${ef.royaltyPrint || 0}%`, color: '#10531a' },
                  { label: 'Royalties digital', value: `${ef.royaltyDigital || 0}%`, color: '#0284c7' },
                  { label: 'Seuil paiement', value: `${ef.royaltyThreshold || 0} ex.`, color: '#f59e0b' },
                  { label: 'Ex. gratuits', value: `${ef.freeCopies || 0} ex.`, color: '#7c3aed' },
                ].map(item => (
                  <div key={item.label} className="ct-royalty-card" style={{ background: `${item.color}08`, borderColor: `${item.color}15` }}>
                    <div className="ct-royalty-label">{item.label}</div>
                    <div className="ct-royalty-value" style={{ color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Documents */}
          <div className="ct-section">
            <h3 className="ct-section-title"><FiFileText size={16} /> Documents</h3>
            {contract.documents?.length > 0 ? (
              contract.documents.map((d, i) => {
                const ext = d.name.split('.').pop().toLowerCase();
                const isPdf = ext === 'pdf';
                const iconColor = isPdf ? '#dc2626' : '#0284c7';
                return (
                  <div key={i} className="ct-doc-item">
                    <div className="ct-doc-info">
                      <span className="ct-doc-icon" style={{ background: `${iconColor}12`, color: iconColor }}>{ext.toUpperCase()}</span>
                      <span className="ct-doc-name">{d.name}</span>
                    </div>
                    <button onClick={handleDownload} className="ct-doc-btn" style={{ background: iconColor }}>
                      <FiDownload size={12} /> {ext.toUpperCase()}
                    </button>
                  </div>
                );
              })
            ) : (
              <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Aucun document. Validez le contrat pour générer le PDF.</p>
            )}
          </div>

          {/* Notes */}
          <div className="ct-section">
            <h3 className="ct-section-title">Notes</h3>
            {isEditing ? (
              <textarea rows={4} value={editForm.note_private} onChange={e => setEditForm({ ...editForm, note_private: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #d1d5db', resize: 'vertical', fontFamily: 'inherit' }} />
            ) : (
              contract.notePrivate ? (
                <p style={{ whiteSpace: 'pre-wrap', fontSize: '0.9rem', color: '#475569', margin: 0, lineHeight: 1.6 }}>{contract.notePrivate}</p>
              ) : (
                <p style={{ fontSize: '0.9rem', color: '#94a3b8', margin: 0, fontStyle: 'italic' }}>Aucune note.</p>
              )
            )}
          </div>

          {/* Signature */}
          {contract.status >= 1 && (
            <div className="ct-section">
              <h3 className="ct-section-title"><FiCheckCircle size={16} /> Signature en ligne</h3>
              <div className={`ct-sign-status ${signStatus?.status >= 2 ? 'signed' : 'pending'}`}>
                <div className="ct-sign-label" style={{ color: signStatus?.status >= 2 ? '#166534' : '#92400e' }}>
                  {signStatus?.label || 'Non signé'}
                </div>
                {signStatus?.signedBy && (
                  <div className="ct-sign-detail">Signé par : {signStatus.signedBy} {signStatus.signedIp ? `(IP: ${signStatus.signedIp})` : ''}</div>
                )}
                {signStatus?.status >= 2 && (
                  signStatus?.certifiedInPdf ? (
                    <div className="ct-sign-detail" style={{ color: '#166534', marginTop: 6 }}>
                      ✓ Certificat intégré au PDF ({signStatus.pdfSignerDate})
                    </div>
                  ) : (
                    <div className="ct-sign-detail" style={{ color: '#b45309', marginTop: 6 }}>
                      ⚠ Le PDF actuel ne contient pas encore le certificat de signature.
                    </div>
                  )
                )}
              </div>
              {signStatus?.status < 2 && (
                <div className="ct-sign-actions">
                  <button onClick={handleSendSignature} disabled={sendingSign} className="ct-btn ct-btn-primary" style={{ justifyContent: 'center' }}>
                    {sendingSign ? 'Envoi...' : 'Envoyer le lien à l’auteur'}
                  </button>
                  {signUrl && (
                    <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                      Ou copier le lien : {' '}
                      <button onClick={() => { navigator.clipboard?.writeText(signUrl); toast.success('Lien copié'); }} className="ct-btn-link">
                        Copier l'URL
                      </button>
                    </div>
                  )}
                </div>
              )}
              {signStatus?.status >= 2 && (
                <div className="ct-sign-actions">
                  <button onClick={handleRegenerate} disabled={regenerating} className="ct-btn ct-btn-blue" style={{ justifyContent: 'center' }}>
                    <FiRefreshCw size={14} /> {regenerating ? 'Régénération…' : 'Régénérer le PDF signé'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Confirmation modals */}
      {confirmAction === 'validate' && (
        <ConfirmModal
          title="Valider ce contrat ?"
          message="Le contrat passera en statut Actif et ne pourra plus être modifié. Le PDF sera généré automatiquement."
          confirmLabel="Valider le contrat"
          onConfirm={handleValidate}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'close' && (
        <ConfirmModal
          title="Clôturer ce contrat ?"
          message="Le contrat sera définitivement clôturé. Cette action est irréversible."
          confirmLabel="Clôturer"
          danger
          onConfirm={handleClose}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'delete' && (
        <ConfirmModal
          title="Supprimer ce brouillon ?"
          message="Le contrat sera définitivement supprimé. Cette action est irréversible."
          confirmLabel="Supprimer"
          danger
          onConfirm={handleDelete}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
