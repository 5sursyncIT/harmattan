import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import Layout from './components/layout/Layout';
import Loader from './components/common/Loader';

// Eager: homepage (first paint)
import HomePage from './pages/HomePage';

// Lazy: all other pages
const CatalogPage = lazy(() => import('./pages/CatalogPage'));
const ProductPage = lazy(() => import('./pages/ProductPage'));
const CartPage = lazy(() => import('./pages/CartPage'));
const CheckoutPage = lazy(() => import('./pages/CheckoutPage'));
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
const PosManagementPanel = lazy(() => import('./pages/admin/panels/PosManagementPanel'));
const PaymentsPanel = lazy(() => import('./pages/admin/panels/PaymentsPanel'));
const AccountingPanel = lazy(() => import('./pages/admin/panels/AccountingPanel'));
const AccountingSales = lazy(() => import('./pages/admin/panels/AccountingSales'));
const AccountingPayments = lazy(() => import('./pages/admin/panels/AccountingPayments'));
const AccountingReceivables = lazy(() => import('./pages/admin/panels/AccountingReceivables'));
const AccountingTreasury = lazy(() => import('./pages/admin/panels/AccountingTreasury'));
const AccountingRoyalties = lazy(() => import('./pages/admin/panels/AccountingRoyalties'));
const StockDashboardPanel = lazy(() => import('./pages/admin/panels/StockDashboardPanel'));
const StockAlertsPanel = lazy(() => import('./pages/admin/panels/StockAlertsPanel'));
const StockProductsPanel = lazy(() => import('./pages/admin/panels/StockProductsPanel'));
const SuppliersPanel = lazy(() => import('./pages/admin/panels/SuppliersPanel'));

// Portail auteur (workflow éditorial)
const AuthorLoginPage = lazy(() => import('./pages/author/AuthorLoginPage'));
const AuthorRegisterPage = lazy(() => import('./pages/author/AuthorRegisterPage'));
const AuthorForgotPasswordPage = lazy(() => import('./pages/author/AuthorForgotPasswordPage'));
const AuthorSubmitPage = lazy(() => import('./pages/author/AuthorSubmitPage'));
const AuthorDashboard = lazy(() => import('./pages/author/AuthorDashboard'));
const AuthorManuscriptDetail = lazy(() => import('./pages/author/AuthorManuscriptDetail'));

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
            <Route path="stock" element={<StockDashboardPanel />} />
            <Route path="stock/alerts" element={<StockAlertsPanel />} />
            <Route path="stock/products" element={<StockProductsPanel />} />
            <Route path="suppliers" element={<SuppliersPanel />} />
            <Route path="contracts" element={<ContractsPanel />} />
            <Route path="contracts/list" element={<ContractsList />} />
            <Route path="contracts/new" element={<ContractCreate />} />
            <Route path="contracts/:id" element={<ContractDetail />} />
          </Route>

          {/* POS — fullscreen, hors Layout */}
          <Route path="/pos/connexion" element={<POSLoginPage />} />
          <Route path="/pos" element={<PosProtectedRoute><POSPage /></PosProtectedRoute>} />

          <Route path="/" element={<Layout />}>
            <Route index element={<HomePage />} />
            {/* Portail auteur */}
            <Route path="auteur/connexion" element={<AuthorLoginPage />} />
            <Route path="auteur/inscription" element={<AuthorRegisterPage />} />
            <Route path="auteur/mot-de-passe-oublie" element={<AuthorForgotPasswordPage />} />
            <Route path="auteur/dashboard" element={<AuthorProtectedRoute><AuthorDashboard /></AuthorProtectedRoute>} />
            <Route path="auteur/soumettre" element={<AuthorProtectedRoute><AuthorSubmitPage /></AuthorProtectedRoute>} />
            <Route path="auteur/manuscrits/:id" element={<AuthorProtectedRoute><AuthorManuscriptDetail /></AuthorProtectedRoute>} />
            <Route path="catalogue" element={<CatalogPage />} />
            <Route path="se-faire-editer" element={<SeFaireEditerPage />} />
            <Route path="evenements" element={<EvenementsPage />} />
            <Route path="produit/:id" element={<ProductPage />} />
            <Route path="panier" element={<CartPage />} />
            <Route path="commande" element={<CheckoutPage />} />
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
