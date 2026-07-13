#!/usr/bin/env node
/**
 * Rattrapage de l'invariant « un auteur est forcément un tiers ».
 *
 * Périmètre = auteurs SANS tiers Dolibarr (authors.dolibarr_thirdparty_id NULL)
 * ayant une VRAIE relation :
 *   - email réel (≠ auteur+…@senharmattan.local), OU
 *   - au moins un manuscrit soumis.
 * Les fiches de catalogue importées en masse (email factice, sans manuscrit)
 * sont volontairement EXCLUES pour ne pas repolluer Dolibarr (cf. dépollution
 * tiers 2026-05).
 *
 * Pour chaque auteur : déduplication (email/téléphone → réutilise un tiers actif
 * existant) sinon création via la clé admin, puis liaison. Logique 100 % partagée
 * avec le runtime (server/author-tier.js) — aucun code dupliqué.
 *
 * Sécurités : DRY-RUN par défaut (aucune écriture) ; journal réversible JSON en
 * cas d'--apply (liste des tiers créés + liaisons, pour rollback).
 *
 * Usage :
 *   node scripts/backfill-author-tiers.mjs            (dry-run, défaut)
 *   node scripts/backfill-author-tiers.mjs --apply
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { openMysql, openSqlite, TODAY } from './tiers-hygiene-lib.mjs';
import { ensureAuthorTier } from '../server/author-tier.js';

const apply = process.argv.includes('--apply');
const pool = openMysql();
const db = openSqlite(!apply); // écriture nécessaire seulement en --apply
const LOG = `/var/www/html/senharmattan-shop/backups/author-tiers-backfill-${TODAY}.json`;

const CANDIDATES_SQL = `
  SELECT a.id, a.firstname, a.lastname, a.display_name, a.email, a.phone
    FROM authors a
   WHERE a.dolibarr_thirdparty_id IS NULL
     AND (
       (a.email IS NOT NULL AND a.email <> '' AND a.email NOT LIKE '%@senharmattan.local')
       OR EXISTS (SELECT 1 FROM manuscripts m WHERE m.author_id = a.id)
     )
   ORDER BY a.id ASC`;

function label(a) {
  return `#${a.id} ${(a.display_name || `${a.firstname || ''} ${a.lastname || ''}`).trim()}`;
}

try {
  console.log(`\nRattrapage « auteur = tiers » · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const candidates = db.prepare(CANDIDATES_SQL).all();
  console.log(`Auteurs candidats (relation réelle, sans tiers) : ${candidates.length}\n`);

  const tally = { linked: 0, created: 0, skipped: 0, error: 0 };
  const created = []; // journal réversible

  for (const a of candidates) {
    const r = await ensureAuthorTier({ db, dolibarrPool: pool }, a.id, { dryRun: !apply });
    if (r.skipped === 'error') {
      tally.error++;
      console.log(`  ✗ ${label(a)} — ERREUR : ${r.error}`);
    } else if (r.skipped) {
      tally.skipped++;
      console.log(`  – ${label(a)} — ignoré (${r.skipped})`);
    } else if (r.created) {
      tally.created++;
      console.log(`  ${apply ? '✔' : '»'} ${label(a)} — ${apply ? `tiers CRÉÉ #${r.thirdpartyId}` : 'tiers À CRÉER'}`);
      if (apply) created.push({ authorId: a.id, label: label(a), thirdpartyId: r.thirdpartyId, action: 'created' });
    } else {
      tally.linked++;
      console.log(`  ${apply ? '✔' : '»'} ${label(a)} — ${apply ? 'LIÉ au tiers' : 'À LIER'} #${r.thirdpartyId} (dédup ${r.matchedBy})`);
      if (apply) created.push({ authorId: a.id, label: label(a), thirdpartyId: r.thirdpartyId, action: 'linked', matchedBy: r.matchedBy });
    }
  }

  console.log(`\nRésumé :`);
  console.log(`  Tiers créés   : ${tally.created}`);
  console.log(`  Auteurs liés (dédup) : ${tally.linked}`);
  console.log(`  Ignorés       : ${tally.skipped}`);
  console.log(`  Erreurs       : ${tally.error}`);

  if (!apply) {
    console.log('\nDRY-RUN : aucune écriture. Relancer avec --apply pour exécuter.\n');
  } else {
    writeFileSync(LOG, JSON.stringify({ date: TODAY, apply: true, tally, entries: created }, null, 2));
    console.log(`\nJournal réversible : ${LOG}`);
    console.log('Rollback : pour chaque entrée "created", remettre authors.dolibarr_thirdparty_id à NULL et archiver le tiers (status=0).\n');
  }
} catch (err) {
  console.error('\nÉchec du rattrapage :', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  db.close();
}
