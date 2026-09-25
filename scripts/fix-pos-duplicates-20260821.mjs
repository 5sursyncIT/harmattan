// Remédiation one-off — doublons POS du 21/08/2026 (terminal 7, caisse_principale).
//
// Cause (journal systemd + base) : l'appel d'encaissement Dolibarr
// (POST /invoices/paymentsdistributed, closepaidinvoices=yes) a dépassé le timeout
// HTTP de 30 s DEUX fois (17:08:45 et 17:17:43). Dolibarr avait pourtant bien créé
// le paiement ; côté app l'erreur réseau a été lue comme « paiement non enregistré »
// → rollbackSale() cas 2 → facture repassée en brouillon (stock restitué, correct)
// puis suppression REFUSÉE (« Invoice not erasable » : un paiement existe). Le
// caissier a ressaisi la vente → seconde facture validée et payée.
//
// Reste donc en base, par vente : 1 brouillon orphelin portant un paiement FANTÔME
// (argent jamais encaissé — caisse WAVE surévaluée de 16 000 F au total) + la vraie
// facture payée.
//
//   Fantôme                                   Vraie vente
//   41940 LIBFAC20260821-023615 (15 000)  →   41941 LIBFAC20260821-023616 (payée)
//   41942 LIBFAC20260821-023617 ( 1 000)  →   41943 LIBFAC20260821-023618 (payée)
//
// Actions, en transaction, pour chaque paire :
//   1) supprimer le paiement fantôme (paiement + lien facture + ligne banque + liens) ;
//   2) passer le brouillon en Abandonnée / replaced (fk_statut=3) — le numéro est
//      conservé, la séquence reste sans trou ([[incident_pos_timeout_phantom_payment]]).
// Le stock n'est PAS touché : les mouvements sont déjà nets (-1 puis +1 au rollback,
// puis -1 sur la vente ressaisie).
//
//   node scripts/fix-pos-duplicates-20260821.mjs            → DRY-RUN (n'écrit rien)
//   node scripts/fix-pos-duplicates-20260821.mjs --apply    → applique
//
// Garde-fous : montants attendus, paiement imputé EXCLUSIVEMENT sur son brouillon,
// ligne banque non rapprochée (rappro=0, num_releve NULL), aucune écriture comptable,
// brouillon au statut 0 avec la bonne référence, vraie facture existante et payée.
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
const PAIRS = [
  {
    pay: 33099, pf: 34240, bank: 32728, bankUrl: [67234, 67235],
    facture: 41940, ref: 'LIBFAC20260821-023615',
    keep: 41941, keepRef: 'LIBFAC20260821-023616', amount: 15000,
  },
  {
    pay: 33101, pf: 34242, bank: 32730, bankUrl: [67238, 67239],
    facture: 41942, ref: 'LIBFAC20260821-023617',
    keep: 41943, keepRef: 'LIBFAC20260821-023618', amount: 1000,
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

  for (const P of PAIRS) {
    const todo = { pair: P, killPayment: false, abandon: false, before: null };

    // ---------- PRÉ-CONTRÔLES paiement fantôme ----------
    const [[pay]] = await conn.query('SELECT rowid, amount, fk_bank FROM llx_paiement WHERE rowid=?', [P.pay]);
    if (!pay) {
      console.log(`[${P.ref}] paiement fantôme ${P.pay} déjà supprimé — saut.`);
    } else {
      if (Number(pay.amount) !== P.amount) errors.push(`paiement ${P.pay} montant=${pay.amount} ≠ ${P.amount}`);
      if (Number(pay.fk_bank) !== P.bank) errors.push(`paiement ${P.pay} ligne banque=${pay.fk_bank} ≠ ${P.bank}`);

      const [links] = await conn.query('SELECT rowid, fk_facture FROM llx_paiement_facture WHERE fk_paiement=?', [P.pay]);
      if (links.length !== 1 || Number(links[0].fk_facture) !== P.facture || Number(links[0].rowid) !== P.pf) {
        errors.push(`paiement ${P.pay} non imputé exclusivement sur ${P.facture} (pf ${P.pf}) — vérif manuelle`);
      }

      const [[b]] = await conn.query('SELECT amount, rappro, num_releve FROM llx_bank WHERE rowid=?', [P.bank]);
      if (!b) errors.push(`ligne banque ${P.bank} introuvable`);
      else {
        if (Number(b.amount) !== P.amount) errors.push(`banque ${P.bank} montant=${b.amount} ≠ ${P.amount}`);
        if (Number(b.rappro) !== 0) errors.push(`banque ${P.bank} RAPPROCHÉE (rappro=${b.rappro}) — abandon`);
        if (b.num_releve) errors.push(`banque ${P.bank} sur relevé ${b.num_releve} — abandon`);
      }

      // Convention du moteur compta maison : doc_type='bank' + fk_doc=rowid du paiement.
      const [[bk]] = await conn.query(
        "SELECT COUNT(*) AS nb FROM llx_accounting_bookkeeping WHERE doc_type='bank' AND fk_doc=?", [P.pay],
      );
      if (bk && Number(bk.nb) > 0) errors.push(`paiement ${P.pay} a ${bk.nb} écriture(s) comptable(s) — traitement compta requis`);

      todo.killPayment = true;
    }

    // ---------- PRÉ-CONTRÔLES brouillon ----------
    const [[f]] = await conn.query(
      `SELECT rowid, ref, fk_statut, paye, total_ttc, close_code, close_note, date_closing, fk_user_closing
       FROM llx_facture WHERE rowid=?`, [P.facture],
    );
    if (!f) errors.push(`facture ${P.facture} introuvable`);
    else if (f.ref !== P.ref) errors.push(`facture ${P.facture} réf=${f.ref} ≠ ${P.ref}`);
    else if (Number(f.total_ttc) !== P.amount) errors.push(`facture ${P.facture} total=${f.total_ttc} ≠ ${P.amount}`);
    else if (Number(f.fk_statut) === 3) console.log(`[${P.ref}] déjà Abandonnée — saut.`);
    else if (Number(f.fk_statut) !== 0) errors.push(`facture ${P.facture} statut=${f.fk_statut} (brouillon attendu)`);
    else { todo.abandon = true; todo.before = f; }

    // ---------- La vraie vente doit exister, payée ----------
    const [[k]] = await conn.query('SELECT ref, fk_statut, paye, total_ttc FROM llx_facture WHERE rowid=?', [P.keep]);
    if (!k) errors.push(`vraie facture ${P.keep} introuvable`);
    else {
      if (k.ref !== P.keepRef) errors.push(`vraie facture ${P.keep} réf=${k.ref} ≠ ${P.keepRef}`);
      if (Number(k.total_ttc) !== P.amount) errors.push(`vraie facture ${P.keep} total=${k.total_ttc} ≠ ${P.amount}`);
      if (Number(k.paye) !== 1) errors.push(`vraie facture ${P.keep} non payée — la vente réelle doit être encaissée`);
    }

    // ---------- Le stock a bien été restitué au rollback ----------
    const [[mv]] = await conn.query(
      'SELECT COUNT(*) AS nb FROM llx_stock_mouvement WHERE value > 0 AND label LIKE ?', [`%${P.ref}%`],
    );
    if (!mv || Number(mv.nb) < 1) errors.push(`aucun mouvement de restitution de stock pour ${P.ref} — le stock serait faussé`);

    plan.push(todo);
  }

  if (errors.length) {
    console.error('⛔ Pré-contrôles échoués (données déjà modifiées ?) :');
    errors.forEach((e) => console.error('   - ' + e));
    process.exit(1);
  }

  const actions = plan.filter((t) => t.killPayment || t.abandon);
  if (actions.length === 0) { console.log('Rien à faire : correction déjà appliquée.'); process.exit(0); }

  // ---------- SAUVEGARDE + SQL D'ANNULATION ----------
  for (const t of plan) {
    const P = t.pair;
    if (t.killPayment) {
      const [bkP] = await conn.query('SELECT * FROM llx_paiement WHERE rowid=?', [P.pay]);
      const [bkPf] = await conn.query('SELECT * FROM llx_paiement_facture WHERE rowid=?', [P.pf]);
      const [bkB] = await conn.query('SELECT * FROM llx_bank WHERE rowid=?', [P.bank]);
      const [bkBu] = await conn.query('SELECT * FROM llx_bank_url WHERE rowid IN (?)', [P.bankUrl]);
      backup[P.ref] = { paiement: bkP, paiement_facture: bkPf, bank: bkB, bank_url: bkBu, facture: t.before };
      bkB.forEach((r) => undo.push(buildInsert('llx_bank', r)));
      bkBu.forEach((r) => undo.push(buildInsert('llx_bank_url', r)));
      bkP.forEach((r) => undo.push(buildInsert('llx_paiement', r)));
      bkPf.forEach((r) => undo.push(buildInsert('llx_paiement_facture', r)));
    }
    if (t.abandon) {
      const f = t.before;
      undo.push(
        `UPDATE llx_facture SET fk_statut=${f.fk_statut}, paye=${Number(f.paye)}, `
        + `close_code=${f.close_code ? `'${f.close_code}'` : 'NULL'}, `
        + `close_note=${f.close_note ? `'${String(f.close_note).replace(/'/g, "''")}'` : 'NULL'}, `
        + `date_closing=${f.date_closing ? `'${f.date_closing}'` : 'NULL'}, `
        + `fk_user_closing=${f.fk_user_closing ?? 'NULL'} WHERE rowid=${P.facture};`,
      );
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bkDir = join(__dir, 'backups');
  mkdirSync(bkDir, { recursive: true });
  const jsonPath = join(bkDir, `pos-duplicates-20260821-${ts}.json`);
  const undoPath = join(bkDir, `pos-duplicates-20260821-${ts}.undo.sql`);
  writeFileSync(jsonPath, JSON.stringify(backup, null, 2));
  writeFileSync(undoPath, '-- Annulation de fix-pos-duplicates-20260821\n' + undo.join('\n') + '\n');
  console.log(`\n💾 Sauvegarde : ${jsonPath}`);
  console.log(`↩️  Annulation : ${undoPath}\n`);

  console.log('PLAN :');
  for (const t of plan) {
    const P = t.pair;
    if (t.killPayment) console.log(`   [${P.ref}] supprimer paiement fantôme ${P.pay} (${fmt(P.amount)} F WAVE) + banque ${P.bank} + liens ${P.bankUrl.join(', ')}`);
    if (t.abandon) console.log(`   [${P.ref}] brouillon ${P.facture} → Abandonnée / replaced (remplacée par ${P.keepRef})`);
  }
  console.log('   stock : aucun impact (mouvements déjà nets)\n');

  if (!APPLY) { console.log('🔍 DRY-RUN — aucune écriture. Relancez avec --apply pour appliquer.'); process.exit(0); }

  // ---------- APPLICATION (transaction) ----------
  await conn.beginTransaction();
  for (const t of plan) {
    const P = t.pair;
    if (t.killPayment) {
      await conn.query('DELETE FROM llx_paiement_facture WHERE rowid=?', [P.pf]);
      await conn.query('DELETE FROM llx_bank_url WHERE rowid IN (?)', [P.bankUrl]);
      await conn.query('DELETE FROM llx_bank WHERE rowid=?', [P.bank]);
      await conn.query('DELETE FROM llx_paiement WHERE rowid=?', [P.pay]);
    }
    if (t.abandon) {
      // close_note est un varchar(128) : on reste court, le détail complet est
      // consigné dans invoice_audit_log (motif + snapshots avant/après).
      const note = `Doublon timeout POS 21/08 — remplacée par ${P.keepRef} (paiement fantôme ${fmt(P.amount)} F annulé)`;
      const [r] = await conn.query(
        `UPDATE llx_facture
           SET fk_statut=3, paye=0, close_code='replaced', close_note=?,
               date_closing=NOW(), fk_user_closing=?, fk_user_modif=?, tms=NOW()
         WHERE rowid=? AND fk_statut=0`,
        [note, ADMIN_UID, ADMIN_UID, P.facture],
      );
      if (r.affectedRows !== 1) {
        await conn.rollback();
        console.error(`⛔ UPDATE ${P.ref} a touché ${r.affectedRows} ligne(s) — ROLLBACK`);
        process.exit(1);
      }
    }
  }

  // ---------- VÉRIFICATION FINALE (avant COMMIT) ----------
  let ok = true;
  for (const t of plan) {
    const P = t.pair;
    const [[regle]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS r FROM llx_paiement_facture WHERE fk_facture=?', [P.facture]);
    const [[stillPay]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_paiement WHERE rowid=?', [P.pay]);
    const [[stillBank]] = await conn.query('SELECT COUNT(*) AS nb FROM llx_bank WHERE rowid=?', [P.bank]);
    const [[fin]] = await conn.query('SELECT fk_statut, close_code FROM llx_facture WHERE rowid=?', [P.facture]);
    const [[keep]] = await conn.query('SELECT paye, (SELECT COALESCE(SUM(amount),0) FROM llx_paiement_facture WHERE fk_facture=?) AS r FROM llx_facture WHERE rowid=?', [P.keep, P.keep]);
    const good = Number(regle.r) === 0 && Number(stillPay.nb) === 0 && Number(stillBank.nb) === 0
      && Number(fin.fk_statut) === 3 && Number(keep.paye) === 1 && Number(keep.r) === P.amount;
    ok = ok && good;
    console.log(`   ${good ? '✅' : '❌'} ${P.ref} : réglé=${fmt(regle.r)}, statut=${fin.fk_statut}/${fin.close_code} — ${P.keepRef} payée ${fmt(keep.r)}`);
  }
  if (!ok) {
    await conn.rollback();
    console.error('\n⛔ ROLLBACK — état final inattendu. Aucune modification appliquée.');
    process.exit(1);
  }
  await conn.commit();
  console.log('\n✅ COMMIT — caisse WAVE corrigée de 16 000 F, 2 brouillons neutralisés.');

  // ---------- JOURNAL D'AUDIT APPLICATIF ----------
  const sdb = new Database(join(__dir, '..', 'newsletter.sqlite'));
  const stmt = sdb.prepare(
    `INSERT INTO invoice_audit_log (fk_facture, ref_facture, action, reason, user_id, user_name, user_role, before_snapshot, after_snapshot)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const t of plan) {
    if (!t.abandon) continue;
    const P = t.pair;
    stmt.run(
      P.facture, P.ref, 'abandon',
      `Doublon (timeout POS 21/08) — remplacée par ${P.keepRef} ; paiement fantôme ${P.pay} supprimé`,
      ADMIN_UID, 'admin (régularisation console)', 'super_admin',
      JSON.stringify({ fk_statut: 0, paye: 1, regle: P.amount, paiement: P.pay }),
      JSON.stringify({ fk_statut: 3, close_code: 'replaced', replaced_by: P.keepRef, regle: 0 }),
    );
  }
  sdb.close();
  console.log('✅ Journal d’audit : entrées « abandon » ajoutées.');
} catch (e) {
  try { await conn.rollback(); } catch { /* ignore */ }
  console.error('Erreur — ROLLBACK :', e.message);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
