import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FiDollarSign, FiTrendingUp, FiPackage, FiShoppingBag, FiUsers, FiMail,
  FiFileText, FiRefreshCw, FiAlertCircle, FiAlertTriangle, FiBookOpen,
  FiMonitor, FiUser, FiBook, FiCreditCard, FiTarget, FiActivity,
  FiClock, FiInbox, FiEdit,
} from 'react-icons/fi';
import {
  getAdminStatsMain, getAdminStatsTimeseries,
  getAdminStatsChannels, getAdminStatsTop,
} from '../../../api/admin';
import KpiCard from '../../../components/admin/KpiCard';
import RevenueChart from '../../../components/admin/RevenueChart';
import ChannelsPie from '../../../components/admin/ChannelsPie';
import PaymentMethodsBar from '../../../components/admin/PaymentMethodsBar';
import TopList from '../../../components/admin/TopList';
import '../../../components/admin/DashboardKpi.css';

const POLL_INTERVAL = 60_000;

function formatRelativeTime(date) {
  if (!date) return '—';
  const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (diff < 5) return "à l'instant";
  if (diff < 60) return `il y a ${diff}s`;
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return new Date(date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export default function StatsPanel() {
  const [main, setMain] = useState(null);
  const [series, setSeries] = useState(null);
  const [channels, setChannels] = useState(null);
  const [top, setTop] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState(null);
  const [, setTick] = useState(0); // forces re-render for "il y a Xs"
  const pollRef = useRef(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const [mainRes, seriesRes, channelsRes, topRes] = await Promise.all([
        getAdminStatsMain(),
        getAdminStatsTimeseries(),
        getAdminStatsChannels(),
        getAdminStatsTop(),
      ]);
      setMain(mainRes.data);
      setSeries(seriesRes.data);
      setChannels(channelsRes.data);
      setTop(topRes.data);
      setLastUpdate(new Date());
      setError(null);
    } catch (err) {
      console.error('Dashboard load error:', err);
      setError('Données non actualisées');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load + polling
  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(false), POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, [load]);

  // Tick to update "il y a Xs"
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  if (loading && !main) {
    return (
      <div className="admin-panel">
        <div className="kpi-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="kpi-skeleton" />
          ))}
        </div>
      </div>
    );
  }

  if (!main) {
    return (
      <div className="admin-panel">
        <div className="dashboard-error">
          <FiAlertCircle /> Impossible de charger les statistiques
        </div>
      </div>
    );
  }

  const rev = main.revenue;
  const ops = main.operations;
  const cust = main.customers;
  const edit = main.editorial;
  const eng = main.engagement;
  const pos = main.pos_today;

  return (
    <div className="admin-panel">
      {/* ─── Header ─────────────────────────────────────── */}
      <div className="dashboard-header">
        <div>
          <h2>Tableau de bord · L'Harmattan Sénégal</h2>
          <p>KPIs temps réel pour le pilotage de l'activité</p>
        </div>
        <div className="dashboard-refresh">
          <span>Mis à jour {formatRelativeTime(lastUpdate)}</span>
          <button onClick={() => load(true)} className={refreshing ? 'loading' : ''}>
            <FiRefreshCw size={14} /> Rafraîchir
          </button>
        </div>
      </div>

      {error && (
        <div className="dashboard-error">
          <FiAlertTriangle /> {error}
        </div>
      )}

      {/* ─── Section 1 : Chiffre d'affaires ─────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiDollarSign /> Chiffre d'affaires</h3>
        <div className="kpi-grid-4">
          <KpiCard
            icon={<FiDollarSign />}
            label="CA aujourd'hui"
            value={rev.today.amount}
            format="currency"
            suffix="F"
            trend={rev.today.trend_pct}
            trendLabel="vs hier"
            sub={`${rev.today.count} facture${rev.today.count > 1 ? 's' : ''}`}
            color="green"
          />
          <KpiCard
            icon={<FiTrendingUp />}
            label="CA du mois"
            value={rev.month.amount}
            format="currency"
            suffix="F"
            trend={rev.month.trend_pct}
            trendLabel="vs mois dernier"
            sub={`${rev.month.count} factures`}
            color="blue"
          />
          <KpiCard
            icon={<FiTarget />}
            label="Ticket moyen (mois)"
            value={rev.avg_ticket_month}
            format="currency"
            suffix="F"
            sub={`Aujourd'hui : ${rev.avg_ticket_today.toLocaleString('fr-FR')} F`}
            color="purple"
          />
          <KpiCard
            icon={<FiAlertCircle />}
            label="Impayés"
            value={rev.outstanding_ar.amount}
            format="currency"
            suffix="F"
            sub={`${rev.outstanding_ar.count} facture${rev.outstanding_ar.count > 1 ? 's' : ''} en attente`}
            color="red"
          />
        </div>
      </section>

      {/* ─── Section 2 : Graphique CA 30 jours ──────────── */}
      <section className="dashboard-section">
        <div className="chart-card">
          <div className="chart-card-title">
            <span>Évolution du CA sur 30 jours</span>
            <span className="chart-card-subtitle">CA annuel : {(rev.year.amount / 1_000_000).toFixed(1)} M FCFA</span>
          </div>
          <RevenueChart data={series?.daily_30d || []} />
        </div>
      </section>

      {/* ─── Section 3 : Opérations ──────────────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiPackage /> Opérations & stock</h3>
        <div className="kpi-grid-4">
          <KpiCard
            icon={<FiBook />}
            label="Produits en vente"
            value={ops.products_total}
            sub="Catalogue actif"
            color="teal"
          />
          <KpiCard
            icon={<FiAlertCircle />}
            label="En rupture"
            value={ops.products_out_of_stock}
            sub={`${((ops.products_out_of_stock / Math.max(ops.products_total, 1)) * 100).toFixed(1)}% du catalogue`}
            color="red"
          />
          <KpiCard
            icon={<FiAlertTriangle />}
            label="Stock bas (< 5)"
            value={ops.low_stock_count}
            sub="À réapprovisionner"
            color="amber"
          />
          <KpiCard
            icon={<FiPackage />}
            label="Valeur du stock"
            value={ops.stock_value_retail}
            format="currency"
            suffix="F"
            sub="Prix de vente TTC"
            color="green"
          />
        </div>
      </section>

      {/* ─── Section 4 : Canaux & Paiements ─────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiCreditCard /> Canaux de vente & paiements (30 jours)</h3>
        <div className="kpi-grid-2">
          <div className="chart-card">
            <div className="chart-card-title">
              <span>Répartition par canal</span>
            </div>
            <ChannelsPie data={channels?.by_channel || []} />
          </div>
          <div className="chart-card">
            <div className="chart-card-title">
              <span>Moyens de paiement</span>
            </div>
            <PaymentMethodsBar data={channels?.by_payment_method || []} />
          </div>
        </div>
      </section>

      {/* ─── Section 5 : POS Today & Clients ────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiMonitor /> Activité POS & clients</h3>
        <div className="kpi-grid-4">
          <KpiCard
            icon={<FiShoppingBag />}
            label="Ventes POS aujourd'hui"
            value={pos.revenue}
            format="currency"
            suffix="F"
            sub={`${pos.count} ticket${pos.count > 1 ? 's' : ''} · ${pos.terminals_active} terminal(aux)`}
            color="blue"
          />
          <KpiCard
            icon={<FiUser />}
            label="Top caissier du jour"
            value={pos.top_cashier?.revenue || 0}
            format="currency"
            suffix="F"
            sub={pos.top_cashier ? `${pos.top_cashier.name} · ${pos.top_cashier.count} ventes` : '—'}
            color="purple"
          />
          <KpiCard
            icon={<FiUsers />}
            label="Clients actifs (30j)"
            value={cust.active_30d}
            sub={`${cust.total.toLocaleString('fr-FR')} au total`}
            color="teal"
          />
          <KpiCard
            icon={<FiTrendingUp />}
            label="Nouveaux clients"
            value={cust.new_this_month}
            sub="Ce mois-ci"
            color="pink"
          />
        </div>
      </section>

      {/* ─── Section 6 : Pipeline éditorial ─────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiBookOpen /> Pipeline éditorial</h3>
        <div className="kpi-grid-4">
          <KpiCard
            icon={<FiFileText />}
            label="Manuscrits en attente"
            value={edit.manuscripts_pending}
            sub={`${edit.manuscripts_total} reçus au total`}
            color="amber"
          />
          <KpiCard
            icon={<FiBookOpen />}
            label="Contrats actifs"
            value={edit.contracts_active}
            sub="En cours de validité"
            color="green"
          />
          <KpiCard
            icon={<FiClock />}
            label="Contrats à renouveler"
            value={edit.contracts_expiring_soon}
            sub="Expire dans 60 jours"
            color="red"
          />
          <KpiCard
            icon={<FiInbox />}
            label="Précommandes"
            value={edit.preorders_pending}
            sub="En attente de sortie"
            color="purple"
          />
        </div>
      </section>

      {/* ─── Section 7 : Tops du mois ───────────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiTarget /> Top performers du mois</h3>
        <div className="kpi-grid-3">
          <TopList
            title="Top auteurs"
            items={top?.top_authors || []}
            labelKey="name"
            emptyLabel="Aucune vente ce mois-ci"
          />
          <TopList
            title="Top catégories"
            items={top?.top_categories || []}
            emptyLabel="Aucune vente ce mois-ci"
          />
          <TopList
            title="Top produits"
            items={top?.top_products || []}
            emptyLabel="Aucune vente ce mois-ci"
          />
        </div>
      </section>

      {/* ─── Section 8 : Engagement ──────────────────────── */}
      <section className="dashboard-section">
        <h3 className="dashboard-section-title"><FiMail /> Engagement</h3>
        <div className="kpi-grid-4">
          <KpiCard
            icon={<FiMail />}
            label="Messages non lus"
            value={eng.contact_unread}
            sub="Formulaire de contact"
            color="amber"
          />
          <KpiCard
            icon={<FiUsers />}
            label="Newsletter"
            value={eng.newsletter_confirmed}
            sub={`${eng.newsletter_total} inscrits au total`}
            color="blue"
          />
          <KpiCard
            icon={<FiMonitor />}
            label="Top caissier (mois)"
            value={(top?.top_cashiers?.[0]?.revenue) || 0}
            format="currency"
            suffix="F"
            sub={top?.top_cashiers?.[0] ? `${top.top_cashiers[0].name} · ${top.top_cashiers[0].sales_count} ventes` : '—'}
            color="purple"
          />
          <KpiCard
            icon={<FiDollarSign />}
            label="CA annuel"
            value={rev.year.amount}
            format="currency"
            suffix="F"
            sub="Cumul depuis le 1er janvier"
            color="green"
          />
        </div>
      </section>

      {/* ─── Section 9 : Derniers événements ────────────── */}
      <section className="dashboard-section">
        <div className="kpi-grid-2">
          <div className="chart-card">
            <div className="chart-card-title">
              <span><FiFileText /> Dernières factures</span>
            </div>
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>Référence</th>
                  <th>Client</th>
                  <th style={{ textAlign: 'right' }}>Montant</th>
                </tr>
              </thead>
              <tbody>
                {(main.recent_invoices || []).slice(0, 8).map((inv) => (
                  <tr key={inv.ref}>
                    <td className="ref">{inv.ref}</td>
                    <td>{inv.customer}</td>
                    <td className="amount">{inv.total.toLocaleString('fr-FR')} F</td>
                  </tr>
                ))}
                {(!main.recent_invoices || main.recent_invoices.length === 0) && (
                  <tr><td colSpan="3" style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Aucune facture récente</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="chart-card">
            <div className="chart-card-title">
              <span><FiActivity /> Activité admin récente</span>
            </div>
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>Utilisateur</th>
                  <th>Action</th>
                  <th>Quand</th>
                </tr>
              </thead>
              <tbody>
                {(main.recent_activity || []).slice(0, 8).map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.username}</strong></td>
                    <td>{a.details || a.action}</td>
                    <td className="ref">{formatRelativeTime(a.created_at)}</td>
                  </tr>
                ))}
                {(!main.recent_activity || main.recent_activity.length === 0) && (
                  <tr><td colSpan="3" style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Aucune activité récente</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
