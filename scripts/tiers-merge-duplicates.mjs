#!/usr/bin/env node
/**
 * T3 — Fusion des tiers en doublon (llx_societe).
 *
 * Regroupe les tiers ACTIFS partageant une même identité fiable (email, et/ou
 * téléphone), choisit un MAÎTRE, repointe tout l'historique (factures, commandes,
 * devis, contrats, contacts, projets…) des absorbés vers le maître, enrichit le
 * maître des champs manquants, puis ARCHIVE les absorbés (status=0).
 *
 * ⚠️ NE FUSIONNE JAMAIS sur le nom (patronymes communs = personnes distinctes).
 *
 * Choix du maître (par ordre) : lié app > plus d'historique > plus complet >
 * plus ancien (rowid). Un cluster contenant ≥2 tiers liés app/protégés est
 * IGNORÉ (révision manuelle) pour ne pas archiver un enregistrement référencé.
 *
 * NE touche PAS aux tables descriptives du tiers (adresses, RIB, remises,
 * catégories, commerciaux, perentity) : l'absorbé reste archivé avec les siennes.
 *
 * Réversibilité : journal JSON complet (rowids repointés par table + champs
 * enrichis + absorbés archivés) → réversion exacte. Dry-run par défaut.
 *
 * Usage :
 *   node scripts/tiers-merge-duplicates.mjs                 (dry-run, clé=email)
 *   node scripts/tiers-merge-duplicates.mjs --key=both      (email + téléphone)
 *   node scripts/tiers-merge-duplicates.mjs --key=phone
 *   node scripts/tiers-merge-duplicates.mjs --apply [--key=...]
 */

import { writeFileSync } from 'node:fs';
import {
  openMysql, openSqlite, collectAppLinkedIds, normPhone, toCsv, TODAY, PROTECTED_IDS,
} from './tiers-hygiene-lib.mjs';

const apply = process.argv.includes('--apply');
const keyArg = (process.argv.find((a) => a.startsWith('--key=')) || '--key=email').split('=')[1];
const useEmail = keyArg === 'email' || keyArg === 'both';
const usePhone = keyArg === 'phone' || keyArg === 'both';
const MIN_PHONE_DIGITS = 8; // évite de clusteriser sur des fragments

// Tables dont le fk_soc = historique/relation à déplacer vers le maître.
const REPOINT_TABLES = [
  'llx_facture', 'llx_facture_rec', 'llx_facture_fourn', 'llx_facture_fourn_rec',
  'llx_commande', 'llx_commande_fournisseur', 'llx_propal', 'llx_supplier_proposal',
  'llx_contrat', 'llx_expedition', 'llx_delivery', 'llx_reception',
  'llx_fichinter', 'llx_fichinter_rec', 'llx_deplacement', 'llx_don', 'llx_mrp_mo',
  'llx_actioncomm', 'llx_projet', 'llx_ticket', 'llx_partnership',
  'llx_socpeople', 'llx_societe_contacts',
  'llx_product_customer_price', 'llx_product_customer_price_log',
  'llx_product_fournisseur_price', 'llx_product_thirdparty',
  'llx_prelevement_lignes', 'llx_societe_account', 'llx_adherent',
  'llx_eventorganization_conferenceorboothattendee', 'llx_recruitment_recruitmentjobposition',
  'llx_oauth_token', 'llx_notify', 'llx_notify_def', 'llx_user',
];

const pool = openMysql();
const sdb = openSqlite(true);
const appLinked = collectAppLinkedIds(sdb);
const LOG = `/var/www/html/senharmattan-shop/backups/tiers-hygiene/tiers_T3_merge_${TODAY}.json`;
const PLAN_CSV = `/tmp/tiers_T3_plan_${TODAY}.csv`;

const isProtected = (id) => appLinked.has(id) || PROTECTED_IDS.has(id);

try {
  console.log(`\nT3 — Fusion doublons · mode ${apply ? 'APPLY' : 'DRY-RUN'} · clé=${keyArg}`);

  // ── 1. Charger les tiers actifs ─────────────────────────────
  const [tiers] = await pool.query(
    `SELECT rowid, nom, name_alias, email, phone, address, zip, town,
            client, fournisseur, code_client, datec
       FROM llx_societe WHERE status = 1`
  );
  const byId = new Map(tiers.map((t) => [t.rowid, t]));

  // ── 2. Union-find par identité ──────────────────────────────
  const parent = new Map(tiers.map((t) => [t.rowid, t.rowid]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const linkBy = (keyFn) => {
    const groups = new Map();
    for (const t of tiers) {
      const k = keyFn(t);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(t.rowid);
    }
    for (const ids of groups.values()) for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  };
  if (useEmail) linkBy((t) => { const e = (t.email || '').trim().toLowerCase(); return e || null; });
  if (usePhone) linkBy((t) => { const p = normPhone(t.phone); return p.length >= MIN_PHONE_DIGITS ? p : null; });

  // Composants de taille >= 2
  const comps = new Map();
  for (const t of tiers) { const r = find(t.rowid); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(t.rowid); }
  const clusters = [...comps.values()].filter((m) => m.length > 1);

  // ── 3. Poids transactionnel (6 tables principales, en bloc) ─
  const allClustered = clusters.flat();
  const txWeight = new Map(allClustered.map((id) => [id, 0]));
  if (allClustered.length) {
    const ph = allClustered.map(() => '?').join(',');
    for (const tbl of ['llx_facture', 'llx_commande', 'llx_propal', 'llx_contrat', 'llx_facture_fourn', 'llx_commande_fournisseur']) {
      try {
        const [rows] = await pool.query(`SELECT fk_soc, COUNT(*) c FROM ${tbl} WHERE fk_soc IN (${ph}) GROUP BY fk_soc`, allClustered);
        for (const r of rows) txWeight.set(r.fk_soc, (txWeight.get(r.fk_soc) || 0) + Number(r.c));
      } catch { /* table absente */ }
    }
  }

  const completeness = (t) => (t.email ? 1 : 0) + (normPhone(t.phone) ? 1 : 0) + (t.name_alias ? 1 : 0) + Math.min(1, (t.nom || '').length / 12);

  // ── 4. Choix du maître + classification ─────────────────────
  const toMerge = [];
  const toReview = [];
  for (const members of clusters) {
    const protectedMembers = members.filter(isProtected);
    if (protectedMembers.length > 1) { toReview.push({ members, reason: `${protectedMembers.length} membres liés app/protégés` }); continue; }

    let master;
    if (protectedMembers.length === 1) master = protectedMembers[0];
    else {
      master = [...members].sort((a, b) => {
        const ta = byId.get(a), tb = byId.get(b);
        return (txWeight.get(b) - txWeight.get(a))
          || (completeness(tb) - completeness(ta))
          || (a - b);
      })[0];
    }
    const absorbed = members.filter((id) => id !== master);
    toMerge.push({ master, absorbed });
  }

  // ── 5. Récupérer les rowids à repointer (en bloc par table) ─
  const allAbsorbed = toMerge.flatMap((c) => c.absorbed);
  // moves : table -> Map(absorbedId -> [rowids])  (pour tables avec rowid)
  // movesNoRowid : table -> Map(absorbedId -> count) (tables sans rowid)
  const moves = new Map();
  const pkByTable = {}; // table -> 'rowid' | 'id' (pour le journal de réversion)
  if (allAbsorbed.length) {
    const ph = allAbsorbed.map(() => '?').join(',');
    for (const tbl of REPOINT_TABLES) {
      // Détecte la vraie PK : rowid prioritaire, sinon id (ex. llx_actioncomm).
      let pk = null;
      try {
        const [cols] = await pool.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME IN ('rowid','id')`,
          [process.env.MYSQL_DATABASE, tbl]
        );
        const names = cols.map((c) => c.COLUMN_NAME);
        pk = names.includes('rowid') ? 'rowid' : (names.includes('id') ? 'id' : null);
      } catch { continue; }
      if (!pk) continue;
      try {
        const [rows] = await pool.query(`SELECT ${pk} AS pk, fk_soc FROM ${tbl} WHERE fk_soc IN (${ph})`, allAbsorbed);
        if (rows.length) {
          pkByTable[tbl] = pk;
          const m = new Map();
          for (const r of rows) { if (!m.has(r.fk_soc)) m.set(r.fk_soc, []); m.get(r.fk_soc).push(r.pk); }
          moves.set(tbl, m);
        }
      } catch { /* table absente / inaccessible */ }
    }
  }

  const rowsForCluster = (cluster) => {
    const out = {};
    for (const [tbl, m] of moves) {
      const ids = [];
      for (const a of cluster.absorbed) if (m.has(a)) ids.push(...m.get(a));
      if (ids.length) out[tbl] = ids;
    }
    return out;
  };

  // ── 6. Rapport ──────────────────────────────────────────────
  console.log(`\nClusters détectés (≥2)            : ${clusters.length}`);
  console.log(`  à fusionner                     : ${toMerge.length}`);
  console.log(`  à revoir manuellement           : ${toReview.length}`);
  console.log(`Tiers absorbés (seront archivés)  : ${allAbsorbed.length}`);

  const planRows = [];
  let totalMovedRows = 0;
  for (const c of toMerge) {
    const mt = byId.get(c.master);
    const rws = rowsForCluster(c);
    const moved = Object.values(rws).reduce((s, a) => s + a.length, 0);
    totalMovedRows += moved;
    for (const a of c.absorbed) {
      const at = byId.get(a);
      planRows.push({
        cluster_maitre: c.master, maitre_nom: mt.nom, maitre_email: mt.email || '', maitre_tel: mt.phone || '',
        absorbe_id: a, absorbe_nom: at.nom, absorbe_email: at.email || '', absorbe_tel: at.phone || '',
        absorbe_tx: txWeight.get(a) || 0,
      });
    }
  }
  writeFileSync(PLAN_CSV, toCsv(planRows, ['cluster_maitre', 'maitre_nom', 'maitre_email', 'maitre_tel', 'absorbe_id', 'absorbe_nom', 'absorbe_email', 'absorbe_tel', 'absorbe_tx']));
  console.log(`Lignes d'historique à repointer   : ${totalMovedRows}`);
  console.log(`Plan détaillé (CSV)               : ${PLAN_CSV}`);

  // Aperçu des 8 premiers clusters
  console.log('\nAperçu (8 premiers clusters) :');
  for (const c of toMerge.slice(0, 8)) {
    const mt = byId.get(c.master);
    const key = mt.email || normPhone(mt.phone);
    console.log(`  ◆ ${key}  → MAÎTRE #${c.master} "${mt.nom}" (tx=${txWeight.get(c.master) || 0}) ; absorbe ${c.absorbed.map((a) => '#' + a).join(', ')}`);
  }
  if (toReview.length) {
    console.log('\nClusters à revoir manuellement :');
    for (const r of toReview.slice(0, 10)) console.log(`  ⚠ ${r.members.map((m) => '#' + m).join(', ')} — ${r.reason}`);
  }

  if (!apply) {
    console.log('\nDRY-RUN : aucune écriture. Relancer avec --apply pour exécuter.\n');
  } else if (toMerge.length === 0) {
    console.log('\nRien à fusionner.\n');
  } else {
    // ── 7. Application (transaction par cluster) ──────────────
    const journal = { date: TODAY, key: keyArg, pk: pkByTable, clusters: [] };
    let okClusters = 0, archived = 0, repointed = 0, conflicts = 0;

    for (const c of toMerge) {
      const conn = await pool.getConnection();
      // moves : agrégat par table (pour comptage) ; movesByAbsorbed : détail
      // table -> absorbé -> [rowids] (pour une réversion EXACTE).
      const entry = { master: c.master, absorbed: c.absorbed, moves: {}, movesByAbsorbed: {}, conflicts: {}, enrich: {}, archived: [] };
      try {
        await conn.beginTransaction();

        // Enrichissement du maître (uniquement champs vides)
        const mt = byId.get(c.master);
        const fill = {};
        for (const f of ['email', 'phone', 'name_alias', 'address', 'zip', 'town']) {
          if (!mt[f]) {
            const donor = c.absorbed.map((a) => byId.get(a)).find((x) => x[f]);
            if (donor) { fill[f] = donor[f]; entry.enrich[f] = mt[f] || null; }
          }
        }
        if (Object.keys(fill).length) {
          const sets = Object.keys(fill).map((k) => `${k}=?`).join(', ');
          await conn.query(`UPDATE llx_societe SET ${sets} WHERE rowid=?`, [...Object.values(fill), c.master]);
        }

        // Repointage : on itère PAR ABSORBÉ et PAR TABLE pour journaliser
        // précisément (réversion exacte même avec plusieurs absorbés).
        for (const a of c.absorbed) {
          for (const [tbl, m] of moves) {
            const ids = m.get(a);
            if (!ids || !ids.length) continue;
            const pk = pkByTable[tbl] || 'rowid';
            const movedHere = [];
            for (let i = 0; i < ids.length; i += 500) {
              const batch = ids.slice(i, i + 500);
              const ph = batch.map(() => '?').join(',');
              try {
                await conn.query(`UPDATE ${tbl} SET fk_soc=? WHERE ${pk} IN (${ph})`, [c.master, ...batch]);
                movedHere.push(...batch);
              } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') {
                  for (const rid of batch) {
                    try { await conn.query(`UPDATE ${tbl} SET fk_soc=? WHERE ${pk}=?`, [c.master, rid]); movedHere.push(rid); }
                    catch { entry.conflicts[tbl] = (entry.conflicts[tbl] || 0) + 1; conflicts++; }
                  }
                } else throw e;
              }
            }
            if (movedHere.length) {
              entry.moves[tbl] = (entry.moves[tbl] || 0) + movedHere.length;
              if (!entry.movesByAbsorbed[tbl]) entry.movesByAbsorbed[tbl] = {};
              entry.movesByAbsorbed[tbl][a] = movedHere;
              repointed += movedHere.length;
            }
          }
        }

        // Archivage des absorbés + marque
        for (const a of c.absorbed) {
          await conn.query(
            `UPDATE llx_societe SET status=0, fournisseur=0,
               note_private = CONCAT(COALESCE(note_private,''), ?)
             WHERE rowid=?`,
            [`\n[FUSION ${TODAY}] absorbé dans tiers #${c.master}`, a]
          );
          entry.archived.push(a);
          archived++;
        }

        await conn.commit();
        okClusters++;
        journal.clusters.push(entry);
      } catch (e) {
        await conn.rollback();
        console.error(`  ✗ cluster maître #${c.master} : rollback (${e.message})`);
        journal.clusters.push({ ...entry, error: e.message, rolledBack: true });
      } finally {
        conn.release();
      }
    }

    writeFileSync(LOG, JSON.stringify(journal, null, 2));
    console.log(`\n✓ APPLY terminé : ${okClusters}/${toMerge.length} clusters fusionnés, ${repointed} lignes repointées, ${archived} tiers archivés${conflicts ? `, ${conflicts} conflits ignorés` : ''}.`);
    console.log(`Journal de réversion : ${LOG}`);
    console.log(`Réversion : node scripts/tiers-merge-revert.mjs ${LOG} --apply\n`);
  }
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  sdb.close();
}
