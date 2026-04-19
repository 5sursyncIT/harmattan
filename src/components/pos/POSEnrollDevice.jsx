import { useState } from 'react';
import { posEnrollDevice } from '../../api/pos';
import { FiShield, FiMonitor } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function POSEnrollDevice({ onEnrolled }) {
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await posEnrollDevice(code.trim(), deviceName.trim() || undefined);
      localStorage.setItem('pos-device-token', res.data.device_token);
      toast.success(`Appareil "${res.data.device_name}" enregistré`);
      onEnrolled();
    } catch (err) {
      setError(err.response?.data?.error || 'Code invalide ou expiré');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pos-login">
      <div className="pos-login-card" style={{ maxWidth: 420 }}>
        <div className="pos-login-logo">
          <img src="/images/logo.png" alt="Harmattan" />
          <h1>Enregistrement de l'appareil</h1>
        </div>

        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12, padding: 16, marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <FiShield size={20} style={{ color: '#3b82f6', flexShrink: 0, marginTop: 2 }} />
            <div style={{ fontSize: '0.85rem', color: '#1e40af', lineHeight: 1.5 }}>
              <strong>Configuration unique</strong><br />
              Cet appareil doit être autorisé par un manager avant de pouvoir accéder au Point de Vente.
              Saisissez le code d'enregistrement fourni par votre manager.
            </div>
          </div>
        </div>

        {error && <div style={{ color: '#dc2626', background: '#fef2f2', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: '0.85rem', fontWeight: 600 }}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', marginBottom: 6, color: '#333' }}>Code d'enregistrement</label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Ex: A1B2C3D4"
              style={{ width: '100%', padding: '14px 16px', fontSize: '1.2rem', textAlign: 'center', letterSpacing: 6, fontWeight: 800, fontFamily: 'monospace', borderRadius: 12, border: '2px solid #e5e7eb', textTransform: 'uppercase' }}
              autoFocus
              required
              maxLength={20}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', marginBottom: 6, color: '#333' }}>
              <FiMonitor size={14} style={{ verticalAlign: -2 }} /> Nom de l'appareil (optionnel)
            </label>
            <input
              type="text"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="Ex: Caisse 1, Tablette librairie..."
              style={{ width: '100%', padding: '10px 14px', fontSize: '0.9rem', borderRadius: 10, border: '2px solid #e5e7eb' }}
            />
          </div>

          <button
            type="submit"
            className="pos-login-submit"
            disabled={loading || !code.trim()}
          >
            {loading ? 'Vérification...' : 'Enregistrer cet appareil'}
          </button>
        </form>
      </div>
    </div>
  );
}
