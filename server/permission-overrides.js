// ─── Surcharges de permissions par rôle — STORE PARTAGÉ ──────────────────────
// Source unique de vérité (table SQLite + cache mémoire) pour les surcharges de
// permissions que le super-admin pose à chaud depuis la matrice. Avant, le cache
// vivait dans la closure de setupAdminRoutes() et n'était donc visible que par les
// routes /api/admin. Ce store est désormais créé une seule fois dans index.js et
// injecté à TOUS les routeurs concernés (admin, contrats…) pour que la même
// surcharge s'applique partout, même hors /api/admin.
//
// Modèle : { [role]: { [module]: level } } avec level ∈ {'crud','rw','r','-'}.
// Une surcharge prime TOUJOURS sur la config de base (roles-config.js) : elle peut
// élargir OU restreindre. Manuel uniquement (pas d'expiration auto).
import crypto from 'crypto';
import { moduleForPath, methodAllowedForLevel } from './roles-config.js';

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createOverridesStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS role_permission_overrides (
    role TEXT NOT NULL,
    module TEXT NOT NULL,
    level TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (role, module)
  )`);

  // Cache mémoire : rechargé au démarrage et après chaque écriture (rare).
  let cache = {};
  function reload() {
    const rows = db.prepare('SELECT role, module, level FROM role_permission_overrides').all();
    const map = {};
    for (const r of rows) {
      (map[r.role] || (map[r.role] = {}))[r.module] = r.level;
    }
    cache = map;
  }
  reload();

  const get = (role, module) => cache[role]?.[module];
  const forRole = (role) => cache[role] || {};
  const all = () => cache;

  function set(role, module, level, by) {
    db.prepare(`INSERT INTO role_permission_overrides (role, module, level, created_by, created_at)
                VALUES (?, ?, ?, ?, datetime('now'))
                ON CONFLICT(role, module) DO UPDATE SET
                  level = excluded.level, created_by = excluded.created_by, created_at = datetime('now')`)
      .run(role, module, level, by || null);
    reload();
  }

  function clear(role, module) {
    db.prepare('DELETE FROM role_permission_overrides WHERE role = ? AND module = ?').run(role, module);
    reload();
  }

  function clearAll() {
    db.prepare('DELETE FROM role_permission_overrides').run();
    reload();
  }

  // Résout le rôle admin porté par le cookie de session (ou null). Utilisé par le
  // gate pour les routeurs montés HORS /api/admin (ex. /api/contracts), qui ne
  // passent pas par la RBAC par chemin d'admin-routes.js.
  function roleFromRequest(req) {
    const session = req.cookies?.admin_session;
    if (!session) return null;
    const row = db.prepare(
      "SELECT role FROM admin_users WHERE session_token = ? AND (session_expires_at IS NULL OR session_expires_at > datetime('now'))"
    ).get(hashSessionToken(session));
    return row?.role || null;
  }

  // Middleware « gate » à monter sur un routeur hors /api/admin. Il N'AUTHENTIFIE
  // pas (l'auth par-route reste responsable) : il se contente d'arbitrer une
  // surcharge éventuelle pour le module du chemin courant.
  //  - pas de session / super_admin / pas de module / pas de surcharge → next()
  //    (comportement de base inchangé) ;
  //  - surcharge qui autorise la méthode → pose req.rbacGranted = true (l'auth
  //    par-route doit l'honorer même si le rôle n'est pas dans sa liste) ;
  //  - surcharge qui refuse la méthode → 403.
  function gate(req, res, next) {
    const role = roleFromRequest(req);
    if (!role || role === 'super_admin') return next();
    const path = req.originalUrl.split('?')[0];
    const mod = moduleForPath(path);
    if (!mod) return next();
    const level = cache[role]?.[mod];
    if (level === undefined) return next();
    if (methodAllowedForLevel(level, req.method)) {
      req.rbacGranted = true;
      return next();
    }
    return res.status(403).json({ error: 'Accès non autorisé (permission en vigueur)' });
  }

  return { reload, get, forRole, all, set, clear, clearAll, roleFromRequest, gate };
}
