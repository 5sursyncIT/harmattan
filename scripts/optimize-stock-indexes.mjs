/**
 * Optimisation des index pour le module Stock (/admin/stock).
 *
 * Contexte : le dashboard stock enchaînait 7 full scans de llx_product
 * (84 colonnes, ~1,3 Ko/ligne, ~7,5 Mo) par chargement — aucun index
 * n'était exploitable sur `tosell` / `stock`. Idem côté SQLite où
 * stock_alerts (8 000+ lignes) n'avait aucun index.
 *
 * Idempotent : relançable sans risque.
 *
 * Usage : node scripts/optimize-stock-indexes.mjs
 */

import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

// ─── MySQL (Dolibarr) ──────────────────────────────────────

const MYSQL_INDEXES = [
  {
    table: 'llx_product',
    name: 'idx_product_tosell_stock',
    // Index couvrant : rend index-only les 4 requêtes KPI du dashboard
    // (total actifs, ruptures, stock bas, valeur stock).
    ddl: 'ALTER TABLE llx_product ADD INDEX idx_product_tosell_stock (tosell, stock, price_ttc)',
  },
];

async function migrateMysql() {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  for (const { table, name, ddl } of MYSQL_INDEXES) {
    const [rows] = await conn.query('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name]);
    if (rows.length > 0) {
      console.log(`  = ${table}.${name} — déjà présent`);
      continue;
    }
    const t0 = Date.now();
    await conn.query(ddl);
    console.log(`  + ${table}.${name} — créé en ${Date.now() - t0} ms`);
  }

  await conn.end();
}

// ─── SQLite (newsletter.sqlite) ────────────────────────────

const SQLITE_INDEXES = [
  // Dashboard : SELECT alert_type, severity, COUNT(*) WHERE status='open' GROUP BY ...
  `CREATE INDEX IF NOT EXISTS idx_stock_alerts_status_type
     ON stock_alerts(status, alert_type, severity)`,
  // Panneau Alertes : filtres par type/sévérité + tri chronologique.
  `CREATE INDEX IF NOT EXISTS idx_stock_alerts_product
     ON stock_alerts(product_id)`,
  // Dashboard + panneau Recommandations : WHERE status = ? ORDER BY coverage_days
  `CREATE INDEX IF NOT EXISTS idx_purchase_reco_status
     ON purchase_recommendations(status, coverage_days)`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_reco_product
     ON purchase_recommendations(product_id)`,
];

function migrateSqlite() {
  const db = new Database(join(ROOT, 'newsletter.sqlite'));
  db.pragma('journal_mode = WAL');

  for (const ddl of SQLITE_INDEXES) {
    const name = ddl.match(/idx_[a-z_]+/)[0];
    const before = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name=?").get(name).n;
    db.exec(ddl);
    console.log(before ? `  = ${name} — déjà présent` : `  + ${name} — créé`);
  }

  db.exec('ANALYZE');

  // Le WAL avait atteint 47 Mo faute de checkpoint : on le tronque.
  const ck = db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`  ~ wal_checkpoint(TRUNCATE) → ${JSON.stringify(ck)}`);

  db.close();
}

// ─── Run ───────────────────────────────────────────────────

console.log('MySQL (Dolibarr) :');
await migrateMysql();
console.log('SQLite (newsletter.sqlite) :');
migrateSqlite();
console.log('Terminé.');
