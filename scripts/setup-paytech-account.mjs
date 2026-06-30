#!/usr/bin/env node
/**
 * Crée (idempotent) le compte de trésorerie « PayTech » et le mode de paiement
 * « PAYTECH » dans Dolibarr, dédiés aux encaissements en ligne via l'agrégateur.
 *
 * - llx_bank_account  : ref CPTEPAYTECH, compte courant (courant=1) pour ne pas
 *   être mêlé au comptage de caisse du POS, ledger 521 (comme Wave/OM).
 * - llx_c_paiement    : code PAYTECH, type 2 (comme CB/WAVE/OM), actif.
 *
 * Réexécutable sans risque : ne recrée rien s'il existe déjà (lookup par ref/code).
 * Affiche les ids résultants (à reporter dans ECOMMERCE_PAYMENT_MAP si besoin).
 *
 * Usage : node scripts/setup-paytech-account.mjs
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
});

const ENTITY = 1;

async function ensureBankAccount() {
  const [exist] = await pool.query(
    'SELECT rowid, ref, label, courant, account_number FROM llx_bank_account WHERE ref = ? LIMIT 1',
    ['CPTEPAYTECH']
  );
  if (exist.length) {
    console.log(`✔ Compte bancaire déjà présent : rowid=${exist[0].rowid} (${exist[0].label})`);
    return exist[0].rowid;
  }
  const [res] = await pool.query(
    `INSERT INTO llx_bank_account
       (datec, tms, ref, label, entity, bank, code_banque, code_guichet, number,
        cle_rib, bic, iban_prefix, domiciliation, pti_in_ctti, fk_pays, proprio,
        owner_address, courant, clos, rappro, account_number, currency_code, comment)
     VALUES
       (NOW(), NOW(), ?, ?, ?, '', '', '', '', '', '', '', '', 0, 22, '',
        '', 1, 0, 1, '521', 'XOF', ?)`,
    ['CPTEPAYTECH', 'COMPTE PAYTECH (en ligne)', ENTITY, 'Encaissements e-commerce via PayTech (CB / Wave / OM agrégés)']
  );
  console.log(`✚ Compte bancaire créé : rowid=${res.insertId} (CPTEPAYTECH)`);
  return res.insertId;
}

async function ensurePaymentMode() {
  const [exist] = await pool.query(
    'SELECT id, code, libelle, active FROM llx_c_paiement WHERE code = ? AND entity = ? LIMIT 1',
    ['PTECH', ENTITY]
  );
  if (exist.length) {
    if (!exist[0].active) {
      await pool.query('UPDATE llx_c_paiement SET active = 1 WHERE id = ?', [exist[0].id]);
      console.log(`✔ Mode de paiement réactivé : id=${exist[0].id} (PAYTECH)`);
    } else {
      console.log(`✔ Mode de paiement déjà présent : id=${exist[0].id} (PAYTECH)`);
    }
    return exist[0].id;
  }
  const [res] = await pool.query(
    `INSERT INTO llx_c_paiement (entity, code, libelle, type, active, position, cyberbank)
     VALUES (?, 'PTECH', 'PayTech (en ligne)', 2, 1, 0, 0)`,
    [ENTITY]
  );
  console.log(`✚ Mode de paiement créé : id=${res.insertId} (PAYTECH)`);
  return res.insertId;
}

try {
  const accountId = await ensureBankAccount();
  const paymentId = await ensurePaymentMode();
  console.log('\n──────────────────────────────────────────');
  console.log(`PAYTECH bankAccount (accountId) = ${accountId}`);
  console.log(`PAYTECH paymentId (c_paiement)  = ${paymentId}`);
  console.log('──────────────────────────────────────────');
} catch (e) {
  console.error('Erreur:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
