import { useState, useEffect, useCallback } from 'react';
import {
  FiBookOpen, FiSearch, FiPlus, FiChevronLeft, FiChevronRight, FiAlertCircle,
  FiAlertTriangle, FiClock, FiInbox,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import Loader from '../../../components/common/Loader';
import { formatPrice } from '../../../utils/formatters';
import { listSpecialOrders, getSpecialOrderMeta } from '../../../api/specialOrders';
import SpecialOrderCreateModal from '../../../components/admin/SpecialOrderCreateModal';
import SpecialOrderDetailModal from '../../../components/admin/SpecialOrderDetailModal';
import './SpecialOrders.css';

const fmtDate = (s) => (s ? new Date(String(s).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function SpecialOrdersPanel() {
  const [data, setData] = useState({ orders: [], total: 0, pages: 1, kpis: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filters, setFilters] = useState({ status: '', search: '', overdue: '', date_from: '', date_to: '', page: 1 });
  const [meta, setMeta] = useState({ statuses: [], paymentMethods: ['cash', 'wave', 'orange_money', 'virement', 'cb', 'cheque'] });
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState(null);

  useEffect(() => {
    getSpecialOrderMeta().then((r) => setMeta(r.data)).catch(() => {});
  }, []);

  const reload = useCallback(() => {
    setLoading(true); setError(false);
    const params = { ...filters };
    Object.keys(params).forEach((k) => { if (params[k] === '' || params[k] == null) delete params[k]; });
    listSpecialOrders(params)
      .then((r) => setData(r.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [filters]);
  useEffect(() => { reload(); }, [reload]);

  const update = (k, v) => setFilters((f) => ({ ...f, [k]: v, page: 1 }));
  const k = data.kpis || {};
  const byStatus = k.byStatus || {};
  const enAttente = (byStatus.registered || 0) + (byStatus.pending_validation || 0);
  const enCours = (byStatus.sent_to_supply || 0) + (byStatus.in_production || 0);
  const cloturees = (byStatus.closed || 0) + (byStatus.picked_up || 0);

  const statusInfoOf = (key) => meta.statuses.find((s) => s.key === key) || { label: key, bg: '#f1f5f9', color: '#475569' };

  const cards = [
    { v: k.total ?? 0, l: 'Commandes', c: '#0f172a' },
    { v: enAttente, l: 'En attente', c: '#92400e' },
    { v: enCours, l: 'En cours', c: '#1e40af' },
    { v: k.ready ?? 0, l: 'Prêtes à retirer', c: '#166534' },
    { v: cloturees, l: 'Clôturées / retirées', c: '#334155' },
    { v: k.overdue ?? 0, l: 'En retard', c: '#b45309', overdue: true },
    { v: formatPrice(k.collected ?? 0), l: 'Encaissé', c: '#166534', money: true },
    { v: formatPrice(k.balanceDue ?? 0), l: 'Solde dû', c: '#b45309', money: true },
  ];

  return (
    <div className="admin-panel">
      <div className="admin-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiBookOpen /> Commandes spéciales</h3>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><FiPlus size={16} /> Nouvelle commande</button>
      </div>
      <p style={{ marginTop: 0, color: '#64748b', fontSize: '0.88rem' }}>
        Gérez les demandes de livres indisponibles en stock, de l'enregistrement jusqu'au retrait par le client.
      </p>

      {/* Dashboard KPIs */}
      <div className="so-kpis">
        {cards.map((c, i) => (
          <div key={i} className={`so-kpi${c.overdue ? ' clickable' : ''}${c.overdue && filters.overdue === '1' ? ' active' : ''}`}
            onClick={c.overdue ? () => update('overdue', filters.overdue === '1' ? '' : '1') : undefined}>
            <div className="so-kpi-value" style={{ color: c.c, fontSize: c.money ? '1.15rem' : undefined }}>{c.v}</div>
            <div className="so-kpi-label">{c.overdue && <FiAlertTriangle size={11} style={{ verticalAlign: -1, marginRight: 3 }} />}{c.l}</div>
          </div>
        ))}
      </div>

      {/* Filtres */}
      <div className="so-filters">
        <div className="so-search">
          <FiSearch size={15} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input value={filters.search} onChange={(e) => update('search', e.target.value)} placeholder="N° commande, client, téléphone, livre, ISBN..." />
        </div>
        <select value={filters.status} onChange={(e) => update('status', e.target.value)}>
          <option value="">Tous les statuts</option>
          {meta.statuses.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={(e) => update('date_from', e.target.value)} title="Du" />
        <input type="date" value={filters.date_to} onChange={(e) => update('date_to', e.target.value)} title="Au" />
        {(filters.search || filters.status || filters.overdue || filters.date_from || filters.date_to) && (
          <button className="btn btn-outline btn-sm" onClick={() => setFilters({ status: '', search: '', overdue: '', date_from: '', date_to: '', page: 1 })}>Réinitialiser</button>
        )}
      </div>

      {loading ? <Loader /> : error ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiAlertCircle size={40} style={{ color: '#ef4444', marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Erreur de chargement</p>
          <button className="btn btn-primary" onClick={reload} style={{ marginTop: 8 }}>Réessayer</button>
        </div>
      ) : data.orders.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>
          <FiInbox size={40} style={{ opacity: 0.3, marginBottom: 8 }} />
          <p style={{ fontWeight: 600 }}>Aucune commande spéciale</p>
          <button className="btn btn-primary" onClick={() => setCreating(true)} style={{ marginTop: 8 }}><FiPlus size={15} /> Créer la première</button>
        </div>
      ) : (
        <>
          <div className="admin-table-container">
            <table className="admin-table">
              <thead><tr>
                <th>N°</th><th>Client</th><th>Ouvrages</th>
                <th style={{ textAlign: 'right' }}>Total</th><th style={{ textAlign: 'right' }}>Reste dû</th>
                <th>Statut</th><th>Dispo. prévue</th><th>Créée</th>
              </tr></thead>
              <tbody>
                {data.orders.map((o) => {
                  const si = o.statusInfo || statusInfoOf(o.status);
                  return (
                    <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(o.id)}>
                      <td><strong style={{ color: '#10531a', textDecoration: 'underline', textUnderlineOffset: 3 }}>{o.ref}</strong></td>
                      <td>{o.customer.name}{o.customer.phone ? <div style={{ fontSize: '0.76rem', color: '#94a3b8' }}>{o.customer.phone}</div> : ''}</td>
                      <td style={{ fontSize: '0.84rem' }}>
                        {o.books?.firstTitle ? o.books.firstTitle : '—'}
                        {o.books && o.books.count > 1 ? <span style={{ color: '#94a3b8' }}> +{o.books.count - 1}</span> : ''}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatPrice(o.totals.total)}</td>
                      <td style={{ textAlign: 'right', color: o.totals.balance > 0 ? '#b45309' : '#166534', fontWeight: 600 }}>
                        {o.totals.balance > 0 ? formatPrice(o.totals.balance) : 'Soldée'}
                      </td>
                      <td>
                        <span className="so-badge" style={{ background: si.bg, color: si.color }}>{si.label}</span>
                        {o.overdue && <div className="so-overdue" style={{ marginTop: 3 }}><FiAlertTriangle size={11} /> retard</div>}
                      </td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{o.expectedDate ? fmtDate(o.expectedDate) : (o.delayEstimate || '—')}</td>
                      <td style={{ fontSize: '0.82rem', color: '#64748b' }}><FiClock size={11} style={{ verticalAlign: -1, marginRight: 3 }} />{fmtDate(o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {data.pages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 16 }}>
              <button className="btn btn-outline btn-sm" disabled={filters.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}><FiChevronLeft size={16} /></button>
              <span style={{ fontSize: '0.85rem', color: '#64748b' }}>Page {filters.page} / {data.pages} · {data.total} commande{data.total > 1 ? 's' : ''}</span>
              <button className="btn btn-outline btn-sm" disabled={filters.page >= data.pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}><FiChevronRight size={16} /></button>
            </div>
          )}
        </>
      )}

      {creating && (
        <SpecialOrderCreateModal
          paymentMethods={meta.paymentMethods}
          onClose={() => setCreating(false)}
          onCreated={(o) => { setCreating(false); reload(); setDetailId(o.id); }}
        />
      )}
      {detailId && (
        <SpecialOrderDetailModal
          orderId={detailId}
          statuses={meta.statuses}
          paymentMethods={meta.paymentMethods}
          onClose={() => setDetailId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
