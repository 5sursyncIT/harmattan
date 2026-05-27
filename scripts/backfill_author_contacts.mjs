#!/usr/bin/env node
/**
 * Rapprochement emails + téléphones des auteurs avec Dolibarr.
 *
 * Beaucoup d'auteurs en base ont des emails placeholder du type
 * `auteur+slug@senharmattan.local` générés à l'import. Ce script cherche les
 * vrais email/phone dans Dolibarr et propose la mise à jour.
 *
 * Sources scannées, par ordre de priorité :
 *  1. llx_societe.email / phone via authors.dolibarr_thirdparty_id (direct)
 *  2. llx_socpeople (contacts liés au tiers) — premier contact avec email valide
 *  3. Match par nom (firstname + lastname normalisés) contre llx_societe.nom
 *     si pas de dolibarr_thirdparty_id
 *
 * Sécurités :
 *  - Mode --dry-run par défaut : aucune écriture, juste un rapport
 *  - --apply : exécute les UPDATE
 *  - Détecte les conflits d'unicité email avant d'appliquer
 *  - Skip les emails invalides (regex)
 *  - Skip si l'email existant est déjà valide (ne touche pas aux email_verified=1
 *    et aux emails ne se terminant pas par @senharmattan.local sauf --force)
 *
 * Usage :
 *   node scripts/backfill_author_contacts.mjs --dry-run
 *   node scripts/backfill_author_contacts.mjs --apply
 *   node scripts/backfill_author_contacts.mjs --apply --force
 *   node scripts/backfill_author_contacts.mjs --report     (CSV uniquement)
 */

import 'dotenv/config';
import Db from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const reportOnly = process.argv.includes('--report');
if (!apply && !dryRun && !reportOnly) {
  console.error('Usage: node scripts/backfill_author_contacts.mjs --dry-run | --apply [--force] | --report');
  process.exit(1);
}

const SQLITE_PATH = '/var/www/html/senharmattan-shop/newsletter.sqlite';
const PLACEHOLDER_DOMAIN = '@senharmattan.local';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CSV_OUT = `/tmp/author_contacts_report_${new Date().toISOString().slice(0, 10)}.csv`;

const db = new Db(SQLITE_PATH, { readonly: !apply });
const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 4,
});

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\s,;\-_]+/g, ' ')
    .trim();
}
function validEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s) && !s.endsWith(PLACEHOLDER_DOMAIN);
}
// Tolérante : extrait un email même tronqué (ex: "djibanafa@yahoofr" sans le ".")
// et tente de le réparer pour des domaines connus (yahoofr → yahoo.fr).
const EMAIL_EXTRACT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const EMAIL_LIKELY_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+)([A-Za-z0-9.-]*)/;
const COMMON_TLD_FIXES = [
  [/^yahoofr$/i, 'yahoo.fr'], [/^yahoocom$/i, 'yahoo.com'],
  [/^gmailco$/i, 'gmail.com'], [/^gmailcom$/i, 'gmail.com'],
  [/^hotmailcom$/i, 'hotmail.com'], [/^hotmailfr$/i, 'hotmail.fr'],
  [/^outlookcom$/i, 'outlook.com'], [/^outlookfr$/i, 'outlook.fr'],
];
function extractEmail(text) {
  if (!text) return null;
  // 1. Pattern standard "x@y.z"
  const m1 = String(text).match(EMAIL_EXTRACT_RE);
  if (m1 && validEmail(m1[0])) return m1[0].toLowerCase();
  // 2. Pattern incomplet "x@yahoofr" → tente une réparation TLD
  const m2 = String(text).match(EMAIL_LIKELY_RE);
  if (m2) {
    const local = m2[1];
    const domainBlob = (m2[2] + (m2[3] || '')).toLowerCase();
    for (const [pat, fix] of COMMON_TLD_FIXES) {
      if (pat.test(domainBlob)) {
        const repaired = `${local.toLowerCase()}@${fix}`;
        if (validEmail(repaired)) return repaired;
      }
    }
  }
  return null;
}
function cleanPhone(s) {
  if (!s) return null;
  let trimmed = String(s).replace(/\s+/g, ' ').trim();
  // Si le champ contient un email mal placé, retire-le pour ne pas le remettre en phone
  if (EMAIL_EXTRACT_RE.test(trimmed) || EMAIL_LIKELY_RE.test(trimmed)) {
    trimmed = trimmed.replace(EMAIL_LIKELY_RE, '').trim();
  }
  if (trimmed.length < 6) return null;
  // Vérifie qu'il reste au moins 5 chiffres
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return trimmed;
}

// ─── 1. Cibles : auteurs avec email placeholder (ou tous si --force) ───
const targets = db.prepare(
  force
    ? `SELECT id, email, firstname, lastname, phone, dolibarr_thirdparty_id FROM authors ORDER BY id ASC`
    : `SELECT id, email, firstname, lastname, phone, dolibarr_thirdparty_id
       FROM authors
       WHERE email IS NULL OR email LIKE '%${PLACEHOLDER_DOMAIN}'
       ORDER BY id ASC`
).all();

console.log(`\nMode : ${apply ? 'APPLY (écritures)' : dryRun ? 'DRY-RUN (simulation)' : 'REPORT (CSV uniquement)'}`);
console.log(`Cibles : ${targets.length} auteur(s) à examiner${force ? ' (--force : inclut tous les auteurs)' : ''}\n`);

// ─── 2. Pour chaque cible, chercher dans Dolibarr ───
const matches = [];
let countSocietePrimary = 0;
let countContactFallback = 0;
let countNameMatch = 0;
let countNoMatch = 0;

for (const author of targets) {
  let foundEmail = null;
  let foundPhone = null;
  let source = null;
  let socId = author.dolibarr_thirdparty_id;

  // (a) Tiers direct via dolibarr_thirdparty_id
  if (socId) {
    const [rows] = await pool.query(
      `SELECT rowid, email, phone, COALESCE(phone_mobile, '') AS phone_mobile,
              address, name_alias
       FROM llx_societe WHERE rowid = ?`, [socId]
    );
    const soc = rows[0];
    if (soc) {
      if (validEmail(soc.email)) { foundEmail = soc.email; source = 'societe'; }
      // Email mal placé dans phone/address/name_alias ?
      if (!foundEmail) {
        const fromPhone   = extractEmail(soc.phone);
        const fromAddr    = extractEmail(soc.address);
        const fromAlias   = extractEmail(soc.name_alias);
        if (fromPhone)   { foundEmail = fromPhone; source = 'societe-phone-misplaced'; }
        else if (fromAddr) { foundEmail = fromAddr; source = 'societe-address-misplaced'; }
        else if (fromAlias) { foundEmail = fromAlias; source = 'societe-alias-misplaced'; }
      }
      foundPhone = cleanPhone(soc.phone) || cleanPhone(soc.phone_mobile);
    }
  }

  // (b) Contact lié au tiers (llx_socpeople) si pas d'email trouvé
  if (!foundEmail && socId) {
    const [rows] = await pool.query(
      `SELECT email, phone_pro, phone_mobile FROM llx_socpeople
       WHERE fk_soc = ? AND statut = 1 ORDER BY priv ASC, rowid ASC`, [socId]
    );
    for (const c of rows) {
      if (validEmail(c.email)) {
        foundEmail = c.email;
        if (!foundPhone) foundPhone = cleanPhone(c.phone_pro) || cleanPhone(c.phone_mobile);
        source = 'socpeople';
        break;
      }
    }
  }

  // (c) Match par nom si toujours pas d'email (uniquement si auteur sans tiers Dolibarr)
  if (!foundEmail && !socId && author.firstname && author.lastname) {
    const fn = norm(author.firstname);
    const ln = norm(author.lastname);
    const variants = new Set([
      `${fn} ${ln}`,            // "prénom nom"
      `${ln} ${fn}`,            // "nom prénom" (très courant en SN)
      `${ln} ${fn[0]}.`,        // "nom p."
      `${fn[0]}. ${ln}`,        // "p. nom"
    ].filter(v => v.trim().length > 2));

    // Étape 1 : essais d'égalité stricte sur les variantes
    // (on ne filtre PLUS sur email NOT NULL — un email peut être mal placé dans phone/address)
    let candidates = [];
    for (const v of variants) {
      const [rows] = await pool.query(
        `SELECT rowid, nom, email, phone, phone_mobile, address, name_alias
         FROM llx_societe WHERE LOWER(nom) = ?`,
        [v]
      );
      candidates = candidates.concat(rows);
    }
    // Déduplique par rowid
    const seen = new Set();
    candidates = candidates.filter(r => seen.has(r.rowid) ? false : seen.add(r.rowid));

    // Étape 2 : si rien d'égal, tente word-set match (tolérant ordre des mots)
    if (candidates.length === 0) {
      const wantWords = new Set(`${fn} ${ln}`.split(' ').filter(w => w.length > 1));
      if (wantWords.size >= 2) {
        const [rows] = await pool.query(
          `SELECT rowid, nom, email, phone, phone_mobile, address, name_alias
           FROM llx_societe
           WHERE LOWER(nom) LIKE ? AND LOWER(nom) LIKE ?
           LIMIT 30`,
          [`%${ln}%`, `%${fn}%`]
        );
        for (const r of rows) {
          const gotWords = new Set(norm(r.nom).split(' ').filter(w => w.length > 1));
          const allWanted = [...wantWords].every(w => gotWords.has(w));
          if (allWanted && gotWords.size <= wantWords.size + 2) {
            candidates.push(r);
          }
        }
      }
    }

    // Pour chaque candidat, calculer un email effectif (email column OU fallback phone/address/alias)
    const enriched = candidates.map(c => {
      let mail = validEmail(c.email) ? c.email : null;
      let src = 'name-match';
      if (!mail) {
        const fromPhone = extractEmail(c.phone);
        const fromAddr  = extractEmail(c.address);
        const fromAlias = extractEmail(c.name_alias);
        if (fromPhone)   { mail = fromPhone; src = 'name-match+phone-misplaced'; }
        else if (fromAddr) { mail = fromAddr; src = 'name-match+address-misplaced'; }
        else if (fromAlias) { mail = fromAlias; src = 'name-match+alias-misplaced'; }
      }
      return { ...c, _email: mail, _source: src };
    }).filter(c => c._email); // on ne garde que les candidats avec un email récupérable

    if (enriched.length === 1) {
      foundEmail = enriched[0]._email;
      foundPhone = cleanPhone(enriched[0].phone) || cleanPhone(enriched[0].phone_mobile);
      socId = enriched[0].rowid;
      source = enriched[0]._source;
    } else if (enriched.length > 1) {
      source = `name-ambiguous(${enriched.length})`;
    }

    // Étape 3 : fallback "lastname uniquement" — STRICT
    // Garde uniquement si :
    //   - lastname ≥ 4 chars (évite les noms trop communs courts)
    //   - tiers Dolibarr s'appelle EXACTEMENT comme le lastname (pas "Prénom Seck")
    //     ou contient le prénom de l'auteur
    if (!foundEmail && ln && ln.length >= 4) {
      const [rows] = await pool.query(
        `SELECT rowid, nom, email, phone, phone_mobile, address, name_alias
         FROM llx_societe WHERE LOWER(nom) LIKE ?
         LIMIT 10`,
        [`%${ln}%`]
      );
      const strict = rows.filter(r => {
        const tierWords = new Set(norm(r.nom).split(' ').filter(w => w.length > 1));
        if (!tierWords.has(ln)) return false;
        // OK si tiers n'a que le lastname (1 mot)
        if (tierWords.size === 1) return true;
        // OK si tiers contient AUSSI le prénom de l'auteur
        if (fn && tierWords.has(fn)) return true;
        // Sinon : risque de confusion (tiers = "Autre Prénom Seck")
        return false;
      });
      const enrichedLn = strict.map(c => {
        let mail = validEmail(c.email) ? c.email : null;
        let src = 'lastname-strict';
        if (!mail) {
          const fp = extractEmail(c.phone), fa = extractEmail(c.address), fal = extractEmail(c.name_alias);
          if (fp)       { mail = fp;  src = 'lastname-strict+phone-misplaced'; }
          else if (fa)  { mail = fa;  src = 'lastname-strict+address-misplaced'; }
          else if (fal) { mail = fal; src = 'lastname-strict+alias-misplaced'; }
        }
        return { ...c, _email: mail, _source: src };
      }).filter(c => {
        if (!c._email) return false;
        // Anti-faux-positif : l'email local-part doit contenir au moins le lastname OU
        // au moins 3 premières lettres du prénom (cas où le tiers Dolibarr s'appelle
        // juste "Diouf" mais l'email réel est de quelqu'un d'autre du même nom)
        const localPart = c._email.split('@')[0].toLowerCase()
          .normalize('NFD').replace(/\p{Diacritic}/gu, '');
        const lnNorm = ln.replace(/\s/g, '');
        const fnFirst3 = (fn || '').replace(/\s/g, '').slice(0, 3);
        if (localPart.includes(lnNorm)) return true;
        if (fnFirst3.length >= 3 && localPart.includes(fnFirst3)) return true;
        return false;
      });

      if (enrichedLn.length === 1) {
        foundEmail = enrichedLn[0]._email;
        foundPhone = cleanPhone(enrichedLn[0].phone) || cleanPhone(enrichedLn[0].phone_mobile);
        socId = enrichedLn[0].rowid;
        source = enrichedLn[0]._source;
      } else if (enrichedLn.length > 1) {
        source = `lastname-ambiguous(${enrichedLn.length})`;
      }
    }
  }

  if (foundEmail || foundPhone) {
    matches.push({
      id: author.id, firstname: author.firstname, lastname: author.lastname,
      oldEmail: author.email, newEmail: foundEmail,
      oldPhone: author.phone || '', newPhone: foundPhone || '',
      source, socId: socId || '',
    });
    if (source?.startsWith('societe')) countSocietePrimary++;
    else if (source === 'socpeople') countContactFallback++;
    else if (source?.startsWith('name-match') || source?.startsWith('lastname-strict')) countNameMatch++;
  } else {
    countNoMatch++;
  }
}

// ─── 3. Détecter conflits d'unicité email avant apply ───
const conflicts = [];
const seenNew = new Map();
const allEmailsInDb = new Set(
  db.prepare(`SELECT email FROM authors WHERE email IS NOT NULL`).all().map(r => r.email.toLowerCase())
);
for (const m of matches) {
  if (!m.newEmail) continue;
  const lower = m.newEmail.toLowerCase();
  // Conflit si une autre row a déjà cet email (et c'est un autre auteur)
  const existing = db.prepare(`SELECT id FROM authors WHERE LOWER(email) = ? AND id != ?`).get(lower, m.id);
  if (existing) {
    conflicts.push({ ...m, conflict: `email déjà attribué à author #${existing.id}` });
    m.newEmail = null; // skip
    continue;
  }
  // Conflit si plusieurs auteurs distincts reçoivent le même nouvel email
  if (seenNew.has(lower) && seenNew.get(lower) !== m.id) {
    conflicts.push({ ...m, conflict: `2 auteurs cibles partagent ce nouvel email` });
    m.newEmail = null;
    continue;
  }
  seenNew.set(lower, m.id);
}

// ─── 4. Récap console + CSV ───
const willUpdate = matches.filter(m => m.newEmail || m.newPhone);
console.log(`\n─── Résultat du scan ───`);
console.log(`  Match via societe (direct)      : ${countSocietePrimary}`);
console.log(`  Match via socpeople (contact)   : ${countContactFallback}`);
console.log(`  Match par nom (name-match)      : ${countNameMatch}`);
console.log(`  Aucun match                     : ${countNoMatch}`);
console.log(`  Conflits écartés                : ${conflicts.length}`);
console.log(`  À mettre à jour                 : ${willUpdate.length}\n`);

// CSV pour audit
const csv = [
  ['author_id', 'firstname', 'lastname', 'old_email', 'new_email', 'old_phone', 'new_phone', 'source', 'societe_id'].join(','),
  ...matches.map(m => [
    m.id, csvEscape(m.firstname), csvEscape(m.lastname),
    csvEscape(m.oldEmail), csvEscape(m.newEmail || ''),
    csvEscape(m.oldPhone), csvEscape(m.newPhone),
    csvEscape(m.source || ''), m.socId,
  ].join(',')),
  ...(conflicts.length ? [
    '',
    '# Conflits écartés',
    'author_id,firstname,lastname,proposed_email,reason',
    ...conflicts.map(c => [
      c.id, csvEscape(c.firstname), csvEscape(c.lastname),
      csvEscape(c.oldEmail + ' → ' + c.newEmail), csvEscape(c.conflict),
    ].join(',')),
  ] : []),
].join('\n');
writeFileSync(CSV_OUT, csv);
console.log(`Rapport CSV : ${CSV_OUT}\n`);

if (reportOnly) {
  await pool.end();
  process.exit(0);
}

// ─── 5. Appliquer (si --apply) ───
if (apply) {
  const linkSoc = db.prepare('UPDATE authors SET dolibarr_thirdparty_id = ? WHERE id = ? AND (dolibarr_thirdparty_id IS NULL OR dolibarr_thirdparty_id = 0)');
  const updateEmail = db.prepare('UPDATE authors SET email = ?, email_verified = 0 WHERE id = ?');
  const updatePhone = db.prepare('UPDATE authors SET phone = ? WHERE id = ?');
  const updateBoth  = db.prepare('UPDATE authors SET email = ?, phone = ?, email_verified = 0 WHERE id = ?');
  const txn = db.transaction(() => {
    let nE = 0, nP = 0, nL = 0;
    for (const m of willUpdate) {
      if (m.socId) {
        const r = linkSoc.run(m.socId, m.id);
        if (r.changes > 0) nL++;
      }
      if (m.newEmail && m.newPhone && m.newPhone !== m.oldPhone) {
        updateBoth.run(m.newEmail, m.newPhone, m.id);
        nE++; nP++;
      } else if (m.newEmail) {
        updateEmail.run(m.newEmail, m.id);
        nE++;
      } else if (m.newPhone && m.newPhone !== m.oldPhone) {
        updatePhone.run(m.newPhone, m.id);
        nP++;
      }
    }
    return { nE, nP, nL };
  });
  const { nE, nP, nL } = txn();
  console.log(`✓ Appliqué : ${nE} email(s), ${nP} téléphone(s), ${nL} lien(s) dolibarr_thirdparty_id`);
  console.log(`  (email_verified remis à 0 — les auteurs devront re-valider via réinit MDP)\n`);
} else {
  console.log('Mode dry-run — aucune écriture. Relance avec --apply pour exécuter.\n');
  if (willUpdate.length > 0) {
    console.log('Aperçu des 5 premiers changements :');
    for (const m of willUpdate.slice(0, 5)) {
      console.log(`  #${m.id} ${m.firstname} ${m.lastname}`);
      if (m.newEmail) console.log(`     email : ${m.oldEmail} → ${m.newEmail}  (source: ${m.source})`);
      if (m.newPhone && m.newPhone !== m.oldPhone) console.log(`     phone : ${m.oldPhone || '(vide)'} → ${m.newPhone}`);
    }
  }
}

await pool.end();
process.exit(0);

function csvEscape(s) {
  const v = String(s ?? '');
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
