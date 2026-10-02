/**
 * Doublons de tiers (llx_societe) — détection, fusion, annulation.
 *
 * Détection (lecture seule) : regroupe les tiers ACTIFS qui partagent
 *   - le même email            → confiance forte ;
 *   - le même téléphone        → confiance forte ;
 *   - le même nom complet      → À VÉRIFIER (homonymes possibles).
 * Les paires écartées par un humain (« pas des doublons ») sont mémorisées
 * dans `tier_duplicate_dismissals` et ne ressortent plus.
 *
 * Fusion : repointe TOUT l'historique de l'absorbé (fk_soc de toutes les tables
 * Dolibarr, liens bancaires, liens app SQLite) vers le maître, complète les
 * champs vides du maître, puis archive l'absorbé (status=0 + note [FUSION]).
 * Une transaction MySQL par absorbé ; journal complet dans `tier_merges`
 * → annulation exacte possible.
 *
 * ⚠️ Jamais de fusion automatique : toujours une décision humaine.
 */
import { nameKey, normalizePhone } from './tier-dedup.js';

// Tables descriptives du tiers : restent attachées à l'absorbé archivé.
const SKIP_TABLES = new Set([
  'llx_societe', 'llx_societe_rib', 'llx_societe_remise', 'llx_societe_commerciaux',
  'llx_categorie_societe', 'llx_societe_perentity', 'llx_societe_prices',
]);
// Liens application (SQLite) vers un tiers Dolibarr.
const APP_LINKS = [
  ['authors', 'dolibarr_thirdparty_id'],
  ['customers', 'dolibarr_id'],
  ['consignors', 'fk_soc'],
];
// Tiers système jamais absorbables (SERVICE PRESSE).
const PROTECTED_IDS = new Set([33]);
const ENRICH_FIELDS = ['email', 'phone', 'address', 'zip', 'town'];
const FAKE_EMAIL_RE = /@senharmattan\.local$/i;

export function ensureTierMergeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tier_merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      master_id INTEGER NOT NULL,
      absorbed_id INTEGER NOT NULL,
      master_name TEXT,
      absorbed_name TEXT,
      actor TEXT,
      journal TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      reverted_at TEXT,
      reverted_by TEXT
    );
    CREATE TABLE IF NOT EXISTS tier_duplicate_dismissals (
      a INTEGER NOT NULL,
      b INTEGER NOT NULL,
      actor TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (a, b)
    );
  `);
}

const pairKey = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);

// ── Détection ─────────────────────────────────────────────────────────────
export async function findDuplicateClusters({ db, dolibarrPool }) {
  const [tiers] = await dolibarrPool.query(
    `SELECT rowid AS id, nom, name_alias, email, phone, code_client, code_fournisseur,
            client, fournisseur, town, datec AS created_at
       FROM llx_societe WHERE status = 1`,
  );
  const dismissed = new Set(
    db.prepare('SELECT a, b FROM tier_duplicate_dismissals').all().map((r) => pairKey(r.a, r.b)),
  );

  // Arêtes entre tiers, étiquetées par critère.
  const groupsBy = (keyFn) => {
    const m = new Map();
    for (const t of tiers) {
      const k = keyFn(t);
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t.id);
    }
    return [...m.values()].filter((g) => g.length > 1);
  };
  const edges = new Map(); // pairKey -> Set(reasons)
  const addGroups = (groups, reason) => {
    for (const g of groups) {
      if (g.length > 12) continue; // clé trop générique (ex. téléphone standard) : ignorée
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const k = pairKey(g[i], g[j]);
          if (dismissed.has(k)) continue;
          if (!edges.has(k)) edges.set(k, new Set());
          edges.get(k).add(reason);
        }
      }
    }
  };
  addGroups(groupsBy((t) => String(t.email || '').trim().toLowerCase() || null), 'email');
  addGroups(groupsBy((t) => { const p = normalizePhone(t.phone); return p.length >= 8 ? p.slice(-9) : null; }), 'phone');
  addGroups(groupsBy((t) => nameKey(t.nom, t.name_alias || '')), 'name');
  addGroups(groupsBy((t) => nameKey(t.nom)), 'name');

  // Composantes connexes.
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const k of edges.keys()) {
    const [a, b] = k.split('-').map(Number);
    parent.set(find(a), find(b));
  }
  const comps = new Map();
  for (const id of parent.keys()) {
    const r = find(id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(id);
  }
  const clusters = [...comps.values()].filter((c) => c.length > 1);
  if (!clusters.length) return [];

  // Statistiques des membres (factures, dernière activité, auteurs liés).
  const ids = clusters.flat();
  const stats = new Map(ids.map((id) => [id, { invoice_count: 0, invoice_total: 0, last_invoice: null }]));
  const [inv] = await dolibarrPool.query(
    `SELECT fk_soc, COUNT(*) n, COALESCE(SUM(total_ttc),0) total, MAX(datef) last
       FROM llx_facture WHERE fk_soc IN (?) GROUP BY fk_soc`, [ids],
  );
  for (const r of inv) Object.assign(stats.get(r.fk_soc), { invoice_count: Number(r.n), invoice_total: Number(r.total), last_invoice: r.last });
  const authorsByTier = new Map();
  try {
    for (const a of db.prepare(`SELECT id, display_name, dolibarr_thirdparty_id t FROM authors WHERE dolibarr_thirdparty_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      if (!authorsByTier.has(a.t)) authorsByTier.set(a.t, []);
      authorsByTier.get(a.t).push({ id: a.id, name: a.display_name });
    }
  } catch { /* table absente */ }

  const byId = new Map(tiers.map((t) => [t.id, t]));
  return clusters.map((members) => {
    const reasons = new Set();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        for (const r of edges.get(pairKey(members[i], members[j])) || []) reasons.add(r);
      }
    }
    const rows = members.map((id) => ({
      ...byId.get(id),
      ...stats.get(id),
      authors: authorsByTier.get(id) || [],
      protected: PROTECTED_IDS.has(id),
    }));
    // Maître suggéré : protégé > plus de factures > plus ancien.
    rows.sort((a, b) => (b.protected - a.protected) || (b.invoice_count - a.invoice_count) || (a.id - b.id));
    const strong = reasons.has('email') || reasons.has('phone');
    return {
      key: members.slice().sort((a, b) => a - b).join('-'),
      confidence: strong ? 'high' : 'review',
      reasons: [...reasons],
      suggested_master: rows[0].id,
      members: rows,
    };
  }).sort((a, b) => (a.confidence === b.confidence ? b.members.length - a.members.length : a.confidence === 'high' ? -1 : 1));
}

export function dismissDuplicates(db, ids, actor) {
  const uniq = [...new Set(ids.map(Number).filter(Boolean))];
  const ins = db.prepare('INSERT OR IGNORE INTO tier_duplicate_dismissals (a, b, actor) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const [a, b] = uniq[i] < uniq[j] ? [uniq[i], uniq[j]] : [uniq[j], uniq[i]];
        ins.run(a, b, actor);
      }
    }
  });
  tx();
  return uniq.length;
}

// ── Fusion ────────────────────────────────────────────────────────────────
async function fkSocTables(dolibarrPool) {
  const [cols] = await dolibarrPool.query(
    `SELECT c.TABLE_NAME t,
            (SELECT k.COLUMN_NAME FROM information_schema.COLUMNS k
              WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
                AND k.COLUMN_NAME IN ('rowid','id') ORDER BY k.COLUMN_NAME DESC LIMIT 1) pk
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES tb
         ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE'
      WHERE c.TABLE_SCHEMA = DATABASE() AND c.COLUMN_NAME = 'fk_soc' AND c.TABLE_NAME LIKE 'llx\\_%'`,
  );
  return cols.filter((c) => !SKIP_TABLES.has(c.t));
}

/**
 * Fusionne `absorbedId` dans `masterId`. Retourne { mergeId, moved, enrich }.
 * `dryRun` : calcule seulement ce qui serait déplacé.
 */
export async function mergeTierPair({ db, dolibarrPool }, { masterId, absorbedId, actor = 'system', dryRun = false }) {
  masterId = Number(masterId); absorbedId = Number(absorbedId);
  if (!masterId || !absorbedId || masterId === absorbedId) throw new Error('Maître et absorbé doivent être deux tiers distincts');
  if (PROTECTED_IDS.has(absorbedId)) throw new Error(`Le tiers #${absorbedId} est protégé et ne peut pas être absorbé`);

  const [soc] = await dolibarrPool.query(
    `SELECT rowid, nom, name_alias, email, phone, address, zip, town, client, fournisseur, code_client, status
       FROM llx_societe WHERE rowid IN (?, ?)`, [masterId, absorbedId],
  );
  const M = soc.find((s) => s.rowid === masterId);
  const A = soc.find((s) => s.rowid === absorbedId);
  if (!M || !A) throw new Error('Tiers introuvable');
  if (M.status !== 1) throw new Error(`Le maître #${masterId} est archivé`);
  if (A.status !== 1) throw new Error(`Le tiers #${absorbedId} est déjà archivé`);

  const moves = {};
  for (const { t, pk } of await fkSocTables(dolibarrPool)) {
    const [rows] = await dolibarrPool.query(`SELECT ${pk || 'NULL'} AS pk FROM ${t} WHERE fk_soc = ?`, [absorbedId]);
    if (rows.length) moves[t] = { pk, ids: rows.map((r) => r.pk) };
  }
  const [bankUrl] = await dolibarrPool.query(`SELECT rowid FROM llx_bank_url WHERE type = 'company' AND url_id = ?`, [absorbedId]);

  const appMoves = {};
  for (const [tbl, col] of APP_LINKS) {
    try {
      const rows = db.prepare(`SELECT id FROM ${tbl} WHERE CAST(${col} AS INTEGER) = ?`).all(absorbedId);
      if (rows.length) appMoves[`${tbl}.${col}`] = rows.map((r) => r.id);
    } catch { /* table absente */ }
  }

  // Enrichissement : champs vides du maître (jamais d'email factice).
  const fill = {};
  const previous = {};
  for (const f of ENRICH_FIELDS) {
    if (M[f] || !A[f]) continue;
    if (f === 'email' && FAKE_EMAIL_RE.test(A[f])) continue;
    fill[f] = A[f]; previous[f] = M[f] ?? null;
  }
  if (!M.name_alias && A.nom && nameKey(A.nom) !== nameKey(M.nom)) { fill.name_alias = A.nom; previous.name_alias = M.name_alias ?? null; }
  if ((M.client | A.client) !== M.client) { fill.client = M.client | A.client; previous.client = M.client; }
  if (A.fournisseur && !M.fournisseur) { fill.fournisseur = 1; previous.fournisseur = M.fournisseur; }

  const moved = Object.fromEntries(Object.entries(moves).map(([t, m]) => [t, m.ids.length]));
  if (bankUrl.length) moved.llx_bank_url = bankUrl.length;
  for (const [k, v] of Object.entries(appMoves)) moved[k] = v.length;
  if (dryRun) return { dryRun: true, moved, enrich: fill };

  const today = new Date().toISOString().slice(0, 10);
  const journal = { master: masterId, absorbed: absorbedId, before: { master: M, absorbed: A }, moves: {}, bank_url: [], enrich: fill, previous, app: appMoves };
  const conn = await dolibarrPool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [t, { pk, ids }] of Object.entries(moves)) {
      if (pk) await conn.query(`UPDATE ${t} SET fk_soc = ? WHERE ${pk} IN (?)`, [masterId, ids]);
      else await conn.query(`UPDATE ${t} SET fk_soc = ? WHERE fk_soc = ?`, [masterId, absorbedId]);
      journal.moves[t] = { pk, ids };
    }
    if (bankUrl.length) {
      journal.bank_url = bankUrl.map((r) => r.rowid);
      await conn.query(`UPDATE llx_bank_url SET url_id = ? WHERE rowid IN (?)`, [masterId, journal.bank_url]);
    }
    if (Object.keys(fill).length) {
      await conn.query(`UPDATE llx_societe SET ${Object.keys(fill).map((k) => `${k} = ?`).join(', ')} WHERE rowid = ?`, [...Object.values(fill), masterId]);
    }
    await conn.query(
      `UPDATE llx_societe SET status = 0, note_private = CONCAT(COALESCE(note_private, ''), ?) WHERE rowid = ?`,
      [`\n[FUSION ${today}] absorbé dans tiers #${masterId} par ${actor}`, absorbedId],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // Liens app + journal (SQLite, après commit MySQL).
  const mergeId = db.transaction(() => {
    for (const [key, ids] of Object.entries(appMoves)) {
      const [tbl, col] = key.split('.');
      db.prepare(`UPDATE ${tbl} SET ${col} = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(masterId, ...ids);
    }
    return db.prepare(
      `INSERT INTO tier_merges (master_id, absorbed_id, master_name, absorbed_name, actor, journal) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(masterId, absorbedId, M.nom, A.nom, actor, JSON.stringify(journal)).lastInsertRowid;
  })();

  return { mergeId: Number(mergeId), moved, enrich: fill };
}

/** Annule une fusion journalisée (remet l'historique d'origine sur l'absorbé). */
export async function revertTierMerge({ db, dolibarrPool }, mergeId, actor = 'system') {
  const row = db.prepare('SELECT * FROM tier_merges WHERE id = ?').get(mergeId);
  if (!row) throw new Error('Fusion introuvable');
  if (row.reverted_at) throw new Error('Fusion déjà annulée');
  const j = JSON.parse(row.journal);
  const today = new Date().toISOString().slice(0, 10);

  const conn = await dolibarrPool.getConnection();
  try {
    await conn.beginTransaction();
    for (const [t, { pk, ids }] of Object.entries(j.moves || {})) {
      if (pk && ids.length) await conn.query(`UPDATE ${t} SET fk_soc = ? WHERE ${pk} IN (?) AND fk_soc = ?`, [j.absorbed, ids, j.master]);
    }
    if (j.bank_url?.length) {
      await conn.query(`UPDATE llx_bank_url SET url_id = ? WHERE rowid IN (?) AND url_id = ?`, [j.absorbed, j.bank_url, j.master]);
    }
    // Champs complétés : restaurés seulement s'ils n'ont pas été retouchés depuis.
    for (const [f, v] of Object.entries(j.enrich || {})) {
      const prev = j.previous?.[f] ?? null;
      await conn.query(`UPDATE llx_societe SET ${f} = ? WHERE rowid = ? AND ${f} = ?`, [prev, j.master, v]);
    }
    await conn.query(
      `UPDATE llx_societe SET status = 1, note_private = CONCAT(COALESCE(note_private, ''), ?) WHERE rowid = ?`,
      [`\n[FUSION ANNULÉE ${today}] par ${actor}`, j.absorbed],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  db.transaction(() => {
    for (const [key, ids] of Object.entries(j.app || {})) {
      const [tbl, col] = key.split('.');
      db.prepare(`UPDATE ${tbl} SET ${col} = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND CAST(${col} AS INTEGER) = ?`)
        .run(j.absorbed, ...ids, j.master);
    }
    db.prepare(`UPDATE tier_merges SET reverted_at = CURRENT_TIMESTAMP, reverted_by = ? WHERE id = ?`).run(actor, mergeId);
  })();
  return { master: j.master, absorbed: j.absorbed };
}
