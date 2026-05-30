#!/usr/bin/env node
/**
 * Diagnostic d'hygiène des tiers Dolibarr — LECTURE SEULE.
 *
 * Produit un rapport chiffré et exporte des CSV détaillés des candidats à la
 * dépollution (T1 flag fournisseur, T2 orphelins, doublons email/téléphone),
 * en tenant compte des garde-fous (tiers liés côté app, ids protégés).
 *
 * N'écrit JAMAIS dans aucune base. Sert de base de décision avant
 * tiers-fix-fournisseur.mjs et tiers-archive-orphans.mjs.
 *
 * Usage : node scripts/tiers-hygiene-diagnose.mjs
 */

import { writeFileSync } from 'node:fs';
import {
  openMysql, openSqlite, collectAppLinkedIds, normPhone, toCsv, TODAY,
  ORPHAN_PREDICATE, REAL_SUPPLIER_PREDICATE, PROTECTED_IDS,
} from './tiers-hygiene-lib.mjs';

const pool = openMysql();
const sdb = openSqlite(true);
const appLinked = collectAppLinkedIds(sdb);
const OUT = (name) => `/tmp/tiers_${name}_${TODAY}.csv`;

const line = (l = '') => console.log(l);
const h = (t) => { line(); line('═'.repeat(64)); line('  ' + t); line('═'.repeat(64)); };

try {
  line(`\nDiagnostic hygiène des tiers — ${TODAY}`);
  line(`Tiers liés côté app (protégés) : ${appLinked.size}`);
  line(`Ids protégés système : ${[...PROTECTED_IDS].join(', ') || '—'}`);

  // ── Vue d'ensemble ──────────────────────────────────────────
  h('VUE D\'ENSEMBLE');
  const [[ov]] = await pool.query(`SELECT
      COUNT(*) total,
      SUM(client>0) clients, SUM(fournisseur=1) flag_fournisseur,
      SUM(status=0) deja_inactifs,
      SUM(email IS NULL OR email='') sans_email,
      SUM(phone IS NULL OR phone='') sans_tel
    FROM llx_societe`);
  console.table([ov]);

  // ── T1 : flag fournisseur ───────────────────────────────────
  h('T1 — FLAG FOURNISSEUR');
  const [[f]] = await pool.query(`SELECT
      SUM(fournisseur=1) flag_total,
      SUM(fournisseur=1 AND ${REAL_SUPPLIER_PREDICATE}) vrais
    FROM llx_societe s`);
  const [faux] = await pool.query(
    `SELECT s.rowid, s.nom, s.client, s.email, s.phone, s.code_fournisseur
       FROM llx_societe s
      WHERE s.fournisseur = 1 AND NOT ${REAL_SUPPLIER_PREDICATE}`
  );
  const fauxClean = faux.filter((r) => !appLinked.has(r.rowid) && !PROTECTED_IDS.has(r.rowid));
  const fauxProtégés = faux.length - fauxClean.length;
  const sansRoleApres = fauxClean.filter((r) => !(r.client > 0)).length;
  console.table([{
    flag_fournisseur: Number(f.flag_total),
    vrais_fournisseurs: Number(f.vrais),
    faux_a_corriger: fauxClean.length,
    faux_mais_proteges_app: fauxProtégés,
    deviendront_sans_role_client: sansRoleApres,
  }]);
  writeFileSync(OUT('T1_faux_fournisseurs'),
    toCsv(fauxClean, ['rowid', 'nom', 'client', 'email', 'phone', 'code_fournisseur']));
  line(`→ CSV : ${OUT('T1_faux_fournisseurs')}`);

  // ── T2 : orphelins ──────────────────────────────────────────
  h('T2 — TIERS ORPHELINS (aucune transaction ni relation)');
  const [orph] = await pool.query(
    `SELECT s.rowid, s.nom, s.client, s.fournisseur, s.email, s.phone,
            DATE_FORMAT(s.datec,'%Y-%m-%d') datec, s.status
       FROM llx_societe s
      WHERE ${ORPHAN_PREDICATE}
      ORDER BY s.datec ASC`
  );
  const orphClean = orph.filter((r) => !appLinked.has(r.rowid) && !PROTECTED_IDS.has(r.rowid));
  const orphProtégés = orph.length - orphClean.length;
  console.table([{
    orphelins_total: orph.length,
    archivables: orphClean.length,
    proteges_app_ou_systeme: orphProtégés,
    deja_inactifs: orphClean.filter((r) => r.status === 0).length,
  }]);
  writeFileSync(OUT('T2_orphelins'),
    toCsv(orphClean, ['rowid', 'nom', 'client', 'fournisseur', 'email', 'phone', 'datec', 'status']));
  line(`→ CSV : ${OUT('T2_orphelins')}`);

  // ── Doublons fiables (email puis téléphone) ─────────────────
  h('DOUBLONS FIABLES (email / téléphone) — pour T3 (fusion)');
  const [withId] = await pool.query(
    `SELECT s.rowid, s.nom, s.email, s.phone, s.client, s.fournisseur,
            (SELECT COUNT(*) FROM llx_facture f WHERE f.fk_soc=s.rowid)
           +(SELECT COUNT(*) FROM llx_commande o WHERE o.fk_soc=s.rowid)
           +(SELECT COUNT(*) FROM llx_propal p WHERE p.fk_soc=s.rowid)
           +(SELECT COUNT(*) FROM llx_contrat ct WHERE ct.fk_soc=s.rowid) AS nb_tx
       FROM llx_societe s`
  );
  const byEmail = new Map();
  const byPhone = new Map();
  for (const r of withId) {
    const e = (r.email || '').trim().toLowerCase();
    if (e) { if (!byEmail.has(e)) byEmail.set(e, []); byEmail.get(e).push(r); }
    const p = normPhone(r.phone);
    if (p.length >= 6) { if (!byPhone.has(p)) byPhone.set(p, []); byPhone.get(p).push(r); }
  }
  const emailClusters = [...byEmail.entries()].filter(([, v]) => v.length > 1);
  const phoneClusters = [...byPhone.entries()].filter(([, v]) => v.length > 1);
  console.table([{
    clusters_email: emailClusters.length,
    tiers_en_doublon_email: emailClusters.reduce((s, [, v]) => s + v.length, 0),
    clusters_tel: phoneClusters.length,
    tiers_en_doublon_tel: phoneClusters.reduce((s, [, v]) => s + v.length, 0),
  }]);

  // Export des clusters à plat (clé, membre, nb_tx, suggestion maître)
  const clusterRows = [];
  const pushClusters = (clusters, type) => {
    for (const [key, members] of clusters) {
      // Maître suggéré : plus de transactions, puis le plus petit rowid (ancienneté)
      const master = [...members].sort((a, b) => (b.nb_tx - a.nb_tx) || (a.rowid - b.rowid))[0];
      for (const m of members) {
        clusterRows.push({
          type, cle: key, rowid: m.rowid, nom: m.nom, email: m.email, phone: m.phone,
          nb_tx: m.nb_tx, role: m.master,
          maitre_suggere: m.rowid === master.rowid ? 'MAITRE' : 'absorbe',
        });
      }
    }
  };
  pushClusters(emailClusters, 'email');
  pushClusters(phoneClusters, 'tel');
  writeFileSync(OUT('doublons_clusters'),
    toCsv(clusterRows, ['type', 'cle', 'rowid', 'nom', 'email', 'phone', 'nb_tx', 'maitre_suggere']));
  line(`→ CSV : ${OUT('doublons_clusters')}`);

  // ── Piège patronymes : rappel ───────────────────────────────
  h('RAPPEL — NE PAS dédupliquer par nom');
  const [names] = await pool.query(
    `SELECT nom, COUNT(*) cnt FROM llx_societe GROUP BY LOWER(TRIM(nom)) HAVING cnt>1 ORDER BY cnt DESC LIMIT 8`
  );
  console.table(names);
  line('Ces gros groupes sont des patronymes communs (personnes distinctes) — fusion interdite sur le nom.');

  line('\n✓ Diagnostic terminé — aucune écriture effectuée.\n');
} catch (e) {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
  sdb.close();
}
