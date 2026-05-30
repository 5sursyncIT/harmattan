#!/usr/bin/env node
/**
 * Réversion d'une fusion T3 — relit le journal JSON produit par
 * tiers-merge-duplicates.mjs --apply et annule TOUT :
 *   - réaffecte chaque rowid repointé à son tiers absorbé d'origine ;
 *   - restaure les champs enrichis du maître à leur valeur d'avant ;
 *   - réactive les absorbés (status=1) et retire la marque de fusion.
 *
 * Usage :
 *   node scripts/tiers-merge-revert.mjs <journal.json>            (dry-run)
 *   node scripts/tiers-merge-revert.mjs <journal.json> --apply
 */

import { readFileSync } from 'node:fs';
import { openMysql } from './tiers-hygiene-lib.mjs';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file || file.startsWith('--')) {
  console.error('Usage: node scripts/tiers-merge-revert.mjs <journal.json> [--apply]');
  process.exit(1);
}
const journal = JSON.parse(readFileSync(file, 'utf8'));
const pool = openMysql();

try {
  const clusters = journal.clusters.filter((c) => !c.rolledBack && c.archived?.length);
  console.log(`\nRéversion fusion ${journal.date} (clé=${journal.key}) · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Clusters à annuler : ${clusters.length}`);

  let repoint = 0, restored = 0, reactivated = 0;
  for (const c of clusters) {
    // movesByAbsorbed : table -> { absorbéId -> [rowids] } → réversion exacte.
    for (const [tbl, byAbs] of Object.entries(c.movesByAbsorbed || {})) {
      const pk = (journal.pk && journal.pk[tbl]) || 'rowid';
      for (const [abs, rids] of Object.entries(byAbs)) {
        if (!rids.length) continue;
        if (apply) {
          for (let i = 0; i < rids.length; i += 500) {
            const batch = rids.slice(i, i + 500);
            const ph = batch.map(() => '?').join(',');
            await pool.query(`UPDATE ${tbl} SET fk_soc=? WHERE ${pk} IN (${ph})`, [Number(abs), ...batch]);
          }
        }
        repoint += rids.length;
      }
    }

    // Restaurer les champs enrichis du maître
    if (c.enrich && Object.keys(c.enrich).length) {
      if (apply) {
        const sets = Object.keys(c.enrich).map((k) => `${k}=?`).join(', ');
        await pool.query(`UPDATE llx_societe SET ${sets} WHERE rowid=?`, [...Object.values(c.enrich), c.master]);
      }
      restored++;
    }

    // Réactiver les absorbés
    for (const a of c.archived) {
      if (apply) {
        await pool.query(
          `UPDATE llx_societe SET status=1,
             note_private = REPLACE(note_private, CONCAT('\n[FUSION ${journal.date}] absorbé dans tiers #', ?), '')
           WHERE rowid=?`, [c.master, a]
        );
      }
      reactivated++;
    }
  }

  console.log(`\n${apply ? '✓ Réversion appliquée' : 'DRY-RUN'} : ${repoint} lignes repointées, ${restored} maîtres restaurés, ${reactivated} absorbés réactivés.`);
  if (!apply) console.log('Relancer avec --apply pour exécuter.\n');
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
