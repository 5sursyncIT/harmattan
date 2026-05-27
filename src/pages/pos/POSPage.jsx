import { useState, useEffect, useCallback } from 'react';
import { FiSmartphone, FiGrid, FiSidebar } from 'react-icons/fi';
import { posGetCurrentSession, posCreateQuote, posCreateSale } from '../../api/pos';
import { syncOfflineSales, getPendingSales } from '../../utils/offlineQueue';
import usePosCartStore from '../../store/posCartStore';
import usePosSessionStore from '../../store/posSessionStore';
import POSHeader from '../../components/pos/POSHeader';
import POSActionsPanel from '../../components/pos/POSActionsPanel';
import ProductSearch from '../../components/pos/ProductSearch';
import CategoryBar from '../../components/pos/CategoryBar';
import ProductGrid from '../../components/pos/ProductGrid';
import POSCart from '../../components/pos/POSCart';
import POSNumpad from '../../components/pos/POSNumpad';
import PaymentPanel from '../../components/pos/PaymentPanel';
import POSReceipt from '../../components/pos/POSReceipt';
import POSQuoteReceipt from '../../components/pos/POSQuoteReceipt';
import CustomerSelect from '../../components/pos/CustomerSelect';
import CashRegister from '../../components/pos/CashRegister';
import POSCashReport from '../../components/pos/POSCashReport';
import POSOpenSessionScreen from '../../components/pos/POSOpenSessionScreen';
import POSChangePin from '../../components/pos/POSChangePin';
import POSReturn from '../../components/pos/POSReturn';
import POSHistory from '../../components/pos/POSHistory';
import POSFreeProduct from '../../components/pos/POSFreeProduct';
import DeviceManager from '../../components/pos/DeviceManager';
import POSPrinterSettings from '../../components/pos/POSPrinterSettings';
import usePosPrinterStore from '../../store/posPrinterStore';
import { printSaleReceipt } from '../../pos/printReceipt';
import toast from 'react-hot-toast';
import './POSPage.css';

export default function POSPage() {
  const [selectedCategory, setSelectedCategory] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('pos-category')); } catch { return null; }
  });
  const [showPayment, setShowPayment] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [returnInitialRef, setReturnInitialRef] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showFreeProduct, setShowFreeProduct] = useState(false);
  const [paymentSplitMode, setPaymentSplitMode] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  const [showPrinterSettings, setShowPrinterSettings] = useState(false);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showCashRegister, setShowCashRegister] = useState(false);
  const [showCashReport, setShowCashReport] = useState(false);
  const [completedSale, setCompletedSale] = useState(null);
  const [completedQuote, setCompletedQuote] = useState(null);
  const [session, setSession] = useState(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [touchMode, setTouchMode] = useState(() => {
    const saved = localStorage.getItem('pos-touch-mode');
    return saved !== null ? saved === 'true' : true;
  });
  const [activePanel, setActivePanel] = useState(() => {
    return sessionStorage.getItem('pos-active-panel') || 'catalog';
  });

  const clearTicket = usePosCartStore((s) => s.clearTicket);
  const setDiscount = usePosCartStore((s) => s.setDiscount);
  const items = usePosCartStore((s) => s.items);
  const getItemCount = usePosCartStore((s) => s.getItemCount);
  const openSessionStore = usePosSessionStore((s) => s.openSession);
  const closeSessionStore = usePosSessionStore((s) => s.closeSession);
  const itemCount = getItemCount();
  const ticketTotal = items.reduce((sum, item) => sum + item.line_total, 0);
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
    } finally {
      setSessionLoaded(true);
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
      if (getPendingSales().length === 0) return;
      syncOfflineSales(posCreateSale, {
        onSuccess: (result) => toast.success(`Vente hors ligne synchronisée : ${result.invoice_ref}`),
        onPermanentFail: (sale) => toast.error(
          `Vente hors ligne refusée (${sale.last_error || 'erreur serveur'}) — à régulariser avec le manager`,
          { duration: 10000 }
        ),
      });
    };
    window.addEventListener('online', trySync);
    trySync(); // also try on mount
    return () => window.removeEventListener('online', trySync);
  }, []);

  const handlePaymentComplete = (sale) => {
    setShowPayment(false);
    const { items: cartItems, customer } = usePosCartStore.getState();
    const fullSale = { ...sale, items: cartItems, customer_name: customer?.name };
    setCompletedSale(fullSale);
    clearTicket();

    // Auto-impression thermique via QZ Tray (fallback silencieux si indispo)
    if (usePosPrinterStore.getState().autoPrint) {
      printSaleReceipt(fullSale, { silent: true }).catch(() => { /* noop, fallback disponible via bouton */ });
    }
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

  const handleNewAction = () => {
    if (!items.length) return;
    if (confirm('Vider le ticket en cours ?')) clearTicket();
  };

  const handleGlobalDiscount = () => {
    if (!items.length) return;
    const val = prompt('Remise globale en % (0-100) appliquée à toutes les lignes :', '0');
    if (val === null) return;
    const pct = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
    items.forEach((item) => setDiscount(item.product_id, pct));
    toast.success(`Remise ${pct}% appliquée à ${items.length} ligne${items.length > 1 ? 's' : ''}`);
  };

  const handleCashReport = () => setShowCashReport(true);

  const handlePayCash = () => {
    if (!items.length) return;
    setShowPayment(true);
  };

  const handleSoon = (label) => () => {
    toast(`${label} — bientôt disponible`, { icon: '🚧' });
  };

  // Évite le flash de l'UI POS pendant le chargement initial de la session :
  // tant qu'on ne sait pas s'il y a une session ouverte, on n'instancie aucun
  // sous-composant (sinon header/catalogue se montent et déclenchent leurs
  // fetch). Loader plein écran qui se fond visuellement dans l'écran d'ouverture.
  if (!sessionLoaded) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#0a1628',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#94a3b8', fontSize: '0.9rem', letterSpacing: '0.5px',
        zIndex: 2000,
      }}>
        Chargement…
      </div>
    );
  }
  // Bloque l'accès au POS tant qu'aucune session caisse n'est ouverte
  // (alignement avec le flux Dolibarr TakePOS : PIN → ouverture caisse → POS).
  if (!session) {
    return <POSOpenSessionScreen onOpened={loadSession} />;
  }

  return (
    <div className={`pos-page ${touchMode ? 'touch-mode' : ''} panel-${activePanel}`}>
      <POSHeader
        onOpenCashRegister={() => setShowCashRegister(true)}
        onChangePin={() => setShowChangePin(true)}
        onReturn={() => setShowReturn(true)}
        onDevices={() => setShowDevices(true)}
        onPrinterSettings={() => setShowPrinterSettings(true)}
      />

      <div className="pos-body">
        <div className="pos-ticket-col">
          <POSCart
            onPay={() => {
              setPaymentSplitMode(false);
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

        <div className="pos-catalog-col">
          <section className="pos-search-shell">
            <ProductSearch />
          </section>

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
            <CategoryBar selected={selectedCategory} onSelect={setSelectedCategory} />
            <ProductGrid category={selectedCategory} />
          </section>
        </div>

        <div className="pos-actions-col">
          <POSActionsPanel
            onNew={handleNewAction}
            onHistory={() => setShowHistory(true)}
            onFreeProduct={() => setShowFreeProduct(true)}
            onGlobalDiscount={handleGlobalDiscount}
            onSplit={() => { setPaymentSplitMode(true); setActivePanel('ticket'); setShowPayment(true); }}
            onPay={() => { setPaymentSplitMode(false); setActivePanel('ticket'); setShowPayment(true); }}
            onPayCash={handlePayCash}
            onCashReport={handleCashReport}
            onCloseRegister={() => setShowCashRegister(true)}
          />
          <POSNumpad />
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
          onClose={() => { setShowPayment(false); setPaymentSplitMode(false); }}
          onComplete={(sale) => { setPaymentSplitMode(false); handlePaymentComplete(sale); }}
          splitMode={paymentSplitMode}
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

      {showCashReport && (
        <POSCashReport onClose={() => setShowCashReport(false)} />
      )}

      {showChangePin && (
        <POSChangePin onClose={() => setShowChangePin(false)} />
      )}

      {showReturn && (
        <POSReturn
          onClose={() => { setShowReturn(false); setReturnInitialRef(''); }}
          initialRef={returnInitialRef}
        />
      )}

      {showHistory && (
        <POSHistory
          onClose={() => setShowHistory(false)}
          onReturn={(ref) => { setReturnInitialRef(ref); setShowReturn(true); }}
        />
      )}

      {showFreeProduct && (
        <POSFreeProduct onClose={() => setShowFreeProduct(false)} />
      )}

      {showDevices && (
        <DeviceManager onClose={() => setShowDevices(false)} />
      )}

      {showPrinterSettings && (
        <POSPrinterSettings onClose={() => setShowPrinterSettings(false)} />
      )}
    </div>
  );
}
