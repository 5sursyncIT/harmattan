import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import Footer from './Footer';
import Newsletter from './Newsletter';
import WhatsAppButton from '../common/WhatsAppButton';

export default function Layout() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Aller au contenu principal</a>
      <Header />
      <main className="main-content" id="main-content" tabIndex="-1">
        <Outlet />
      </main>
      <Newsletter />
      <Footer />
      <WhatsAppButton />
    </div>
  );
}
