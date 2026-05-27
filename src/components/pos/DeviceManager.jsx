import { useState, useEffect, useCallback } from 'react';
import { posListDevices, posRevokeDevice, posGenerateEnrollCode, posListTerminalSlots, posReassignTerminal } from '../../api/pos';
import { FiX, FiMonitor, FiTrash2, FiPlus, FiCopy, FiCheck, FiShield, FiEdit2 } from 'react-icons/fi';
import toast from 'react-hot-toast';

export default function DeviceManager({ onClose }) {
  const [devices, setDevices] = useState([]);
  const [slots, setSlots] = useState([]);
  const [showGenerate, setShowGenerate] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [chosenTerminal, setChosenTerminal] = useState('');
  const [generatedCode, setGeneratedCode] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);

  const refresh = useCallback(() => {
    posListDevices().then((res) => setDevices(res.data)).catch(() => {});
    posListTerminalSlots().then((res) => setSlots(res.data)).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleGenerate = async (e) => {
    e.preventDefault();
    if (!deviceName.trim()) return;
    setGenerating(true);
    try {
      const res = await posGenerateEnrollCode(deviceName.trim(), chosenTerminal || null);
      setGeneratedCode(res.data);
      setDeviceName(''); setChosenTerminal('');
      refresh();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    } finally { setGenerating(false); }
  };

  const handleRevoke = async (device) => {
    if (!confirm(`Révoquer l'appareil "${device.device_name}" ? Il devra être ré-enregistré.`)) return;
    try {
      await posRevokeDevice(device.id);
      toast.success('Appareil révoqué');
      refresh();
    } catch { toast.error('Erreur'); }
  };

  const handleReassign = async (device, newT) => {
    try {
      await posReassignTerminal(device.id, parseInt(newT));
      toast.success(`${device.device_name} → Terminal ${newT}`);
      setEditingDevice(null);
      refresh();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur réassignation');
    }
  };

  const copyCode = () => {
    navigator.clipboard?.writeText(generatedCode.code);
    toast.success('Code copié');
  };

  const freeSlots = slots.filter((s) => s.free);
  const slotsForDevice = (deviceId) => slots.filter((s) => s.free || s.device_id === deviceId);

  return (
    <div className="pos-receipt-overlay" style={{ zIndex: 200 }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 24, maxWidth: 560, width: '95%', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: '1.1rem' }}>
            <FiShield /> Appareils autorisés
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer' }}><FiX size={20} /></button>
        </div>

        {generatedCode ? (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: 16, marginBottom: 20, textAlign: 'center' }}>
            <p style={{ margin: '0 0 8px', fontWeight: 700, color: '#166534' }}>
              Code pour « {generatedCode.device_name} »
              {generatedCode.terminal && <> · Terminal {generatedCode.terminal}</>}
            </p>
            <div style={{ fontSize: '2rem', fontFamily: 'monospace', fontWeight: 900, letterSpacing: 6, color: '#10531a', margin: '12px 0' }}>
              {generatedCode.code}
            </div>
            <button onClick={copyCode} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 16px', background: '#10531a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: '0.85rem' }}>
              <FiCopy size={14} /> Copier
            </button>
            <p style={{ margin: '10px 0 0', fontSize: '0.8rem', color: '#888' }}>
              Expire dans 10 minutes. Saisissez ce code sur le nouvel appareil.
            </p>
            <button onClick={() => setGeneratedCode(null)} style={{ marginTop: 10, background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '0.85rem' }}>Fermer</button>
          </div>
        ) : (
          <div style={{ marginBottom: 20 }}>
            <button onClick={() => setShowGenerate(!showGenerate)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', background: '#10531a', color: '#fff', border: 'none', borderRadius: 10, fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}>
              <FiPlus /> Ajouter un appareil
            </button>
            {showGenerate && (
              <form onSubmit={handleGenerate} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                  type="text"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="Nom de l'appareil (ex: Caisse 2)"
                  required
                  style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #ddd', fontSize: '0.9rem' }}
                />
                <div>
                  <div style={{ fontSize: '0.8rem', color: '#475569', marginBottom: 6, fontWeight: 600 }}>
                    Terminal à attribuer
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                    <button
                      type="button"
                      onClick={() => setChosenTerminal('')}
                      style={{
                        padding: '8px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer',
                        border: chosenTerminal === '' ? '2px solid #10531a' : '1px solid #cbd5e1',
                        background: chosenTerminal === '' ? '#f0fdf4' : '#fff',
                        color: chosenTerminal === '' ? '#10531a' : '#475569',
                      }}
                    >Auto</button>
                    {slots.map((s) => (
                      <button
                        key={s.terminal}
                        type="button"
                        onClick={() => s.free && setChosenTerminal(String(s.terminal))}
                        disabled={!s.free}
                        title={s.free ? `Terminal ${s.terminal} libre` : `Occupé par ${s.device_name}`}
                        style={{
                          padding: '8px', borderRadius: 8, fontSize: '0.78rem', fontWeight: 600,
                          cursor: s.free ? 'pointer' : 'not-allowed',
                          border: String(s.terminal) === chosenTerminal ? '2px solid #10531a' : '1px solid #cbd5e1',
                          background: !s.free ? '#f1f5f9' : (String(s.terminal) === chosenTerminal ? '#f0fdf4' : '#fff'),
                          color: !s.free ? '#94a3b8' : (String(s.terminal) === chosenTerminal ? '#10531a' : '#475569'),
                          textDecoration: !s.free ? 'line-through' : 'none',
                        }}
                      >T{s.terminal}</button>
                    ))}
                  </div>
                  {chosenTerminal === '' && (
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 4 }}>
                      Auto : le plus petit numéro libre ({freeSlots[0]?.terminal ?? '—'}) sera attribué à l'enrôlement.
                    </div>
                  )}
                </div>
                <button type="submit" disabled={generating} style={{ padding: '10px 16px', background: '#10531a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer' }}>
                  {generating ? '...' : 'Générer le code'}
                </button>
              </form>
            )}
          </div>
        )}

        <div>
          {devices.length === 0 ? (
            <p style={{ color: '#888', textAlign: 'center', padding: 20 }}>Aucun appareil enregistré</p>
          ) : devices.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #f3f4f6' }}>
              <FiMonitor size={18} style={{ color: d.active ? '#10531a' : '#999', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: d.active ? '#222' : '#999', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {d.device_name}
                  {d.terminal != null && (
                    <span style={{ background: '#eef2f6', color: '#0f172a', padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700 }}>
                      T{d.terminal}
                    </span>
                  )}
                  {!d.active && <span style={{ fontSize: '0.75rem', color: '#dc2626', fontWeight: 600 }}>Révoqué</span>}
                </div>
                <div style={{ fontSize: '0.78rem', color: '#888' }}>
                  {d.last_ip || '—'} · {d.last_seen_at ? `Vu le ${new Date(d.last_seen_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Jamais connecté'}
                </div>
                {editingDevice === d.id && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.78rem', color: '#475569', fontWeight: 600 }}>Nouveau terminal :</span>
                    {slotsForDevice(d.id).map((s) => (
                      <button
                        key={s.terminal}
                        onClick={() => handleReassign(d, s.terminal)}
                        disabled={s.terminal === d.terminal}
                        style={{
                          padding: '4px 8px', borderRadius: 6, fontSize: '0.75rem', fontWeight: 600,
                          border: '1px solid #cbd5e1',
                          background: s.terminal === d.terminal ? '#10531a' : '#fff',
                          color: s.terminal === d.terminal ? '#fff' : '#475569',
                          cursor: s.terminal === d.terminal ? 'default' : 'pointer',
                        }}
                      >T{s.terminal}</button>
                    ))}
                    <button onClick={() => setEditingDevice(null)} style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '0.78rem' }}>Annuler</button>
                  </div>
                )}
              </div>
              {d.active && (
                <button
                  onClick={() => setEditingDevice(editingDevice === d.id ? null : d.id)}
                  style={{ background: 'none', border: '1px solid #cbd5e1', borderRadius: 8, padding: 6, cursor: 'pointer', color: '#475569' }}
                  title="Changer de terminal"
                >
                  <FiEdit2 size={14} />
                </button>
              )}
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
