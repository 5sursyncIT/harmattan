// Test ponctuel : génère le rapport PDF d'un tiers et vérifie qu'il est valide.
// Usage : node scripts/test-societe-report.mjs [societeId]
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'fs';
import { buildSocieteReportPdf } from '../server/societe-report.js';

const id = parseInt(process.argv[2] || '425', 10);

const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
});

const [[societe]] = await pool.query(
  `SELECT rowid AS id, nom, code_client, phone, email, town, zip, address FROM llx_societe WHERE rowid = ?`, [id]);
const [[totals]] = await pool.query(
  `SELECT COUNT(*) AS count, COALESCE(SUM(total_ht),0) AS total_ht, COALESCE(SUM(total_ttc),0) AS total_ttc,
          COALESCE(SUM(CASE WHEN type<>2 THEN paid_amount ELSE 0 END),0) AS total_paid,
          COALESCE(SUM(CASE WHEN fk_statut=1 AND type<>2 THEN GREATEST(total_ttc-paid_amount,0) ELSE 0 END),0) AS total_unpaid
   FROM (SELECT f.total_ht,f.total_ttc,f.fk_statut,f.type,
                COALESCE((SELECT SUM(pf.amount) FROM llx_paiement_facture pf WHERE pf.fk_facture=f.rowid),0) AS paid_amount
         FROM llx_facture f WHERE f.fk_soc=?) t`, [id]);
const [byStatus] = await pool.query(
  `SELECT fk_statut AS statut, COUNT(*) AS cnt, COALESCE(SUM(total_ttc),0) AS ttc FROM llx_facture WHERE fk_soc=? GROUP BY fk_statut`, [id]);
const [monthlyRows] = await pool.query(
  `SELECT DATE_FORMAT(datef,'%Y-%m') AS ym, COALESCE(SUM(total_ttc),0) AS ttc, COUNT(*) AS cnt
   FROM llx_facture WHERE fk_soc=? AND type<>2 AND fk_statut IN (1,2)
     AND datef >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH),'%Y-%m-01')
   GROUP BY ym ORDER BY ym`, [id]);

const byYm = new Map(monthlyRows.map(r => [r.ym, r]));
const now = new Date();
const monthly = [];
for (let i = 11; i >= 0; i--) {
  const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const r = byYm.get(ym);
  monthly.push({ ym, ttc: r ? Number(r.ttc) : 0, cnt: r ? Number(r.cnt) : 0 });
}

console.log('Tiers:', societe?.nom, '| totals:', totals, '| statuts:', byStatus.length, '| mois:', monthly.length);
const pdf = buildSocieteReportPdf({ societe, totals, byStatus, monthly, generatedAt: new Date() });
const out = `/tmp/test-report-${id}.pdf`;
writeFileSync(out, pdf);
console.log('PDF écrit:', out, '| taille:', pdf.length, '| entête:', pdf.slice(0, 5).toString());
await pool.end();
