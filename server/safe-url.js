/**
 * Valide une URL http(s) utilisateur — bloque javascript:, data:, etc.
 * Une saisie sans schéma (« www.site.com », « site.com/page ») est normalisée en
 * https:// plutôt que rejetée : sinon un lien saisi sans « https:// » disparaît
 * silencieusement de la page, sans que personne comprenne pourquoi.
 * @param {unknown} raw
 * @param {{ allowHttp?: boolean }} [opts]
 * @returns {string|null} href normalisé ou null
 */
export function safeHttpUrl(raw, opts = {}) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.length > 2048) return null;

  // Un schéma explicite est conservé tel quel : c'est ce qui permet de rejeter
  // javascript: / data: plus bas, au lieu de les préfixer par https://.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme
    ? trimmed
    : `https:${trimmed.startsWith('//') ? '' : '//'}${trimmed}`;

  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:' && !(opts.allowHttp && u.protocol === 'http:')) return null;
    // Sans schéma d'origine, on exige un domaine plausible : « bonjour » donnerait
    // sinon https://bonjour, un lien mort présenté comme valide.
    if (!hasScheme && !/\.[a-z]{2,}$/i.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}
