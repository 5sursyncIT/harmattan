import { useEffect, useState, useCallback } from 'react';
import { FiSearch, FiRefreshCw, FiMail, FiEye, FiX, FiShoppingBag, FiKey, FiExternalLink } from 'react-icons/fi';
import toast from 'react-hot-toast';
import {
  getAdminCustomers, getAdminCustomer, resetCustomerPassword,
} from '../../../api/admin';

function formatDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function formatMoney(n) {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('fr-FR').format(Math.round(n)) + ' XOF';
}

function CustomerDetailModal({ id, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getAdminCustomer(id)
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) toast.error('Erreur de chargement'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const handleReset = async () => {
    if (!window.confirm('Envoyer un email de réinitialisation de mot de passe à ce client ?')) return;
    try {
      const res = await resetCustomerPassword(id);
      toast.success(`Lien de réinitialisation envoyé à ${res.data.email}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur envoi');
    }
  };

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal admin-modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="admin-modal-header">
          <h3>{loading ? 'Chargement…' : `${data?.customer.firstname || ''} ${data?.customer.lastname || ''}`}</h3>
          <button className="btn-ghost" onClick={onClose} aria-label="Fermer"><FiX /></button>
        </div>
        {!loading && data && (
          <div className="admin-modal-body">
            <div className="admin-info-grid">
              <div><strong>Email</strong><span>{data.customer.email}</span></div>
              <div><strong>Téléphone</strong><span>{data.customer.phone || '—'}</span></div>
              <div><strong>Ville</strong><span>{data.customer.city || '—'}</span></div>
              <div><strong>Adresse</strong><span>{data.customer.address || '—'}</span></div>
              <div><strong>Inscrit le</strong><span>{formatDate(data.customer.created_at)}</span></div>
              <div>
                <strong>Dolibarr</strong>
                <span>{data.customer.dolibarr_id ? `#${data.customer.dolibarr_id}` : '—'}</span>
              </div>
            </div>

            {data.invoices?.length > 0 && (
              <section className="admin-modal-section">
                <h4>
                  <FiShoppingBag /> Factures Dolibarr ({data.invoiceTotals?.count || 0})
                  <span className="admin-modal-section-total">
                    Total : {formatMoney(data.invoiceTotals?.total_ttc)}
                  </span>
                </h4>
                <table className="admin-table">
                  <thead><tr><th>Réf.</th><th>Date</th><th>Total TTC</th><th>Payé</th></tr></thead>
                  <tbody>
                    {data.invoices.map((inv) => (
                      <tr key={inv.id}>
                        <td>{inv.ref}</td>
                        <td>{formatDate(inv.date)}</td>
                        <td>{formatMoney(inv.total_ttc)}</td>
                        <td>{inv.paye ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {data.preorders?.length > 0 && (
              <section className="admin-modal-section">
                <h4>Précommandes ({data.preorders.length})</h4>
                <table className="admin-table">
                  <thead><tr><th>Réf.</th><th>Titre</th><th>Qté</th><th>Montant</th><th>Statut</th><th>Date</th></tr></thead>
                  <tbody>
                    {data.preorders.map((p) => (
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
              </section>
            )}

            {data.payments?.length > 0 && (
              <section className="admin-modal-section">
                <h4>Paiements web ({data.payments.length})</h4>
                <table className="admin-table">
                  <thead><tr><th>Commande</th><th>Méthode</th><th>Statut</th><th>Attendu</th><th>Reçu</th><th>Date</th></tr></thead>
                  <tbody>
                    {data.payments.map((p) => (
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
              </section>
            )}

            <div className="admin-modal-actions">
              <button className="btn btn-outline" onClick={handleReset}><FiKey /> Envoyer un lien de réinitialisation MDP</button>
              {data.customer.dolibarr_id && (
                <a
                  className="btn btn-outline"
                  href={`/dolibarr/htdocs/societe/card.php?socid=${data.customer.dolibarr_id}`}
                  target="_blank" rel="noreferrer"
                >
                  <FiExternalLink /> Fiche Dolibarr
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CustomersPanel() {
  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    getAdminCustomers({ q, page, limit: 20 })
      .then((r) => {
        setCustomers(r.data.customers);
        setTotal(r.data.total);
        setPages(r.data.pages);
      })
      .catch(() => toast.error('Erreur de chargement'))
      .finally(() => setLoading(false));
  }, [q, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <div>
          <h3 style={{ margin: 0 }}>Clients ({total})</h3>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 13 }}>
            Comptes créés via la boutique en ligne. Liés aux fiches tiers Dolibarr.
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
              <th>Client</th>
              <th>Email</th>
              <th>Téléphone</th>
              <th>Ville</th>
              <th style={{ textAlign: 'center' }}>Précom.</th>
              <th>Inscrit le</th>
              <th style={{ width: 130 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Chargement…</td></tr>
            ) : customers.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Aucun client</td></tr>
            ) : (
              customers.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.firstname} {c.lastname}</strong></td>
                  <td><a href={`mailto:${c.email}`} style={{ color: '#10531a' }}>{c.email}</a></td>
                  <td>{c.phone || '—'}</td>
                  <td>{c.city || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{c.preorder_count || 0}</td>
                  <td>{formatDate(c.created_at)}</td>
                  <td>
                    <button className="btn-ghost" onClick={() => setSelected(c.id)} title="Voir détails"><FiEye /></button>
                    <a href={`mailto:${c.email}`} className="btn-ghost" title="Envoyer un email"><FiMail /></a>
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

      {selected && <CustomerDetailModal id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
