import crypto from 'crypto';

// Middleware d'authentification admin partagé : cookie de session haché
// SHA-256 → lookup admin_users (session non expirée) → contrôle de rôle.
// Pour les routeurs montés HORS /api/admin (contrats, devis de contribution…)
// qui ne passent pas par la RBAC par chemin d'admin-routes.js.
// NB : ces modules sont volontairement exclus de la matrice de surcharges de
// permissions (cf. roles-config.js, MODULE_PATHS) — leurs rôles sont fixés ici.
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
    if (!allowedRoles.includes(admin.role || 'admin')) {
      return res.status(403).json({ error: 'Accès non autorisé pour votre profil' });
    }
    req.admin = admin;
    next();
  };
}
