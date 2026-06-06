/**
 * Migration : table `book_upcoming` — pilote la section « Ouvrages à paraître »
 * directement depuis le catalogue (fiche produit dans /admin/books).
 *
 * Chaque ligne marque un produit Dolibarr réel comme « à paraître » et porte
 * sa date de parution + (optionnel) une accroche et une remise de précommande.
 * La section de la page d'accueil et la précommande de la fiche produit lisent
 * cette table (jointe aux produits Dolibarr), il n'y a donc qu'une seule source
 * de vérité, gérée nativement depuis le formulaire livre.
 *
 * Idempotent — peut être appelée à chaque boot.
 */
export function migrateAddUpcomingBooks(db) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS book_upcoming (
      product_id            INTEGER PRIMARY KEY,
      release_date          TEXT,                 -- ISO yyyy-mm-dd (nullable)
      summary               TEXT,                 -- accroche optionnelle (sinon description produit)
      preorder_discount_pct REAL DEFAULT 0,       -- % de remise précommande (0 = aucune)
      sort_order            INTEGER DEFAULT 0,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    )`);
  } catch (err) {
    console.error('[MIGRATION] create book_upcoming failed:', err.message);
  }

  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_book_upcoming_release ON book_upcoming(release_date)');
  } catch (err) {
    console.error('[MIGRATION] index book_upcoming failed:', err.message);
  }
}
