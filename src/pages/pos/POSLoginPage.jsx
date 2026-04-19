import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { posLogin } from '../../api/pos';
import usePosAuthStore from '../../store/posAuthStore';
import POSChangePin from '../../components/pos/POSChangePin';
import POSEnrollDevice from '../../components/pos/POSEnrollDevice';
import './POSLoginPage.css';

export default function POSLoginPage() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [deviceRegistered, setDeviceRegistered] = useState(!!localStorage.getItem('pos-device-token'));
  const login = usePosAuthStore((s) => s.login);
  const navigate = useNavigate();

  // If device not registered, show enrollment screen
  if (!deviceRegistered) {
    return <POSEnrollDevice onEnrolled={() => setDeviceRegistered(true)} />;
  }

  const handleDigit = (d) => {
    if (pin.length < 6) setPin((p) => p + d);
    setError('');
  };

  const handleDelete = () => setPin((p) => p.slice(0, -1));
  const handleClear = () => { setPin(''); setError(''); };

  const handleSubmit = async () => {
    if (pin.length < 4) { setError('4 chiffres minimum'); return; }
    setLoading(true);
    try {
      const res = await posLogin(pin);
      login(res.data);
      if (res.data.pin_expired) {
        setShowChangePin(true);
      } else {
        navigate('/pos');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur de connexion');
      setPin('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pos-login">
      {showChangePin && (
        <POSChangePin forced onChanged={() => navigate('/pos')} />
      )}
      <div className="pos-login-card">
        <div className="pos-login-logo">
          <img src="/images/logo.png" alt="Harmattan" />
          <h1>Point de Vente</h1>
          <p>Saisissez votre PIN pour commencer</p>
        </div>

        <div className="pos-pin-display">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={`pos-pin-dot ${i < pin.length ? 'filled' : ''}`} />
          ))}
        </div>

        {error && <div className="pos-login-error">{error}</div>}

        <div className="pos-numpad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
            <button key={d} className="pos-numpad-btn" onClick={() => handleDigit(String(d))} disabled={loading}>
              {d}
            </button>
          ))}
          <button className="pos-numpad-btn pos-numpad-clear" onClick={handleClear} disabled={loading}>C</button>
          <button className="pos-numpad-btn" onClick={() => handleDigit('0')} disabled={loading}>0</button>
          <button className="pos-numpad-btn pos-numpad-delete" onClick={handleDelete} disabled={loading}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 4H8l-7 8 7 8h13a2 2 0 002-2V6a2 2 0 00-2-2z" />
              <line x1="18" y1="9" x2="12" y2="15" /><line x1="12" y1="9" x2="18" y2="15" />
            </svg>
          </button>
        </div>

        <button
          className="pos-login-submit"
          onClick={handleSubmit}
          disabled={pin.length < 4 || loading}
        >
          {loading ? 'Connexion...' : 'Valider'}
        </button>
      </div>
    </div>
  );
}
