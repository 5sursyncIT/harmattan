import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  getAdminRoles,
  setRolePermissionOverride,
  clearRolePermissionOverride,
  clearAllRolePermissionOverrides,
} from '../../../api/admin';
import { FiCheckCircle, FiEdit2, FiEye, FiMinusCircle, FiUsers, FiLock, FiRotateCcw, FiX } from 'react-icons/fi';

const LEVEL_META = {
  crud: { label: 'CRUD', short: 'CRUD', desc: 'Lecture + création + modification + suppression', color: '#10531a', bg: '#d1fae5', Icon: FiCheckCircle },
  rw:   { label: 'L+E',  short: 'L+E',  desc: 'Lecture + modification (pas de suppression)',     color: '#0284c7', bg: '#dbeafe', Icon: FiEdit2 },
  r:    { label: 'Lecture', short: 'L', desc: 'Lecture seule',                                    color: '#6b7280', bg: '#f3f4f6', Icon: FiEye },
  '-':  { label: '—',    short: '—',    desc: 'Aucun accès',                                      color: '#9ca3af', bg: 'transparent', Icon: FiMinusCircle },
};

const EDIT_LEVELS = ['crud', 'rw', 'r', '-'];

export default function RolePermissionsMatrix() {
  const ctx = useOutletContext() || {};
  const isSuperAdmin = ctx.adminRole === 'super_admin';

  const [data, setData] = useState(null);
  const [overrides, setOverrides] = useState({}); // { role: { module: level } }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // { role, module }
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getAdminRoles()
      .then((res) => { setData(res.data); setOverrides(res.data.overrides || {}); })
      .catch((err) => setError(err.response?.data?.error || 'Erreur de chargement'))
      .finally(() => setLoading(false));
  }, []);

  const rolesList = useMemo(() => (data ? Object.entries(data.roles) : []), [data]);
  const moduleEntries = useMemo(() => (data ? Object.entries(data.moduleLabels) : []), [data]);
  const overridable = useMemo(() => new Set(data?.overridableModules || []), [data]);

  const overrideCount = useMemo(
    () => Object.values(overrides).reduce((n, mods) => n + Object.keys(mods || {}).length, 0),
    [overrides]
  );

  if (loading) return <div className="admin-card">Chargement de la matrice…</div>;
  if (error) return <div className="admin-card" style={{ color: '#dc2626' }}>{error}</div>;
  if (!data) return null;

  const baseLevel = (role, mod) => data.permissions?.[role]?.[mod] || '-';
  const overrideLevel = (role, mod) => overrides?.[role]?.[mod];
  const effectiveLevel = (role, mod) => {
    const ov = overrideLevel(role, mod);
    return ov !== undefined ? ov : baseLevel(role, mod);
  };

  const canEdit = (roleKey, role, mod) =>
    isSuperAdmin && roleKey !== 'super_admin' && !role.deprecated && overridable.has(mod);

  const applyLevel = async (roleKey, mod, level) => {
    const base = baseLevel(roleKey, mod);
    setBusy(true);
    try {
      // Choisir la valeur de base = restaurer (supprime la surcharge).
      if (level === base) {
        const res = await clearRolePermissionOverride(roleKey, mod);
        setOverrides(res.data.overrides || {});
        toast.success('Permission restaurée à sa valeur de base');
      } else {
        const res = await setRolePermissionOverride(roleKey, mod, level);
        setOverrides(res.data.overrides || {});
        toast.success('Permission mise à jour');
      }
      setEditing(null);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action impossible');
    } finally {
      setBusy(false);
    }
  };

  const resetCell = async (roleKey, mod) => {
    setBusy(true);
    try {
      const res = await clearRolePermissionOverride(roleKey, mod);
      setOverrides(res.data.overrides || {});
      setEditing(null);
      toast.success('Permission restaurée');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action impossible');
    } finally {
      setBusy(false);
    }
  };

  const resetAll = async () => {
    if (!window.confirm(`Restaurer toutes les permissions (${overrideCount} surcharge(s)) à leur valeur de base ?`)) return;
    setBusy(true);
    try {
      await clearAllRolePermissionOverrides();
      setOverrides({});
      setEditing(null);
      toast.success('Toutes les surcharges ont été restaurées');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Action impossible');
    } finally {
      setBusy(false);
    }
  };

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

        {/* Légende */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12, fontSize: 12, color: '#374151' }}>
          {Object.entries(LEVEL_META).map(([k, m]) => (
            <span key={k} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px',
              borderRadius: 12, background: m.bg, color: m.color, fontWeight: 600,
            }}>
              <m.Icon size={13} /> {m.label} — {m.desc}
            </span>
          ))}
        </div>

        {/* Bandeau super-admin */}
        {isSuperAdmin ? (
          <div style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14,
            padding: '10px 14px', borderRadius: 10,
            background: overrideCount > 0 ? '#fffbeb' : '#f0fdf4',
            border: `1px solid ${overrideCount > 0 ? '#fde68a' : '#bbf7d0'}`,
          }}>
            <FiEdit2 size={15} style={{ color: overrideCount > 0 ? '#b45309' : '#10531a' }} />
            <span style={{ fontSize: 13, color: '#374151' }}>
              {overrideCount > 0
                ? <><strong>{overrideCount} surcharge(s) temporaire(s) active(s).</strong> Cliquez sur une cellule modifiable pour ajuster un accès. Les cellules surchargées sont entourées.</>
                : <>Cliquez sur une cellule (rôle × module) pour <strong>élargir ou restreindre</strong> temporairement un accès.</>}
            </span>
            {overrideCount > 0 && (
              <button
                type="button"
                onClick={resetAll}
                disabled={busy}
                style={{
                  marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 8, border: '1px solid #d1d5db',
                  background: '#fff', color: '#b91c1c', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                }}
              >
                <FiRotateCcw size={13} /> Tout restaurer
              </button>
            )}
          </div>
        ) : (
          <p style={{ marginTop: 0, marginBottom: 14, fontSize: 12, color: '#6b7280' }}>
            Les permissions temporaires sont modifiables uniquement par le super-administrateur.
          </p>
        )}

        <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #e5e7eb' }}>
          <table className="admin-table" style={{ minWidth: 'auto', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: '#f9fafb', zIndex: 2, minWidth: 200 }}>Module</th>
                {rolesList.map(([key, role]) => (
                  <th key={key} title={role.description} style={{ textAlign: 'center', minWidth: 96 }}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 4, background: `${role.color}15`,
                      color: role.color, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
                    }}>{role.label}</span>
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
                  {rolesList.map(([roleKey, role]) => {
                    const level = effectiveLevel(roleKey, modKey);
                    const meta = LEVEL_META[level] || LEVEL_META['-'];
                    const isOv = overrideLevel(roleKey, modKey) !== undefined;
                    const editable = canEdit(roleKey, role, modKey);
                    const isEditing = editing && editing.role === roleKey && editing.module === modKey;
                    const lockedForSuper = isSuperAdmin && roleKey !== 'super_admin' && !role.deprecated && !overridable.has(modKey);
                    return (
                      <td key={roleKey} style={{ textAlign: 'center', position: 'relative' }}
                          title={isOv ? `${modLabel} • ${meta.desc} (surcharge — base : ${LEVEL_META[baseLevel(roleKey, modKey)].label})` : `${modLabel} • ${meta.desc}`}>
                        <button
                          type="button"
                          onClick={editable ? () => setEditing(isEditing ? null : { role: roleKey, module: modKey }) : undefined}
                          disabled={!editable}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                            padding: '2px 8px', borderRadius: 6, background: meta.bg, color: meta.color,
                            fontSize: 11, fontWeight: 700, minWidth: 52,
                            border: isOv ? '2px solid #f59e0b' : '2px solid transparent',
                            cursor: editable ? 'pointer' : 'default',
                            outline: editable ? undefined : 'none',
                          }}
                        >
                          <meta.Icon size={11} /> {meta.short}
                          {lockedForSuper && <FiLock size={9} style={{ marginLeft: 2, opacity: 0.5 }} />}
                        </button>

                        {isEditing && (
                          <div style={{
                            position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                            zIndex: 20, marginTop: 4, background: '#fff', border: '1px solid #e5e7eb',
                            borderRadius: 10, boxShadow: '0 12px 30px rgba(0,0,0,0.15)', padding: 6, minWidth: 170,
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 6px 6px' }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>{role.label} · {modLabel}</span>
                              <button type="button" onClick={() => setEditing(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#9ca3af' }}><FiX size={13} /></button>
                            </div>
                            {EDIT_LEVELS.map((lv) => {
                              const m = LEVEL_META[lv];
                              const active = level === lv;
                              const isBase = baseLevel(roleKey, modKey) === lv;
                              return (
                                <button
                                  key={lv}
                                  type="button"
                                  disabled={busy}
                                  onClick={() => applyLevel(roleKey, modKey, lv)}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                                    padding: '7px 8px', border: 'none', borderRadius: 6, cursor: 'pointer',
                                    background: active ? m.bg : 'transparent', color: m.color,
                                    fontSize: 12, fontWeight: 600, textAlign: 'left',
                                  }}
                                >
                                  <m.Icon size={13} /> {m.label}
                                  {isBase && <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>base</span>}
                                </button>
                              );
                            })}
                            {isOv && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => resetCell(roleKey, modKey)}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', marginTop: 4,
                                  padding: '7px 8px', borderTop: '1px solid #f3f4f6', border: 'none', borderRadius: 6,
                                  cursor: 'pointer', background: 'transparent', color: '#b91c1c', fontSize: 12, fontWeight: 600,
                                }}
                              >
                                <FiRotateCcw size={13} /> Restaurer la base
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
          {isSuperAdmin
            ? <>Chaque permission est <strong>activable / désactivable</strong> par cellule (rôle × module), à la manière de Dolibarr. Les surcharges sont <strong>immédiates</strong> et <strong>manuelles</strong> (aucune expiration auto) : restaurez chaque cellule ou utilisez « Tout restaurer ». La restriction comme l'octroi sont appliqués côté serveur. <FiLock size={10} /> = « Mon profil » (espace personnel, toujours accessible). À noter : le module « Point de vente » pilote l'administration POS et l'affichage du menu ; la connexion caissier au terminal reste par code PIN.</>
            : <>Cette matrice est informative. La restriction effective est appliquée côté serveur par <code>roles-config.js</code> et les surcharges du super-administrateur.</>}
        </p>
      </div>
    </div>
  );
}
