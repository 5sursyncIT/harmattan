#!/usr/bin/env node
/**
 * Fusion de tiers par IDs EXPLICITES — confirmation humaine.
 *
 * Pour les vrais doublons qu'aucune clé fiable (email/téléphone) ne peut
 * rapprocher — typiquement des organisations homonymes sans contact (ex. 3FPT).
 * ⚠️ NE JAMAIS utiliser pour fusionner des homonymes patronymiques (NDiaye,
 * Diop…) qui sont des personnes distinctes : ici c'est l'humain qui désigne
 * les rowids, donc la responsabilité du rapprochement lui revient.
 *
 * Repointe tout l'historique des absorbés vers le maître (mêmes tables que la
 * fusion auto, PK rowid OU id), enrichit le maître, archive les absorbés
 * (status=0). Journal JSON compatible avec tiers-merge-revert.mjs.
 *
 * Usage :
 *   node scripts/tiers-merge-ids.mjs --master=1095 --absorbed=1954            (dry-run)
 *   node scripts/tiers-merge-ids.mjs --master=1095 --absorbed=1954,1960 --apply
 */

import { writeFileSync } from 'node:fs';
import { openMysql, openSqlite, collectAppLinkedIds, PROTECTED_IDS, TODAY } from './tiers-hygiene-lib.mjs';

const apply = process.argv.includes('--apply');
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : null; };
const master = parseInt(arg('master'), 10);
const absorbed = String(arg('absorbed') || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);

if (!master || absorbed.length === 0 || absorbed.includes(master)) {
  console.error('Usage: node scripts/tiers-merge-ids.mjs --master=ID --absorbed=ID1,ID2 [--apply]');
  process.exit(1);
}

const REPOINT_TABLES = [
  'llx_facture', 'llx_facture_rec', 'llx_facture_fourn', 'llx_facture_fourn_rec',
  'llx_commande', 'llx_commande_fournisseur', 'llx_propal', 'llx_supplier_proposal',
  'llx_contrat', 'llx_expedition', 'llx_delivery', 'llx_reception',
  'llx_fichinter', 'llx_fichinter_rec', 'llx_deplacement', 'llx_don', 'llx_mrp_mo',
  'llx_actioncomm', 'llx_projet', 'llx_ticket', 'llx_partnership',
  'llx_socpeople', 'llx_societe_contacts',
  'llx_product_customer_price', 'llx_product_customer_price_log',
  'llx_product_fournisseur_price', 'llx_product_thirdparty',
  'llx_prelevement_lignes', 'llx_societe_account', 'llx_adherent',
  'llx_eventorganization_conferenceorboothattendee', 'llx_recruitment_recruitmentjobposition',
  'llx_oauth_token', 'llx_notify', 'llx_notify_def', 'llx_user',
];

const pool = openMysql();
const sdb = openSqlite(true);
const appLinked = collectAppLinkedIds(sdb);

try {
  const ids = [master, ...absorbed];
  const ph = ids.map(() => '?').join(',');
  const [rows] = await pool.query(
    `SELECT rowid, nom, email, phone, address, zip, town, name_alias, status FROM llx_societe WHERE rowid IN (${ph})`, ids
  );
  const byId = new Map(rows.map((r) => [r.rowid, r]));
  if (!byId.has(master)) { console.error(`Maître #${master} introuvable.`); process.exit(1); }

  // Garde-fou : ne pas archiver un absorbé référencé côté app/protégé.
  for (const a of absorbed) {
    if (!byId.has(a)) { console.error(`Absorbé #${a} introuvable.`); process.exit(1); }
    if (appLinked.has(a) || PROTECTED_IDS.has(a)) {
      console.error(`⛔ #${a} est lié à l'app / protégé — désignez-le comme MAÎTRE plutôt que de l'archiver.`);
      process.exit(1);
    }
  }

  console.log(`\nFusion par IDs · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`MAÎTRE  #${master} "${byId.get(master).nom}"`);
  for (const a of absorbed) console.log(`absorbe #${a} "${byId.get(a).nom}"`);

  // Détecte PK + lignes à repointer
  const journal = { date: TODAY, key: 'manual', pk: {}, clusters: [{ master, absorbed, movesByAbsorbed: {}, moves: {}, enrich: {}, archived: [] }] };
  const entry = journal.clusters[0];
  const aph = absorbed.map(() => '?').join(',');
  let totalRows = 0;

  const movesByTable = {};
  for (const tbl of REPOINT_TABLES) {
    let pk = null;
    try {
      const [cols] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME IN ('rowid','id')`,
        [process.env.MYSQL_DATABASE, tbl]
      );
      const names = cols.map((c) => c.COLUMN_NAME);
      pk = names.includes('rowid') ? 'rowid' : (names.includes('id') ? 'id' : null);
    } catch { continue; }
    if (!pk) continue;
    let r;
    try { [r] = await pool.query(`SELECT ${pk} AS pk, fk_soc FROM ${tbl} WHERE fk_soc IN (${aph})`, absorbed); } catch { continue; }
    if (!r.length) continue;
    journal.pk[tbl] = pk;
    const byAbs = {};
    for (const row of r) { (byAbs[row.fk_soc] = byAbs[row.fk_soc] || []).push(row.pk); }
    movesByTable[tbl] = { pk, byAbs };
    const n = r.length; totalRows += n;
    console.log(`  ${tbl} (pk=${pk}) : ${n}`);
  }
  console.log(`Total lignes à repointer : ${totalRows}`);

  if (!apply) { console.log('\nDRY-RUN : aucune écriture. Ajouter --apply pour exécuter.\n'); }
  else {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Enrichissement maître (champs vides)
      const mt = byId.get(master);
      const fill = {};
      for (const f of ['email', 'phone', 'name_alias', 'address', 'zip', 'town']) {
        if (!mt[f]) { const donor = absorbed.map((a) => byId.get(a)).find((x) => x[f]); if (donor) { fill[f] = donor[f]; entry.enrich[f] = mt[f] || null; } }
      }
      if (Object.keys(fill).length) {
        await conn.query(`UPDATE llx_societe SET ${Object.keys(fill).map((k) => `${k}=?`).join(', ')} WHERE rowid=?`, [...Object.values(fill), master]);
      }
      // Repointage
      for (const [tbl, { pk, byAbs }] of Object.entries(movesByTable)) {
        for (const [abs, pks] of Object.entries(byAbs)) {
          for (let i = 0; i < pks.length; i += 500) {
            const batch = pks.slice(i, i + 500);
            await conn.query(`UPDATE ${tbl} SET fk_soc=? WHERE ${pk} IN (${batch.map(() => '?').join(',')})`, [master, ...batch]);
          }
          entry.movesByAbsorbed[tbl] = entry.movesByAbsorbed[tbl] || {};
          entry.movesByAbsorbed[tbl][abs] = pks;
          entry.moves[tbl] = (entry.moves[tbl] || 0) + pks.length;
        }
      }
      // Archivage
      for (const a of absorbed) {
        await conn.query(
          `UPDATE llx_societe SET status=0, note_private=CONCAT(COALESCE(note_private,''), ?) WHERE rowid=?`,
          [`\n[FUSION ${TODAY}] absorbé dans tiers #${master}`, a]
        );
        entry.archived.push(a);
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    const LOG = `/var/www/html/senharmattan-shop/backups/tiers-hygiene/tiers_mergeids_${master}_${TODAY}.json`;
    writeFileSync(LOG, JSON.stringify(journal, null, 2));
    console.log(`\n✓ Fusion appliquée. Journal de réversion : ${LOG}`);
    console.log(`Réversion : node scripts/tiers-merge-revert.mjs ${LOG} --apply\n`);
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  sdb.close();
}
