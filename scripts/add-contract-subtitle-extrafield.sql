-- Ajout des extrafields supplémentaires sur les contrats (sous-titre, seuil numérique, achat auteur)
-- Exécution : mysql -u dolibarr -p dolibarr < add-contract-subtitle-extrafield.sql

-- Sous-titre de l'ouvrage
INSERT INTO llx_extrafields (name, label, type, size, elementtype, fieldrequired, pos, alwayseditable, entity)
VALUES
  ('book_subtitle', 'Sous-titre de l''ouvrage', 'varchar', 200, 'contrat', 0, 25, 1, 1),
  ('royalty_digital_threshold_fcfa', 'Seuil report droits numériques (FCFA)', 'int', 11, 'contrat', 0, 65, 1, 1),
  ('author_purchase_enabled', 'Engagement achat auteur', 'boolean', 1, 'contrat', 0, 70, 1, 1),
  ('author_purchase_qty', 'Quantité achat auteur', 'int', 11, 'contrat', 0, 71, 1, 1),
  ('author_purchase_discount', 'Remise achat auteur (%)', 'double', '5,2', 'contrat', 0, 72, 1, 1)
ON DUPLICATE KEY UPDATE label = VALUES(label), size = VALUES(size);

ALTER TABLE llx_contrat_extrafields
  ADD COLUMN IF NOT EXISTS book_subtitle VARCHAR(200) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS royalty_digital_threshold_fcfa INT(11) DEFAULT 20000,
  ADD COLUMN IF NOT EXISTS author_purchase_enabled TINYINT(1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS author_purchase_qty INT(11) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS author_purchase_discount DECIMAL(5,2) DEFAULT 0;
