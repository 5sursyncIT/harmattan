/**
 * Déduplication des tiers à la création — prévention de la repollution.
 *
 * Avant de créer un nouveau tiers Dolibarr (POS, auteur de contrat, compte web…),
 * on cherche un tiers ACTIF existant par identité fiable :
 *   1. email normalisé (exact) — clé la plus sûre ;
 *   2. téléphone normalisé (chiffres, comparaison sur les 9 derniers pour
 *      absorber le préfixe +221 / le 0 initial).
 *
 * ⚠️ JAMAIS de rapprochement par le nom (patronymes communs = personnes
 * distinctes — cf. dépollution tiers 2026-05).
 *
 * Lecture seule. Retourne { id, name, email, phone, matchedBy } ou null.
 */

export function normalizeEmail(e) {
  return String(e || '').trim().toLowerCase();
}

export function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '');
}

// fk_typent du « Particulier » dans Dolibarr (llx_c_typent.code = TE_PRIVATE).
export const TYPENT_PARTICULIER = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validation d'identité minimale à la création d'un tiers :
 *   - nom obligatoire (≥2) ;
 *   - prénom obligatoire (≥2) pour un PARTICULIER (pas pour une entreprise) ;
 *   - au moins un identifiant : téléphone OU email (formats vérifiés si fournis).
 * Retourne un message d'erreur (string) ou null si valide.
 */
export function validateTierIdentity({ name, firstname, email, phone, isCompany } = {}) {
  const nom = String(name || '').trim();
  const prenom = String(firstname || '').trim();
  const mail = String(email || '').trim();
  const tel = String(phone || '').trim();
  if (nom.length < 2) return 'Nom requis (2 caractères min.)';
  if (!isCompany && prenom.length < 2) return 'Prénom requis (2 caractères min.)';
  if (!mail && !tel) return 'Téléphone ou email requis';
  if (mail && !EMAIL_RE.test(mail)) return 'Email invalide';
  if (tel && normalizePhone(tel).length < 6) return 'Téléphone invalide';
  return null;
}

// Nom stocké côté Dolibarr : « Prénom NOM » pour un particulier, sinon le nom seul.
export function buildTierName({ name, firstname, isCompany } = {}) {
  const nom = String(name || '').trim();
  const prenom = String(firstname || '').trim();
  return (!isCompany && prenom) ? `${prenom} ${nom}`.trim() : nom;
}

// ── Rapprochement par NOM COMPLET — SUGGESTION seulement ─────────────────────
// Le nom n'est jamais une clé d'identité fiable (homonymes fréquents), donc on
// ne s'en sert JAMAIS pour relier/fusionner automatiquement : il sert à MONTRER
// à un humain « ce tiers existe peut-être déjà » avant une création, et à
// alimenter l'écran des doublons à vérifier.
//
// Identité nominale = ENSEMBLE des mots de `nom` + `name_alias`, sans accents ni
// ponctuation, ordre indifférent : « SIBY » + alias « CHEIKH MOUHAMADOU BAMBA »
// ≡ « Cheikh Mouhamadou Bamba Siby » ≡ « SIBY (Cheikh Mouhamadou Bamba) ».
// Au moins 2 mots exigés (un patronyme seul ne suffit pas).
const NAME_STOPWORDS = new Set(['dr', 'pr', 'mr', 'mme', 'mlle', 'me', 'soeur', 'pere', 'abbe']);

export function nameTokens(...parts) {
  const words = parts.join(' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2 && !NAME_STOPWORDS.has(w));
  return [...new Set(words)].sort();
}

export function nameKey(...parts) {
  const t = nameTokens(...parts);
  return t.length >= 2 ? t.join(' ') : null;
}

/**
 * Tiers ACTIFS dont le nom complet (nom + nom alternatif) a exactement les
 * mêmes mots que `name`. Lecture seule. Retourne [] si le nom a < 2 mots.
 */
export async function findSimilarTiers(pool, { name, excludeIds = [], limit = 5 } = {}) {
  if (!pool) return [];
  const tokens = nameTokens(name);
  if (tokens.length < 2) return [];
  const key = tokens.join(' ');
  // Pré-filtre SQL sur le mot le plus long, puis égalité exacte des ensembles en JS.
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
  const pat = `%${longest}%`;
  const [rows] = await pool.query(
    `SELECT s.rowid AS id, s.nom AS name, s.name_alias, s.code_client, s.email, s.phone, s.town,
            s.datec AS created_at,
            (SELECT COUNT(*) FROM llx_facture f WHERE f.fk_soc = s.rowid) AS invoice_count
       FROM llx_societe s
      WHERE s.status = 1 AND (s.nom LIKE ? OR s.name_alias LIKE ?)
      LIMIT 200`,
    [pat, pat],
  );
  const excl = new Set(excludeIds.map(Number));
  return rows
    .filter((r) => !excl.has(r.id) && (nameKey(r.name, r.name_alias || '') === key || nameKey(r.name) === key))
    .sort((a, b) => b.invoice_count - a.invoice_count || a.id - b.id)
    .slice(0, limit);
}

export async function findExistingTier(pool, { email, phone } = {}) {
  if (!pool) return null;

  // 1) Email exact (normalisé)
  const e = normalizeEmail(email);
  if (e) {
    const [rows] = await pool.query(
      `SELECT rowid AS id, nom AS name, email, phone
         FROM llx_societe
        WHERE status = 1 AND email <> '' AND LOWER(TRIM(email)) = ?
        ORDER BY rowid ASC LIMIT 1`,
      [e],
    );
    if (rows.length) return { ...rows[0], matchedBy: 'email' };
  }

  // 2) Téléphone (chiffres uniquement, match sur les 9 derniers)
  const digits = normalizePhone(phone);
  if (digits.length >= 8) {
    const suffix = digits.slice(-9);
    const [rows] = await pool.query(
      `SELECT rowid AS id, nom AS name, email, phone
         FROM llx_societe
        WHERE status = 1 AND phone <> ''
          AND REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'+',''),'-',''),'.',''),'(',''),')','') LIKE CONCAT('%', ?)
        ORDER BY rowid ASC LIMIT 5`,
      [suffix],
    );
    for (const r of rows) {
      const rd = normalizePhone(r.phone);
      if (rd === digits || rd.slice(-9) === suffix) return { ...r, matchedBy: 'phone' };
    }
  }

  return null;
}
