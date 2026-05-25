import { useEffect, useMemo, useState } from 'react';
import { getAdminRoles } from '../../../api/admin';
import { FiCheckCircle, FiEdit2, FiEye, FiMinusCircle, FiUsers } from 'react-icons/fi';

const LEVEL_META = {
  crud: { label: 'CRUD', short: 'CRUD', desc: 'Lecture + création + modification + suppression', color: '#10531a', bg: '#d1fae5', Icon: FiCheckCircle },
  rw:   { label: 'L+E',  short: 'L+E',  desc: 'Lecture + modification (pas de suppression)',     color: '#0284c7', bg: '#dbeafe', Icon: FiEdit2 },
  r:    { label: 'Lecture', short: 'L', desc: 'Lecture seule',                                    color: '#6b7280', bg: '#f3f4f6', Icon: FiEye },
  '-':  { label: '—',    short: '—',    desc: 'Aucun accès',                                      color: '#9ca3af', bg: 'transparent', Icon: FiMinusCircle },
};

export default function RolePermissionsMatrix() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getAdminRoles()
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  }, []);

  const rolesList = useMemo(() => (data ? Object.entries(data.roles) : []), [data]);
  const moduleEntries = useMemo(() => (data ? Object.entries(data.moduleLabels) : []), [data]);

  if (loading) return <div className="admin-card">Chargement de la matrice…</div>;
  if (error) return <div className="admin-card" style={{ color: '#dc2626' }}>{error}</div>;
  if (!data) return null;

  return (
    <div className="admin-panel">
      <div className="admin-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
          <FiUsers size={20} style={{ color: '#10531a' }} />
          <h3 style={{ margin: 0 }}>Matrice des permissions par rôle</h3>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
            Source : <code>server/roles-config.js</code>
          </span>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16, fontSize: 12, color: '#374151' }}>
          {Object.entries(LEVEL_META).map(([k, m]) => (
            <span key={k} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
              borderRadius: 12, background: m.bg, color: m.color, fontWeight: 600,
            }}>
              <m.Icon size={13} /> {m.label} — {m.desc}
            </span>
          ))}
        </div>

        <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <table className="admin-table" style={{ minWidth: 'auto', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: '#f9fafb', zIndex: 1, minWidth: 200 }}>Module</th>
                {rolesList.map(([key, role]) => (
                  <th key={key} title={role.description} style={{ textAlign: 'center', minWidth: 92 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4, background: `${role.color}15`,
                        color: role.color, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                      }}>{role.label}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {moduleEntries.map(([modKey, modLabel]) => (
                <tr key={modKey}>
                  <td style={{ position: 'sticky', left: 0, background: '#fff', fontWeight: 600, zIndex: 1 }}>
                    {modLabel}
                  </td>
                  {rolesList.map(([roleKey]) => {
                    const level = data.permissions?.[roleKey]?.[modKey] || '-';
                    const meta = LEVEL_META[level] || LEVEL_META['-'];
                    return (
                      <td key={roleKey} style={{ textAlign: 'center' }} title={`${modLabel} • ${meta.desc}`}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                          padding: '2px 8px', borderRadius: 6, background: meta.bg, color: meta.color,
                          fontSize: 11, fontWeight: 700, minWidth: 50,
                        }}>
                          <meta.Icon size={11} /> {meta.short}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
          Cette matrice est purement informative. La restriction effective est appliquée côté serveur par la whitelist <code>ROLE_ALLOWED_PATHS</code> dans <code>roles-config.js</code>.
        </p>
      </div>
    </div>
  );
}
