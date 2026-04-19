import { useState, useEffect, useCallback } from 'react';
import { FiLayers, FiPauseCircle, FiShoppingCart, FiCheckCircle, FiSmartphone, FiGrid, FiSidebar } from 'react-icons/fi';
import { posGetCurrentSession, posCreateQuote, posCreateSale } from '../../api/pos';
import { syncOfflineSales, getPendingSales } from '../../utils/offlineQueue';
import usePosCartStore from '../../store/posCartStore';
import usePosSessionStore from '../../store/posSessionStore';
import POSHeader from '../../components/pos/POSHeader';
import ProductSearch from '../../components/pos/ProductSearch';
import CategoryBar from '../../components/pos/CategoryBar';
import ProductGrid from '../../components/pos/ProductGrid';
import POSCart from '../../components/pos/POSCart';
import PaymentPanel from '../../components/pos/PaymentPanel';
import POSReceipt from '../../components/pos/POSReceipt';
import POSQuoteReceipt from '../../components/pos/POSQuoteReceipt';
import CustomerSelect from '../../components/pos/CustomerSelect';
import CashRegister from '../../components/pos/CashRegister';
import POSChangePin from '../../components/pos/POSChangePin';
import POSReturn from '../../components/pos/POSReturn';
import DeviceManager from '../../components/pos/DeviceManager';
import toast from 'react-hot-toast';
import './POSPage.css';

export default function POSPage() {
  const [selectedCategory, setSelectedCategory] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('pos-category')); } catch { return null; }
  });
  const [showPayment, setShowPayment] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showCashRegister, setShowCashRegister] = useState(false);
  const [completedSale, setCompletedSale] = useState(null);
  const [completedQuote, setCompletedQuote] = useState(null);
  const [session, setSession] = useState(null);
  const [touchMode, setTouchMode] = useState(() => {
    const saved = localStorage.getItem('pos-touch-mode');
    return saved !== null ? saved === 'true' : true;
  });
  const [activePanel, setActivePanel] = useState(() => {
    return sessionStorage.getItem('pos-active-panel') || 'catalog';
  });

  const clearTicket = usePosCartStore((s) => s.clearTicket);
  const items = usePosCartStore((s) => s.items);
  const held = usePosCartStore((s) => s.held);
  const getItemCount = usePosCartStore((s) => s.getItemCount);
  const openSessionStore = usePosSessionStore((s) => s.openSession);
  const closeSessionStore = usePosSessionStore((s) => s.closeSession);
  const itemCount = getItemCount();
  const ticketTotal = items.reduce((sum, item) => sum + item.line_total, 0);
  const statCards = [
    { icon: <FiLayers size={16} />, label: 'Lignes ticket', value: items.length },
    { icon: <FiShoppingCart size={16} />, label: 'Articles', value: itemCount },
    { icon: <FiPauseCircle size={16} />, label: 'Tickets en attente', value: held.length },
    { icon: <FiCheckCircle size={16} />, label: 'Montant ticket', value: `${Math.round(ticketTotal).toLocaleString('fr-FR')} F` },
  ];
  const toolbarActions = [
    {
      key: 'touch',
      label: touchMode ? 'Mode tactile activé' : 'Mode tactile',
      icon: <FiSmartphone size={16} />,
      active: touchMode,
      onClick: () => setTouchMode((value) => !value),
    },
    {
      key: 'catalog',
      label: 'Catalogue',
      icon: <FiGrid size={16} />,
      active: activePanel === 'catalog',
      onClick: () => setActivePanel('catalog'),
    },
    {
      key: 'cart',
      label: `Ticket${items.length ? ` · ${items.length}` : ''}`,
      icon: <FiSidebar size={16} />,
      active: activePanel === 'ticket',
      onClick: () => setActivePanel('ticket'),
    },
  ];

  // Persist UI preferences
  useEffect(() => { localStorage.setItem('pos-touch-mode', String(touchMode)); }, [touchMode]);
  useEffect(() => { sessionStorage.setItem('pos-active-panel', activePanel); }, [activePanel]);
  useEffect(() => { sessionStorage.setItem('pos-category', JSON.stringify(selectedCategory)); }, [selectedCategory]);

  const loadSession = useCallback(async () => {
    try {
      const res = await posGetCurrentSession();
      if (res.data) {
        setSession(res.data);
        openSessionStore(res.data);
      } else {
        setSession(null);
        closeSessionStore();
      }
    } catch {
      setSession(null);
      closeSessionStore();
    }
  }, [closeSessionStore, openSessionStore]);

  useEffect(() => {
    const sessionTimer = window.setTimeout(() => {
      loadSession();
    }, 0);

    return () => clearTimeout(sessionTimer);
  }, [loadSession]);

  // Sync offline sales when connection comes back
  useEffect(() => {
    const trySync = () => {
      if (getPendingSales().length > 0) {
        syncOfflineSales(
          posCreateSale,
          (result) => toast.success(`Vente hors ligne synchronisée: ${result.invoice_ref}`),
          () => {}
        );
      }
    };
    window.addEventListener('online', trySync);
    trySync(); // also try on mount
    return () => window.removeEventListener('online', trySync);
  }, []);

  const handlePaymentComplete = (sale) => {
    setShowPayment(false);
    const { items: cartItems, customer } = usePosCartStore.getState();
    setCompletedSale({ ...sale, items: cartItems, customer_name: customer?.name });
    clearTicket();
  };

  const handleNewTicket = () => {
    setCompletedSale(null);
  };

  const handleQuote = async () => {
    const currentItems = usePosCartStore.getState().items;
    const customer = usePosCartStore.getState().customer;
    if (!currentItems.length) return;
    try {
      const res = await posCreateQuote({ items: currentItems, customer });
      setCompletedQuote(res.data);
      clearTicket();
      toast.success(`Facture proforma ${res.data.ref} créée`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur création facture proforma');
    }
  };

  return (
    <div className={`pos-page ${touchMode ? 'touch-mode' : ''} panel-${activePanel}`}>
      <POSHeader onOpenCashRegister={() => setShowCashRegister(true)} onChangePin={() => setShowChangePin(true)} onReturn={() => setShowReturn(true)} onDevices={() => setShowDevices(true)} />

      <div className="pos-body">
        <div className="pos-left">
          <div className="pos-left-top">
            <section className="pos-search-shell">
              <div className="pos-shell-heading">
                <div>
                  <span className="pos-shell-eyebrow">Encaissement</span>
                  <h1 className="pos-shell-title">Point de vente</h1>
                </div>
                <span className={`pos-session-badge ${session ? 'open' : 'closed'}`}>
                  {session ? 'Session active' : 'Session fermée'}
                </span>
              </div>
              <ProductSearch />
            </section>

            <section className="pos-stats-grid" aria-label="Résumé du ticket">
              {statCards.map(({ icon, label, value }) => (
                <div key={label} className="pos-stat-card">
                  <span className="pos-stat-icon">{icon}</span>
                  <span className="pos-stat-label">{label}</span>
                  <strong className="pos-stat-value">{value}</strong>
                </div>
              ))}
            </section>
          </div>

          <section className="pos-toolbar" aria-label="Options d’affichage POS">
            {toolbarActions.map((action) => (
              <button
                key={action.key}
                type="button"
                className={`pos-toolbar-btn ${action.active ? 'active' : ''}`}
                onClick={action.onClick}
                aria-pressed={action.active}
              >
                <span className="pos-toolbar-icon">{action.icon}</span>
                <span>{action.label}</span>
              </button>
            ))}
          </section>

          <section className="pos-catalog-shell">
            <div className="pos-shell-heading pos-shell-heading-compact">
              <div>
                <span className="pos-shell-eyebrow">Catalogue</span>
                <h2 className="pos-shell-title pos-shell-title-sm">Ajout rapide des ouvrages</h2>
              </div>
              <span className="pos-catalog-badge">
                {selectedCategory ? 'Catégorie filtrée' : 'Toutes catégories'}
              </span>
            </div>
            <CategoryBar selected={selectedCategory} onSelect={setSelectedCategory} />
            <ProductGrid category={selectedCategory} />
          </section>
        </div>

        <div className="pos-right">
          <POSCart
            onPay={() => {
              setActivePanel('ticket');
              setShowPayment(true);
            }}
            onQuote={handleQuote}
            onSelectCustomer={() => setShowCustomer(true)}
            onBackToCatalog={() => setActivePanel('catalog')}
            showBackButton={activePanel === 'ticket'}
            isProMode={activePanel === 'ticket'}
          />
        </div>
      </div>

      <button
        type="button"
        className={`pos-mobile-summary ${activePanel === 'ticket' ? 'is-hidden' : ''}`}
        onClick={() => setActivePanel('ticket')}
      >
        <span className="pos-mobile-summary-label">Ticket</span>
        <strong className="pos-mobile-summary-total">{Math.round(ticketTotal).toLocaleString('fr-FR')} F</strong>
        <span className="pos-mobile-summary-meta">{itemCount} article{itemCount > 1 ? 's' : ''}</span>
      </button>

      {showPayment && (
        <PaymentPanel
          onClose={() => setShowPayment(false)}
          onComplete={handlePaymentComplete}
        />
      )}

      {completedSale && (
        <POSReceipt sale={completedSale} onClose={handleNewTicket} />
      )}

      {completedQuote && (
        <POSQuoteReceipt quote={completedQuote} onClose={() => setCompletedQuote(null)} />
      )}

      {showCustomer && (
        <CustomerSelect onClose={() => setShowCustomer(false)} />
      )}

      {showCashRegister && (
        <CashRegister
          session={session}
          onClose={() => setShowCashRegister(false)}
          onUpdate={loadSession}
        />
      )}

      {showChangePin && (
        <POSChangePin onClose={() => setShowChangePin(false)} />
      )}

      {showReturn && (
        <POSReturn onClose={() => setShowReturn(false)} />
      )}

      {showDevices && (
        <DeviceManager onClose={() => setShowDevices(false)} />
      )}
    </div>
  );
}
