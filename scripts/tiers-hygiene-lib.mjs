/**
 * Helpers partagés pour la dépollution des tiers Dolibarr.
 *
 * Centralise : connexions (MySQL Dolibarr + SQLite app), les définitions SQL
 * « orphelin » et « vrai fournisseur », et la collecte des ids de tiers
 * RÉFÉRENCÉS côté application (newsletter.sqlite) — qui ne doivent JAMAIS être
 * archivés/modifiés même sans transaction Dolibarr (ex. déposant fraîchement
 * créé, client web sans commande, auteur lié).
 *
 * Aucune écriture ici : pure lecture + utilitaires.
 */

import 'dotenv/config';
import Db from 'better-sqlite3';
import mysql from 'mysql2/promise';

export const SQLITE_PATH = '/var/www/html/senharmattan-shop/newsletter.sqlite';

// Tiers à toujours protéger (clients système POS, etc.). SERVICE PRESSE = 33.
export const PROTECTED_IDS = new Set([33]);

export function openMysql() {
  return mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 4,
  });
}

export function openSqlite(readonly = true) {
  return new Db(SQLITE_PATH, { readonly });
}

// ── Définition SQL : un tiers s est « orphelin » s'il n'a AUCUNE trace
// transactionnelle ni relationnelle dans Dolibarr. Utilisable en sous-requête
// (l'alias du tiers doit être `s`).
export const ORPHAN_PREDICATE = `
  NOT EXISTS(SELECT 1 FROM llx_facture f               WHERE f.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_commande o          WHERE o.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_propal p            WHERE p.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_contrat ct          WHERE ct.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_facture_fourn ff    WHERE ff.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_commande_fournisseur cf WHERE cf.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_expedition e        WHERE e.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_socpeople sp        WHERE sp.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_projet pj           WHERE pj.fk_soc = s.rowid)
  AND NOT EXISTS(SELECT 1 FROM llx_product_fournisseur_price pfp WHERE pfp.fk_soc = s.rowid)
`;

// Définition SQL : « vrai fournisseur » = au moins une trace d'achat.
export const REAL_SUPPLIER_PREDICATE = `(
  EXISTS(SELECT 1 FROM llx_facture_fourn ff       WHERE ff.fk_soc = s.rowid)
  OR EXISTS(SELECT 1 FROM llx_commande_fournisseur cf WHERE cf.fk_soc = s.rowid)
  OR EXISTS(SELECT 1 FROM llx_product_fournisseur_price pfp WHERE pfp.fk_soc = s.rowid)
)`;

// Collecte tous les ids de tiers Dolibarr référencés côté app SQLite.
// Défensif : ignore une table/colonne absente.
export function collectAppLinkedIds(sdb) {
  const ids = new Set();
  const tryCollect = (sql, col = 'id') => {
    try {
      for (const row of sdb.prepare(sql).all()) {
        const v = parseInt(row[col], 10);
        if (Number.isInteger(v) && v > 0) ids.add(v);
      }
    } catch { /* table/colonne absente : on ignore */ }
  };
  tryCollect("SELECT dolibarr_id AS id FROM customers WHERE dolibarr_id IS NOT NULL AND dolibarr_id != ''");
  tryCollect("SELECT dolibarr_thirdparty_id AS id FROM authors WHERE dolibarr_thirdparty_id IS NOT NULL AND dolibarr_thirdparty_id != ''");
  tryCollect("SELECT fk_soc AS id FROM consignors WHERE fk_soc IS NOT NULL");
  // IMPORTANT : ne protéger que les fournisseurs CURÉS (active=1). La table
  // `suppliers` contient ~1524 coquilles active=0 issues d'un sync historique
  // pollué (une ligne par tier fournisseur=1) — ne PAS les protéger, sinon le
  // garde-fou protège la pollution même qu'on veut nettoyer.
  tryCollect("SELECT CAST(dolibarr_supplier_id AS INTEGER) AS id FROM suppliers WHERE active = 1 AND dolibarr_supplier_id IS NOT NULL AND dolibarr_supplier_id != ''");
  return ids;
}

// Téléphone normalisé (pour clustering doublons) : chiffres seulement.
export function normPhone(s) {
  return String(s || '').replace(/\D/g, '');
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const head = columns.join(';');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(';')).join('\n');
  return head + '\n' + body + '\n';
}

export const TODAY = new Date().toISOString().slice(0, 10);
