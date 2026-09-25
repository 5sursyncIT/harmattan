/**
 * Supprime l'entrée en doublon « Célia Sanchez » (intervenants #8) du carnet.
 *
 * Contexte : le carnet contenait deux fiches correcteur pour le même email
 * (celiasanchez4@gmail.com) — #2 active et #8 inactive. La #8 n'est référencée
 * par aucun manuscrit ; elle ne sert qu'à polluer les listes et les audits.
 *
 * Sécurité : la suppression n'a lieu QUE si zéro référence est trouvée sur
 * l'ensemble des colonnes d'affectation. La ligne est affichée avant suppression
 * pour pouvoir la recréer si besoin.
 *
 * Usage : node scripts/cleanup-intervenant-duplicate.mjs [--apply]
 *         (sans --apply : simulation, aucune écriture)
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const TARGET_ID = 8;

const db = new Database(join(ROOT, 'newsletter.sqlite'));

const row = db.prepare('SELECT * FROM intervenants WHERE id = ?').get(TARGET_ID);
if (!row) {
  console.log(`Intervenant #${TARGET_ID} absent — rien à faire (déjà supprimé ?).`);
  process.exit(0);
}
console.log(`Cible : #${row.id} « ${row.nom} » <${row.email}> métier=${row.metier} actif=${row.is_active}`);

// Garde-fou : l'entrée conservée doit exister et être active.
const keeper = db.prepare(
  'SELECT * FROM intervenants WHERE LOWER(email) = LOWER(?) AND metier = ? AND id != ?'
).get(row.email, row.metier, TARGET_ID);
if (!keeper) {
  console.error('ARRÊT : aucune autre fiche pour cet email/métier — supprimer effacerait le seul enregistrement.');
  process.exit(1);
}
console.log(`Conservée : #${keeper.id} « ${keeper.nom} » actif=${keeper.is_active}`);

// Toutes les colonnes de manuscripts pouvant pointer vers un intervenant.
const contactCols = db.prepare("SELECT name FROM pragma_table_info('manuscripts')")
  .all().map((c) => c.name).filter((n) => /_contact_id$/.test(n));

let refs = 0;
console.log('\nRecherche de références :');
for (const col of contactCols) {
  const n = db.prepare(`SELECT COUNT(*) c FROM manuscripts WHERE ${col} = ?`).get(TARGET_ID).c;
  console.log(`  manuscripts.${col} : ${n}`);
  refs += n;
}

// Toute autre table portant une colonne intervenant_id.
for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${t.name}')`).all().map((c) => c.name);
  for (const c of cols.filter((n) => /^intervenant_id$|_intervenant_id$/.test(n))) {
    const n = db.prepare(`SELECT COUNT(*) c FROM "${t.name}" WHERE "${c}" = ?`).get(TARGET_ID).c;
    console.log(`  ${t.name}.${c} : ${n}`);
    refs += n;
  }
}

if (refs > 0) {
  console.error(`\nARRÊT : ${refs} référence(s) trouvée(s) — suppression annulée.`);
  process.exit(1);
}
console.log('\nAucune référence. Suppression sûre.');

if (!APPLY) {
  console.log('SIMULATION — relancer avec --apply pour appliquer.');
  process.exit(0);
}

console.log('Ligne supprimée (à conserver pour restauration éventuelle) :');
console.log(JSON.stringify(row));
db.prepare('DELETE FROM intervenants WHERE id = ?').run(TARGET_ID);
console.log(`\nIntervenant #${TARGET_ID} supprimé.`);
console.table(db.prepare("SELECT id, nom, email, metier, is_active FROM intervenants WHERE metier='correcteur' ORDER BY id").all());
db.close();
