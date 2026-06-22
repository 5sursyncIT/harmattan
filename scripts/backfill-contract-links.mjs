/**
 * Backfill : rattache les contrats Dolibarr existants (créés « à part ») aux
 * manuscrits correspondants, quand AUTEUR ET TITRE concordent (haute confiance).
 *
 *   node scripts/backfill-contract-links.mjs            # DRY-RUN (n'écrit rien)
 *   node scripts/backfill-contract-links.mjs --apply    # applique
 *
 * Réplique la logique de linkContractToManuscript() : lien + contract_id +
 * transition (si favorable) + journalisation frise (contract_linked + devis).
 * Idempotent : ignore les manuscrits déjà liés.
 */
import Database from 'better-sqlite3';
import { transition as wfTransition, logManuscriptEvent } from '../server/manuscript-workflow.js';

const APPLY = process.argv.includes('--apply');
const db = new Database('newsletter.sqlite');

const stripAccents = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Manuscrits sans contrat + auteur.
const manuscripts = db.prepare(`
  SELECT m.id, m.title, m.current_stage, a.firstname, a.lastname
  FROM manuscripts m JOIN authors a ON a.id = m.author_id
  WHERE m.contract_id IS NULL`).all();

// Contrats existants (un contrat = N devis possibles) : regrouper par contract_id.
const quotes = db.prepare('SELECT contract_id, recipient_name, book_title FROM contract_quotes').all();
const byContract = new Map();
for (const q of quotes) {
  if (!byContract.has(q.contract_id)) byContract.set(q.contract_id, { contract_id: q.contract_id, recipient_name: q.recipient_name, book_title: q.book_title, n: 0 });
  byContract.get(q.contract_id).n++;
}

// Tokens significatifs (>3 lettres) du nom, pour comparer auteur ↔ destinataire.
const nameSet = (s) => new Set(stripAccents(s).toLowerCase().split(/[^a-z]+/).filter(t => t.length > 3));
const authorMatch = (msName, recipient) => {
  const a = nameSet(msName), b = nameSet(recipient);
  for (const t of a) if (b.has(t)) return true;
  return false;
};
const titleMatch = (t1, t2) => {
  const a = norm(t1), b = norm(t2);
  if (!a || !b) return false;
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 12 && l.startsWith(s); // l'un préfixe de l'autre (titres tronqués)
};

const matches = [];
for (const m of manuscripts) {
  const msAuthor = `${m.firstname || ''} ${m.lastname || ''}`;
  const cands = [...byContract.values()].filter(c => titleMatch(m.title, c.book_title) && authorMatch(msAuthor, c.recipient_name));
  if (cands.length === 1) matches.push({ m, c: cands[0], msAuthor });
  else if (cands.length > 1) console.log(`  ⚠ ms#${m.id} « ${m.title} » : ${cands.length} contrats candidats (${cands.map(c => c.contract_id).join(', ')}) — ignoré (ambigu)`);
}

console.log(`\nMode : ${APPLY ? 'APPLY (écriture)' : 'DRY-RUN (lecture seule)'}`);
console.log(`Correspondances haute confiance (auteur + titre) : ${matches.length}\n`);
for (const { m, c, msAuthor } of matches) {
  console.log(`  ms#${m.id} [${m.current_stage}] ${msAuthor} — « ${m.title} »`);
  console.log(`     ↔ contrat#${c.contract_id} (${c.n} devis) — ${c.recipient_name} — « ${c.book_title} »`);
}
if (!matches.length) { console.log('  (aucune)'); db.close(); process.exit(0); }

if (!APPLY) { console.log('\nDRY-RUN : rien n\'a été écrit. Relancer avec --apply pour appliquer.'); db.close(); process.exit(0); }

let done = 0;
const tx = db.transaction(() => {
  db.exec(`CREATE TABLE IF NOT EXISTS contract_manuscript_links (
    contract_id INTEGER, manuscript_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (contract_id, manuscript_id))`);
  for (const { m, c } of matches) {
    const fresh = db.prepare('SELECT contract_id, current_stage FROM manuscripts WHERE id = ?').get(m.id);
    if (fresh.contract_id) { console.log(`  ↷ ms#${m.id} déjà lié (#${fresh.contract_id}) — ignoré`); continue; }
    const other = db.prepare('SELECT id FROM manuscripts WHERE contract_id = ?').get(c.contract_id);
    if (other) { console.log(`  ↷ contrat#${c.contract_id} déjà lié au ms#${other.id} — ignoré`); continue; }

    db.prepare('INSERT OR IGNORE INTO contract_manuscript_links (contract_id, manuscript_id) VALUES (?, ?)').run(c.contract_id, m.id);
    const actor = { role: 'system', label: 'backfill (rattachement)' };
    if (fresh.current_stage === 'evaluation_positive') {
      wfTransition(db, m.id, 'contract_pending', actor, { note: `Contrat #${c.contract_id} rattaché (backfill)`, updates: { contract_id: c.contract_id } });
    } else {
      db.prepare("UPDATE manuscripts SET contract_id = ?, updated_at = datetime('now') WHERE id = ?").run(c.contract_id, m.id);
    }
    logManuscriptEvent(db, m.id, 'contract_linked', actor, `Contrat #${c.contract_id} rattaché (backfill auteur+titre)`);
    const devis = db.prepare('SELECT ref, total FROM contract_quotes WHERE contract_id = ?').all(c.contract_id);
    for (const d of devis) logManuscriptEvent(db, m.id, 'quote_created', actor, `Devis ${d.ref} — ${Number(d.total || 0).toLocaleString('fr-FR')} FCFA (rattaché)`);
    done++;
    console.log(`  ✓ ms#${m.id} ↔ contrat#${c.contract_id} rattaché (+${devis.length} devis journalisés)`);
  }
});
tx();
console.log(`\n✓ ${done} rattachement(s) appliqué(s).`);
db.close();
