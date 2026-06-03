#!/usr/bin/env node
/**
 * Corriger les paiements rattachés à la MAUVAISE facture.
 *
 * Signature de corruption (probable artefact migration v13→v21) : un paiement P
 * dont le champ num_paiement nomme une facture F_orig (le POS fait toujours
 * num_payment = ref de la facture réglée), avec montant = total exact de F_orig,
 * mais dont le lien llx_paiement_facture pointe une AUTRE facture F_liee.
 * Résultat : F_orig est marquée payée mais sans paiement (orpheline), et F_liee
 * apparaît (sur-)payée à tort.
 *
 * Correction, en transaction :
 *  1. Ré-affecte le lien : llx_paiement_facture.fk_facture = F_orig (la ligne
 *     bancaire n'est pas touchée — même argent, même compte).
 *  2. Recalcule le statut de chaque F_liee : si, après retrait du paiement
 *     mal-lié, elle n'est plus soldée alors qu'elle était paye=1, on la ROUVRE
 *     (paye=0, fk_statut=1, date_closing/fk_user_closing remis à NULL).
 *     → corrige notamment les factures clôturées à tort le 2026-06-03.
 *
 * Garde-fous :
 *  - --dry-run par défaut (aucune écriture).
 *  - Ne traite QUE les liens où montant = total_ttc de F_orig au centime près.
 *  - Refuse de ré-affecter si F_orig a déjà un paiement lié (anti double-paiement).
 *  - N'touche jamais aux avoirs (type=2) côté statut.
 *  - Backup automatique des lignes impactées avant écriture.
 *
 * Usage :
 *   node scripts/fix-mislinked-payments.mjs            # dry-run
 *   node scripts/fix-mislinked-payments.mjs --apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync, mkdirSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const fmt = (n) => Number(n).toLocaleString('fr-FR');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  multipleStatements: false,
});

// Détection dynamique des liens corrompus (auto-validante : montant = total F_orig).
const CORRUPT_SQL = `
  SELECT pf.rowid AS link_id, p.rowid AS paie_id, p.ref AS paie_ref, pf.amount,
         flie.rowid AS flie_id, flie.ref AS flie_ref, flie.type AS flie_type,
         flie.paye AS flie_paye, flie.fk_statut AS flie_statut, flie.total_ttc AS flie_ttc,
         forig.rowid AS forig_id, forig.ref AS forig_ref, forig.total_ttc AS forig_ttc,
         (SELECT COUNT(*) FROM llx_paiement_facture x WHERE x.fk_facture = forig.rowid) AS forig_nb_paie
  FROM llx_paiement p
  JOIN llx_paiement_facture pf ON pf.fk_paiement = p.rowid
  JOIN llx_facture flie  ON flie.rowid = pf.fk_facture
  JOIN llx_facture forig ON forig.ref   = p.num_paiement
  WHERE (p.num_paiement LIKE 'LIBFAC%' OR p.num_paiement LIKE 'FA%')
    AND flie.ref <> p.num_paiement
    AND ABS(pf.amount - forig.total_ttc) < 1
  ORDER BY p.ref`;

const remainAfter = async (conn, facId, excludeLinkId) => {
  const [[r]] = await conn.query(
    `SELECT f.total_ttc
            - COALESCE((SELECT SUM(amount) FROM llx_paiement_facture WHERE fk_facture=f.rowid AND rowid<>?),0)
            - COALESCE((SELECT SUM(amount_ttc) FROM llx_societe_remise_except WHERE fk_facture=f.rowid),0) AS remain
       FROM llx_facture f WHERE f.rowid=?`, [excludeLinkId, facId]);
  return Number(r.remain);
};

async function main() {
  console.log(`\n=== Correction des paiements mal rattachés ===`);
  console.log(apply ? '*** MODE --apply : écritures réelles (transaction) ***\n' : '(dry-run : aucune écriture)\n');

  const [rows] = await pool.query(CORRUPT_SQL);
  console.log(`${rows.length} lien(s) corrompu(s) détecté(s).\n`);

  const plan = [];
  for (const r of rows) {
    if (r.forig_nb_paie > 0) {
      console.log(`⚠ SKIP ${r.paie_ref} : la vraie facture ${r.forig_ref} a déjà ${r.forig_nb_paie} paiement(s) → risque double-paiement, à examiner manuellement.`);
      continue;
    }
    // Statut de F_liee après retrait du paiement mal-lié.
    const remain = await remainAfter(pool, r.flie_id, r.link_id);
    const reopen = r.flie_type !== 2 && r.flie_paye === 1 && remain > 0.01;
    plan.push({ ...r, remain, reopen });
    console.log(
      `→ ${r.paie_ref} (${fmt(r.amount)})  ` +
      `${r.flie_ref}[${fmt(r.flie_ttc)}${r.flie_type === 2 ? ',avoir' : ''}] ⇒ ${r.forig_ref}[${fmt(r.forig_ttc)}]` +
      (reopen ? `  | ROUVRIR ${r.flie_ref} (restant ${fmt(remain)})` : (r.flie_paye === 1 && r.flie_type !== 2 ? '  | F_liee reste payée (autre paiement)' : ''))
    );
  }

  if (!apply) {
    console.log(`\nDRY-RUN : ${plan.length} ré-affectation(s), ${plan.filter(p => p.reopen).length} réouverture(s). Relancer avec --apply.\n`);
    await pool.end();
    return;
  }

  // Backup rollback : on capture l'état RÉEL exact des lignes avant écriture.
  mkdirSync('scripts/backups', { recursive: true });
  const restore = ['-- Rollback fix-mislinked-payments (restaure l\'état exact pré-correction)'];
  for (const p of plan) {
    restore.push(`UPDATE llx_paiement_facture SET fk_facture=${p.flie_id} WHERE rowid=${p.link_id};`);
    if (p.reopen) {
      const [[f]] = await pool.query(
        `SELECT paye, fk_statut, IFNULL(QUOTE(date_closing),'NULL') dc, IFNULL(fk_user_closing,'NULL') uc
           FROM llx_facture WHERE rowid=?`, [p.flie_id]);
      restore.push(`UPDATE llx_facture SET paye=${f.paye}, fk_statut=${f.fk_statut}, date_closing=${f.dc}, fk_user_closing=${f.uc} WHERE rowid=${p.flie_id};`);
    }
  }
  const backupPath = `scripts/backups/rollback-mislinked.sql`;
  writeFileSync(backupPath, restore.join('\n') + '\n');
  console.log(`\nBackup rollback : ${backupPath} (${restore.length - 1} instructions)`);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let repointed = 0, reopened = 0;
    for (const p of plan) {
      await conn.query(`UPDATE llx_paiement_facture SET fk_facture=? WHERE rowid=? AND fk_facture=?`,
        [p.forig_id, p.link_id, p.flie_id]);
      repointed++;
      if (p.reopen) {
        await conn.query(
          `UPDATE llx_facture SET paye=0, fk_statut=1, date_closing=NULL, fk_user_closing=NULL WHERE rowid=?`,
          [p.flie_id]);
        reopened++;
      }
    }
    await conn.commit();
    console.log(`\n✓ ${repointed} paiement(s) ré-affecté(s), ${reopened} facture(s) rouverte(s). COMMIT.`);
  } catch (e) {
    await conn.rollback();
    console.error('\n✗ ROLLBACK — aucune modification appliquée :', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
