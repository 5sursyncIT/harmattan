import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { FiArrowLeft, FiDownload, FiUser, FiPlus, FiExternalLink, FiFileText, FiLink2, FiEdit3 } from 'react-icons/fi';
import toast from 'react-hot-toast';
import { manuscriptsApi, intervenantsApi } from '../../../api/manuscripts';
import { getContracts, signContractPhysical, validateContract } from '../../../api/contracts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import ManuscriptTimeline from '../../../components/common/ManuscriptTimeline';
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
// Ancienne colonne (historique admin_users) associée à chaque ligne, pour rappel en lecture seule.
const LEGACY_COL = {
  assigned_evaluator_contact_id: 'assigned_evaluator_id',
  assigned_corrector_contact_id: 'assigned_corrector_id',
  assigned_printer_contact_id: 'assigned_printer_id',
};

export default function ManuscriptDetailPanel() {
  const { id } = useParams();
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

  const load = () => {
    setLoading(true);
    manuscriptsApi.get(id)
      .then((res) => setData(res.data))
      .catch((err) => toast.error(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load();   }, [id]);

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

  // La route /contracts/list n'a pas de recherche plein-texte unique : on charge la
  // liste récente et on filtre côté client (réf / titre / auteur).
  const loadContracts = async () => {
    setContractSearching(true);
    try {
      const res = await getContracts({ limit: 50, sort: 'date', order: 'DESC' });
      const list = Array.isArray(res.data) ? res.data : (res.data?.contracts || res.data?.items || []);
      setContractResults(list);
    } catch { setContractResults([]); }
    finally { setContractSearching(false); }
  };
  const openLinkModal = () => { setLinkModal(true); setContractQuery(''); loadContracts(); };
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

      {manuscript.current_stage === 'payment_pending' && (
        <div className="ms-action-banner">
          <h4>Paiement en attente</h4>
          <p>Confirmez le paiement pour déclencher la phase de correction.</p>
          <div className="ms-actions">
            <button type="button" className="ms-btn ms-btn-primary" onClick={markPaid}>Confirmer le paiement</button>
          </div>
        </div>
      )}

      {manuscript.current_stage === 'contract_pending' && (
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
                {['submitted', 'in_evaluation', 'evaluation_negative'].includes(manuscript.current_stage) ? (
                  <small style={{ color: '#9ca3af' }}>Un contrat se crée après une évaluation favorable.</small>
                ) : (
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
                )}
              </>
            )}
          </div>

          <div className="ms-card">
            <h3>Fichiers ({files?.length || 0})</h3>
            {files?.length ? (
              <ul className="ms-file-list">
                {files.map((f) => (
                  <li key={f.id}>
                    <div>
                      <span className="ms-file-kind">{f.kind}</span>
                      {f.version > 1 && <strong>v{f.version}</strong>} {f.file_name}
                    </div>
                    {f.external_url ? (
                      <a href={f.external_url}
                        target="_blank" rel="noopener noreferrer"
                        className="ms-btn">
                        <FiExternalLink /> Ouvrir le lien
                      </a>
                    ) : (
                      <a href={manuscriptsApi.downloadUrl(manuscript.id, f.id)}
                        target="_blank" rel="noopener noreferrer"
                        className="ms-btn">
                        <FiDownload /> Télécharger
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p style={{ color: '#6b7280' }}>Aucun fichier.</p>}
          </div>

          {evaluations?.length > 0 && (
            <div className="ms-card">
              <h3>Évaluations ({evaluations.length})</h3>
              {evaluations.map((ev) => (
                <div key={ev.id} style={{ padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <strong style={{ color: ev.verdict === 'positive' ? '#10531a' : '#dc2626' }}>
                    {ev.verdict === 'positive' ? 'Avis favorable' : 'Avis défavorable'}
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
                    <button type="button" className="ms-btn" onClick={() => openAssign(col)}>Modifier</button>
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
            <ManuscriptTimeline stages={stages} />
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
    </div>
  );
}
