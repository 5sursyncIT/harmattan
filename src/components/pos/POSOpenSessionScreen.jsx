import { useEffect, useState, useCallback } from 'react';
import { FiMonitor, FiLogIn, FiLogOut, FiClock, FiUser, FiEdit2 } from 'react-icons/fi';
import { posGetConfig, posOpenSession, posLogout, posListTerminalSlots, posReassignTerminal } from '../../api/pos';
import usePosAuthStore from '../../store/posAuthStore';
import usePosSessionStore from '../../store/posSessionStore';
import toast from 'react-hot-toast';
import './POSOpenSessionScreen.css';

export default function POSOpenSessionScreen({ onOpened }) {
  const [config, setConfig] = useState(null);
  const [openingCash, setOpeningCash] = useState('');
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showTerminalPicker, setShowTerminalPicker] = useState(false);
  const [slots, setSlots] = useState([]);
  const [switching, setSwitching] = useState(false);
  const openSessionStore = usePosSessionStore((s) => s.openSession);
  const logout = usePosAuthStore((s) => s.logout);
  const staff = usePosAuthStore((s) => s.staff);

  const loadConfig = useCallback(() => {
    posGetConfig().then((res) => {
      setConfig(res.data);
      if (res.data?.last_close?.counted_cash != null && !edited) {
        setOpeningCash(String(Math.round(res.data.last_close.counted_cash)));
      }
    }).catch(() => setError('Impossible de récupérer la configuration du terminal'));
  }, [edited]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const openTerminalPicker = async () => {
    setShowTerminalPicker(true);
    setError('');
    try {
      const res = await posListTerminalSlots();
      setSlots(res.data || []);
    } catch {
      setError('Impossible de charger la liste des terminaux');
    }
  };

  const handleSwitch = async (newT) => {
    if (!config?.device_id) {
      setError('Impossible d\'identifier votre appareil');
      return;
    }
    if (newT === config?.terminal) {
      setShowTerminalPicker(false);
      return;
    }
    setSwitching(true);
    try {
      await posReassignTerminal(config.device_id, newT);
      toast.success(`Terminal changé : T${newT}`);
      setShowTerminalPicker(false);
      loadConfig();
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur changement de terminal');
    } finally { setSwitching(false); }
  };

  const handleOpen = async () => {
    setLoading(true); setError('');
    try {
      const res = await posOpenSession({ opening_cash: parseInt(openingCash) || 0 });
      openSessionStore(res.data);
      onOpened?.();
    } catch (err) {
      setError(err.response?.data?.error || 'Erreur ouverture caisse');
    } finally { setLoading(false); }
  };

  const handleLogout = async () => {
    try { await posLogout(); } catch { /* noop */ }
    logout();
    window.location.replace('/pos/connexion');
  };

  const lastClose = config?.last_close;

  return (
    <div className="pos-open-screen">
      <div className="pos-open-card">
        <div className="pos-open-header">
          <img src="/images/logo.png" alt="Harmattan" />
          <h1>Ouverture de caisse</h1>
          <p>Confirmez le fond de caisse avant de commencer</p>
        </div>

        <div className="pos-open-terminal">
          <div className="pos-open-terminal-row">
            <span className="pos-open-label"><FiMonitor /> Terminal</span>
            <span className="pos-open-value" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {config ? `T${config.terminal}${config.device_name ? ` — ${config.device_name}` : ''}` : '…'}
              {config && (
                <button
                  type="button"
                  onClick={openTerminalPicker}
                  title="Changer de terminal"
                  style={{ background: 'transparent', border: '1px solid #cbd5e1', borderRadius: 6, padding: '3px 6px', cursor: 'pointer', color: '#475569', display: 'inline-flex' }}
                >
                  <FiEdit2 size={12} />
                </button>
              )}
            </span>
          </div>
          {staff && (
            <div className="pos-open-terminal-row">
              <span className="pos-open-label"><FiUser /> Caissier</span>
              <span className="pos-open-value">{staff.name}</span>
            </div>
          )}
          {lastClose && (
            <div className="pos-open-terminal-row">
              <span className="pos-open-label"><FiClock /> Dernière clôture</span>
              <span className="pos-open-value">
                {new Date(lastClose.closed_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}
                {lastClose.staff_name ? ` · ${lastClose.staff_name}` : ''}
              </span>
            </div>
          )}
        </div>

        <div className="pos-open-field">
          <label htmlFor="opening-cash">Fond de caisse (espèces, FCFA)</label>
          <input
            id="opening-cash"
            type="number"
            inputMode="numeric"
            value={openingCash}
            onChange={(e) => { setOpeningCash(e.target.value); setEdited(true); }}
            placeholder="0"
            autoFocus
          />
          {lastClose?.counted_cash != null && (
            <div className="pos-open-hint">
              Suggestion : {Math.round(lastClose.counted_cash).toLocaleString('fr-FR')} F (dernière clôture comptée)
            </div>
          )}
        </div>

        {error && <div className="pos-open-error">{error}</div>}

        <button
          className="pos-open-btn primary"
          onClick={handleOpen}
          disabled={loading}
        >
          <FiLogIn /> {loading ? 'Ouverture…' : 'Ouvrir la caisse'}
        </button>
        <button className="pos-open-btn ghost" onClick={handleLogout} disabled={loading}>
          <FiLogOut /> Se déconnecter
        </button>
      </div>

      {showTerminalPicker && (
        <div
          onClick={() => !switching && setShowTerminalPicker(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, zIndex: 2100 }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 420, boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '1.05rem', color: '#0f172a' }}>Choisir le terminal</h3>
            <p style={{ margin: '0 0 16px', fontSize: '0.82rem', color: '#64748b' }}>
              Sélectionnez un numéro de caisse disponible. Les caisses occupées sont grisées.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginBottom: 14 }}>
              {slots.map((s) => {
                const isCurrent = s.terminal === config?.terminal;
                const taken = !s.free && !isCurrent;
                return (
                  <button
                    key={s.terminal}
                    onClick={() => !taken && !switching && handleSwitch(s.terminal)}
                    disabled={taken || switching}
                    title={isCurrent ? 'Terminal actuel' : (taken ? `Occupé par ${s.device_name}` : `T${s.terminal} libre`)}
                    style={{
                      padding: '12px 4px', borderRadius: 10, fontWeight: 700, fontSize: '0.95rem',
                      cursor: taken ? 'not-allowed' : 'pointer',
                      border: isCurrent ? '2px solid #10531a' : '1px solid #cbd5e1',
                      background: isCurrent ? '#10531a' : (taken ? '#f1f5f9' : '#fff'),
                      color: isCurrent ? '#fff' : (taken ? '#94a3b8' : '#0f172a'),
                      textDecoration: taken ? 'line-through' : 'none',
                    }}
                  >T{s.terminal}</button>
                );
              })}
            </div>
            {error && <div className="pos-open-error" style={{ marginTop: 0 }}>{error}</div>}
            <button
              onClick={() => setShowTerminalPicker(false)}
              disabled={switching}
              style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', cursor: 'pointer', fontWeight: 600 }}
            >Annuler</button>
          </div>
        </div>
      )}
    </div>
  );
}
