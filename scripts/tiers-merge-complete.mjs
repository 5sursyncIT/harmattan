#!/usr/bin/env node
/**
 * Complément de fusion T3 — repointe les tables d'historique OUBLIÉES par un run
 * précédent (ex. llx_actioncomm dont la PK est `id` et non `rowid`).
 *
 * Relit le journal d'une fusion, reconstruit la table absorbé→maître, détecte la
 * vraie clé primaire de chaque table (rowid OU id), repointe les références
 * restantes vers le maître, et ENRICHIT le journal (movesByAbsorbed + pk) pour
 * que la réversion reste exacte.
 *
 * Usage :
 *   node scripts/tiers-merge-complete.mjs <journal.json>            (dry-run)
 *   node scripts/tiers-merge-complete.mjs <journal.json> --apply
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { openMysql } from './tiers-hygiene-lib.mjs';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file || file.startsWith('--')) {
  console.error('Usage: node scripts/tiers-merge-complete.mjs <journal.json> [--apply]');
  process.exit(1);
}
const journal = JSON.parse(readFileSync(file, 'utf8'));
const pool = openMysql();

// Tables d'historique/relation à repointer (mêmes que la fusion).
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

try {
  // absorbé -> maître + index cluster
  const absToMaster = new Map();
  const clusterByMaster = new Map();
  journal.clusters.forEach((c, idx) => {
    if (c.rolledBack) return;
    clusterByMaster.set(c.master, c);
    for (const a of (c.archived || c.absorbed || [])) absToMaster.set(a, c.master);
  });
  const absorbed = [...absToMaster.keys()];
  if (!absorbed.length) { console.log('Aucun absorbé dans le journal.'); process.exit(0); }

  console.log(`\nComplément fusion ${journal.date} · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Absorbés : ${absorbed.length}`);

  journal.pk = journal.pk || {};
  const ph = absorbed.map(() => '?').join(',');
  let totalFixed = 0;

  for (const tbl of REPOINT_TABLES) {
    // Détecte la PK (rowid prioritaire, sinon id).
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

    let rows;
    try {
      [rows] = await pool.query(`SELECT ${pk} AS pk, fk_soc FROM ${tbl} WHERE fk_soc IN (${ph})`, absorbed);
    } catch { continue; }
    if (!rows.length) continue;

    console.log(`  ${tbl} (pk=${pk}) : ${rows.length} ligne(s) à repointer`);
    journal.pk[tbl] = pk;

    // Groupe par absorbé
    const byAbs = new Map();
    for (const r of rows) { if (!byAbs.has(r.fk_soc)) byAbs.set(r.fk_soc, []); byAbs.get(r.fk_soc).push(r.pk); }

    for (const [abs, pks] of byAbs) {
      const master = absToMaster.get(abs);
      if (apply) {
        for (let i = 0; i < pks.length; i += 500) {
          const batch = pks.slice(i, i + 500);
          const inPh = batch.map(() => '?').join(',');
          await pool.query(`UPDATE ${tbl} SET fk_soc=? WHERE ${pk} IN (${inPh})`, [master, ...batch]);
        }
        // Enrichit le journal du cluster correspondant (réversion exacte).
        const entry = clusterByMaster.get(master);
        if (entry) {
          entry.movesByAbsorbed = entry.movesByAbsorbed || {};
          entry.movesByAbsorbed[tbl] = entry.movesByAbsorbed[tbl] || {};
          entry.movesByAbsorbed[tbl][abs] = (entry.movesByAbsorbed[tbl][abs] || []).concat(pks);
          entry.moves = entry.moves || {};
          entry.moves[tbl] = (typeof entry.moves[tbl] === 'number' ? entry.moves[tbl] : 0) + pks.length;
        }
      }
      totalFixed += pks.length;
    }
  }

  if (apply && totalFixed) {
    writeFileSync(file, JSON.stringify(journal, null, 2));
    console.log(`\n✓ ${totalFixed} ligne(s) repointée(s). Journal mis à jour : ${file}`);
  } else if (!apply) {
    console.log(`\nDRY-RUN : ${totalFixed} ligne(s) seraient repointées. Relancer avec --apply.\n`);
  } else {
    console.log('\nRien à compléter.\n');
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
