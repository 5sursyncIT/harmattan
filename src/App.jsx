import { lazy as reactLazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from './components/layout/Layout';
import Loader from './components/common/Loader';

// Eager: homepage (first paint)
import HomePage from './pages/HomePage';

// Wrapper React.lazy : si le chunk dynamique manque (déploiement récent →
// l'onglet a un index.html périmé en mémoire référençant d'anciens hashs),
// on force un reload une seule fois (garde sessionStorage 10s anti-boucle).
// Couvre l'erreur Firefox "disallowed MIME type" et Chrome "Failed to fetch
// dynamically imported module" qui ne déclenchaient pas window.onerror
// quand l'échec est intercepté dans une frontière Suspense.
function lazy(importFn) {
  return reactLazy(() =>
    importFn().catch((err) => {
      const msg = String(err?.message || err || '');
      if (/dynamic|chunk|Loading|MIME|disallowed|Importing a module/i.test(msg)) {
        const last = parseInt(sessionStorage.getItem('__chunk_reload_at') || '0', 10);
        if (Date.now() - last > 10000) {
          sessionStorage.setItem('__chunk_reload_at', String(Date.now()));
          window.location.reload();
          return new Promise(() => {}); // ne résout jamais — la page se recharge
        }
      }
      throw err;
    }),
  );
}

// Lazy: all other pages
const CatalogPage = lazy(() => import('./pages/CatalogPage'));
const ProductPage = lazy(() => import('./pages/ProductPage'));
const CartPage = lazy(() => import('./pages/CartPage'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
const CheckoutSuccessPage = lazy(() => import('./pages/CheckoutSuccessPage'));
const CheckoutFailurePage = lazy(() => import('./pages/CheckoutFailurePage'));
const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const ContactPage = lazy(() => import('./pages/ContactPage'));
const AboutPage = lazy(() => import('./pages/AboutPage'));
const FAQPage = lazy(() => import('./pages/FAQPage'));
const CGVPage = lazy(() => import('./pages/CGVPage'));
const MentionsLegalesPage = lazy(() => import('./pages/MentionsLegalesPage'));
const OrderTrackingPage = lazy(() => import('./pages/OrderTrackingPage'));
const SeFaireEditerPage = lazy(() => import('./pages/SeFaireEditerPage'));
const EvenementsPage = lazy(() => import('./pages/EvenementsPage'));
const ActualitesPage = lazy(() => import('./pages/ActualitesPage'));
const ActualiteDetailPage = lazy(() => import('./pages/ActualiteDetailPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));
const POSLoginPage = lazy(() => import('./pages/pos/POSLoginPage'));
const POSPage = lazy(() => import('./pages/pos/POSPage'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));

// Panels Admin en Lazy Loading pour le Code Splitting
const AdminStatsPanel = lazy(() => import('./pages/admin/panels/StatsPanel'));
const AdminConfigPanel = lazy(() => import('./pages/admin/panels/ConfigPanel'));
const AdminSlidesPanel = lazy(() => import('./pages/admin/panels/SlidesPanel'));
const AdminFAQPanel = lazy(() => import('./pages/admin/panels/FAQPanel'));
const AdminContactPanel = lazy(() => import('./pages/admin/panels/ContactPanel'));
const AdminManuscriptsPanel = lazy(() => import('./pages/admin/panels/ManuscriptsPanelV2'));
const AdminManuscriptDetail = lazy(() => import('./pages/admin/panels/ManuscriptDetailPanel'));
const AdminEvaluationsPanel = lazy(() => import('./pages/admin/panels/EvaluationsPanel'));
const AdminCorrectionsPanel = lazy(() => import('./pages/admin/panels/CorrectionsPanel'));
const AdminEditorialPanel = lazy(() => import('./pages/admin/panels/EditorialPanel'));
const AdminCoversPanel = lazy(() => import('./pages/admin/panels/CoversPanel'));
const AdminPrintingPanel = lazy(() => import('./pages/admin/panels/PrintingPanel'));
const AdminNewsletterPanel = lazy(() => import('./pages/admin/panels/NewsletterPanel'));
const AdminProfilePanel = lazy(() => import('./pages/admin/panels/ProfilePanel'));
const AdminUsersPanel = lazy(() => import('./pages/admin/panels/AdminUsersPanel'));
const ActivityLogPanel = lazy(() => import('./pages/admin/panels/ActivityLogPanel'));
const ContractsPanel = lazy(() => import('./pages/admin/panels/ContractsPanel'));
const ContractsList = lazy(() => import('./pages/admin/panels/ContractsList'));
const ContractDetail = lazy(() => import('./pages/admin/panels/ContractDetail'));
const ContractCreate = lazy(() => import('./pages/admin/panels/ContractCreate'));
const BooksPanel = lazy(() => import('./pages/admin/panels/BooksPanel'));
const TagsPanel = lazy(() => import('./pages/admin/panels/TagsPanel'));
const PosManagementPanel = lazy(() => import('./pages/admin/panels/PosManagementPanel'));
const PaymentsPanel = lazy(() => import('./pages/admin/panels/PaymentsPanel'));
const AccountingPanel = lazy(() => import('./pages/admin/panels/AccountingPanel'));
const AccountingSales = lazy(() => import('./pages/admin/panels/AccountingSales'));
const AccountingPayments = lazy(() => import('./pages/admin/panels/AccountingPayments'));
const AccountingReceivables = lazy(() => import('./pages/admin/panels/AccountingReceivables'));
const AccountingTreasury = lazy(() => import('./pages/admin/panels/AccountingTreasury'));
const AccountingRoyalties = lazy(() => import('./pages/admin/panels/AccountingRoyalties'));
const AccountingChart = lazy(() => import('./pages/admin/panels/AccountingChart'));
const AccountingLedger = lazy(() => import('./pages/admin/panels/AccountingLedger'));
const AccountingBalance = lazy(() => import('./pages/admin/panels/AccountingBalance'));
const AccountingStatements = lazy(() => import('./pages/admin/panels/AccountingStatements'));
const AccountingEntries = lazy(() => import('./pages/admin/panels/AccountingEntries'));
const AccountingSuppliers = lazy(() => import('./pages/admin/panels/AccountingSuppliers'));
const AccountingVat = lazy(() => import('./pages/admin/panels/AccountingVat'));
const InvoicesPanel = lazy(() => import('./pages/admin/panels/InvoicesPanel'));
const InvoicesAuditPanel = lazy(() => import('./pages/admin/panels/InvoicesAuditPanel'));
const DeliveriesPanel = lazy(() => import('./pages/admin/panels/DeliveriesPanel'));
const ConsignmentPanel = lazy(() => import('./pages/admin/panels/ConsignmentPanel'));
const ExpensesPanel = lazy(() => import('./pages/admin/panels/ExpensesPanel'));
const OrdersPanel = lazy(() => import('./pages/admin/panels/OrdersPanel'));
const DevisPanel = lazy(() => import('./pages/admin/panels/DevisPanel'));
const StockDashboardPanel = lazy(() => import('./pages/admin/panels/StockDashboardPanel'));
const StockAlertsPanel = lazy(() => import('./pages/admin/panels/StockAlertsPanel'));
const StockProductsPanel = lazy(() => import('./pages/admin/panels/StockProductsPanel'));
const StockRecommendationsPanel = lazy(() => import('./pages/admin/panels/StockRecommendationsPanel'));
const StockPurchaseOrdersPanel = lazy(() => import('./pages/admin/panels/StockPurchaseOrdersPanel'));
const SuppliersPanel = lazy(() => import('./pages/admin/panels/SuppliersPanel'));
const CustomersPanel = lazy(() => import('./pages/admin/panels/CustomersPanel'));
const CustomerDetailPage = lazy(() => import('./pages/admin/panels/CustomerDetailPage'));
const TiersPanel = lazy(() => import('./pages/admin/panels/TiersPanel'));
const SocieteDetailPage = lazy(() => import('./pages/admin/panels/SocieteDetailPage'));
const AuthorsPanel = lazy(() => import('./pages/admin/panels/AuthorsPanel'));
const AdminNewsPanel = lazy(() => import('./pages/admin/panels/NewsPanel'));

// Pages publiques auteurs (annuaire + profil)
const AuthorsDirectoryPage = lazy(() => import('./pages/AuthorsDirectoryPage'));
const AuthorProfilePage = lazy(() => import('./pages/AuthorProfilePage'));

// Portail auteur (workflow éditorial)
const AuthorLoginPage = lazy(() => import('./pages/author/AuthorLoginPage'));
const AuthorRegisterPage = lazy(() => import('./pages/author/AuthorRegisterPage'));
const AuthorForgotPasswordPage = lazy(() => import('./pages/author/AuthorForgotPasswordPage'));
const AuthorSubmitPage = lazy(() => import('./pages/author/AuthorSubmitPage'));
const AuthorDashboard = lazy(() => import('./pages/author/AuthorDashboard'));
const AuthorManuscriptDetail = lazy(() => import('./pages/author/AuthorManuscriptDetail'));
const AuthorNotificationsPage = lazy(() => import('./pages/author/AuthorNotificationsPage'));
const AuthorPreferencesPage = lazy(() => import('./pages/author/AuthorPreferencesPage'));
const AuthorActivatePage = lazy(() => import('./pages/author/AuthorActivatePage'));

import { SiteConfigProvider } from './hooks/useSiteConfig.jsx';
import ProtectedRoute from './components/auth/ProtectedRoute';
import PosProtectedRoute from './components/pos/PosProtectedRoute';
import AuthorProtectedRoute from './components/author/AuthorProtectedRoute';

export default function App() {
  return (
    <>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            fontFamily: 'Lato, sans-serif',
            fontSize: '14px',
          },
          success: {
            style: { background: '#10531a', color: '#fff' },
          },
        }}
      />
      <SiteConfigProvider>
      <Suspense fallback={<Loader />}>
        <Routes>
          {/* Admin — fullscreen, hors Layout, avec sous-routes */}
          <Route path="/admin" element={<AdminDashboard />}>
            <Route index element={<AdminStatsPanel />} />
            <Route path="books" element={<BooksPanel />} />
            <Route path="tags" element={<TagsPanel />} />
            <Route path="pos" element={<PosManagementPanel />} />
            <Route path="config" element={<AdminConfigPanel />} />
            <Route path="slides" element={<AdminSlidesPanel />} />
            <Route path="faq" element={<AdminFAQPanel />} />
            <Route path="contacts" element={<AdminContactPanel />} />
            <Route path="manuscripts" element={<AdminManuscriptsPanel />} />
            <Route path="manuscripts/:id" element={<AdminManuscriptDetail />} />
            <Route path="evaluations" element={<AdminEvaluationsPanel />} />
            <Route path="corrections" element={<AdminCorrectionsPanel />} />
            <Route path="editorial" element={<AdminEditorialPanel />} />
            <Route path="covers" element={<AdminCoversPanel />} />
            <Route path="printing" element={<AdminPrintingPanel />} />
            <Route path="newsletter" element={<AdminNewsletterPanel />} />
            <Route path="profile" element={<AdminProfilePanel />} />
            <Route path="users" element={<AdminUsersPanel />} />
            <Route path="activity" element={<ActivityLogPanel />} />
            <Route path="payments" element={<PaymentsPanel />} />
            <Route path="accounting" element={<AccountingPanel />} />
            <Route path="accounting/sales" element={<AccountingSales />} />
            <Route path="accounting/payments" element={<AccountingPayments />} />
            <Route path="accounting/receivables" element={<AccountingReceivables />} />
            <Route path="accounting/treasury" element={<AccountingTreasury />} />
            <Route path="accounting/royalties" element={<AccountingRoyalties />} />
            <Route path="accounting/chart" element={<AccountingChart />} />
            <Route path="accounting/ledger" element={<AccountingLedger />} />
            <Route path="accounting/balance" element={<AccountingBalance />} />
            <Route path="accounting/statements" element={<AccountingStatements />} />
            <Route path="accounting/entries" element={<AccountingEntries />} />
            <Route path="accounting/suppliers" element={<AccountingSuppliers />} />
            <Route path="accounting/vat" element={<AccountingVat />} />
            <Route path="invoices" element={<InvoicesPanel />} />
            <Route path="invoices/audit-log" element={<InvoicesAuditPanel />} />
            <Route path="deliveries" element={<DeliveriesPanel />} />
            <Route path="consignments" element={<ConsignmentPanel />} />
            <Route path="expenses" element={<ExpensesPanel />} />
            <Route path="orders" element={<OrdersPanel />} />
            <Route path="devis" element={<DevisPanel />} />
            <Route path="stock" element={<StockDashboardPanel />} />
            <Route path="stock/alerts" element={<StockAlertsPanel />} />
            <Route path="stock/products" element={<StockProductsPanel />} />
            <Route path="stock/recommendations" element={<StockRecommendationsPanel />} />
            <Route path="stock/purchase-orders" element={<StockPurchaseOrdersPanel />} />
            <Route path="suppliers" element={<SuppliersPanel />} />
            <Route path="contracts" element={<ContractsPanel />} />
            <Route path="contracts/list" element={<ContractsList />} />
            <Route path="contracts/new" element={<ContractCreate />} />
            <Route path="contracts/:id" element={<ContractDetail />} />
            <Route path="customers" element={<CustomersPanel />} />
            <Route path="customers/:id" element={<CustomerDetailPage />} />
            <Route path="tiers" element={<TiersPanel />} />
            <Route path="tiers/:id" element={<SocieteDetailPage />} />
            <Route path="authors" element={<AuthorsPanel />} />
            <Route path="news" element={<AdminNewsPanel />} />
          </Route>

          {/* POS — fullscreen, hors Layout */}
          <Route path="/pos/connexion" element={<POSLoginPage />} />
          <Route path="/pos" element={<PosProtectedRoute><POSPage /></PosProtectedRoute>} />

          <Route path="/" element={<Layout />}>
            <Route index element={<HomePage />} />
            {/* Pages publiques auteurs */}
            <Route path="auteurs" element={<AuthorsDirectoryPage />} />
            <Route path="auteur/:slug" element={<AuthorProfilePage />} />

            {/* Portail auteur */}
            <Route path="auteur/connexion" element={<AuthorLoginPage />} />
            <Route path="auteur/inscription" element={<AuthorRegisterPage />} />
            <Route path="auteur/mot-de-passe-oublie" element={<AuthorForgotPasswordPage />} />
            <Route path="auteur/activer" element={<AuthorActivatePage />} />
            <Route path="auteur/dashboard" element={<AuthorProtectedRoute><AuthorDashboard /></AuthorProtectedRoute>} />
            <Route path="auteur/soumettre" element={<AuthorProtectedRoute><AuthorSubmitPage /></AuthorProtectedRoute>} />
            <Route path="auteur/manuscrits/:id" element={<AuthorProtectedRoute><AuthorManuscriptDetail /></AuthorProtectedRoute>} />
            <Route path="auteur/notifications" element={<AuthorProtectedRoute><AuthorNotificationsPage /></AuthorProtectedRoute>} />
            <Route path="auteur/preferences" element={<AuthorProtectedRoute><AuthorPreferencesPage /></AuthorProtectedRoute>} />
            <Route path="catalogue" element={<CatalogPage />} />
            <Route path="se-faire-editer" element={<SeFaireEditerPage />} />
            <Route path="evenements" element={<EvenementsPage />} />
            <Route path="actualites" element={<ActualitesPage />} />
            <Route path="actualites/:slug" element={<ActualiteDetailPage />} />
            <Route path="produit/:id" element={<ProductPage />} />
            <Route path="panier" element={<CartPage />} />
            <Route path="commande" element={<CheckoutPage />} />
            <Route path="commande/succes" element={<CheckoutSuccessPage />} />
            <Route path="commande/echec" element={<CheckoutFailurePage />} />
            <Route path="connexion" element={<LoginPage />} />
            <Route path="inscription" element={<RegisterPage />} />
            <Route path="mot-de-passe-oublie" element={<ForgotPasswordPage />} />
            <Route path="reinitialiser-mdp" element={<ResetPasswordPage />} />
            <Route path="compte" element={<ProtectedRoute><AccountPage /></ProtectedRoute>} />
            <Route path="contact" element={<ContactPage />} />
            <Route path="a-propos" element={<AboutPage />} />
            <Route path="faq" element={<FAQPage />} />
            <Route path="cgv" element={<CGVPage />} />
            <Route path="mentions-legales" element={<MentionsLegalesPage />} />
            <Route path="suivi-commande" element={<OrderTrackingPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
      </SiteConfigProvider>
    </>
  );
}
