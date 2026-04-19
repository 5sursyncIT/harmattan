import { useState, useEffect, useCallback } from 'react';
import {
  FiMonitor, FiUsers, FiPlus, FiTrash2, FiKey, FiCheck, FiX,
  FiEdit2, FiSave, FiCopy, FiRefreshCw, FiAlertCircle, FiActivity,
} from 'react-icons/fi';
import toast from 'react-hot-toast';
import {
  getPosDevices, generatePosEnrollmentCode, getPosEnrollmentCodes,
  updatePosDevice, revokePosDevice,
  getPosStaff, createPosStaff, updatePosStaff, resetPosStaffPin, deletePosStaff,
  getPosSessions,
} from '../../../api/admin';
import './PosManagementPanel.css';

const fmtDate = (d) => d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

export default function PosManagementPanel() {
  const [tab, setTab] = useState('devices');

  return (
    <div className="admin-panel">
      <div className="pos-mgmt-tabs">
        <button className={`pos-tab ${tab === 'devices' ? 'active' : ''}`} onClick={() => setTab('devices')}>
          <FiMonitor /> Appareils
        </button>
        <button className={`pos-tab ${tab === 'staff' ? 'active' : ''}`} onClick={() => setTab('staff')}>
          <FiUsers /> Personnel POS
        </button>
        <button className={`pos-tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>
          <FiActivity /> Sessions actives
        </button>
      </div>

      {tab === 'devices' && <DevicesTab />}
      {tab === 'staff' && <StaffTab />}
      {tab === 'sessions' && <SessionsTab />}
    </div>
  );
}

/* ══════════════════════════════════════════════════════ */
/*  DEVICES TAB                                           */
/* ══════════════════════════════════════════════════════ */

function DevicesTab() {
  const [devices, setDevices] = useState([]);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newCode, setNewCode] = useState(null);
  const [deviceName, setDeviceName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [devRes, codeRes] = await Promise.all([getPosDevices(), getPosEnrollmentCodes()]);
      setDevices(devRes.data || []);
      setCodes(codeRes.data || []);
    } catch {
      toast.error('Erreur chargement');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    try {
      const res = await generatePosEnrollmentCode(deviceName || 'Nouveau POS');
      setNewCode(res.data);
      setDeviceName('');
      load();
      toast.success('Code généré');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const copyCode = (code) => {
    navigator.clipboard.writeText(code);
    toast.success('Code copié');
  };

  const handleRevoke = async (d) => {
    if (!confirm(`Révoquer l'appareil "${d.device_name}" ? Il devra être ré-enrôlé.`)) return;
    try {
      await revokePosDevice(d.id);
      load();
      toast.success('Appareil révoqué');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const handleReactivate = async (d) => {
    try {
      await updatePosDevice(d.id, { active: 1 });
      load();
      toast.success('Appareil réactivé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  return (
    <div className="pos-tab-content">
      {/* Generate code */}
      <div className="admin-card pos-generate-card">
        <h3><FiKey /> Enrôler un nouvel appareil</h3>
        <p className="pos-hint">Générez un code unique à saisir sur le nouvel appareil POS (valable 10 minutes).</p>
        <div className="pos-generate-form">
          <input
            type="text"
            placeholder="Nom de l'appareil (ex: Caisse 2)"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
          />
          <button className="btn btn-primary" onClick={handleGenerate}>
            <FiPlus /> Générer un code
          </button>
        </div>

        {newCode && (
          <div className="pos-code-display">
            <span className="pos-code-label">Code d'enrôlement :</span>
            <code className="pos-code-value" onClick={() => copyCode(newCode.code)}>{newCode.code}</code>
            <button className="btn-icon" onClick={() => copyCode(newCode.code)} title="Copier">
              <FiCopy />
            </button>
            <span className="pos-code-expires">Valable jusqu'à {fmtDate(newCode.expires_at)}</span>
          </div>
        )}

        {codes.length > 0 && (
          <div className="pos-pending-codes">
            <strong>Codes en attente :</strong>
            <ul>
              {codes.map((c) => (
                <li key={c.code}>
                  <code onClick={() => copyCode(c.code)}>{c.code}</code>
                  <span>{c.device_name}</span>
                  <span className="pos-expire-small">expire {fmtDate(c.expires_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Devices list */}
      <div className="admin-card">
        <div className="admin-panel-header">
          <h3>Appareils ({devices.filter((d) => d.active).length} actif{devices.filter((d) => d.active).length > 1 ? 's' : ''} / {devices.length} total)</h3>
          <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Rafraîchir</button>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Dernière activité</th>
              <th>Dernière IP</th>
              <th>Statut</th>
              <th style={{ width: 100 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.length === 0 && (
              <tr><td colSpan="5" className="pos-empty">Aucun appareil enregistré</td></tr>
            )}
            {devices.map((d) => (
              <tr key={d.id} className={!d.active ? 'inactive' : ''}>
                <td><strong>{d.device_name}</strong></td>
                <td>{fmtDate(d.last_seen_at)}</td>
                <td><code className="pos-ip">{d.last_ip || '—'}</code></td>
                <td>
                  {d.active ? (
                    <span className="pos-badge pos-badge-ok"><FiCheck size={11} /> Actif</span>
                  ) : (
                    <span className="pos-badge pos-badge-ko"><FiX size={11} /> Révoqué</span>
                  )}
                </td>
                <td>
                  {d.active ? (
                    <button className="btn-icon danger" onClick={() => handleRevoke(d)} title="Révoquer"><FiTrash2 size={14} /></button>
                  ) : (
                    <button className="btn-icon" onClick={() => handleReactivate(d)} title="Réactiver"><FiRefreshCw size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════ */
/*  STAFF TAB                                             */
/* ══════════════════════════════════════════════════════ */

function StaffTab() {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', pin: '', role: 'cashier' });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [resetPinId, setResetPinId] = useState(null);
  const [newPin, setNewPin] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getPosStaff();
      setStaff(res.data || []);
    } catch {
      toast.error('Erreur chargement personnel');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !/^\d{4,6}$/.test(form.pin)) {
      return toast.error('Nom et PIN (4-6 chiffres) requis');
    }
    try {
      await createPosStaff(form);
      setForm({ name: '', pin: '', role: 'cashier' });
      setShowForm(false);
      load();
      toast.success('Personnel créé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const startEdit = (s) => {
    setEditingId(s.id);
    setEditForm({ name: s.name, role: s.role });
  };

  const saveEdit = async (id) => {
    try {
      await updatePosStaff(id, editForm);
      setEditingId(null);
      load();
      toast.success('Modifié');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const toggleActive = async (s) => {
    try {
      await updatePosStaff(s.id, { active: s.active ? 0 : 1 });
      load();
      toast.success(s.active ? 'Désactivé' : 'Activé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const handleResetPin = async () => {
    if (!/^\d{4,6}$/.test(newPin)) return toast.error('PIN invalide (4-6 chiffres)');
    try {
      await resetPosStaffPin(resetPinId, newPin);
      setResetPinId(null);
      setNewPin('');
      load();
      toast.success('PIN réinitialisé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const handleDelete = async (s) => {
    if (!confirm(`Supprimer "${s.name}" ? (désactivation)`)) return;
    try {
      await deletePosStaff(s.id);
      load();
      toast.success('Supprimé');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Erreur');
    }
  };

  const isPinExpired = (d) => d && new Date(d) < new Date();

  return (
    <div className="pos-tab-content">
      <div className="admin-card">
        <div className="admin-panel-header">
          <h3>Personnel POS ({staff.filter((s) => s.active).length} actif{staff.filter((s) => s.active).length > 1 ? 's' : ''})</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Rafraîchir</button>
            <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
              <FiPlus /> Nouveau membre
            </button>
          </div>
        </div>

        {showForm && (
          <form className="pos-staff-form" onSubmit={handleCreate}>
            <input
              type="text"
              placeholder="Nom complet"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{4,6}"
              placeholder="PIN (4-6 chiffres)"
              value={form.pin}
              onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              maxLength={6}
              required
            />
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="cashier">Caissier</option>
              <option value="manager">Manager</option>
            </select>
            <button type="submit" className="btn btn-primary"><FiSave /> Créer</button>
          </form>
        )}

        <table className="admin-table">
          <thead>
            <tr>
              <th>Nom</th>
              <th>Rôle</th>
              <th>PIN expire</th>
              <th>Statut</th>
              <th style={{ width: 160 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {staff.length === 0 && (
              <tr><td colSpan="5" className="pos-empty">Aucun personnel enregistré</td></tr>
            )}
            {staff.map((s) => {
              const editing = editingId === s.id;
              const expired = isPinExpired(s.pin_expires_at);
              return (
                <tr key={s.id} className={!s.active ? 'inactive' : ''}>
                  <td>
                    {editing ? (
                      <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                    ) : (
                      <strong>{s.name}</strong>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}>
                        <option value="cashier">Caissier</option>
                        <option value="manager">Manager</option>
                      </select>
                    ) : (
                      <span className={`pos-role-badge ${s.role}`}>
                        {s.role === 'manager' ? 'Manager' : 'Caissier'}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.pin_expires_at ? (
                      expired ? (
                        <span className="pos-expired"><FiAlertCircle size={12} /> Expiré</span>
                      ) : (
                        <span>{fmtDate(s.pin_expires_at)}</span>
                      )
                    ) : '—'}
                  </td>
                  <td>
                    {s.active ? (
                      <span className="pos-badge pos-badge-ok"><FiCheck size={11} /> Actif</span>
                    ) : (
                      <span className="pos-badge pos-badge-ko"><FiX size={11} /> Inactif</span>
                    )}
                  </td>
                  <td>
                    {editing ? (
                      <div className="pos-actions-row">
                        <button className="btn-icon" onClick={() => saveEdit(s.id)} title="Enregistrer"><FiSave size={14} /></button>
                        <button className="btn-icon" onClick={() => setEditingId(null)} title="Annuler"><FiX size={14} /></button>
                      </div>
                    ) : (
                      <div className="pos-actions-row">
                        <button className="btn-icon" onClick={() => startEdit(s)} title="Modifier"><FiEdit2 size={14} /></button>
                        <button className="btn-icon" onClick={() => setResetPinId(s.id)} title="Réinitialiser PIN"><FiKey size={14} /></button>
                        <button
                          className={`btn-icon ${s.active ? '' : 'active-toggle'}`}
                          onClick={() => toggleActive(s)}
                          title={s.active ? 'Désactiver' : 'Activer'}
                        >
                          {s.active ? <FiX size={14} /> : <FiCheck size={14} />}
                        </button>
                        <button className="btn-icon danger" onClick={() => handleDelete(s)} title="Supprimer"><FiTrash2 size={14} /></button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* PIN reset modal */}
      {resetPinId && (
        <div className="pos-modal-overlay" onClick={() => { setResetPinId(null); setNewPin(''); }}>
          <div className="pos-modal" onClick={(e) => e.stopPropagation()}>
            <h3><FiKey /> Réinitialiser le PIN</h3>
            <p>Entrez le nouveau PIN (4 à 6 chiffres)</p>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{4,6}"
              maxLength={6}
              autoFocus
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="Nouveau PIN"
            />
            <div className="pos-modal-actions">
              <button className="btn btn-outline" onClick={() => { setResetPinId(null); setNewPin(''); }}>Annuler</button>
              <button className="btn btn-primary" onClick={handleResetPin}><FiSave /> Enregistrer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════ */
/*  SESSIONS TAB                                          */
/* ══════════════════════════════════════════════════════ */

function SessionsTab() {
  const [sessions, setSessions] = useState([]);

  const load = useCallback(async () => {
    try {
      const res = await getPosSessions();
      setSessions(res.data || []);
    } catch {
      toast.error('Erreur chargement sessions');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="pos-tab-content">
      <div className="admin-card">
        <div className="admin-panel-header">
          <h3>Sessions POS actives ({sessions.length})</h3>
          <button className="btn btn-outline" onClick={load}><FiRefreshCw /> Rafraîchir</button>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Membre</th>
              <th>Rôle</th>
              <th>Token (masqué)</th>
              <th>Connexion</th>
              <th>Expire</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 && (
              <tr><td colSpan="5" className="pos-empty">Aucune session active</td></tr>
            )}
            {sessions.map((s) => (
              <tr key={s.token}>
                <td><strong>{s.name}</strong></td>
                <td>
                  <span className={`pos-role-badge ${s.role}`}>
                    {s.role === 'manager' ? 'Manager' : 'Caissier'}
                  </span>
                </td>
                <td><code>{s.token}</code></td>
                <td>{fmtDate(s.created_at)}</td>
                <td>{fmtDate(s.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
