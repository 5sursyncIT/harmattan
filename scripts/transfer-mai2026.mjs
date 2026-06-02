// Transfert en comptabilité (SYSCOHADA, AUTOGEN) pour mai 2026.
// Idempotent : régénère les écritures AUTOGEN non validées de la période.
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

try {
  const date_from = '2026-05-01';
  const date_to = '2026-05-31';
  console.log(`Transfert en comptabilité ${date_from} → ${date_to} ...`);
  const r = await runTransfer(pool, { date_from, date_to, userId: 0, force: false });
  console.log('Résultat :', JSON.stringify(r, null, 2));
  const s = await getTransferSummary(pool);
  console.log('Grand livre :', JSON.stringify(s, null, 2));
} catch (e) {
  console.error('ERREUR :', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
