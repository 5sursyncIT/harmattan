#!/usr/bin/env node
/**
 * Phase 2 du refactor auteur : backfill book_authors à partir de pe.auteur (Dolibarr)
 *
 * - Match exact (post-normalisation) entre pe.auteur et authors.display_name / firstname+lastname
 * - Insère dans book_authors si match, sinon ignore et compte
 * - Produit un CSV des auteurs non-matchés, trié par nb de livres décroissant
 * - Idempotent : DELETE + INSERT par produit
 *
 * Usage:
 *   node scripts/backfill_book_authors.mjs --dry-run
 *   node scripts/backfill_book_authors.mjs --apply
 *   node scripts/backfill_book_authors.mjs --report  (génère uniquement le CSV)
 */

import 'dotenv/config';
import Db from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const apply     = process.argv.includes('--apply');
const dryRun    = process.argv.includes('--dry-run');
const reportOnly = process.argv.includes('--report');
const seedAll   = process.argv.includes('--seed-from-unmatched');
if (!apply && !dryRun && !reportOnly) {
  console.error('Usage: node backfill_book_authors.mjs --dry-run | --apply [--seed-from-unmatched] | --report');
  process.exit(1);
}

// ─── DB connections ───
const db = new Db('/var/www/html/senharmattan-shop/newsletter.sqlite');
const pool = await mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 4,
});

// ─── Helpers (copie de book-routes.js) ───
function normalizeAuthorName(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s,;\-_]+/g, ' ')
    .trim();
}

// ─── Chargement des auteurs SQLite en mémoire (indexé par formes normalisées) ───
const authorsRows = db.prepare(`SELECT id, firstname, lastname, display_name FROM authors`).all();
const authorIndex = new Map(); // normalized form → author_id
for (const a of authorsRows) {
  const forms = new Set([
    normalizeAuthorName(a.display_name),
    normalizeAuthorName(`${a.firstname || ''} ${a.lastname || ''}`),
    normalizeAuthorName(`${a.lastname || ''} ${a.firstname || ''}`),
  ]);
  for (const f of forms) {
    if (f && !authorIndex.has(f)) authorIndex.set(f, a.id);
  }
}
console.log(`Auteurs SQLite chargés : ${authorsRows.length} (${authorIndex.size} formes uniques)`);

// ─── Parcours des produits Dolibarr ───
const [rows] = await pool.query(`
  SELECT p.rowid AS product_id, pe.auteur
  FROM llx_product p
  LEFT JOIN llx_product_extrafields pe ON pe.fk_object = p.rowid
  WHERE p.tosell = 1
    AND p.fk_product_type = 0
    AND pe.auteur IS NOT NULL
    AND TRIM(pe.auteur) <> ''
`);
console.log(`Produits avec pe.auteur non vide : ${rows.length}`);

let nMatched = 0;
let nUnmatched = 0;
const unmatchedFreq = new Map(); // raw author name → { count, sampleProductIds[] }

const insertStmt  = db.prepare(`INSERT INTO book_authors (product_id, author_id, role, position) VALUES (?, ?, 'author', 0)`);
const deleteStmt  = db.prepare(`DELETE FROM book_authors WHERE product_id = ?`);
const txProcess = db.transaction((productId, authorId) => {
  deleteStmt.run(productId);
  if (authorId) insertStmt.run(productId, authorId);
});

for (const r of rows) {
  const norm = normalizeAuthorName(r.auteur);
  const matchId = norm ? authorIndex.get(norm) : null;

  if (matchId) {
    if (apply) txProcess(r.product_id, matchId);
    nMatched++;
  } else {
    nUnmatched++;
    const key = r.auteur.trim();
    const slot = unmatchedFreq.get(key) || { count: 0, sampleProductIds: [] };
    slot.count++;
    if (slot.sampleProductIds.length < 3) slot.sampleProductIds.push(r.product_id);
    unmatchedFreq.set(key, slot);
  }
}

console.log(`\n=== Bilan ===`);
console.log(`Match : ${nMatched}`);
console.log(`Non-match : ${nUnmatched}`);
console.log(`Auteurs distincts non-matchés : ${unmatchedFreq.size}`);

// ─── CSV des non-matchés, trié par fréquence ───
const csvPath = join('/tmp', `unmatched_authors_${new Date().toISOString().replace(/[:.]/g,'-')}.csv`);
const sorted = [...unmatchedFreq.entries()].sort((a, b) => b[1].count - a[1].count);
const csv = ['author_name,book_count,sample_product_ids']
  .concat(sorted.map(([name, info]) => {
    const safe = `"${name.replace(/"/g, '""')}"`;
    return `${safe},${info.count},"${info.sampleProductIds.join(' ')}"`;
  }))
  .join('\n');
writeFileSync(csvPath, csv);
console.log(`\nCSV non-matchés : ${csvPath}`);

// Top 10 console
console.log(`\n=== TOP 10 auteurs non-matchés (à créer en priorité) ===`);
for (const [name, info] of sorted.slice(0, 10)) {
  console.log(`  ${String(info.count).padStart(4)} livres  |  ${name}  (ex: ${info.sampleProductIds.join(', ')})`);
}

if (!apply) {
  console.log(`\n(${dryRun ? 'dry-run' : 'report'} : rien d'écrit dans book_authors)`);
}

// ─── --seed-from-unmatched : crée auto les auteurs absents puis re-link ───
if (apply && seedAll && unmatchedFreq.size > 0) {
  console.log(`\n=== SEED : création auto de ${unmatchedFreq.size} auteurs dans SQLite ===`);

  // Helpers locaux
  const slugify = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const splitName = (full) => {
    const parts = full.trim().split(/\s+/);
    if (parts.length === 1) return { firstname: '', lastname: parts[0] };
    return { firstname: parts[0], lastname: parts.slice(1).join(' ') };
  };

  const insertAuthor = db.prepare(
    `INSERT INTO authors (email, password, firstname, lastname, display_name, slug, public_listed) VALUES (?, '', ?, ?, ?, ?, 0)`
  );
  const findBySlug = db.prepare(`SELECT id FROM authors WHERE slug = ?`);

  let createdCnt = 0;
  let skipExists = 0;
  const newAuthorIds = new Map(); // normalized form → id

  const seedTx = db.transaction(() => {
    for (const [rawName] of unmatchedFreq) {
      const { firstname, lastname } = splitName(rawName);
      let slug = slugify(rawName);
      if (!slug) continue;
      // Évite collision : ajoute -2, -3... si occupé
      let candidate = slug, n = 2;
      while (findBySlug.get(candidate)) {
        candidate = `${slug}-${n++}`;
        if (n > 50) break;
      }
      const email = `auteur+${candidate}@senharmattan.local`;
      try {
        const r = insertAuthor.run(email, firstname, lastname, rawName, candidate);
        createdCnt++;
        newAuthorIds.set(normalizeAuthorName(rawName), r.lastInsertRowid);
      } catch (e) {
        skipExists++;
        console.warn(`  skip "${rawName}" (${e.message})`);
      }
    }
  });
  seedTx();
  console.log(`Auteurs créés : ${createdCnt}, skip : ${skipExists}`);

  // Re-link : refait un pass de matching avec les nouveaux auteurs
  console.log(`\n=== Re-link des produits avec les auteurs fraîchement créés ===`);
  let nReLinked = 0;
  const reLinkTx = db.transaction(() => {
    for (const r of rows) {
      const norm = normalizeAuthorName(r.auteur);
      const newId = newAuthorIds.get(norm);
      if (newId) {
        deleteStmt.run(r.product_id);
        insertStmt.run(r.product_id, newId);
        nReLinked++;
      }
    }
  });
  reLinkTx();
  console.log(`Re-linked : ${nReLinked}`);
}

await pool.end();
db.close();
