/**
 * Rattrapage de l'attribution des mouvements de stock déjà réalisés.
 *
 * L'application journalise ses ajustements dans `admin_activity_log` depuis le
 * 2026-06-03 (avec l'auteur), mais rien ne reliait ces lignes aux mouvements
 * Dolibarr correspondants. Ce script pose ce lien a posteriori dans
 * `stock_movement_actors`, en marquant l'attribution `inferred` : l'historique
 * affichera « rapproché » et non « application », car il s'agit d'un
 * rapprochement, pas d'un enregistrement à la source.
 *
 * APPARIEMENT — quatre critères conjoints, aucun n'est deviné :
 *   1. la référence produit          (journal ↔ llx_product.ref)
 *   2. le dépôt                      (journal ↔ fk_entrepot)
 *   3. le couple avant→après         (journal ↔ libellé « Ajustement inventaire (11→10) »)
 *   4. l'horodatage à ±120 s près
 * Un mouvement déjà attribué n'est jamais réécrit. Une ligne de journal qui
 * apparie plusieurs mouvements est laissée de côté et signalée.
 *
 * PIÈGE DE FUSEAU — `datem` est lu en CHAÎNE BRUTE (DATE_FORMAT) et non en Date :
 * le pilote MySQL réinterpréterait l'heure locale du serveur (CEST) en UTC, ce
 * qui décalerait toutes les comparaisons de deux heures. Les deux journaux
 * partagent la même horloge murale — vérifié à la seconde près.
 *
 * Usage :  node scripts/backfill-stock-actors.mjs            (simulation)
 *          node scripts/backfill-stock-actors.mjs --apply
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createStockJournal } from '../server/stock-journal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');
const TOLERANCE_SECONDS = 120;

const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DATABASE,
});
const db = new Database(join(__dirname, '..', 'newsletter.sqlite'));
const journal = createStockJournal(db);

// « Ajustement : 9782336631356 11→10 (-1, dépôt 4) — Comptage rayon »
// Le stock AVANT peut être négatif (« -105→95 ») : un stock parti en négatif est
// justement le cas qu'on ajuste le plus souvent. Le signe est donc obligatoirement
// accepté des deux côtés de la flèche.
const LOG_RE = /^Ajustement\s*:\s*(\S+)\s+(-?\d+)→(-?\d+)\s*\(([+-]?\d+),\s*d[ée]p[ôo]t\s*(\d+)\)(?:\s*—\s*(.*))?$/;

const logs = db.prepare(
  "SELECT id, admin_username, details, created_at FROM admin_activity_log WHERE action = 'stock_adjust' ORDER BY id"
).all();

// Mouvements d'ajustement, horodatage en chaîne brute (cf. piège de fuseau).
const [movements] = await pool.query(`
  SELECT m.rowid AS id, DATE_FORMAT(m.datem, '%Y-%m-%d %H:%i:%s') AS datem_raw,
         m.label, m.value, m.fk_entrepot, p.ref AS product_ref
    FROM llx_stock_mouvement m
    JOIN llx_product p ON p.rowid = m.fk_product
   WHERE m.label LIKE 'Ajustement%'
   ORDER BY m.rowid`);

// Index par (produit, dépôt, avant→après) — les trois critères structurels.
const LABEL_RE = /\((-?\d+)→(-?\d+)\)/;
const buckets = new Map();
for (const m of movements) {
  const t = LABEL_RE.exec(m.label || '');
  if (!t) continue;
  const key = `${m.product_ref}|${m.fk_entrepot}|${t[1]}→${t[2]}`;
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(m);
}

const already = new Set(db.prepare('SELECT movement_id FROM stock_movement_actors').all().map(r => r.movement_id));
const seconds = (s) => Math.floor(new Date(String(s).replace(' ', 'T') + 'Z').getTime() / 1000);

const report = { matched: [], ambiguous: [], unmatched: [], skipped: 0 };

for (const log of logs) {
  const m = LOG_RE.exec(String(log.details || '').trim());
  if (!m) { report.unmatched.push({ log: log.id, raison: 'format de détail non reconnu', details: log.details }); continue; }
  const [, productRef, before, after, , warehouse, reason] = m;

  const candidates = (buckets.get(`${productRef}|${warehouse}|${before}→${after}`) || [])
    .filter(c => !already.has(c.id));
  if (candidates.length === 0) {
    report.unmatched.push({ log: log.id, raison: 'aucun mouvement correspondant', details: log.details });
    continue;
  }

  const logTs = seconds(log.created_at);
  const near = candidates.filter(c => Math.abs(seconds(c.datem_raw) - logTs) <= TOLERANCE_SECONDS);
  const pool_ = near.length > 0 ? near : [];
  if (pool_.length === 0) {
    report.unmatched.push({ log: log.id, raison: `mouvement trouvé mais hors fenêtre ±${TOLERANCE_SECONDS}s`, details: log.details });
    continue;
  }
  if (pool_.length > 1) {
    report.ambiguous.push({ log: log.id, candidats: pool_.map(c => c.id), details: log.details });
    continue;
  }

  const move = pool_[0];
  already.add(move.id); // un mouvement ne sert qu'une fois
  report.matched.push({ movement: move.id, user: log.admin_username, ref: productRef, delta: move.value, reason });

  if (APPLY) {
    journal.record(move.id, {
      username: log.admin_username, source: 'adjust', reason: reason || null,
      attribution: 'inferred',
      context: { product_ref: productRef, warehouse_id: Number(warehouse), before: Number(before), after: Number(after), backfilled_from_log: log.id },
    });
  }
}

console.log(`\n=== ${APPLY ? 'RATTRAPAGE APPLIQUÉ' : 'SIMULATION (ajouter --apply)'} ===\n`);
console.log(`Lignes de journal « stock_adjust » : ${logs.length}`);
console.log(`Mouvements d'ajustement en base    : ${movements.length}`);
console.log(`\nAppariés                           : ${report.matched.length}`);
console.log(`Ambigus (plusieurs candidats)      : ${report.ambiguous.length}`);
console.log(`Non appariés                       : ${report.unmatched.length}`);

const parUser = {};
for (const r of report.matched) parUser[r.user] = (parUser[r.user] || 0) + 1;
if (report.matched.length) {
  console.log('\nPar utilisateur :');
  for (const [u, n] of Object.entries(parUser).sort((a, b) => b[1] - a[1])) console.log(`   ${u.padEnd(22)} ${n}`);
}
for (const r of report.ambiguous.slice(0, 10)) console.log(`   AMBIGU  log#${r.log} → mouvements ${r.candidats.join(', ')} | ${r.details}`);
for (const r of report.unmatched.slice(0, 10)) console.log(`   ORPHELIN log#${r.log} (${r.raison}) | ${r.details}`);
if (report.unmatched.length > 10) console.log(`   … et ${report.unmatched.length - 10} autres non appariés`);

console.log('');
await pool.end();
