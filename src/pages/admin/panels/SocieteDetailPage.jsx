import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  FiArrowLeft, FiMail, FiPhone, FiMapPin, FiEye, FiDollarSign,
  FiFileText, FiClipboard, FiCreditCard, FiRefreshCw, FiUser, FiEdit3, FiTrash2,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import PdfViewerModal from '../../../components/admin/PdfViewerModal';
import InvoicePayModal from '../../../components/admin/InvoicePayModal';
import TiersFormModal from '../../../components/admin/TiersFormModal';
import { getAdminSociete, deleteAdminSociete } from '../../../api/admin';

const INVOICE_STATUS = {
  0: { label: 'Brouillon', color: '#6b7280' },
  1: { label: 'Validée', color: '#0284c7' },
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

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatMoney(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('fr-FR').format(Math.round(n)) + ' XOF';
}
function StatusBadge({ status, map }) {
  const meta = map[status] || { label: status, color: '#888' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 12,
      background: meta.color + '22', color: meta.color, fontSize: 12, fontWeight: 600,
    }}>{meta.label}</span>
  );
}
function TypeTags({ client, fournisseur }) {
  const tags = [];
  if (client === 1 || client === 3) tags.push({ label: 'Client', color: '#10531a' });
  if (client === 2 || client === 3) tags.push({ label: 'Prospect', color: '#0284c7' });
  if (fournisseur === 1) tags.push({ label: 'Fournisseur', color: '#7c3aed' });
  if (!tags.length) tags.push({ label: 'Aucun', color: '#9ca3af' });
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {tags.map((t, i) => (
        <span key={i} style={{
          background: t.color + '22', color: t.color, padding: '2px 10px',
          borderRadius: 12, fontSize: 12, fontWeight: 600,
        }}>{t.label}</span>
      ))}
    </span>
  );
}

export default function SocieteDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('invoices');
  const [pdfView, setPdfView] = useState(null);
  const [payInvoice, setPayInvoice] = useState(null); // facture en cours de paiement
  const [editing, setEditing] = useState(false);

  const handleDelete = async () => {
    if (!data?.societe) return;
    if (!window.confirm(`Supprimer définitivement « ${data.societe.nom} » ?`)) return;
    try {
      await deleteAdminSociete(id);
      toast.success('Tiers supprimé');
      navigate('/admin/tiers');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur suppression');
    }
  };

  const load = () => {
    setLoading(true);
    getAdminSociete(id)
      .then(r => setData(r.data))
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  if (loading) return <Loader />;
  if (!data) return <div className="admin-panel">Tiers introuvable</div>;

  const { societe, invoices, invoiceTotals, quotes, quoteTotals, webAccount } = data;

  const tabs = [
    { id: 'invoices', label: 'Factures', icon: <FiFileText />,  count: invoiceTotals?.count || invoices?.length || 0 },
    { id: 'quotes',   label: 'Devis',    icon: <FiClipboard />, count: quoteTotals?.count || quotes?.length || 0 },
  ];

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <button className="btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: 8 }}>
            <FiArrowLeft /> Retour
          </button>
          <h2 style={{ margin: 0 }}>{societe.nom}</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            {societe.code_client && <span>Code client <strong>{societe.code_client}</strong> · </span>}
            {societe.code_fournisseur && <span>Code fournisseur <strong>{societe.code_fournisseur}</strong> · </span>}
            Dolibarr #{societe.id} · Créé le {formatDate(societe.created_at)}
          </p>
          <div style={{ marginTop: 8 }}>
            <TypeTags client={societe.client} fournisseur={societe.fournisseur} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
          <button className="btn btn-outline" onClick={() => setEditing(true)}><FiEdit3 /> Modifier</button>
          <button className="btn btn-outline" onClick={handleDelete} style={{ color: '#dc2626', borderColor: '#fecaca' }}>
            <FiTrash2 /> Supprimer
          </button>
          {webAccount && (
            <Link className="btn btn-outline" to={`/admin/customers/${webAccount.id}`}>
              <FiUser /> Compte web #{webAccount.id}
            </Link>
          )}
        </div>
      </div>

      <div className="admin-card" style={{ marginBottom: 16 }}>
        <h4 style={{ marginTop: 0 }}>Coordonnées</h4>
        <div className="admin-info-grid">
          {societe.name_alias && (
            <div><strong>Nom alternatif</strong><span>{societe.name_alias}</span></div>
          )}
          <div><strong><FiMail /> Email</strong>
            <span>{societe.email ? <a href={`mailto:${societe.email}`} style={{ color: '#10531a' }}>{societe.email}</a> : '—'}</span>
          </div>
          <div><strong><FiPhone /> Téléphone</strong>
            <span>{societe.phone ? <a href={`tel:${societe.phone}`} style={{ color: '#10531a' }}>{societe.phone}</a> : '—'}</span>
          </div>
          <div><strong><FiMapPin /> Ville</strong>
            <span>{[societe.zip, societe.town].filter(Boolean).join(' ') || '—'}</span>
          </div>
          {societe.address && <div><strong>Adresse</strong><span>{societe.address}</span></div>}
          {societe.siret && <div><strong>SIRET</strong><span>{societe.siret}</span></div>}
          {societe.tva_intra && <div><strong>TVA intra.</strong><span>{societe.tva_intra}</span></div>}
          {societe.barcode && <div><strong>Code-barres</strong><span>{societe.barcode}</span></div>}
        </div>
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', overflowX: 'auto' }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                padding: '12px 20px', border: 'none', background: 'none',
                borderBottom: tab === t.id ? '2px solid #10531a' : '2px solid transparent',
                color: tab === t.id ? '#10531a' : '#6b7280',
                fontWeight: tab === t.id ? 600 : 500,
                cursor: 'pointer', whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
              {t.icon} {t.label}
              {t.count > 0 && <span style={{
                background: tab === t.id ? '#10531a' : '#e5e7eb',
                color: tab === t.id ? '#fff' : '#374151',
                padding: '1px 8px', borderRadius: 10, fontSize: 11,
              }}>{t.count}</span>}
            </button>
          ))}
        </div>

        <div style={{ padding: 16 }}>
          {tab === 'invoices' && (
            invoices?.length ? (
              <>
                <div style={{ marginBottom: 12, color: '#6b7280', fontSize: 13 }}>
                  Total : <strong>{formatMoney(invoiceTotals?.total_ttc)}</strong> TTC
                  ({invoiceTotals?.count} facture{invoiceTotals?.count > 1 ? 's' : ''})
                </div>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Réf.</th><th>Date</th><th>Total HT</th><th>Total TTC</th>
                      <th>Payée</th><th>Statut</th><th>Type</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map(inv => (
                      <tr key={inv.id}>
                        <td><strong>{inv.ref}</strong></td>
                        <td>{formatDate(inv.date)}</td>
                        <td>{formatMoney(inv.total_ht)}</td>
                        <td>{formatMoney(inv.total_ttc)}</td>
                        <td style={{ textAlign: 'center' }}>{inv.paye ? '✓' : '—'}</td>
                        <td><StatusBadge status={inv.fk_statut} map={INVOICE_STATUS} /></td>
                        <td>{inv.type === 2 ? 'Avoir' : inv.type === 1 ? 'Récurrente' : 'Standard'}</td>
                        <td>
                          <button className="btn-ghost" title="Voir le PDF"
                            onClick={() => setPdfView({ url: `/api/admin/invoices/${inv.id}/pdf`, title: `Facture ${inv.ref}` })}>
                            <FiEye />
                          </button>
                          {!inv.paye && inv.fk_statut === 1 && inv.type !== 2 && (
                            <button
                              className="btn-ghost"
                              title="Marquer payée"
                              onClick={() => setPayInvoice(inv)}
                              style={{ color: '#10531a' }}
                            >
                              <FiDollarSign />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <div style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>Aucune facture.</div>
          )}
          {tab === 'quotes' && (
            quotes?.length ? (
              <>
                <div style={{ marginBottom: 12, color: '#6b7280', fontSize: 13 }}>
                  Total : <strong>{formatMoney(quoteTotals?.total_ttc)}</strong> TTC
                  ({quoteTotals?.count} devis)
                </div>
                <table className="admin-table">
                  <thead>
                    <tr><th>Réf.</th><th>Date</th><th>Total HT</th><th>Total TTC</th><th>Statut</th><th>PDF</th></tr>
                  </thead>
                  <tbody>
                    {quotes.map(q => (
                      <tr key={q.id}>
                        <td><strong>{q.ref}</strong></td>
                        <td>{formatDate(q.date)}</td>
                        <td>{formatMoney(q.total_ht)}</td>
                        <td>{formatMoney(q.total_ttc)}</td>
                        <td><StatusBadge status={q.fk_statut} map={PROPAL_STATUS} /></td>
                        <td>
                          <button className="btn-ghost" title="Voir le PDF"
                            onClick={() => setPdfView({ url: `/api/admin/propals/${q.id}/pdf`, title: `Devis ${q.ref}` })}>
                            <FiEye />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <div style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>Aucun devis.</div>
          )}
        </div>
      </div>

      {(societe.note_private || societe.note_public) && (
        <div className="admin-card" style={{ marginTop: 16 }}>
          {societe.note_public && (
            <>
              <h4 style={{ marginTop: 0 }}>Note publique</h4>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, color: '#374151' }}>{societe.note_public}</pre>
            </>
          )}
          {societe.note_private && (
            <>
              <h4 style={{ marginTop: societe.note_public ? 16 : 0 }}>Note privée</h4>
              <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, color: '#374151' }}>{societe.note_private}</pre>
            </>
          )}
        </div>
      )}

      {pdfView && (
        <PdfViewerModal url={pdfView.url} title={pdfView.title} onClose={() => setPdfView(null)} />
      )}

      {payInvoice && (
        <InvoicePayModal
          invoice={payInvoice}
          onClose={() => setPayInvoice(null)}
          onSuccess={load}
        />
      )}

      {editing && (
        <TiersFormModal
          tier={societe}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); }}
        />
      )}
    </div>
  );
}
