#!/usr/bin/env node
/**
 * Réparer le fk_doc des écritures comptables de trésorerie (doc_type='bank').
 *
 * BUG (accounting-engine.js, corrigé en parallèle) : les écritures AUTOGEN du
 * journal de banque/caisse ont été écrites avec fk_doc = rowid du PAIEMENT, alors
 * que la convention Dolibarr veut fk_doc = rowid de la LIGNE BANQUE (llx_bank).
 * Comme les rowid de paiements et de lignes banque vivent dans des séquences
 * proches, ils COLLISIONNENT : le garde-fou natif AccountLine::delete() croit alors
 * qu'une ligne banque est « déjà comptabilisée » et bloque la suppression/annulation
 * de paiements qui n'ont en réalité rien à voir (cf. doublons POS).
 *
 * Ce script remappe fk_doc : pour chaque écriture 'bank' AUTOGEN dont fk_doc pointe
 * un paiement (rowid + ref concordants), on remplace fk_doc par le fk_bank de ce
 * paiement (l'id réel de la ligne banque). Montants, comptes, sens : INTOUCHÉS.
 * Seul le lien documentaire fk_doc est corrigé.
 *
 * Sûreté :
 *  - --dry-run par défaut (aucune écriture) : montre le volume + un échantillon.
 *  - N'agit QUE sur doc_type='bank' AND import_key='AUTOGEN' AND date_validated IS NULL
 *    (jamais une écriture validée/verrouillée).
 *  - Mapping calé sur (fk_doc=paiement.rowid ET doc_ref=paiement.ref) → pas de
 *    faux appariement. Idempotent (ignore les lignes déjà correctes : fk_bank<>fk_doc).
 *  - Avant écriture : table de backup imp_bkp_bank_fkdoc_<ts> (bk_rowid, old, new)
 *    → réversible via un simple UPDATE…JOIN (commande affichée en fin de run).
 *  - UPDATE final en transaction.
 *
 * Usage :
 *   node scripts/fix-accounting-bank-fkdoc.mjs            # dry-run
 *   node scripts/fix-accounting-bank-fkdoc.mjs --apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const apply = process.argv.includes('--apply');
const fmt = (n) => Number(n).toLocaleString('fr-FR');
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
const BKP = `imp_bkp_bank_fkdoc_${ts}`;

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  multipleStatements: false,
});

// Lignes 'bank' AUTOGEN dont fk_doc = un rowid de paiement client (à remapper vers fk_bank).
const SELECT_CLIENT = `
  FROM llx_accounting_bookkeeping bk
  JOIN llx_paiement p ON p.rowid = bk.fk_doc AND p.ref = bk.doc_ref
  WHERE bk.doc_type = 'bank' AND bk.import_key = 'AUTOGEN' AND bk.date_validated IS NULL
    AND p.fk_bank IS NOT NULL AND p.fk_bank <> bk.fk_doc`;
// Idem côté paiements fournisseurs (table llx_paiementfourn) — futur-proof (0 aujourd'hui).
const SELECT_FOURN = `
  FROM llx_accounting_bookkeeping bk
  JOIN llx_paiementfourn p ON p.rowid = bk.fk_doc AND p.ref = bk.doc_ref
  WHERE bk.doc_type = 'bank' AND bk.import_key = 'AUTOGEN' AND bk.date_validated IS NULL
    AND p.fk_bank IS NOT NULL AND p.fk_bank <> bk.fk_doc`;

async function main() {
  // ── Diagnostic ──────────────────────────────────────────────────
  const [[cli]] = await pool.query(`SELECT COUNT(*) AS n ${SELECT_CLIENT}`);
  const [[fou]] = await pool.query(`SELECT COUNT(*) AS n ${SELECT_FOURN}`);
  const [[locked]] = await pool.query(
    `SELECT COUNT(*) AS n FROM llx_accounting_bookkeeping
     WHERE doc_type='bank' AND import_key='AUTOGEN' AND date_validated IS NOT NULL`
  );
  const [[orphan]] = await pool.query(
    `SELECT COUNT(*) AS n FROM llx_accounting_bookkeeping bk
     WHERE bk.doc_type='bank' AND bk.import_key='AUTOGEN' AND bk.date_validated IS NULL
       AND NOT EXISTS (SELECT 1 FROM llx_paiement p     WHERE p.rowid=bk.fk_doc AND p.ref=bk.doc_ref)
       AND NOT EXISTS (SELECT 1 FROM llx_paiementfourn pf WHERE pf.rowid=bk.fk_doc AND pf.ref=bk.doc_ref)`
  );
  const total = Number(cli.n) + Number(fou.n);

  console.log(`\n=== Réparation fk_doc des écritures 'bank' (AUTOGEN) ===`);
  console.log(`À remapper (clients)      : ${fmt(cli.n)}`);
  console.log(`À remapper (fournisseurs) : ${fmt(fou.n)}`);
  console.log(`Déjà validées (ignorées)  : ${fmt(locked.n)}`);
  console.log(`Orphelines (paiement supprimé/ref divergente, laissées telles quelles) : ${fmt(orphan.n)}`);
  console.log(`TOTAL à corriger          : ${fmt(total)}`);

  const [sample] = await pool.query(
    `SELECT bk.rowid AS bk_rowid, bk.doc_ref, bk.fk_doc AS old_fk_doc, p.fk_bank AS new_fk_doc, bk.numero_compte, bk.debit, bk.credit
     ${SELECT_CLIENT} LIMIT 5`
  );
  if (sample.length) {
    console.log(`\nÉchantillon (avant→après) :`);
    for (const r of sample) {
      console.log(`  bk#${r.bk_rowid} ${r.doc_ref} cpt ${r.numero_compte}  fk_doc ${r.old_fk_doc} → ${r.new_fk_doc}  (D ${fmt(r.debit)} / C ${fmt(r.credit)})`);
    }
  }

  if (total === 0) { console.log(`\nRien à faire. ✓`); await pool.end(); return; }

  if (!apply) {
    console.log(`\n[DRY-RUN] Aucune écriture. Relancer avec --apply pour appliquer.`);
    await pool.end();
    return;
  }

  // ── Application ─────────────────────────────────────────────────
  // 1) Backup (table persistante) — DDL hors transaction.
  await pool.query(
    `CREATE TABLE ${BKP} (bk_rowid INT PRIMARY KEY, old_fk_doc INT, new_fk_doc INT, doc_ref VARCHAR(64))`
  );
  await pool.query(
    `INSERT INTO ${BKP} (bk_rowid, old_fk_doc, new_fk_doc, doc_ref)
     SELECT bk.rowid, bk.fk_doc, p.fk_bank, bk.doc_ref ${SELECT_CLIENT}`
  );
  await pool.query(
    `INSERT IGNORE INTO ${BKP} (bk_rowid, old_fk_doc, new_fk_doc, doc_ref)
     SELECT bk.rowid, bk.fk_doc, p.fk_bank, bk.doc_ref ${SELECT_FOURN}`
  );
  const [[bkpCount]] = await pool.query(`SELECT COUNT(*) AS n FROM ${BKP}`);
  console.log(`\nBackup créé : table ${BKP} (${fmt(bkpCount.n)} lignes).`);

  // 2) UPDATE en transaction, depuis le mapping figé.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [upd] = await conn.query(
      `UPDATE llx_accounting_bookkeeping bk
       JOIN ${BKP} t ON t.bk_rowid = bk.rowid
       SET bk.fk_doc = t.new_fk_doc`
    );
    await conn.commit();
    console.log(`UPDATE appliqué : ${fmt(upd.affectedRows)} écriture(s) corrigée(s). ✓`);
  } catch (e) {
    await conn.rollback();
    console.error(`ROLLBACK — erreur : ${e.message}`);
    process.exitCode = 1;
  } finally {
    conn.release();
  }

  // 3) Contrôle post + commande de réversion.
  const [[stillCli]] = await pool.query(`SELECT COUNT(*) AS n ${SELECT_CLIENT}`);
  console.log(`Restant à remapper (clients) après run : ${fmt(stillCli.n)} (attendu 0)`);
  console.log(`\n↩️  Réversion si besoin :`);
  console.log(`   UPDATE llx_accounting_bookkeeping bk JOIN ${BKP} t ON t.bk_rowid=bk.rowid SET bk.fk_doc=t.old_fk_doc;`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
