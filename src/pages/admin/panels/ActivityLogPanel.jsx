import { useState, useEffect } from 'react';
import { getActivityLog } from '../../../api/admin';
import { FiClock, FiUser, FiActivity } from 'react-icons/fi';

const ACTION_LABELS = {
  login: 'Connexion',
  create_admin: 'Création admin',
  delete_admin: 'Suppression admin',
  reply_message: 'Réponse message',
  update_config: 'Modification config',
};

export default function ActivityLogPanel() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getActivityLog(100)
      .then((res) => setLogs(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Chargement...</p>;

  return (
    <div className="admin-panel">
      <div className="admin-panel-header">
        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiActivity /> Journal d'activité</h3>
        <span style={{ color: '#888', fontSize: '0.85rem' }}>{logs.length} entrées</span>
      </div>

      <div className="admin-card">
        {logs.length === 0 ? (
          <div className="admin-empty"><FiClock size={48} /><p>Aucune activité enregistrée</p></div>
        ) : (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            {logs.map((log) => (
              <div key={log.id} style={{ display: 'flex', gap: 12, padding: '12px 16px', borderBottom: '1px solid #f3f4f6', alignItems: 'flex-start' }}>
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#f0faf2', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <FiUser size={14} style={{ color: '#10531a' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '0.9rem' }}>{log.admin_username}</strong>
                    <span style={{ fontSize: '0.8rem', color: '#888' }}>
                      {new Date(log.created_at).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.85rem', color: '#555', marginTop: 2 }}>
                    <span style={{ display: 'inline-block', padding: '2px 8px', background: '#e0f2fe', color: '#0284c7', borderRadius: 4, fontSize: '0.75rem', fontWeight: 700, marginRight: 6 }}>
                      {ACTION_LABELS[log.action] || log.action}
                    </span>
                    {log.details}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
