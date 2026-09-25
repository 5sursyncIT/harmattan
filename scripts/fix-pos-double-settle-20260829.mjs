// Remédiation one-off — paiements en DOUBLE sur règlement d'impayé (28 & 29/08/2026).
//
// ⚠️ Ce ne sont PAS des factures en double : chaque facture est une vente unique,
// c'est le PAIEMENT qui a été enregistré deux fois. Supprimer la facture
// effacerait une vente réelle et son mouvement de stock.
//
// Cause : POST /pos/invoices/:id/settle (server/pos-routes.js) n'avait ni verrou
// ni idempotence. Ses garde-fous (paye=1, reste<=0.5) sont lus AVANT l'appel
// Dolibarr `paymentsdistributed` avec closepaidinvoices=yes, qui reste en
// transaction ouverte pendant 2 min (soldage + régénération ODT + agenda).
// Le caissier, l'écran figé, a rechargé la page (ce qui remet `busy` à false)
// et relancé le règlement : la 2ᵉ requête a passé les mêmes garde-fous, et
// la garde anti-sur-paiement de Dolibarr (api_invoices.class.php ~1635) l'a
// laissée passer aussi car en REPEATABLE READ elle ne voyait pas encore le
// 1ᵉʳ paiement non committé. → 2 × le montant plein sur la même facture.
//
//   42059 LIBFAC20260828-023730  10 500 F  → pay 33226 (18:18:08) + 33227 (18:19:31)
//   42101 LIBFAC20260829-023771  13 500 F  → pay 33257 (18:21:48) + 33258 (18:23:37)
//
// Les deux sur T7, mode Espèces, compte 3 (COMPTE LIQUIDE), client 949
// (LIVRES AU SENEGAL) : la caisse liquide est surévaluée de 24 000 F au total.
//
// Actions, en transaction, pour chaque facture : supprimer le 2ᵉ paiement
// (paiement + imputation + ligne banque + liens banque). La facture reste
// validée/payée avec le montant exact — aucun changement de statut, aucun
// impact stock (la vente est réelle et déjà sortie du stock).
//
//   node scripts/fix-pos-double-settle-20260829.mjs            → DRY-RUN (n'écrit rien)
//   node scripts/fix-pos-double-settle-20260829.mjs --apply    → applique
//
// Garde-fous : montants attendus, paiement imputé EXCLUSIVEMENT sur sa facture,
// ligne banque non rapprochée (rappro=0, num_releve NULL), aucune écriture
// comptable, 1ᵉʳ paiement conservé intact, total réglé après = total_ttc exact.
// Idempotent (ce qui est déjà fait est sauté). Backup JSON + undo.sql avant écriture.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const __dir = dirname(fileURLToPath(import.meta.url));
const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));

const ADMIN_UID = 1; // login=admin

// --- Identifiants vérifiés par inspection lecture seule -------------------
const CASES = [
  {
    facture: 42059, ref: 'LIBFAC20260828-023730', amount: 10500,
    keepPay: 33226,                                    // 1ᵉʳ paiement — la vraie encaisse
    pay: 33227, pf: 34368, bank: 32855, bankUrl: [67488, 67489], // le doublon
  },
  {
    facture: 42101, ref: 'LIBFAC20260829-023771', amount: 13500,
    keepPay: 33257,
    pay: 33258, pf: 34399, bank: 32886, bankUrl: [67550, 67551],
  },
];

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost', user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
  waitForConnections: true, connectionLimit: 2, dateStrings: true,
});

function buildInsert(table, row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => {
    const v = row[c];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`;
}

const conn = await pool.getConnection();
try {
  const errors = [];
  const plan = [];
  const undo = [];
  const backup = {};

  for (const C of CASES) {
    const todo = { c: C, killPayment: false, facture: null };

    // ---------- La facture : vente réelle, unique, validée ----------
    const [[f]] = await conn.query(
      'SELECT rowid, ref, fk_statut, paye, total_ttc, fk_soc, pos_source FROM llx_facture WHERE rowid=?',
      [C.facture],
    );
    if (!f) errors.push(`facture ${C.facture} introuvable`);
    else {
      if (f.ref !== C.ref) errors.push(`facture ${C.facture} réf=${f.ref} ≠ ${C.ref}`);
      if (Number(f.total_ttc) !== C.amount) errors.push(`facture ${C.facture} total=${f.total_ttc} ≠ ${C.amount}`);
      if (Number(f.fk_statut) !== 2) errors.push(`facture ${C.facture} statut=${f.fk_statut} (2/payée attendu)`);
      todo.facture = f;
    }

    // ---------- Le paiement à CONSERVER doit être intact ----------
    const [[kp]] = await conn.query('SELECT rowid, amount FROM llx_paiement WHERE rowid=?', [C.keepPay]);
    if (!kp) errors.push(`paiement à conserver ${C.keepPay} introuvable — ne rien supprimer`);
    else if (Number(kp.amount) !== C.amount) errors.push(`paiement conservé ${C.keepPay} montant=${kp.amount} ≠ ${C.amount}`);

    // ---------- PRÉ-CONTRÔLES du paiement en double ----------
    const [[pay]] = await conn.query('SELECT rowid, amount, fk_bank FROM llx_paiement WHERE rowid=?', [C.pay]);
    if (!pay) {
      console.log(`[${C.ref}] paiement en double ${C.pay} déjà supprimé — saut.`);
    } else {
      if (Number(pay.amount) !== C.amount) errors.push(`paiement ${C.pay} montant=${pay.amount} ≠ ${C.amount}`);
      if (Number(pay.fk_bank) !== C.bank) errors.push(`paiement ${C.pay} ligne banque=${pay.fk_bank} ≠ ${C.bank}`);

      const [links] = await conn.query('SELECT rowid, fk_facture FROM llx_paiement_facture WHERE fk_paiement=?', [C.pay]);
      if (links.length !== 1 || Number(links[0].fk_facture) !== C.facture || Number(links[0].rowid) !== C.pf) {
        errors.push(`paiement ${C.pay} non imputé exclusivement sur ${C.facture} (pf ${C.pf}) — vérif manuelle`);
      }

      const [[b]] = await conn.query('SELECT amount, rappro, num_releve FROM llx_bank WHERE rowid=?', [C.bank]);
      if (!b) errors.push(`ligne banque ${C.bank} introuvable`);
      else {
        if (Number(b.amount) !== C.amount) errors.push(`banque ${C.bank} montant=${b.amount} ≠ ${C.amount}`);
        if (Number(b.rappro) !== 0) errors.push(`banque ${C.bank} RAPPROCHÉE (rappro=${b.rappro}) — abandon`);
        if (b.num_releve) errors.push(`banque ${C.bank} sur relevé ${b.num_releve} — abandon`);
      }

      const [urls] = await conn.query('SELECT rowid FROM llx_bank_url WHERE fk_bank=?', [C.bank]);
      const got = urls.map((u) => Number(u.rowid)).sort((x, y) => x - y);
      if (got.join(',') !== [...C.bankUrl].sort((x, y) => x - y).join(',')) {
        errors.push(`banque ${C.bank} liens=[${got}] ≠ [${C.bankUrl}] — vérif manuelle`);
      }

      // Convention du moteur compta maison : doc_type='bank' + fk_doc=rowid du paiement.
      const [[bk]] = await conn.query(
        "SELECT COUNT(*) AS nb FROM llx_accounting_bookkeeping WHERE doc_type='bank' AND fk_doc=?", [C.pay],
      );
      if (bk && Number(bk.nb) > 0) errors.push(`paiement ${C.pay} a ${bk.nb} écriture(s) comptable(s) — traitement compta requis`);

      // ---------- La facture doit bien être sur-payée d'exactement 1× le montant ----------
      const [[sum]] = await conn.query(
        'SELECT COALESCE(SUM(amount),0) AS r, COUNT(*) AS nb FROM llx_paiement_facture WHERE fk_facture=?', [C.facture],
      );
      if (Number(sum.nb) !== 2) errors.push(`facture ${C.facture} a ${sum.nb} imputation(s), 2 attendues`);
      if (Number(sum.r) !== C.amount * 2) errors.push(`facture ${C.facture} réglé=${sum.r} ≠ ${C.amount * 2}`);

      todo.killPayment = true;
    }

    plan.push(todo);
  }

  if (errors.length) {
    console.error('⛔ Pré-contrôles échoués (données déjà modifiées ?) :');
    errors.forEach((e) => console.error('   - ' + e));
    process.exit(1);
  }

  const actions = plan.filter((t) => t.killPayment);
  if (actions.length === 0) { console.log('Rien à faire : correction déjà appliquée.'); process.exit(0); }

  // ---------- SAUVEGARDE + SQL D'ANNULATION ----------
  for (const t of actions) {
    const C = t.c;
    const [bkP] = await conn.query('SELECT * FROM llx_paiement WHERE rowid=?', [C.pay]);
    const [bkPf] = await conn.query('SELECT * FROM llx_paiement_facture WHERE rowid=?', [C.pf]);
    const [bkB] = await conn.query('SELECT * FROM llx_bank WHERE rowid=?', [C.bank]);
    const [bkBu] = await conn.query('SELECT * FROM llx_bank_url WHERE rowid IN (?)', [C.bankUrl]);
    backup[C.ref] = { facture: t.facture, paiement: bkP, paiement_facture: bkPf, bank: bkB, bank_url: bkBu };
    bkB.forEach((r) => undo.push(buildInsert('llx_bank', r)));
    bkP.forEach((r) => undo.push(buildInsert('llx_paiement', r)));
    bkBu.forEach((r) => undo.push(buildInsert('llx_bank_url', r)));
    bkPf.forEach((r) => undo.push(buildInsert('llx_paiement_facture', r)));
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  const jsonPath = join(bkDir, `pos-double-settle-20260829-${ts}.json`);
  const undoPath = join(bkDir, `pos-double-settle-20260829-${ts}.undo.sql`);
  writeFileSync(jsonPath, JSON.stringify(backup, null, 2));
  writeFileSync(undoPath, '-- Annulation de fix-pos-double-settle-20260829\n' + undo.join('\n') + '\n');
  console.log(`\n💾 Sauvegarde : ${jsonPath}`);
  console.log(`↩️  Annulation : ${undoPath}\n`);

  console.log('PLAN :');
  let cash = 0;
  for (const t of actions) {
    const C = t.c;
    console.log(`   [${C.ref}] facture ${C.facture} CONSERVÉE (vente réelle, ${fmt(C.amount)} F, statut payée)`);
    console.log(`       supprimer le paiement en double ${C.pay} (${fmt(C.amount)} F Espèces) + banque ${C.bank} + liens ${C.bankUrl.join(', ')}`);
    console.log(`       conserver le paiement ${C.keepPay} → réglé après = ${fmt(C.amount)} F, reste 0`);
    cash += C.amount;
  }
  console.log(`   COMPTE LIQUIDE : -${fmt(cash)} F (surévaluation corrigée)`);
  console.log('   stock : aucun impact (ventes réelles, sorties déjà enregistrées)\n');

  if (!APPLY) { console.log('🔍 DRY-RUN — aucune écriture. Relancez avec --apply pour appliquer.'); process.exit(0); }

  // ---------- APPLICATION (transaction) ----------
  await conn.beginTransaction();
  for (const t of actions) {
    const C = t.c;
    await conn.query('DELETE FROM llx_paiement_facture WHERE rowid=?', [C.pf]);
    await conn.query('DELETE FROM llx_bank_url WHERE rowid IN (?)', [C.bankUrl]);
    await conn.query('DELETE FROM llx_bank WHERE rowid=?', [C.bank]);
    await conn.query('DELETE FROM llx_paiement WHERE rowid=?', [C.pay]);
  }

  // ---------- VÉRIFICATION FINALE (avant COMMIT) ----------
  let ok = true;
  for (const t of actions) {
    const C = t.c;
    const [[regle]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS r, COUNT(*) AS nb FROM llx_paiement_facture WHERE fk_facture=?', [C.facture]);
    const [[stillPay]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_paiement WHERE rowid=?', [C.pay]);
    const [[stillBank]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_bank WHERE rowid=?', [C.bank]);
    const [[keptPay]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_paiement WHERE rowid=?', [C.keepPay]);
    const [[fin]] = await conn.query('SELECT fk_statut, paye FROM llx_facture WHERE rowid=?', [C.facture]);
    const good = Number(regle.r) === C.amount && Number(regle.nb) === 1
      && Number(stillPay.nb) === 0 && Number(stillBank.nb) === 0 && Number(keptPay.nb) === 1
      && Number(fin.fk_statut) === 2 && Number(fin.paye) === 1;
    if (!good) ok = false;
    console.log(`   ${good ? '✅' : '❌'} [${C.ref}] réglé=${fmt(regle.r)} F (${regle.nb} paiement) · statut=${fin.fk_statut} · payée=${fin.paye}`);
  }
  if (!ok) { await conn.rollback(); console.error('⛔ Vérification finale KO — ROLLBACK, rien n\'a été modifié.'); process.exit(1); }
  await conn.commit();
  console.log('\n✅ COMMIT — correction appliquée.');

  // ---------- Journal d'audit applicatif ----------
  try {
    const sq = new Database(join(__dir, '..', 'newsletter.sqlite'));
    const ins = sq.prepare(
      `INSERT INTO invoice_audit_log (fk_facture, ref_facture, action, reason, user_id, user_name, user_role, before_snapshot, after_snapshot)
       VALUES (?, ?, 'payment_delete', ?, ?, 'admin', 'admin', ?, ?)`,
    );
    for (const t of actions) {
      const C = t.c;
      ins.run(
        C.facture, C.ref,
        `Paiement en double supprimé (race /settle sans verrou) — paiement ${C.pay} de ${fmt(C.amount)} F Espèces`,
        ADMIN_UID,
        JSON.stringify({ paiements: [C.keepPay, C.pay], regle: C.amount * 2, total_ttc: C.amount }),
        JSON.stringify({ paiements: [C.keepPay], regle: C.amount, total_ttc: C.amount }),
      );
    }
    sq.close();
    console.log('🧾 invoice_audit_log : entrées écrites.');
  } catch (e) {
    console.warn('⚠️  audit log non écrit :', e.message);
  }
} catch (e) {
  try { await conn.rollback(); } catch { /* ignore */ }
  console.error('⛔ Erreur :', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
