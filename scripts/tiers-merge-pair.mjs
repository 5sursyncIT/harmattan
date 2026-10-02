#!/usr/bin/env node
/**
 * Fusion CIBLÉE de deux tiers (llx_societe) désignés à la main.
 *
 * Complète tiers-merge-duplicates.mjs (qui ne regroupe que par email/téléphone) :
 * ici l'opérateur désigne explicitement le MAÎTRE et l'ABSORBÉ (ex. doublon créé
 * sous le nom complet alors que le tiers historique porte le patronyme + alias).
 *
 * - Repointe fk_soc de TOUTES les tables Dolibarr qui ont cette colonne
 *   (découverte dynamique), sauf tables descriptives du tiers.
 * - Repointe llx_bank_url (type='company') et les liens app SQLite
 *   (authors.dolibarr_thirdparty_id, customers.dolibarr_id, consignors.fk_soc).
 * - Enrichit le maître des champs vides (jamais d'email factice @*.local).
 * - Archive l'absorbé (status=0 + note [FUSION]).
 * - Journal JSON réversible. Dry-run par défaut.
 *
 * Usage :
 *   node scripts/tiers-merge-pair.mjs --master=110 --absorbed=2479          (dry-run)
 *   node scripts/tiers-merge-pair.mjs --master=110 --absorbed=2479 --apply
 */

import { writeFileSync } from 'node:fs';
import { openMysql, openSqlite, TODAY } from './tiers-hygiene-lib.mjs';

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1];
const apply = process.argv.includes('--apply');
const master = parseInt(arg('master'), 10);
const absorbed = parseInt(arg('absorbed'), 10);
if (!master || !absorbed || master === absorbed) {
  console.error('Usage : --master=<rowid> --absorbed=<rowid> [--apply]');
  process.exit(1);
}

// Tables descriptives du tiers : restent attachées à l'absorbé archivé.
const SKIP_TABLES = new Set([
  'llx_societe', 'llx_societe_rib', 'llx_societe_remise', 'llx_societe_commerciaux',
  'llx_categorie_societe', 'llx_societe_perentity', 'llx_societe_prices',
]);
const APP_LINKS = [
  ['authors', 'dolibarr_thirdparty_id'],
  ['customers', 'dolibarr_id'],
  ['consignors', 'fk_soc'],
];
const LOG = `/var/www/html/senharmattan-shop/backups/tiers-hygiene/tiers_merge_pair_${master}_${absorbed}_${TODAY}.json`;

const pool = openMysql();
const sdb = openSqlite(!apply);

try {
  const [soc] = await pool.query(
    `SELECT rowid, nom, name_alias, email, phone, address, zip, town, client, fournisseur,
            code_client, code_fournisseur, code_compta, status
       FROM llx_societe WHERE rowid IN (?, ?)`, [master, absorbed]);
  const M = soc.find((s) => s.rowid === master);
  const A = soc.find((s) => s.rowid === absorbed);
  if (!M || !A) throw new Error('tiers introuvable');
  if (A.status === 0) throw new Error(`absorbé #${absorbed} déjà archivé`);

  console.log(`\nFusion ciblée · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  MAÎTRE  #${M.rowid} "${M.nom}" alias="${M.name_alias || ''}" ${M.code_client || ''} email=${M.email || '—'} tél=${M.phone || '—'}`);
  console.log(`  ABSORBÉ #${A.rowid} "${A.nom}" alias="${A.name_alias || ''}" ${A.code_client || ''} email=${A.email || '—'} tél=${A.phone || '—'}`);

  // ── Tables Dolibarr avec fk_soc ─────────────────────────────
  const [cols] = await pool.query(
    `SELECT c.TABLE_NAME t,
            (SELECT k.COLUMN_NAME FROM information_schema.COLUMNS k
              WHERE k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME
                AND k.COLUMN_NAME IN ('rowid','id') ORDER BY k.COLUMN_NAME DESC LIMIT 1) pk
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA=c.TABLE_SCHEMA AND tb.TABLE_NAME=c.TABLE_NAME AND tb.TABLE_TYPE='BASE TABLE'
      WHERE c.TABLE_SCHEMA=? AND c.COLUMN_NAME='fk_soc' AND c.TABLE_NAME LIKE 'llx\\_%'`,
    [process.env.MYSQL_DATABASE]);

  const moves = {};
  for (const { t, pk } of cols) {
    if (SKIP_TABLES.has(t)) continue;
    const [rows] = await pool.query(`SELECT ${pk ? pk : 'NULL'} AS pk FROM ${t} WHERE fk_soc=?`, [absorbed]);
    if (!rows.length) continue;
    if (!pk) console.log(`  ⚠ ${t} : ${rows.length} ligne(s) sans PK — repointées en bloc`);
    moves[t] = { pk, ids: rows.map((r) => r.pk) };
  }
  const [bankUrl] = await pool.query(`SELECT rowid FROM llx_bank_url WHERE type='company' AND url_id=?`, [absorbed]);
  const skipped = (await Promise.all([...SKIP_TABLES].filter((t) => t !== 'llx_societe').map(async (t) => {
    try { const [r] = await pool.query(`SELECT COUNT(*) c FROM ${t} WHERE fk_soc=?`, [absorbed]); return r[0].c ? `${t}=${r[0].c}` : null; } catch { return null; }
  }))).filter(Boolean);

  console.log('\nHistorique Dolibarr à repointer :');
  for (const [t, m] of Object.entries(moves)) console.log(`  ${t.padEnd(34)} ${m.ids.length}`);
  console.log(`  ${'llx_bank_url (company)'.padEnd(34)} ${bankUrl.length}`);
  if (skipped.length) console.log(`  (non repointé, descriptif : ${skipped.join(', ')})`);

  // Écritures comptables portant le code tiers de l'absorbé (information)
  try {
    const [bk] = await pool.query(`SELECT COUNT(*) c FROM llx_accounting_bookkeeping WHERE thirdparty_code=?`, [A.code_client || '#none']);
    if (bk[0].c) console.log(`  ⚠ llx_accounting_bookkeeping : ${bk[0].c} écriture(s) avec thirdparty_code=${A.code_client} (non modifiées)`);
  } catch { /* ignore */ }

  // ── Liens app SQLite ────────────────────────────────────────
  const appMoves = {};
  console.log('\nLiens application (SQLite) :');
  for (const [tbl, col] of APP_LINKS) {
    try {
      const rows = sdb.prepare(`SELECT id FROM ${tbl} WHERE CAST(${col} AS INTEGER)=?`).all(absorbed);
      const onMaster = sdb.prepare(`SELECT id FROM ${tbl} WHERE CAST(${col} AS INTEGER)=?`).all(master);
      console.log(`  ${tbl}.${col} → absorbé: [${rows.map((r) => r.id).join(', ')}]  maître: [${onMaster.map((r) => r.id).join(', ')}]`);
      if (rows.length) appMoves[`${tbl}.${col}`] = rows.map((r) => r.id);
    } catch { /* table absente */ }
  }

  // ── Enrichissement ──────────────────────────────────────────
  const fill = {};
  for (const f of ['email', 'phone', 'address', 'zip', 'town']) {
    if (M[f] || !A[f]) continue;
    if (f === 'email' && /\.local$/i.test(A[f])) continue;
    fill[f] = A[f];
  }
  if (!M.name_alias && A.nom) fill.name_alias = A.nom;
  if (A.client && (M.client & A.client) !== A.client) fill.client = M.client | A.client;
  console.log(`\nEnrichissement maître : ${Object.keys(fill).length ? JSON.stringify(fill) : 'aucun'}`);

  if (!apply) {
    console.log('\nDRY-RUN : aucune écriture. Relancer avec --apply.\n');
  } else {
    const journal = { date: TODAY, master, absorbed, before: { master: M, absorbed: A }, moves: {}, bank_url: [], enrich: fill, app: appMoves };
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const [t, { pk, ids }] of Object.entries(moves)) {
        if (pk) await conn.query(`UPDATE ${t} SET fk_soc=? WHERE ${pk} IN (?)`, [master, ids]);
        else await conn.query(`UPDATE ${t} SET fk_soc=? WHERE fk_soc=?`, [master, absorbed]);
        journal.moves[t] = { pk, ids };
      }
      if (bankUrl.length) {
        const ids = bankUrl.map((r) => r.rowid);
        await conn.query(`UPDATE llx_bank_url SET url_id=? WHERE rowid IN (?)`, [master, ids]);
        journal.bank_url = ids;
      }
      if (Object.keys(fill).length) {
        await conn.query(`UPDATE llx_societe SET ${Object.keys(fill).map((k) => `${k}=?`).join(', ')} WHERE rowid=?`, [...Object.values(fill), master]);
      }
      await conn.query(
        `UPDATE llx_societe SET status=0, note_private=CONCAT(COALESCE(note_private,''), ?) WHERE rowid=?`,
        [`\n[FUSION ${TODAY}] absorbé dans tiers #${master}`, absorbed]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    // SQLite après commit MySQL (journalisé pour réversion)
    for (const [key, ids] of Object.entries(appMoves)) {
      const [tbl, col] = key.split('.');
      sdb.prepare(`UPDATE ${tbl} SET ${col}=? WHERE id IN (${ids.map(() => '?').join(',')})`).run(master, ...ids);
    }
    writeFileSync(LOG, JSON.stringify(journal, null, 2));
    console.log(`\n✓ Fusion appliquée. Journal de réversion : ${LOG}\n`);
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  sdb.close();
}
