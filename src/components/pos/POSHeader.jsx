// POS Header
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import usePosAuthStore from '../../store/posAuthStore';
import usePosSessionStore from '../../store/posSessionStore';
import { posGetTodaySales } from '../../api/pos';
import { FiLogOut, FiDollarSign, FiClock, FiMonitor, FiLock, FiBarChart2, FiRotateCcw, FiShield } from 'react-icons/fi';
import './POSHeader.css';

function getPosTerminal() {
  return parseInt(localStorage.getItem('pos-terminal') || '1');
}

export default function POSHeader({ onOpenCashRegister, onChangePin, onReturn, onDevices }) {
  const staff = usePosAuthStore((s) => s.staff);
  const logout = usePosAuthStore((s) => s.logout);
  const isSessionOpen = usePosSessionStore((s) => s.isOpen);
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());
  const [terminal, setTerminal] = useState(getPosTerminal);
  const [editing, setEditing] = useState(false);
  const [todaySales, setTodaySales] = useState({ count: 0, total: 0 });

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
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
  }, [terminal]);

  const handleLogout = () => {
    logout();
    navigate('/pos/connexion');
  };

  const changeTerminal = (num) => {
    setTerminal(num);
    localStorage.setItem('pos-terminal', String(num));
    setEditing(false);
  };

  return (
    <header className="pos-header">
      <div className="pos-header-left">
        <div className="pos-header-brand">
          <img src="/images/logo.png" alt="Logo L'Harmattan" className="pos-header-logo" />
          <span>L'Harmattan Sénégal</span>
        </div>
        {editing ? (
          <div className="pos-terminal-picker">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={`pos-terminal-opt ${n === terminal ? 'active' : ''}`} onClick={() => changeTerminal(n)}>
                {n}
              </button>
            ))}
          </div>
        ) : (
          <button className="pos-header-terminal" onClick={() => setEditing(true)}>
            <FiMonitor size={12} /> Terminal {terminal}
          </button>
        )}
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
