// POS Header
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import usePosAuthStore from '../../store/posAuthStore';
import usePosSessionStore from '../../store/posSessionStore';
import { posGetTodaySales, posGetConfig, posLogout } from '../../api/pos';
import { FiLogOut, FiDollarSign, FiClock, FiMonitor, FiLock, FiBarChart2, FiRotateCcw, FiShield, FiPrinter } from 'react-icons/fi';
import './POSHeader.css';

export default function POSHeader({ onOpenCashRegister, onChangePin, onReturn, onDevices, onPrinterSettings }) {
  const staff = usePosAuthStore((s) => s.staff);
  const logout = usePosAuthStore((s) => s.logout);
  const isSessionOpen = usePosSessionStore((s) => s.isOpen);
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());
  const [terminal, setTerminal] = useState(null);
  const [todaySales, setTodaySales] = useState({ count: 0, total: 0 });

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Le numéro de terminal est défini par le serveur (lié à l'appareil enrôlé),
  // il n'est plus modifiable depuis le poste.
  useEffect(() => {
    posGetConfig().then((res) => setTerminal(res.data?.terminal ?? null)).catch(() => {});
  }, []);

  // Fetch today's sales summary every 30s
  useEffect(() => {
    const fetchSales = () => {
      posGetTodaySales().then((res) => {
        const sales = res.data || [];
        setTodaySales({
          count: sales.length,
          total: sales.reduce((s, v) => s + parseFloat(v.total_ttc || 0), 0),
        });
      }).catch(() => {});
    };
    fetchSales();
    const interval = setInterval(fetchSales, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = async () => {
    // Appel serveur indispensable : seul le serveur peut effacer le cookie
    // HttpOnly de session et supprimer la session en base.
    try { await posLogout(); } catch { /* hors ligne — on déconnecte localement quand même */ }
    logout();
    navigate('/pos/connexion');
  };

  return (
    <header className="pos-header">
      <div className="pos-header-left">
        <div className="pos-header-brand">
          <img src="/images/logo.png" alt="Logo L'Harmattan" className="pos-header-logo" />
          <span>L'Harmattan Sénégal</span>
        </div>
        <div className="pos-header-terminal">
          <FiMonitor size={12} /> Terminal {terminal ?? '—'}
        </div>
      </div>

      <div className="pos-header-center">
        <FiClock />
        <span>{time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
        <span className="pos-header-separator">|</span>
        <FiBarChart2 size={13} />
        <span className="pos-header-sales">{todaySales.count} ventes — {parseInt(todaySales.total).toLocaleString('fr-FR')} F</span>
      </div>

      <div className="pos-header-right">
        <button
          className={`pos-header-btn pos-header-caisse ${isSessionOpen ? 'open' : 'closed'}`}
          onClick={onOpenCashRegister}
        >
          <FiDollarSign />
          Caisse {isSessionOpen ? 'ouverte' : 'fermée'}
        </button>
        <span className="pos-header-staff">{staff?.name}</span>
        <button className="pos-header-btn" onClick={onReturn} title="Retour / Avoir">
          <FiRotateCcw size={16} />
        </button>
        <button className="pos-header-btn" onClick={onPrinterSettings} title="Imprimante thermique">
          <FiPrinter size={16} />
        </button>
        {staff?.role === 'manager' && (
          <button className="pos-header-btn" onClick={onDevices} title="Appareils autorisés">
            <FiShield size={16} />
          </button>
        )}
        <button className="pos-header-btn" onClick={onChangePin} title="Changer PIN">
          <FiLock size={16} />
        </button>
        <button className="pos-header-btn pos-header-logout" onClick={handleLogout} title="Déconnexion">
          <FiLogOut size={16} />
        </button>
      </div>
    </header>
  );
}
