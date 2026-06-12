import { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  getContract, validateContract, closeContract, deleteContract,
  downloadContractDocument, updateContract, getSignatureUrl,
  sendSignatureEmail, getSignatureStatus, regenerateSignedContract,
  reopenContract, signContractPhysical, getSignedScan,
} from '../../../api/contracts';
import {
  FiArrowLeft, FiCheckCircle, FiXCircle, FiDownload, FiUser, FiBook,
  FiPercent, FiFileText, FiCalendar, FiCopy, FiEdit3, FiSave, FiAlertCircle, FiRefreshCw,
  FiPlus, FiTrash2, FiSend, FiCheck, FiUploadCloud,
} from 'react-icons/fi';
import Loader from '../../../components/common/Loader';
import ConfirmModal from '../../../components/common/ConfirmModal';
import toast from 'react-hot-toast';
import { listContractQuotes, deleteQuote, markQuoteSent, openQuotePdf } from '../../../api/quotes';
import ContractQuoteModal from '../../../components/admin/ContractQuoteModal';
import useAdminRole, { CONTRACT_EDIT_ROLES, CONTRACT_WRITE_ROLES, CONTRACT_VALIDATE_ROLES, CONTRACT_REOPEN_ROLES } from '../../../hooks/useAdminRole';
import { CONTRACT_STATUS_LABELS, CONTRACT_TYPE_OPTIONS, contractTypeMeta } from '../../../utils/contractTypes';
import './Contracts.css';

function InfoRow({ icon, label, value, mono = false }) {
  return (
    <div className="ct-info-row">
      <span className="ct-info-icon">{icon}</span>
      <span className="ct-info-label">{label}</span>
      <span className={`ct-info-value ${mono ? 'mono' : ''}`}>{value || '—'}</span>
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
  // Signature manuscrite (papier) : modale d'attestation + dépôt du scan.
  const [showPhysicalSign, setShowPhysicalSign] = useState(false);
  const [physSigning, setPhysSigning] = useState(false);
  const [physForm, setPhysForm] = useState({ signed_date: new Date().toISOString().slice(0, 10), signer_name: '', file: null });

  // Fermeture au clavier de la modale signature papier (parité avec ConfirmModal).
  useEffect(() => {
    if (!showPhysicalSign) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !physSigning) setShowPhysicalSign(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showPhysicalSign, physSigning]);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [confirmAction, setConfirmAction] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [quotes, setQuotes] = useState([]);
  const [quotesError, setQuotesError] = useState(false);
  const role = useAdminRole();
  // canModify : créer/éditer les champs d'un brouillon (inclut le comptable).
  // canValidateDownload : valider le contrat + télécharger son PDF (inclut le comptable).
  // canManage : actions de cycle de vie sensibles réservées aux profils éditoriaux
  // (clôture, suppression, envoi en signature).
  const canModify = CONTRACT_WRITE_ROLES.includes(role);
  const canValidateDownload = CONTRACT_VALIDATE_ROLES.includes(role);
  const canManage = CONTRACT_EDIT_ROLES.includes(role);
  // canReopen : rouvrir un contrat validé en brouillon pour correction — admins seuls.
  const canReopen = CONTRACT_REOPEN_ROLES.includes(role);

  const loadQuotes = () => {
    if (!id) return;
    setQuotesError(false);
    listContractQuotes(id).then(r => setQuotes(r.data || [])).catch(() => setQuotesError(true));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadQuotes(); }, [id]);

  // Confirmation des actions devis via la même modale accessible que le reste
  // (window.confirm natif : pas de focus trap, pas stylé, bloquant).
  const [confirmQuote, setConfirmQuote] = useState(null); // { action: 'delete'|'send', quote }
  const [quoteActionLoading, setQuoteActionLoading] = useState(false);

  const runQuoteAction = async () => {
    if (!confirmQuote || quoteActionLoading) return;
    setQuoteActionLoading(true);
    try {
      if (confirmQuote.action === 'delete') {
        await deleteQuote(confirmQuote.quote.id);
        toast.success('Devis supprimé');
      } else {
        await markQuoteSent(confirmQuote.quote.id);
        toast.success('Devis marqué comme envoyé');
      }
      setConfirmQuote(null);
      loadQuotes();
    } catch (err) {
      toast.error(err.response?.data?.error || (confirmQuote.action === 'delete' ? 'Erreur suppression' : 'Erreur envoi'));
    } finally {
      setQuoteActionLoading(false);
    }
  };

  // Construit le formulaire d'édition à partir des données du contrat (source unique,
  // évite la duplication entre le chargement initial et les rechargements après action).
  const buildEditForm = (data) => {
    const ef = data?.extrafields || {};
    return {
      contract_type: ef.contractType || 'harmattan_2024',
      book_title: ef.bookTitle || '',
      book_isbn: ef.bookIsbn || '',
      royalty_rate_print: ef.royaltyPrint ?? 10,
      royalty_rate_digital: ef.royaltyDigital ?? 10,
      royalty_threshold: ef.royaltyThreshold ?? 500,
      free_author_copies: ef.freeCopies ?? 5,
      note_private: data?.notePrivate || '',
    };
  };

  const load = () => {
    setLoading(true);
    return getContract(id)
      .then(r => { setContract(r.data); if (r.data) setEditForm(buildEditForm(r.data)); })
      .catch(() => toast.error('Contrat introuvable'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getContract(id)
      .then(r => { if (!cancelled) { setContract(r.data); setEditForm(buildEditForm(r.data)); } })
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

  const handleSignPhysical = async () => {
    if (physSigning) return;
    if (!physForm.file) { toast.error('Veuillez joindre le scan du contrat signé'); return; }
    // Vérification de taille AVANT l'upload : sur 3G, envoyer 20 Mo pour se
    // faire rejeter par le serveur est une vraie perte de temps utilisateur.
    if (physForm.file.size > 15 * 1024 * 1024) { toast.error('Scan trop volumineux : 15 Mo maximum'); return; }
    if (!physForm.signed_date) { toast.error('Veuillez indiquer la date de signature'); return; }
    setPhysSigning(true);
    try {
      const fd = new FormData();
      fd.append('signed_date', physForm.signed_date);
      if (physForm.signer_name.trim()) fd.append('signer_name', physForm.signer_name.trim());
      fd.append('scan', physForm.file);
      await signContractPhysical(id, fd);
      toast.success('Signature manuscrite enregistrée et scan archivé');
      setShowPhysicalSign(false);
      setPhysForm({ signed_date: new Date().toISOString().slice(0, 10), signer_name: '', file: null });
      getSignatureStatus(id).then(r => setSignStatus(r.data)).catch(() => {});
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors de l\'enregistrement de la signature');
    } finally { setPhysSigning(false); }
  };

  const handleDownloadScan = async () => {
    try {
      const res = await getSignedScan(id);
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast.error('Scan signé indisponible'); }
  };

  const handleValidate = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      const res = await validateContract(id);
      toast.success(`Contrat validé : ${res.data.ref}`);
      setConfirmAction(null);
      await load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur validation'); }
    finally { setActionLoading(false); }
  };

  const handleClose = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try { await closeContract(id); toast.success('Contrat clôturé'); setConfirmAction(null); await load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur clôture'); }
    finally { setActionLoading(false); }
  };

  const handleReopen = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      await reopenContract(id);
      toast.success('Contrat rouvert en brouillon — vous pouvez le corriger puis le re-valider');
      setConfirmAction(null);
      await load();
    } catch (err) { toast.error(err.response?.data?.error || 'Erreur réouverture'); }
    finally { setActionLoading(false); }
  };

  const handleDownload = async (format = 'pdf') => {
    const ext = String(format).toLowerCase();
    try {
      const res = await downloadContractDocument(id, ext);
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contrat-${contract.ref || id}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { toast.error('Aucun document disponible'); }
  };

  const handleDelete = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try { await deleteContract(id); toast.success('Contrat supprimé'); navigate('/admin/contracts/list'); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur suppression'); setActionLoading(false); }
  };

  const handleUpdate = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try { await updateContract(id, editForm); toast.success('Contrat mis à jour'); setIsEditing(false); await load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Erreur lors de la mise à jour'); }
    finally { setActionLoading(false); }
  };

  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(contract.ref);
      toast.success('Référence copiée');
    } catch { toast.error('Copie impossible (presse-papier indisponible)'); }
  };

  if (loading) return <Loader />;
  if (!contract) return <div className="ct-empty"><FiAlertCircle size={48} className="ct-empty-icon" /><h3>Contrat introuvable</h3></div>;

  const ef = contract.extrafields || {};
  const typeMeta = contractTypeMeta(ef.contractType);
  const typeColor = typeMeta.color;
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
              {CONTRACT_STATUS_LABELS[contract.status]}
            </span>
          </div>
          {ef.bookTitle && <p style={{ margin: '4px 0 0', fontSize: '1rem', color: '#475569' }}>{ef.bookTitle}</p>}
        </div>

        {canModify && (
          <div className="ct-detail-actions">
            {contract.status === 0 && (
              isEditing ? (
                <>
                  <button onClick={handleUpdate} disabled={actionLoading} className="ct-btn ct-btn-blue"><FiSave size={14} /> {actionLoading ? 'Enregistrement…' : 'Enregistrer'}</button>
                  <button onClick={() => { setIsEditing(false); load(); }} disabled={actionLoading} className="ct-btn ct-btn-outline"><FiXCircle size={14} /> Annuler</button>
                </>
              ) : (
                <>
                  <button onClick={() => setIsEditing(true)} className="ct-btn ct-btn-blue"><FiEdit3 size={14} /> Modifier</button>
                  {canValidateDownload && <button onClick={() => setConfirmAction('validate')} className="ct-btn ct-btn-success"><FiCheckCircle size={14} /> Valider</button>}
                </>
              )
            )}
            {canReopen && contract.status === 1 && (
              <button onClick={() => setConfirmAction('reopen')} className="ct-btn ct-btn-outline"><FiRefreshCw size={14} /> Rouvrir en brouillon</button>
            )}
            {canManage && contract.status === 1 && (
              <button onClick={() => setConfirmAction('close')} className="ct-btn ct-btn-outline"><FiXCircle size={14} /> Clôturer</button>
            )}
            {canValidateDownload && (
              <button onClick={() => handleDownload('pdf')} className="ct-btn ct-btn-dark"><FiDownload size={14} /> Télécharger PDF</button>
            )}
            {canManage && contract.status === 0 && (
              <button onClick={() => setConfirmAction('delete')} className="ct-btn ct-btn-danger"><FiXCircle size={14} /> Supprimer</button>
            )}
          </div>
        )}
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
                    {CONTRACT_TYPE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <>
                <InfoRow icon={<FiBook size={14} />} label="Titre" value={ef.bookTitle} />
                <InfoRow icon={<FiFileText size={14} />} label="ISBN" value={ef.bookIsbn} mono />
                <InfoRow icon={<FiCalendar size={14} />} label="Date contrat" value={formatDate(contract.date)} />
                <InfoRow icon={<FiFileText size={14} />} label="Type" value={
                  ef.contractType ? <span className="ct-badge" style={{ padding: '2px 10px', background: `${typeColor}10`, color: typeColor }}>{typeMeta.label}</span> : '—'
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

          {/* Devis de contribution auteur */}
          <div className="ct-section">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h3 className="ct-section-title" style={{ margin: 0 }}><FiFileText size={16} /> Devis de contribution</h3>
              <button onClick={() => setShowQuoteModal(true)} className="ct-btn ct-btn-primary" style={{ padding: '6px 12px', fontSize: '0.8rem' }}>
                <FiPlus size={12} /> Générer un devis
              </button>
            </div>
            {quotesError ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#b45309', fontSize: '0.85rem' }}>
                <FiAlertCircle size={14} /> Impossible de charger les devis.
                <button onClick={loadQuotes} className="ct-btn-link">Réessayer</button>
              </div>
            ) : quotes.length === 0 ? (
              <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: 0 }}>Aucun devis. Cliquez sur « Générer un devis » pour proposer une participation aux frais d'édition à l'auteur.</p>
            ) : (
              <div className="ct-quotes-list">
                {quotes.map(q => (
                  <div key={q.id} className="ct-quote-row">
                    <div className="ct-quote-row-info">
                      <span className="ct-quote-row-ref">{q.ref}</span>
                      <span className="ct-quote-row-meta">
                        {new Date(q.created_at).toLocaleDateString('fr-FR')} · {q.created_by || 'admin'}
                      </span>
                    </div>
                    <span className="ct-quote-row-total">{Number(q.total).toLocaleString('fr-FR')} FCFA</span>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {q.status === 'sent' && (
                        <span className="ct-badge" style={{ padding: '2px 8px', background: '#10531a14', color: '#10531a', fontSize: '0.72rem', display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Devis envoyé à l'auteur">
                          <FiCheck size={11} /> Envoyé
                        </span>
                      )}
                      <button onClick={() => openQuotePdf(q.id)} className="ct-btn ct-btn-outline" style={{ padding: '5px 10px', fontSize: '0.78rem' }} title="Ouvrir le PDF">
                        <FiDownload size={12} /> PDF
                      </button>
                      {canManage && q.status !== 'sent' && (
                        <button onClick={() => setConfirmQuote({ action: 'send', quote: q })} className="ct-btn ct-btn-outline" style={{ padding: '5px 10px', fontSize: '0.78rem' }} title="Marquer comme envoyé à l'auteur">
                          <FiSend size={12} /> Envoyé
                        </button>
                      )}
                      {canManage && q.status === 'draft' && (
                        <button onClick={() => setConfirmQuote({ action: 'delete', quote: q })} className="ct-btn-ghost" aria-label={`Supprimer le devis ${q.ref}`} title="Supprimer le devis">
                          <FiTrash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Documents (téléchargement du PDF contrat — profils éditoriaux + comptable) */}
          {canValidateDownload && (
          <div className="ct-section">
            <h3 className="ct-section-title"><FiFileText size={16} /> Documents</h3>
            {contract.documents?.length > 0 ? (
              contract.documents.map((d, i) => {
                const ext = d.name.split('.').pop().toLowerCase();
                const isPdf = ext === 'pdf';
                const iconColor = isPdf ? '#dc2626' : '#0284c7';
                return (
                  <div key={d.name || i} className="ct-doc-item">
                    <div className="ct-doc-info">
                      <span className="ct-doc-icon" style={{ background: `${iconColor}12`, color: iconColor }}>{ext.toUpperCase()}</span>
                      <span className="ct-doc-name">{d.name}</span>
                    </div>
                    <button onClick={() => handleDownload(ext)} className="ct-doc-btn" style={{ background: iconColor }}>
                      <FiDownload size={12} /> {ext.toUpperCase()}
                    </button>
                  </div>
                );
              })
            ) : (
              <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Aucun document. Validez le contrat pour générer le PDF.</p>
            )}
          </div>
          )}

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

          {/* Signature (réservé aux profils éditoriaux) — en ligne ou manuscrite */}
          {canManage && contract.status >= 1 && (
            <div className="ct-section">
              <h3 className="ct-section-title"><FiCheckCircle size={16} /> Signature</h3>
              <div className={`ct-sign-status ${signStatus?.status >= 2 ? 'signed' : 'pending'}`}>
                <div className="ct-sign-label" style={{ color: signStatus?.status >= 2 ? '#166534' : '#92400e' }}>
                  {signStatus?.label || 'Non signé'}
                  {signStatus?.method === 'manuscrite' && ' · sur papier'}
                  {signStatus?.method === 'en_ligne' && ' · en ligne'}
                </div>

                {/* Signature en ligne */}
                {signStatus?.method === 'en_ligne' && signStatus?.signedBy && (
                  <div className="ct-sign-detail">Signé par : {signStatus.signedBy} {signStatus.signedIp ? `(IP: ${signStatus.signedIp})` : ''}</div>
                )}

                {/* Signature manuscrite : attestation + preuve */}
                {signStatus?.physical && (
                  <>
                    <div className="ct-sign-detail" style={{ marginTop: 4 }}>
                      Signé sur papier le <strong>{signStatus.physical.signedDate}</strong>
                      {signStatus.physical.signerName ? ` par ${signStatus.physical.signerName}` : ''}.
                    </div>
                    <div className="ct-sign-detail" style={{ fontSize: '0.78rem', color: '#64748b' }}>
                      Attesté par {signStatus.physical.attestedBy} le {signStatus.physical.attestedAt}
                    </div>
                    {signStatus.physical.scanHash && (
                      <details className="ct-sign-detail" style={{ fontSize: '0.75rem', color: '#64748b', marginTop: 2 }}>
                        <summary style={{ cursor: 'pointer' }}>Empreinte d'intégrité du scan (SHA-256)</summary>
                        <code style={{ wordBreak: 'break-all', fontSize: '0.72rem' }}>{signStatus.physical.scanHash}</code>
                      </details>
                    )}
                  </>
                )}

                {signStatus?.status >= 2 && signStatus?.method !== 'manuscrite' && (
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

              {/* Pas encore signé : proposer en ligne OU papier */}
              {signStatus?.status < 2 && (
                <div className="ct-sign-actions">
                  <button onClick={handleSendSignature} disabled={sendingSign} className="ct-btn ct-btn-primary" style={{ justifyContent: 'center' }}>
                    {sendingSign ? 'Envoi...' : 'Envoyer le lien à l’auteur'}
                  </button>
                  <button onClick={() => setShowPhysicalSign(true)} className="ct-btn ct-btn-outline" style={{ justifyContent: 'center' }}>
                    <FiUploadCloud size={14} /> Enregistrer une signature papier
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

              {/* Signé : actions selon le mode */}
              {signStatus?.status >= 2 && (
                <div className="ct-sign-actions">
                  {signStatus?.physical?.hasScan && (
                    <button onClick={handleDownloadScan} className="ct-btn ct-btn-dark" style={{ justifyContent: 'center' }}>
                      <FiDownload size={14} /> Voir le scan signé
                    </button>
                  )}
                  {signStatus?.method !== 'manuscrite' && (
                    <button onClick={handleRegenerate} disabled={regenerating} className="ct-btn ct-btn-blue" style={{ justifyContent: 'center' }}>
                      <FiRefreshCw size={14} /> {regenerating ? 'Régénération…' : 'Régénérer le PDF signé'}
                    </button>
                  )}
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
          loading={actionLoading}
          onConfirm={handleValidate}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {showPhysicalSign && (
        <div className="ct-modal-overlay" onClick={() => !physSigning && setShowPhysicalSign(false)}>
          <div className="ct-modal" role="dialog" aria-modal="true" aria-labelledby="phys-sign-title" onClick={e => e.stopPropagation()}>
            <h3 id="phys-sign-title" style={{ margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <FiUploadCloud size={18} /> Signature manuscrite (papier)
            </h3>
            <p style={{ fontSize: '0.85rem', color: '#64748b', margin: '0 0 16px' }}>
              Attestez la réception du contrat signé à la main par l'auteur et archivez-en le scan comme preuve.
            </p>

            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: 4 }}>Date de signature *</label>
            <input
              type="date"
              autoFocus
              value={physForm.signed_date}
              max={new Date().toISOString().slice(0, 10)}
              onChange={e => setPhysForm(f => ({ ...f, signed_date: e.target.value }))}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, marginBottom: 12 }}
            />

            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: 4 }}>Nom du signataire</label>
            <input
              type="text"
              placeholder="Par défaut : l'auteur du contrat"
              value={physForm.signer_name}
              onChange={e => setPhysForm(f => ({ ...f, signer_name: e.target.value }))}
              style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, marginBottom: 12 }}
            />

            <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: 4 }}>Scan du contrat signé * <span style={{ fontWeight: 400, color: '#94a3b8' }}>(PDF, JPG ou PNG — 15 Mo max)</span></label>
            <input
              type="file"
              accept=".pdf,.jpg,.jpeg,.png"
              onChange={e => setPhysForm(f => ({ ...f, file: e.target.files?.[0] || null }))}
              style={{ width: '100%', marginBottom: 18, fontSize: '0.85rem' }}
            />

            <div className="ct-modal-actions">
              <button onClick={() => setShowPhysicalSign(false)} disabled={physSigning} className="ct-btn ct-btn-outline">Annuler</button>
              <button onClick={handleSignPhysical} disabled={physSigning || !physForm.file} className="ct-btn ct-btn-success">
                {physSigning ? 'Enregistrement…' : 'Attester et archiver'}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmAction === 'reopen' && (
        <ConfirmModal
          title="Rouvrir ce contrat en brouillon ?"
          message="Le contrat repassera en statut Brouillon afin de corriger une erreur, puis pourra être re-validé (ce qui régénérera le document). La référence est conservée."
          confirmLabel="Rouvrir en brouillon"
          loading={actionLoading}
          onConfirm={handleReopen}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'close' && (
        <ConfirmModal
          title="Clôturer ce contrat ?"
          message="Le contrat sera définitivement clôturé. Cette action est irréversible."
          confirmLabel="Clôturer"
          danger
          loading={actionLoading}
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
          loading={actionLoading}
          onConfirm={handleDelete}
          onCancel={() => setConfirmAction(null)}
        />
      )}
      {confirmQuote && (
        <ConfirmModal
          title={confirmQuote.action === 'delete' ? `Supprimer le devis ${confirmQuote.quote.ref} ?` : `Marquer le devis ${confirmQuote.quote.ref} comme envoyé ?`}
          message={confirmQuote.action === 'delete'
            ? 'Le devis sera définitivement supprimé.'
            : 'Le devis sera marqué comme transmis à l\'auteur. Pensez à lui envoyer le PDF par email.'}
          confirmLabel={confirmQuote.action === 'delete' ? 'Supprimer' : 'Marquer envoyé'}
          danger={confirmQuote.action === 'delete'}
          loading={quoteActionLoading}
          onConfirm={runQuoteAction}
          onCancel={() => setConfirmQuote(null)}
        />
      )}
      {showQuoteModal && (
        <ContractQuoteModal
          contract={contract}
          onClose={() => setShowQuoteModal(false)}
          onCreated={loadQuotes}
        />
      )}
    </div>
  );
}
