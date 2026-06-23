import crypto from 'crypto';

// Middleware d'authentification admin partagé : cookie de session haché
// SHA-256 → lookup admin_users (session non expirée) → contrôle de rôle.
// Pour les routeurs montés HORS /api/admin (contrats, devis de contribution…)
// qui ne passent pas par la RBAC par chemin d'admin-routes.js.
// NB : si une surcharge de permission du super-admin a déjà accordé l'accès en
// amont (gate du store partagé → req.rbacGranted = true), le contrôle de rôle de
// base est court-circuité : la matrice « comme Dolibarr » peut ainsi ouvrir un
// module (ex. contrats) à un rôle qui ne l'a pas par défaut. Le gate refuse déjà
// (403) les rôles dont la surcharge restreint l'accès.
export function makeAdminAuth(db, allowedRoles) {
  return function adminAuth(req, res, next) {
    const session = req.cookies?.admin_session;
    if (!session) return res.status(401).json({ error: 'Non authentifié' });
    // Le token brut du cookie est haché avant lookup — la base stocke sha256(token).
    const tokenHash = crypto.createHash('sha256').update(String(session)).digest('hex');
    const admin = db.prepare(
      "SELECT * FROM admin_users WHERE session_token = ? AND (session_expires_at IS NULL OR session_expires_at > datetime('now'))"
    ).get(tokenHash);
    if (!admin) return res.status(401).json({ error: 'Session invalide' });
    if (!req.rbacGranted && !allowedRoles.includes(admin.role || 'admin')) {
      return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
    }
    req.admin = admin;
    next();
  };
}
