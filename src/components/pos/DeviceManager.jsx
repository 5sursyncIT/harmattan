import { useState, useEffect } from 'react';
import { posListDevices, posRevokeDevice, posGenerateEnrollCode } from '../../api/pos';
import { FiX, FiMonitor, FiTrash2, FiPlus, FiCopy, FiCheck, FiShield } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function DeviceManager({ onClose }) {
  const [devices, setDevices] = useState([]);
  const [showGenerate, setShowGenerate] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [generatedCode, setGeneratedCode] = useState(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    posListDevices().then(res => setDevices(res.data)).catch(() => {});
  }, []);

  const handleGenerate = async (e) => {
    e.preventDefault();
    if (!deviceName.trim()) return;
    setGenerating(true);
    try {
      const res = await posGenerateEnrollCode(deviceName.trim());
      setGeneratedCode(res.data);
      setDeviceName('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (device) => {
    if (!confirm(`Révoquer l'appareil "${device.device_name}" ? Il devra être ré-enregistré.`)) return;
    try {
      await posRevokeDevice(device.id);
      setDevices(d => d.map(x => x.id === device.id ? { ...x, active: 0 } : x));
      toast.success('Appareil révoqué');
    } catch {
      toast.error('Erreur');
    }
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(generatedCode.code);
    toast.success('Code copié');
  };

  return (
    <div className="pos-receipt-overlay" style={{ zIndex: 200 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 520, width: '95%', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1.1rem' }}>
            <FiShield /> Appareils autorisés
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><FiX size={20} /></button>
        </div>

        {/* Generate code section */}
        {generatedCode ? (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: 16, marginBottom: 20, textAlign: 'center' }}>
            <p style={{ margin: '0 0 8px', fontWeight: 700, color: '#166534' }}>Code d'enregistrement pour "{generatedCode.device_name}"</p>
            <div style={{ fontSize: '2rem', fontFamily: 'monospace', fontWeight: 900, letterSpacing: 6, color: '#10531a', margin: '12px 0' }}>
              {generatedCode.code}
            </div>
            <button onClick={copyCode} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 16px', background: '#10531a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem' }}>
              <FiCopy size={14} /> Copier
            </button>
            <p style={{ margin: '10px 0 0', fontSize: '0.8rem', color: '#888' }}>Expire dans 10 minutes. Saisissez ce code sur le nouvel appareil.</p>
            <button onClick={() => setGeneratedCode(null)} style={{ marginTop: 10, background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '0.85rem' }}>Fermer</button>
          </div>
        ) : (
          <div style={{ marginBottom: 20 }}>
            <button onClick={() => setShowGenerate(!showGenerate)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', background: '#10531a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}>
              <FiPlus /> Ajouter un appareil
            </button>
            {showGenerate && (
              <form onSubmit={handleGenerate} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input type="text" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} placeholder="Nom de l'appareil (ex: Caisse 2)" required
                  style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd', fontSize: '0.9rem' }} />
                <button type="submit" disabled={generating} style={{ padding: '10px 16px', background: '#10531a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
                  {generating ? '...' : 'Générer le code'}
                </button>
              </form>
            )}
          </div>
        )}

        {/* Device list */}
        <div>
          {devices.length === 0 ? (
            <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>Aucun appareil enregistré</p>
          ) : devices.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #f3f4f6' }}>
              <FiMonitor size={18} style={{ color: d.active ? '#10531a' : '#999', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: d.active ? '#222' : '#999' }}>
                  {d.device_name}
                  {!d.active && <span style={{ marginLeft: 8, fontSize: '0.75rem', color: '#dc2626', fontWeight: 600 }}>Révoqué</span>}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#888' }}>
                  {d.last_ip || '—'} · {d.last_seen_at ? `Vu le ${new Date(d.last_seen_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Jamais connecté'}
                </div>
              </div>
              {d.active ? (
                <button onClick={() => handleRevoke(d)} style={{ background: 'none', border: '1px solid #fecaca', borderRadius: 8, padding: 6, cursor: 'pointer', color: '#dc2626' }} title="Révoquer">
                  <FiTrash2 size={14} />
                </button>
              ) : (
                <FiCheck size={14} style={{ color: '#999' }} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
