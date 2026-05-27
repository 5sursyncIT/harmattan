import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  FiArrowLeft, FiMail, FiPhone, FiMapPin, FiEye, FiKey, FiDollarSign,
  FiFileText, FiClipboard, FiShoppingBag, FiCreditCard, FiRefreshCw,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import PdfViewerModal from '../../../components/admin/PdfViewerModal';
import InvoicePayModal from '../../../components/admin/InvoicePayModal';
import { getAdminCustomer, resetCustomerPassword } from '../../../api/admin';

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

export default function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('invoices');
  const [pdfView, setPdfView] = useState(null); // { url, title }
  const [payInvoice, setPayInvoice] = useState(null);

  const load = () => {
    setLoading(true);
    getAdminCustomer(id)
      .then(r => setData(r.data))
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  const handleReset = async () => {
    if (!window.confirm('Envoyer un email de réinitialisation de mot de passe à ce client ?')) return;
    try {
      const res = await resetCustomerPassword(id);
      toast.success(`Lien envoyé à ${res.data.email}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    }
  };

  if (loading) return <Loader />;
  if (!data) return <div className="admin-panel">Client introuvable</div>;

  const { customer, societe, preorders, payments, invoices, invoiceTotals, quotes, quoteTotals } = data;
  const fullName = `${customer.firstname || ''} ${customer.lastname || ''}`.trim() || '—';

  const tabs = [
    { id: 'invoices',  label: 'Factures',     icon: <FiFileText />,   count: invoiceTotals?.count || invoices?.length || 0 },
    { id: 'quotes',    label: 'Devis',        icon: <FiClipboard />,  count: quoteTotals?.count   || quotes?.length   || 0 },
    { id: 'preorders', label: 'Précommandes', icon: <FiShoppingBag />, count: preorders?.length   || 0 },
    { id: 'payments',  label: 'Paiements',    icon: <FiCreditCard />, count: payments?.length    || 0 },
  ];

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ alignItems: 'flex-start' }}>
        <div>
          <button className="btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: 8 }}>
            <FiArrowLeft /> Retour
          </button>
          <h2 style={{ margin: 0 }}>{fullName}</h2>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            {societe?.code_client && <span>Code client <strong>{societe.code_client}</strong> · </span>}
            Inscrit le {formatDate(customer.created_at)}
            {customer.dolibarr_id && <span> · Dolibarr #{customer.dolibarr_id}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Actualiser</button>
          <button className="btn btn-outline" onClick={handleReset}><FiKey /> Réinit. MDP</button>
        </div>
      </div>

      {/* ─── Coordonnées ─────────────────────────────── */}
      <div className="admin-card" style={{ marginBottom: 16 }}>
        <h4 style={{ marginTop: 0 }}>Coordonnées</h4>
        <div className="admin-info-grid">
          <div><strong><FiMail /> Email</strong>
            <span><a href={`mailto:${customer.email}`} style={{ color: '#10531a' }}>{customer.email || '—'}</a></span>
          </div>
          <div><strong><FiPhone /> Téléphone</strong>
            <span>{customer.phone || societe?.phone || '—'}</span>
          </div>
          <div><strong><FiMapPin /> Ville</strong>
            <span>{customer.city || societe?.town || '—'}</span>
          </div>
          <div><strong>Adresse</strong>
            <span>{customer.address || societe?.address || '—'}</span>
          </div>
          {societe?.siret && <div><strong>SIRET</strong><span>{societe.siret}</span></div>}
          {societe?.tva_intra && <div><strong>TVA intra.</strong><span>{societe.tva_intra}</span></div>}
        </div>
      </div>

      {/* ─── Onglets ─────────────────────────────────── */}
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
            <InvoicesTab invoices={invoices || []} totals={invoiceTotals} onView={setPdfView} onPay={setPayInvoice} />
          )}
          {tab === 'quotes' && (
            <QuotesTab quotes={quotes || []} totals={quoteTotals} onView={setPdfView} />
          )}
          {tab === 'preorders' && (
            <PreordersTab preorders={preorders || []} />
          )}
          {tab === 'payments' && (
            <PaymentsTab payments={payments || []} />
          )}
        </div>
      </div>

      {societe?.note_private && (
        <div className="admin-card" style={{ marginTop: 16 }}>
          <h4 style={{ marginTop: 0 }}>Note privée (Dolibarr)</h4>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, color: '#374151' }}>
            {societe.note_private}
          </pre>
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
    </div>
  );
}

function EmptyRow({ children }) {
  return <div style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>{children}</div>;
}

function InvoicesTab({ invoices, totals, onView, onPay }) {
  if (!invoices.length) return <EmptyRow>Aucune facture pour ce client.</EmptyRow>;
  return (
    <>
      <div style={{ marginBottom: 12, color: '#6b7280', fontSize: 13 }}>
        Total : <strong>{formatMoney(totals?.total_ttc)}</strong> TTC
        ({totals?.count} facture{totals?.count > 1 ? 's' : ''})
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Réf.</th><th>Date</th><th>Total HT</th><th>Total TTC</th>
            <th>Payée</th><th>Statut</th><th>Type</th><th>PDF</th>
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
                  onClick={() => onView({ url: `/api/admin/invoices/${inv.id}/pdf`, title: `Facture ${inv.ref}` })}>
                  <FiEye />
                </button>
                {!inv.paye && inv.fk_statut === 1 && inv.type !== 2 && (
                  <button
                    className="btn-ghost"
                    title="Marquer payée"
                    onClick={() => onPay(inv)}
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
  );
}

function QuotesTab({ quotes, totals, onView }) {
  if (!quotes.length) return <EmptyRow>Aucun devis pour ce client.</EmptyRow>;
  return (
    <>
      <div style={{ marginBottom: 12, color: '#6b7280', fontSize: 13 }}>
        Total : <strong>{formatMoney(totals?.total_ttc)}</strong> TTC
        ({totals?.count} devis)
      </div>
      <table className="admin-table">
        <thead>
          <tr>
            <th>Réf.</th><th>Date</th><th>Total HT</th><th>Total TTC</th><th>Statut</th><th>PDF</th>
          </tr>
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
                  onClick={() => onView({ url: `/api/admin/propals/${q.id}/pdf`, title: `Devis ${q.ref}` })}>
                  <FiEye />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function PreordersTab({ preorders }) {
  if (!preorders.length) return <EmptyRow>Aucune précommande.</EmptyRow>;
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Réf.</th><th>Titre</th><th>Qté</th><th>Montant</th><th>Statut</th><th>Date</th>
        </tr>
      </thead>
      <tbody>
        {preorders.map(p => (
          <tr key={p.id}>
            <td>{p.preorder_ref}</td>
            <td>{p.book_title}</td>
            <td>{p.quantity}</td>
            <td>{formatMoney(p.total_amount)}</td>
            <td>{p.status}</td>
            <td>{formatDate(p.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PaymentsTab({ payments }) {
  if (!payments.length) return <EmptyRow>Aucun paiement enregistré.</EmptyRow>;
  return (
    <table className="admin-table">
      <thead>
        <tr>
          <th>Commande</th><th>Méthode</th><th>Statut</th><th>Attendu</th><th>Reçu</th><th>Date</th>
        </tr>
      </thead>
      <tbody>
        {payments.map(p => (
          <tr key={`${p.order_id}-${p.created_at}`}>
            <td>{p.order_id}</td>
            <td>{p.payment_method}</td>
            <td>{p.payment_status}</td>
            <td>{formatMoney(p.amount_expected)}</td>
            <td>{formatMoney(p.amount_received)}</td>
            <td>{formatDate(p.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
