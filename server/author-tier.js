/**
 * Invariant « un auteur est forcément un tiers ».
 *
 * Un tiers peut être un auteur, mais tout auteur ayant une VRAIE relation
 * (auto-inscription avec email réel, soumission de manuscrit, contrat, devis)
 * doit posséder une fiche tiers Dolibarr (llx_societe), liée via
 * `authors.dolibarr_thirdparty_id`.
 *
 * On NE crée PAS de tiers pour les auteurs de catalogue importés en masse
 * (email factice `@senharmattan.local` et sans manuscrit) : cela repollue
 * Dolibarr (cf. dépollution tiers 2026-05, 1493 faux fournisseurs nettoyés).
 * Le garde-fou « relation réelle » ci-dessous centralise cette règle.
 *
 * Création via la clé ADMIN (la clé régulière renvoie 403 sur POST
 * /thirdparties) et déduplication systématique (email/téléphone) pour éviter
 * les doublons. Idempotent : un auteur déjà lié n'est jamais retouché.
 */
import { adminApi } from './dolibarr-admin-client.js';
import { findExistingTier } from './tier-dedup.js';

const FAKE_EMAIL_DOMAIN = '@senharmattan.local';

export function hasRealEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return !!e && e.includes('@') && !e.endsWith(FAKE_EMAIL_DOMAIN);
}

function fullName(author) {
  const n = [author.firstname, author.lastname].map((s) => String(s || '').trim()).filter(Boolean).join(' ').trim();
  return n || String(author.display_name || '').trim() || (hasRealEmail(author.email) ? String(author.email).trim() : '');
}

/**
 * Garantit qu'un auteur possède une fiche tiers Dolibarr.
 *
 * @param {{db: import('better-sqlite3').Database, dolibarrPool: any}} deps
 * @param {number} authorId
 * @param {object} [opts]
 * @param {boolean} [opts.force]        Ignore le garde-fou « relation réelle » (ex. contrat/POS : la relation est certaine).
 * @param {boolean} [opts.dryRun]       Simule (lecture seule) : dédup seulement, aucune écriture.
 * @param {boolean} [opts.throwOnError] Propage l'erreur au lieu de la journaliser (chemin critique : contrat).
 * @param {number}  [opts.client]       Type de tiers Dolibarr (défaut 1 = client).
 * @returns {Promise<{authorId:number, thirdpartyId?:number, created?:boolean, matchedBy?:string, alreadyLinked?:boolean, skipped?:string, dryRun?:boolean, error?:string}>}
 */
export async function ensureAuthorTier({ db, dolibarrPool }, authorId, opts = {}) {
  const { force = false, dryRun = false, throwOnError = false, client = 1 } = opts;
  const base = { authorId, dryRun };
  try {
    const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(authorId);
    if (!author) return { ...base, skipped: 'author-not-found' };
    if (author.dolibarr_thirdparty_id) {
      return { ...base, thirdpartyId: author.dolibarr_thirdparty_id, created: false, alreadyLinked: true };
    }

    // Garde-fou « relation réelle » : email réel OU au moins un manuscrit.
    // Sans ça, on ne touche pas les fiches catalogue importées (email factice,
    // aucun manuscrit) — elles ne doivent PAS devenir des tiers.
    const emailReal = hasRealEmail(author.email);
    const hasManuscript = !!db.prepare('SELECT 1 FROM manuscripts WHERE author_id = ? LIMIT 1').get(authorId);
    if (!force && !emailReal && !hasManuscript) {
      return { ...base, skipped: 'no-real-relationship' };
    }

    const name = fullName(author);
    if (!name) return { ...base, skipped: 'no-name' };

    // Dédup : réutiliser un tiers ACTIF existant (même email / téléphone) plutôt
    // que d'en créer un doublon. Jamais de rapprochement par le nom.
    const existing = await findExistingTier(dolibarrPool, { email: author.email, phone: author.phone });
    if (existing) {
      if (!dryRun) db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ?').run(existing.id, authorId);
      return { ...base, thirdpartyId: existing.id, created: false, matchedBy: existing.matchedBy };
    }

    if (dryRun) return { ...base, thirdpartyId: null, created: true };

    // Écriture sensible → clé admin (DOLIBARR_ADMIN_API_KEY). code_client:-1 =
    // référence auto-générée. Email factice non transmis (on préfère vide).
    const res = await adminApi.post('/thirdparties', {
      name,
      email: emailReal ? String(author.email).trim() : '',
      phone: author.phone || '',
      client,
      code_client: -1,
    });
    const thirdpartyId = res.data;
    db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ?').run(thirdpartyId, authorId);
    return { ...base, thirdpartyId, created: true };
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    if (throwOnError) throw new Error(`ensureAuthorTier(#${authorId}): ${detail}`);
    console.error(`[AUTHOR-TIER] échec pour auteur #${authorId}:`, detail);
    return { ...base, skipped: 'error', error: detail };
  }
}
