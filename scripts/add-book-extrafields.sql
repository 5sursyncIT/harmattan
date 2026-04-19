-- Ajout des extrafields pour la gestion structurée des livres
-- Exécution : mysql -u dolibarr -p dolibarr < add-book-extrafields.sql

INSERT INTO llx_extrafields (name, label, type, size, elementtype, fieldrequired, pos, alwayseditable, entity)
VALUES
  ('publication_year', 'Année de publication', 'int',     4,   'product', 0, 100, 1, 1),
  ('nombre_pages',     'Nombre de pages',      'int',     11,  'product', 0, 110, 1, 1),
  ('editeur',          'Éditeur',              'varchar', 100, 'product', 0, 120, 1, 1)
ON DUPLICATE KEY UPDATE label = VALUES(label);

-- Ajout des colonnes correspondantes dans llx_product_extrafields
ALTER TABLE llx_product_extrafields
  ADD COLUMN IF NOT EXISTS publication_year INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS nombre_pages INT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS editeur VARCHAR(100) DEFAULT NULL;
