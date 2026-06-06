// Détection (LECTURE SEULE) des factures sur-payées par le bug du paiement
// fractionné (chaque split imputait le total_ttc complet au lieu de sa part).
//
// Aucune écriture : uniquement des SELECT. Réutilise les variables MYSQL_* de .env.
//   node scripts/detect-split-overpay.mjs
import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 3,
});

const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));

try {
  // Factures (hors avoirs) dont la somme des paiements dépasse le total TTC.
  const [over] = await pool.query(
    `SELECT f.rowid, f.ref, f.total_ttc, DATE_FORMAT(f.datef,'%Y-%m-%d') AS datef,
            f.fk_soc, soc.nom AS client,
            COUNT(pf.rowid) AS n_pay,
            COALESCE(SUM(pf.amount),0) AS paid
       FROM llx_facture f
       JOIN llx_paiement_facture pf ON pf.fk_facture = f.rowid
       LEFT JOIN llx_societe soc ON soc.rowid = f.fk_soc
      WHERE f.type <> 2
      GROUP BY f.rowid, f.ref, f.total_ttc, f.datef, f.fk_soc, soc.nom
     HAVING COALESCE(SUM(pf.amount),0) > f.total_ttc + 1
      ORDER BY (COALESCE(SUM(pf.amount),0) - f.total_ttc) DESC`
  );

  if (!over.length) {
    console.log('✅ Aucune facture sur-payée détectée. Rien à corriger.');
    process.exit(0);
  }

  let totalOver = 0;
  let dupSignature = 0;
  console.log(`\n⚠️  ${over.length} facture(s) sur-payée(s) détectée(s) :\n`);
  console.log('REF'.padEnd(24), 'DATE'.padEnd(11), 'TTC'.padStart(12), 'PAYÉ'.padStart(12), 'TROP-PERÇU'.padStart(12), 'NB', ' CLIENT');
  console.log('-'.repeat(110));

  for (const f of over) {
    const overpay = Number(f.paid) - Number(f.total_ttc);
    totalOver += overpay;

    // Détail des paiements de cette facture (pour décision de nettoyage).
    const [pays] = await pool.query(
      `SELECT pf.rowid AS pf_id, pf.fk_paiement, pf.amount,
              DATE_FORMAT(p.datep,'%Y-%m-%d') AS datep,
              cp.code AS method, cp.libelle AS method_label
         FROM llx_paiement_facture pf
         JOIN llx_paiement p ON p.rowid = pf.fk_paiement
         LEFT JOIN llx_c_paiement cp ON cp.id = p.fk_paiement
        WHERE pf.fk_facture = ?
        ORDER BY p.datep ASC, pf.rowid ASC`, [f.rowid]
    );
    // Signature du bug : ≥2 paiements valant exactement le total_ttc.
    const nFull = pays.filter((p) => Math.abs(Number(p.amount) - Number(f.total_ttc)) < 1).length;
    const sig = nFull >= 2 ? ' 🔁BUG-SPLIT' : '';
    if (nFull >= 2) dupSignature++;

    console.log(
      String(f.ref).padEnd(24),
      String(f.datef).padEnd(11),
      fmt(f.total_ttc).padStart(12),
      fmt(f.paid).padStart(12),
      fmt(overpay).padStart(12),
      String(f.n_pay).padStart(2),
      ' ' + String(f.client || `tiers ${f.fk_soc}`).slice(0, 28) + sig
    );
    for (const p of pays) {
      console.log(
        '      ↳',
        `pf=${p.pf_id} paiement=${p.fk_paiement}`.padEnd(24),
        (p.method || '?').padEnd(6),
        fmt(p.amount).padStart(12),
        p.datep
      );
    }
  }

  console.log('-'.repeat(110));
  console.log(`\nTROP-PERÇU TOTAL : ${fmt(totalOver)} FCFA sur ${over.length} facture(s).`);
  console.log(`Dont ${dupSignature} avec la signature du bug fractionné (≥2 paiements = total TTC).`);
  console.log('\n(Lecture seule — aucune donnée modifiée.)');
} catch (e) {
  console.error('Erreur détection :', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
