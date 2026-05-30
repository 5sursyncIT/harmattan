#!/usr/bin/env node
/**
 * T2 — Archiver les tiers orphelins (llx_societe.status = 0).
 *
 * Un orphelin = aucune facture, commande, devis, contrat, achat fournisseur,
 * expédition, contact, projet, ni prix fournisseur (cf. ORPHAN_PREDICATE).
 *
 * On ARCHIVE (status=0, « mis en sommeil » dans Dolibarr), on ne SUPPRIME PAS :
 * réversible et sans perte. La suppression définitive éventuelle se fera après
 * une période de quarantaine, sur décision explicite.
 *
 * Sont EXCLUS : tiers liés côté app (customers/authors/consignors/suppliers),
 * ids protégés système, et tiers déjà inactifs.
 *
 * Sécurités : dry-run par défaut ; export CSV de sauvegarde complet (réversible) ;
 * écriture en transaction unique.
 *
 * Usage :
 *   node scripts/tiers-archive-orphans.mjs            (dry-run, défaut)
 *   node scripts/tiers-archive-orphans.mjs --apply
 */

import { writeFileSync } from 'node:fs';
import {
  openMysql, openSqlite, collectAppLinkedIds, toCsv, TODAY,
  ORPHAN_PREDICATE, PROTECTED_IDS,
} from './tiers-hygiene-lib.mjs';

const apply = process.argv.includes('--apply');
const pool = openMysql();
const sdb = openSqlite(true);
const appLinked = collectAppLinkedIds(sdb);
const BACKUP = `/tmp/tiers_T2_backup_${TODAY}.csv`;

try {
  console.log(`\nT2 — Archivage orphelins · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const [orph] = await pool.query(
    `SELECT s.rowid, s.nom, s.client, s.fournisseur, s.email, s.phone,
            DATE_FORMAT(s.datec,'%Y-%m-%d') datec, s.status
       FROM llx_societe s
      WHERE ${ORPHAN_PREDICATE} AND s.status = 1
      ORDER BY s.datec ASC`
  );
  const cibles = orph.filter((r) => !appLinked.has(r.rowid) && !PROTECTED_IDS.has(r.rowid));
  const protégés = orph.length - cibles.length;

  console.log(`Orphelins actifs détectés         : ${orph.length}`);
  console.log(`  dont protégés (app/système)     : ${protégés}`);
  console.log(`À archiver (status 1 → 0)         : ${cibles.length}`);

  writeFileSync(BACKUP, toCsv(cibles, ['rowid', 'nom', 'client', 'fournisseur', 'email', 'phone', 'datec', 'status']));
  console.log(`Sauvegarde (réversible)           : ${BACKUP}`);

  if (!apply) {
    console.log('\nDRY-RUN : aucune écriture. Relancer avec --apply pour exécuter.\n');
  } else if (cibles.length === 0) {
    console.log('\nRien à archiver.\n');
  } else {
    const ids = cibles.map((r) => r.rowid);
    let done = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        const ph = batch.map(() => '?').join(',');
        const [res] = await conn.query(
          `UPDATE llx_societe SET status = 0 WHERE rowid IN (${ph}) AND status = 1`, batch
        );
        done += res.affectedRows;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    console.log(`\n✓ APPLY terminé : ${done} tiers archivés (status=0).`);
    console.log(`Réversion : UPDATE llx_societe SET status=1 WHERE rowid IN (<ids du CSV ${BACKUP}>)\n`);
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  sdb.close();
}
