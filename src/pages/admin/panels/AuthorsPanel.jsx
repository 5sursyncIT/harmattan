import { useEffect, useState, useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiSearch, FiRefreshCw, FiMail, FiEye, FiX, FiKey, FiCheckCircle, FiExternalLink, FiFileText, FiEdit2, FiDollarSign, FiGlobe, FiUpload, FiCreditCard, FiClipboard, FiBookOpen, FiUser } from 'react-icons/fi';
import toast from 'react-hot-toast';
import {
  getAdminAuthors, getAdminAuthor, resetAuthorPassword,
  updateAdminAuthor, uploadAuthorPhoto, notifyAuthorRoyalties,
} from '../../../api/admin';
import { safeHttpUrl } from '../../../utils/safeUrl';
import PdfViewerModal from '../../../components/admin/PdfViewerModal';
import { CONTRACT_STATUS_LABELS } from '../../../utils/contractTypes';

const STAGE_LABELS = {
  submitted: 'Soumis', in_evaluation: 'En évaluation',
  evaluation_positive: 'Évaluation positive', evaluation_rework: 'À retravailler', evaluation_negative: 'Rejeté',
  contract_pending: 'Contrat en attente', contract_signed: 'Contrat signé',
  payment_pending: 'Paiement en attente', in_correction: 'En correction',
  correction_author_review: 'Relecture auteur', in_editorial: 'Validation éditoriale',
  editorial_validated: 'Validé', cover_design: 'Couverture',
  bat_author_review: 'BAT auteur', print_preparation: 'Préparation impression',
  printing: 'Impression', printed: 'Imprimé',
  in_communication: 'En communication', published: 'Paru',
};
const STAGE_COLORS = {
  submitted: '#0284c7', in_evaluation: '#ea580c',
  evaluation_positive: '#10531a', evaluation_negative: '#dc2626',
  contract_pending: '#d97706', contract_signed: '#10531a',
  payment_pending: '#d97706', in_correction: '#0d9488',
  correction_author_review: '#7c3aed', in_editorial: '#0891b2',
  editorial_validated: '#10531a', cover_design: '#c026d3',
  bat_author_review: '#7c3aed', print_preparation: '#854d0e',
  printing: '#854d0e', printed: '#10531a',
  in_communication: '#0b4f6c', published: '#10531a',
};

const INVOICE_STATUS = {
  0: { label: 'Brouillon', color: '#6b7280' },
  1: { label: 'Impayée', color: '#b91c1c' },
  2: { label: 'Payée', color: '#10531a' },
  3: { label: 'Abandonnée', color: '#9ca3af' },
};
const PROPAL_STATUS = {
  0: { label: 'Brouillon', color: '#6b7280' },
  1: { label: 'Validé', color: '#0284c7' },
  2: { label: 'Signé', color: '#10531a' },
  3: { label: 'Non signé', color: '#b91c1c' },
  4: { label: 'Facturé', color: '#7c3aed' },
};
const CONTRACT_STATUS_COLORS = { 0: '#6b7280', 1: '#10531a', 2: '#0891b2' };
const PAYMENT_METHODS = {
  LIQ: 'Espèces', CB: 'Carte', CHQ: 'Chèque', VIR: 'Virement',
  WAVE: 'Wave', OM: 'Orange Money', PRE: 'Prélèvement', TIP: 'TIP',
};

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatMoney(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)) + ' XOF';
}

function StatusBadge({ status, map }) {
  const meta = map[status] || { label: status ?? '—', color: '#888' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      background: meta.color + '22', color: meta.color, fontSize: 12, fontWeight: 600,
    }}>{meta.label}</span>
  );
}

function KpiChip({ label, value, tone = 'neutral' }) {
  const tones = {
    neutral: { bg: '#f3f4f6', fg: '#374151' },
    good: { bg: '#10531a18', fg: '#10531a' },
    bad: { bg: '#b91c1c18', fg: '#b91c1c' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{ background: t.bg, color: t.fg, padding: '4px 12px', borderRadius: 8, fontSize: 13 }}>
      {label} : <strong>{value}</strong>
    </span>
  );
}

/**
 * Compte du tiers lié : factures, arriérés, règlements, contrats, devis.
 * Tout est rendu nativement — l'UI Dolibarr n'est pas accessible depuis le site,
 * la fiche auteur doit donc se suffire à elle-même.
 */
function AuthorAccountSection({ account, tierId, onPdf }) {
  const [tab, setTab] = useState('invoices');

  if (!account) {
    return (
      <section className="admin-modal-section">
        <h4><FiCreditCard /> Compte & transactions</h4>
        <p style={{ color: tierId ? '#b91c1c' : '#6b7280', margin: 0 }}>
          {tierId
            ? `Fiche tiers #${tierId} rattachée, mais son compte n'a pas pu être chargé (service comptable injoignable).`
            : `Aucune fiche tiers rattachée : cet auteur n'a ni facture, ni règlement, ni contrat enregistré.
               La fiche tiers est créée automatiquement dès la première relation réelle (manuscrit, contrat, devis).`}
        </p>
      </section>
    );
  }
  if (account.restricted) {
    return (
      <section className="admin-modal-section">
        <h4><FiCreditCard /> Compte & transactions</h4>
        <p style={{ color: '#6b7280', margin: 0 }}>
          Cet auteur a un compte tiers, mais sa situation financière (factures, arriérés, règlements)
          n'est pas accessible avec votre rôle.
        </p>
      </section>
    );
  }
  if (account.error || account.missing) {
    return (
      <section className="admin-modal-section">
        <h4><FiCreditCard /> Compte & transactions</h4>
        <p style={{ color: '#b91c1c', margin: 0 }}>
          {account.missing
            ? `La fiche tiers #${account.tier_id} référencée n'existe plus (supprimée ou fusionnée). Le rattachement est à corriger.`
            : `${account.error} — réessayez dans un instant.`}
        </p>
      </section>
    );
  }

  const { societe, invoiceTotals: t, invoices = [], payments = [], contracts = [], quotes = [] } = account;
  const tabs = [
    { id: 'invoices', label: 'Factures', icon: <FiFileText />, count: t?.count || 0 },
    { id: 'payments', label: 'Règlements', icon: <FiDollarSign />, count: payments.length },
    { id: 'contracts', label: 'Contrats', icon: <FiBookOpen />, count: contracts.length },
    { id: 'quotes', label: 'Devis', icon: <FiClipboard />, count: quotes.length },
  ];

  return (
    <section className="admin-modal-section">
      <h4>
        <FiCreditCard /> Compte & transactions
        <span className="admin-modal-section-total">
          Tiers #{societe.id}{societe.code_client ? ` · ${societe.code_client}` : ''}
          {societe.status === 0 ? ' · ARCHIVÉ' : ''}
        </span>
      </h4>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <KpiChip label="Facturé" value={formatMoney(t?.total_ttc)} />
        <KpiChip label="Réglé" value={formatMoney(t?.total_paid)} tone="good" />
        {/* MySQL renvoie les SUM(...) en chaînes : « '0' » est truthy, d'où les Number(). */}
        <KpiChip
          label="Arriérés"
          value={`${formatMoney(t?.total_unpaid)}${Number(t?.unpaid_count) > 0 ? ` (${t.unpaid_count} facture${Number(t.unpaid_count) > 1 ? 's' : ''})` : ''}`}
          tone={Number(t?.total_unpaid) > 0 ? 'bad' : 'good'}
        />
        {Number(t?.draft_count) > 0 && <KpiChip label="Brouillons" value={t.draft_count} />}
        {Number(t?.abandoned_count) > 0 && <KpiChip label="Abandonnées" value={t.abandoned_count} />}
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', overflowX: 'auto', marginBottom: 12 }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            type="button"
            onClick={() => setTab(tb.id)}
            style={{
              padding: '8px 14px', border: 'none', background: 'none',
              borderBottom: tab === tb.id ? '2px solid #10531a' : '2px solid transparent',
              color: tab === tb.id ? '#10531a' : '#6b7280',
              fontWeight: tab === tb.id ? 600 : 500,
              cursor: 'pointer', whiteSpace: 'nowrap',
              display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
            }}
          >
            {tb.icon} {tb.label}
            {tb.count > 0 && (
              <span style={{
                background: tab === tb.id ? '#10531a' : '#e5e7eb',
                color: tab === tb.id ? '#fff' : '#374151',
                padding: '1px 8px', borderRadius: 10, fontSize: 11,
              }}>{tb.count}</span>
            )}
          </button>
        ))}
      </div>

      {tab === 'invoices' && (
        invoices.length ? (
          <>
            <table className="admin-table">
              <thead><tr><th>Réf.</th><th>Date</th><th>Montant</th><th>Reste dû</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                {invoices.map((inv) => {
                  const due = inv.fk_statut === 1 && inv.type !== 2
                    ? Math.max(Number(inv.total_ttc) - Number(inv.paid_amount), 0) : 0;
                  return (
                    <tr key={inv.id}>
                      <td>
                        <Link to={`/admin/invoices?invoice=${inv.id}`} style={{ color: '#10531a', fontWeight: 700 }}
                          title="Ouvrir le détail et les actions de la facture">
                          {inv.ref}
                        </Link>
                        {inv.type === 2 && <span style={{ marginLeft: 6, fontSize: 11, color: '#7c3aed' }}>avoir</span>}
                      </td>
                      <td>{formatDate(inv.date)}</td>
                      <td>{formatMoney(inv.total_ttc)}</td>
                      <td style={{ color: due > 0 ? '#b91c1c' : '#9ca3af', fontWeight: due > 0 ? 700 : 400 }}>
                        {due > 0 ? formatMoney(due) : '—'}
                      </td>
                      <td><StatusBadge status={inv.fk_statut} map={INVOICE_STATUS} /></td>
                      <td>
                        <button className="btn-ghost" title="Voir le PDF"
                          onClick={() => onPdf({ url: `/api/admin/invoices/${inv.id}/pdf`, title: `Facture ${inv.ref}` })}>
                          <FiEye />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {t?.count > invoices.length && (
              <p style={{ color: '#6b7280', fontSize: 12, margin: '8px 0 0' }}>
                {invoices.length} facture(s) les plus récentes sur {t.count} —{' '}
                <Link to={`/admin/tiers/${societe.id}`} style={{ color: '#10531a' }}>voir tout le compte</Link>.
              </p>
            )}
          </>
        ) : <p style={{ color: '#6b7280', margin: 0 }}>Aucune facture.</p>
      )}

      {tab === 'payments' && (
        payments.length ? (
          <table className="admin-table">
            <thead><tr><th>Date</th><th>Montant</th><th>Moyen</th><th>Facture</th></tr></thead>
            <tbody>
              {payments.map((p, i) => (
                <tr key={`${p.id}-${p.invoice_id}-${i}`}>
                  <td>{formatDate(p.date)}</td>
                  <td style={{ fontWeight: 700 }}>{formatMoney(p.amount)}</td>
                  <td>{PAYMENT_METHODS[p.method_code] || p.method_code || '—'}</td>
                  <td>
                    <Link to={`/admin/invoices?invoice=${p.invoice_id}`} style={{ color: '#10531a' }}>
                      {p.invoice_ref}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: '#6b7280', margin: 0 }}>Aucun règlement enregistré.</p>
      )}

      {tab === 'contracts' && (
        contracts.length ? (
          <table className="admin-table">
            <thead><tr><th>Réf.</th><th>Ouvrage</th><th>Date</th><th>Statut</th><th></th></tr></thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 700 }}>{c.ref}</td>
                  <td>{c.book_title || '—'}</td>
                  <td>{formatDate(c.date)}</td>
                  <td>
                    <StatusBadge
                      status={c.statut}
                      map={Object.fromEntries(Object.entries(CONTRACT_STATUS_LABELS).map(
                        ([k, label]) => [k, { label, color: CONTRACT_STATUS_COLORS[k] || '#6b7280' }]
                      ))}
                    />
                  </td>
                  <td>
                    <Link to={`/admin/contracts/${c.id}`} className="btn-ghost" title="Ouvrir le contrat">
                      <FiExternalLink />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: '#6b7280', margin: 0 }}>Aucun contrat.</p>
      )}

      {tab === 'quotes' && (
        quotes.length ? (
          <table className="admin-table">
            <thead><tr><th>Réf.</th><th>Date</th><th>Montant</th><th>Statut</th></tr></thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td style={{ fontWeight: 700 }}>{q.ref}</td>
                  <td>{formatDate(q.date)}</td>
                  <td>{formatMoney(q.total_ttc)}</td>
                  <td><StatusBadge status={q.fk_statut} map={PROPAL_STATUS} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p style={{ color: '#6b7280', margin: 0 }}>Aucun devis.</p>
      )}
    </section>
  );
}

function StageBadge({ stage }) {
  if (!stage) return <span style={{ color: '#9ca3af' }}>—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 12,
      background: STAGE_COLORS[stage] || '#6b7280', color: '#fff',
      fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
    }}>
      {STAGE_LABELS[stage] || stage}
    </span>
  );
}

function AuthorDetailModal({ id, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [notifyLoading, setNotifyLoading] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [pdfView, setPdfView] = useState(null);
  const photoInputRef = useRef(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    getAdminAuthor(id)
      .then((r) => {
        if (cancelled) return;
        setData(r.data);
        setForm({
          firstname: r.data.author.firstname || '',
          lastname: r.data.author.lastname || '',
          email: r.data.author.email || '',
          phone: r.data.author.phone || '',
          display_name: r.data.author.display_name || `${r.data.author.firstname} ${r.data.author.lastname}`.trim(),
          slug: r.data.author.slug || '',
          bio: r.data.author.bio || '',
          photo_url: r.data.author.photo_url || '',
          website: r.data.author.website || '',
          social_twitter: r.data.author.social_twitter || '',
          social_instagram: r.data.author.social_instagram || '',
          social_linkedin: r.data.author.social_linkedin || '',
          social_facebook: r.data.author.social_facebook || '',
          public_listed: !!r.data.author.public_listed,
        });
      })
      .catch(() => { if (!cancelled) toast.error('Erreur de chargement'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleReset = async () => {
    if (!window.confirm('Envoyer un email de réinitialisation de mot de passe à cet auteur ?')) return;
    try {
      const res = await resetAuthorPassword(id);
      toast.success(`Lien de réinitialisation envoyé à ${res.data.email}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await updateAdminAuthor(id, form);
      toast.success(`Profil mis à jour (slug: ${res.data.slug})`);
      if (res.data.dolibarr_synced === false) {
        toast.error('Fiche locale mise à jour, mais la synchronisation Dolibarr a échoué (nom inchangé sur contrats/factures).');
      }
      setEditing(false);
      load();
      onSaved?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  const handleNotifyRoyalties = async () => {
    if (!window.confirm('Envoyer à cet auteur un email récapitulatif de ses royalties dues sur l\'exercice en cours ?')) return;
    setNotifyLoading(true);
    try {
      const res = await notifyAuthorRoyalties(id);
      if (res.data.books === 0) {
        toast.success(`Email envoyé à ${res.data.email} (aucune royaltie due)`);
      } else {
        toast.success(`Email envoyé à ${res.data.email} — ${res.data.books} livre(s), ${res.data.total_due.toLocaleString('fr-FR')} XOF dus`);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    } finally {
      setNotifyLoading(false);
    }
  };

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (file) e.target.value = ''; // permet de re-sélectionner le même fichier
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error('Image trop lourde (8 Mo max)'); return; }
    setUploadingPhoto(true);
    try {
      const res = await uploadAuthorPhoto(id, file);
      setForm((f) => ({ ...f, photo_url: res.data.photo_url }));
      toast.success('Photo mise à jour');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur upload photo');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleChange = (key) => (e) => {
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: val }));
  };

  return (
    <>
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal admin-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{loading ? 'Chargement…' : `${data?.author.firstname || ''} ${data?.author.lastname || ''}`}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Fermer"><FiX /></button>
        </div>
        {!loading && data && (
          <div className="admin-modal-body">
            <div className="admin-info-grid">
              <div><strong>Email</strong><span>
                {data.author.email
                  ? <>{data.author.email} {data.author.email_verified ? <FiCheckCircle style={{ color: '#10531a', verticalAlign: 'middle' }} /> : null}</>
                  : <em style={{ color: '#9ca3af' }}>aucun email saisi</em>}
              </span></div>
              <div><strong>Téléphone</strong><span>{data.author.phone || '—'}</span></div>
              <div><strong>Inscrit le</strong><span>{formatDate(data.author.created_at)}</span></div>
              <div>
                <strong>Dolibarr</strong>
                <span>{data.author.dolibarr_thirdparty_id ? `#${data.author.dolibarr_thirdparty_id}` : '—'}</span>
              </div>
            </div>

            <section className="admin-modal-section">
              <h4>
                <FiFileText /> Manuscrits ({data.totals?.total || 0})
                <span className="admin-modal-section-total">
                  {data.totals?.accepted || 0} acceptés · {data.totals?.rejected || 0} rejetés · {data.totals?.pending || 0} en attente
                </span>
              </h4>
              {data.manuscripts?.length > 0 ? (
                <table className="admin-table">
                  <thead><tr><th>Réf.</th><th>Titre</th><th>Genre</th><th>Étape</th><th>Soumis le</th><th></th></tr></thead>
                  <tbody>
                    {data.manuscripts.map((m) => (
                      <tr key={m.id}>
                        <td>{m.ref}</td>
                        <td>{m.title}</td>
                        <td>{m.genre || '—'}</td>
                        <td><StageBadge stage={m.stage} /></td>
                        <td>{formatDate(m.created_at)}</td>
                        <td>
                          <Link to={`/admin/manuscripts/${m.id}`} className="btn-ghost" title="Ouvrir">
                            <FiExternalLink />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <p style={{ color: '#6b7280', margin: 0 }}>Aucun manuscrit soumis.</p>}
            </section>

            <AuthorAccountSection
              account={data.account}
              tierId={data.author.dolibarr_thirdparty_id}
              onPdf={setPdfView}
            />

            <section className="admin-modal-section">
              <h4>
                <FiGlobe /> Profil public
                {!!data.author.public_listed && data.author.slug && (
                  <span style={{ marginLeft: 12, fontSize: 12, color: '#10531a', fontWeight: 600 }}>
                    Visible · <a href={`/auteur/${data.author.slug}`} target="_blank" rel="noreferrer" style={{ color: '#10531a' }}>/auteur/{data.author.slug}</a>
                  </span>
                )}
              </h4>
              {!editing ? (
                <div className="admin-info-grid">
                  <div><strong>Affichage</strong><span>{data.author.display_name || '—'}</span></div>
                  <div><strong>Slug</strong><span>{data.author.slug || '—'}</span></div>
                  <div><strong>Public</strong><span>{data.author.public_listed ? 'Oui' : 'Non'}</span></div>
                  <div><strong>Site web</strong><span>{safeHttpUrl(data.author.website) ? <a href={safeHttpUrl(data.author.website)} target="_blank" rel="noreferrer">{data.author.website}</a> : (data.author.website || '—')}</span></div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <strong>Biographie</strong>
                    <span style={{ whiteSpace: 'pre-wrap' }}>{data.author.bio || '—'}</span>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSave} style={{ display: 'grid', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Prénom</strong>
                      <input type="text" value={form.firstname} onChange={handleChange('firstname')} style={{ width: '100%' }} />
                    </label>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Nom</strong>
                      <input type="text" value={form.lastname} onChange={handleChange('lastname')} style={{ width: '100%' }} />
                    </label>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Email</strong>
                      <input type="email" value={form.email} onChange={handleChange('email')} placeholder="email@exemple.com" style={{ width: '100%' }} />
                    </label>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Téléphone</strong>
                      <input type="tel" value={form.phone} onChange={handleChange('phone')} style={{ width: '100%' }} />
                    </label>
                  </div>
                  {data.author.dolibarr_thirdparty_id && (
                    <small style={{ color: '#6b7280', marginTop: -6 }}>
                      Nom, email et téléphone seront aussi mis à jour sur la fiche Dolibarr liée (#{data.author.dolibarr_thirdparty_id}).
                    </small>
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Nom d'affichage</strong>
                      <input type="text" value={form.display_name} onChange={handleChange('display_name')} style={{ width: '100%' }} />
                    </label>
                    <label>
                      <strong style={{ display: 'block', marginBottom: 4 }}>Slug URL</strong>
                      <input type="text" value={form.slug} onChange={handleChange('slug')} placeholder="prenom-nom" style={{ width: '100%' }} />
                    </label>
                  </div>
                  <div>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Photo de profil</strong>
                    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                      <div style={{
                        width: 84, height: 110, borderRadius: 8, overflow: 'hidden', flexShrink: 0,
                        background: '#f3f4f6', border: '1px solid #e5e7eb',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        {form.photo_url
                          ? <img src={form.photo_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ color: '#9ca3af', fontSize: 11 }}>Aucune</span>}
                      </div>
                      <div style={{ flex: 1, display: 'grid', gap: 8 }}>
                        <input
                          ref={photoInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          onChange={handlePhotoUpload}
                          style={{ display: 'none' }}
                        />
                        <button
                          type="button"
                          className="btn btn-outline"
                          onClick={() => photoInputRef.current?.click()}
                          disabled={uploadingPhoto}
                          style={{ justifySelf: 'start' }}
                        >
                          <FiUpload /> {uploadingPhoto ? 'Envoi…' : 'Téléverser une image'}
                        </button>
                        <input
                          type="text"
                          inputMode="url"
                          value={form.photo_url}
                          onChange={handleChange('photo_url')}
                          placeholder="…ou coller une URL https://…/photo.jpg"
                          style={{ width: '100%' }}
                        />
                        <small style={{ color: '#6b7280' }}>JPG, PNG ou WEBP — 8 Mo max. L'image est enregistrée immédiatement.</small>
                      </div>
                    </div>
                  </div>
                  <label>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Biographie</strong>
                    <textarea value={form.bio} onChange={handleChange('bio')} rows={6} maxLength={5000} style={{ width: '100%' }} />
                  </label>
                  <label>
                    <strong style={{ display: 'block', marginBottom: 4 }}>Site web</strong>
                    <input type="url" value={form.website} onChange={handleChange('website')} placeholder="https://…" style={{ width: '100%' }} />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>Twitter / X</strong><input type="url" value={form.social_twitter} onChange={handleChange('social_twitter')} style={{ width: '100%' }} /></label>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>Instagram</strong><input type="url" value={form.social_instagram} onChange={handleChange('social_instagram')} style={{ width: '100%' }} /></label>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>LinkedIn</strong><input type="url" value={form.social_linkedin} onChange={handleChange('social_linkedin')} style={{ width: '100%' }} /></label>
                    <label><strong style={{ display: 'block', marginBottom: 4 }}>Facebook</strong><input type="url" value={form.social_facebook} onChange={handleChange('social_facebook')} style={{ width: '100%' }} /></label>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={form.public_listed} onChange={handleChange('public_listed')} />
                    <strong>Publier dans l'annuaire des auteurs</strong>
                  </label>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Annuler</button>
                    <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Sauvegarde…' : 'Enregistrer'}</button>
                  </div>
                </form>
              )}
            </section>

            <div className="admin-modal-actions">
              {!editing && (
                <button className="btn btn-primary" onClick={() => setEditing(true)}><FiEdit2 /> Éditer le profil</button>
              )}
              <button className="btn btn-outline" onClick={handleNotifyRoyalties} disabled={notifyLoading}>
                <FiDollarSign /> {notifyLoading ? 'Envoi…' : 'Envoyer récap royalties'}
              </button>
              <button className="btn btn-outline" onClick={handleReset}><FiKey /> Reset MDP</button>
              {data.account?.societe && (
                <>
                  <Link className="btn btn-outline" to={`/admin/tiers/${data.account.societe.id}`}>
                    <FiUser /> Fiche tiers
                  </Link>
                  {data.account.invoiceTotals?.count > 0 && (
                    <button
                      className="btn btn-outline"
                      onClick={() => setPdfView({
                        url: `/api/admin/societes/${data.account.societe.id}/report.pdf`,
                        title: `État de compte — ${data.account.societe.nom}`,
                      })}
                    >
                      <FiFileText /> État de compte
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    {/* Hors de l'overlay : imbriqué, un clic sur le fond du PDF fermerait aussi la fiche. */}
    {pdfView && (
      <PdfViewerModal url={pdfView.url} title={pdfView.title} onClose={() => setPdfView(null)} />
    )}
    </>
  );
}

export default function AuthorsPanel() {
  const [authors, setAuthors] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  // ?author=<id> — ouvre directement la fiche : c'est la cible du bouton
  // « Fiche auteur » de la fiche manuscrit (l'auteur n'a pas d'URL propre,
  // sa fiche est une modale de cet écran).
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState(() => {
    const id = parseInt(searchParams.get('author'), 10);
    return Number.isInteger(id) ? id : null;
  });
  const closeDetail = () => {
    setSelected(null);
    if (searchParams.get('author')) {
      const next = new URLSearchParams(searchParams);
      next.delete('author');
      setSearchParams(next, { replace: true });
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    getAdminAuthors({ q, page, limit: 20 })
      .then((r) => {
        setAuthors(r.data.authors);
        setTotal(r.data.total);
        setPages(r.data.pages);
      })
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [q, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3 style={{ margin: 0 }}>Auteurs ({total})</h3>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Comptes du portail auteur (soumission de manuscrits). Liés aux fiches tiers Dolibarr.
          </p>
        </div>
        <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <div className="admin-search-row">
          <div className="admin-search-input">
            <FiSearch />
            <input
              type="text"
              placeholder="Rechercher par email, nom, prénom ou téléphone…"
              value={q}
              onChange={(e) => { setPage(1); setQ(e.target.value); }}
            />
          </div>
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Auteur</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th style={{ textAlign: 'center' }}>Manuscrits</th>
              <th>Dernière étape</th>
              <th>Inscrit le</th>
              <th style={{ width: 130 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Chargement…</td></tr>
            ) : authors.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Aucun auteur</td></tr>
            ) : (
              authors.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.firstname} {a.lastname}</strong>
                    {a.email && !a.email_verified && <span style={{ marginLeft: 6, fontSize: 11, color: '#dc2626' }}>(email non vérifié)</span>}
                    {!a.email && <span style={{ marginLeft: 6, fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>(sans email)</span>}
                    {a.public_listed ? (
                      <span style={{ marginLeft: 6, fontSize: 10, padding: '2px 6px', background: '#dcfce7', color: '#166534', borderRadius: 999, fontWeight: 700 }}>PUBLIC</span>
                    ) : null}
                  </td>
                  <td>
                    {a.email
                      ? <a href={`mailto:${a.email}`} style={{ color: '#10531a' }}>{a.email}</a>
                      : <span style={{ color: '#9ca3af' }}>—</span>}
                  </td>
                  <td>{a.phone || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{a.manuscript_count || 0}</td>
                  <td><StageBadge stage={a.latest_stage} /></td>
                  <td>{formatDate(a.created_at)}</td>
                  <td>
                    <button className="btn-ghost" onClick={() => setSelected(a.id)} title="Voir détails"><FiEye /></button>
                    {a.email && <a href={`mailto:${a.email}`} className="btn-ghost" title="Envoyer un email"><FiMail /></a>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div className="admin-pagination">
            <button className="btn btn-outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Précédent</button>
            <span>Page {page} / {pages}</span>
            <button className="btn btn-outline" disabled={page >= pages} onClick={() => setPage(page + 1)}>Suivant</button>
          </div>
        )}
      </div>

      {selected && <AuthorDetailModal id={selected} onClose={closeDetail} />}
    </div>
  );
}
