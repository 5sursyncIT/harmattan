#!/usr/bin/env node
/**
 * T1 — Réparer le flag `fournisseur` pollué (llx_societe.fournisseur).
 *
 * Contexte : un bug historique a posé fournisseur=1 sur ~1500 tiers qui sont en
 * réalité des clients/particuliers. Seuls quelques-uns ont de réelles traces
 * d'achat. Ce script remet fournisseur=0 sur les FAUX fournisseurs.
 *
 * Sont CONSERVÉS (fournisseur=1 maintenu) :
 *   - les vrais fournisseurs (facture_fourn / commande_fournisseur / prix fournisseur)
 *   - les tiers liés côté app (suppliers, consignors) — déposants/fournisseurs gérés
 *   - les ids protégés système
 *
 * Sécurités : dry-run par défaut ; sauvegarde CSV des ids modifiés (réversible) ;
 * écriture en transaction unique.
 *
 * Usage :
 *   node scripts/tiers-fix-fournisseur.mjs            (dry-run, défaut)
 *   node scripts/tiers-fix-fournisseur.mjs --apply
 */

import { writeFileSync } from 'node:fs';
import {
  openMysql, openSqlite, collectAppLinkedIds, toCsv, TODAY,
  REAL_SUPPLIER_PREDICATE, PROTECTED_IDS,
} from './tiers-hygiene-lib.mjs';

const apply = process.argv.includes('--apply');
const pool = openMysql();
const sdb = openSqlite(true);
const appLinked = collectAppLinkedIds(sdb);
const BACKUP = `/tmp/tiers_T1_backup_${TODAY}.csv`;

try {
  console.log(`\nT1 — Flag fournisseur · mode ${apply ? 'APPLY' : 'DRY-RUN'}`);

  const [faux] = await pool.query(
    `SELECT s.rowid, s.nom, s.client, s.email, s.phone
       FROM llx_societe s
      WHERE s.fournisseur = 1 AND NOT ${REAL_SUPPLIER_PREDICATE}`
  );
  const cibles = faux.filter((r) => !appLinked.has(r.rowid) && !PROTECTED_IDS.has(r.rowid));
  const protégés = faux.length - cibles.length;

  console.log(`Faux fournisseurs détectés        : ${faux.length}`);
  console.log(`  dont protégés (app/système)     : ${protégés}`);
  console.log(`À corriger (fournisseur=1 → 0)    : ${cibles.length}`);
  console.log(`  deviendront sans rôle (client=0): ${cibles.filter((r) => !(r.client > 0)).length}`);

  // Sauvegarde des ids concernés AVANT toute écriture (réversibilité).
  writeFileSync(BACKUP, toCsv(cibles, ['rowid', 'nom', 'client', 'email', 'phone']));
  console.log(`Sauvegarde (réversible)           : ${BACKUP}`);

  if (!apply) {
    console.log('\nDRY-RUN : aucune écriture. Relancer avec --apply pour exécuter.\n');
  } else if (cibles.length === 0) {
    console.log('\nRien à corriger.\n');
  } else {
    const ids = cibles.map((r) => r.rowid);
    // UPDATE par lots de 500 (limite placeholders).
    let done = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < ids.length; i += 500) {
        const batch = ids.slice(i, i + 500);
        const ph = batch.map(() => '?').join(',');
        const [res] = await conn.query(
          `UPDATE llx_societe SET fournisseur = 0 WHERE rowid IN (${ph}) AND fournisseur = 1`, batch
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
    console.log(`\n✓ APPLY terminé : ${done} tiers mis à fournisseur=0.`);
    console.log(`Réversion : UPDATE llx_societe SET fournisseur=1 WHERE rowid IN (<ids du CSV ${BACKUP}>)\n`);
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  sdb.close();
}
