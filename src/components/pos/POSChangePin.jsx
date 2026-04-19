import { useState } from 'react';
import { posChangePin } from '../../api/pos';
import { FiLock, FiX } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function POSChangePin({ forced, onClose, onChanged }) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (newPin.length < 6) return toast.error('Le nouveau PIN doit faire au moins 6 chiffres');
    if (!/^\d+$/.test(newPin)) return toast.error('Le PIN doit contenir uniquement des chiffres');
    if (newPin !== confirmPin) return toast.error('Les PINs ne correspondent pas');
    if (newPin === currentPin) return toast.error('Le nouveau PIN doit être différent');

    setLoading(true);
    try {
      await posChangePin(currentPin, newPin);
      toast.success('PIN modifié avec succès');
      onChanged?.();
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur lors du changement de PIN');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pos-receipt-overlay" style={{ zIndex: 300 }}>
      <div style={{
        background: '#fff', borderRadius: 12, padding: '2rem', maxWidth: 400, width: '90%',
        boxShadow: '0 8px 30px rgba(0,0,0,0.3)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiLock /> {forced ? 'PIN expiré — Changez votre PIN' : 'Changer le PIN'}
          </h2>
          {!forced && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
              <FiX size={20} />
            </button>
          )}
        </div>

        {forced && (
          <p style={{ color: '#d32f2f', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Votre PIN a expiré. Veuillez en choisir un nouveau pour continuer.
          </p>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '0.9rem' }}>PIN actuel</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={currentPin}
              onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%', padding: '10px', fontSize: '1.1rem', borderRadius: 8, border: '1px solid #ccc', letterSpacing: 8, textAlign: 'center' }}
              required
              autoFocus
            />
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '0.9rem' }}>Nouveau PIN (6 chiffres min.)</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%', padding: '10px', fontSize: '1.1rem', borderRadius: 8, border: '1px solid #ccc', letterSpacing: 8, textAlign: 'center' }}
              required
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: 4, fontWeight: 600, fontSize: '0.9rem' }}>Confirmer le nouveau PIN</label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={confirmPin}
              onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
              style={{ width: '100%', padding: '10px', fontSize: '1.1rem', borderRadius: 8, border: '1px solid #ccc', letterSpacing: 8, textAlign: 'center' }}
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', padding: '12px', background: '#10531a', color: '#fff',
              border: 'none', borderRadius: 8, fontWeight: 700, fontSize: '1rem', cursor: 'pointer'
            }}
          >
            {loading ? 'Modification...' : 'Valider le nouveau PIN'}
          </button>
        </form>
      </div>
    </div>
  );
}
