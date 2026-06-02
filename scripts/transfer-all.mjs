// Transfert en comptabilité de TOUT l'historique, mois par mois.
// Idempotent (régénère les écritures AUTOGEN non validées de chaque mois).
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { runTransfer, getTransferSummary } from '../server/accounting-engine.js';

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
});

// Plage : décembre 2021 -> juin 2026 (inclus)
const START = { y: 2021, m: 12 };
const END = { y: 2026, m: 6 };

function lastDay(y, m) {
  return new Date(y, m, 0).getDate(); // m = 1..12 -> dernier jour du mois
}

try {
  let totIns = 0, totPieces = 0, totWarn = 0;
  let y = START.y, m = START.m;
  while (y < END.y || (y === END.y && m <= END.m)) {
    const date_from = `${y}-${String(m).padStart(2, '0')}-01`;
    const date_to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay(y, m)).padStart(2, '0')}`;
    try {
      const r = await runTransfer(pool, { date_from, date_to, userId: 0, force: false });
      totIns += r.inserted; totPieces += r.pieces; totWarn += r.warnings.length;
      const w = r.warnings.length ? `  ⚠ ${r.warnings.length} warning(s)` : '';
      console.log(`${date_from.slice(0, 7)} : ${String(r.inserted).padStart(6)} lignes  (${r.breakdown.sales} ventes, ${r.breakdown.sales_payments} règl., ${r.breakdown.purchases} achats)${w}`);
      for (const wn of r.warnings) console.log(`           ⚠ ${wn}`);
    } catch (e) {
      console.log(`${date_from.slice(0, 7)} : ERREUR -> ${e.message}`);
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  console.log('--------------------------------------------------');
  console.log(`TOTAL : ${totIns} lignes insérées, ${totPieces} pièces, ${totWarn} warning(s)`);
  const s = await getTransferSummary(pool);
  console.log('Grand livre final :', JSON.stringify(s, null, 2));
} catch (e) {
  console.error('ERREUR GLOBALE :', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
