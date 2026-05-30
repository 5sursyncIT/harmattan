-- ════════════════════════════════════════════════════════════════════════
-- Migration COMPLÈTE des extrafields de contrats (llx_contrat)
-- ────────────────────────────────────────────────────────────────────────
-- Déclare TOUS les extrafields lus/écrits par server/contract-routes.js et
-- server/accounting-routes.js. Sans cette migration, l'API Dolibarr v21
-- (typage strict) ignore silencieusement les array_options non déclarés —
-- d'où des pertes de données (tirage, date de signature, signataires…) et
-- des templates ODT avec des placeholders vides.
--
-- Idempotent : ré-exécutable sans risque (INSERT ... ON DUPLICATE KEY UPDATE
-- + ADD COLUMN IF NOT EXISTS). Met aussi à jour le TYPE des extrafields déjà
-- présents pour garantir la cohérence avec le code (notamment date_signature
-- qui DOIT être un champ `date` → epoch côté API v21).
--
-- Exécution : mysql -u dolibarr -p dolibarr < contract-extrafields-complete.sql
-- ════════════════════════════════════════════════════════════════════════

-- ─── Déclaration des extrafields (llx_extrafields) ──────────────────────
INSERT INTO llx_extrafields (name, label, type, size, elementtype, fieldrequired, pos, alwayseditable, entity)
VALUES
  -- Identité de l'ouvrage / type de contrat
  ('contract_type',                  'Type de contrat',                       'varchar',  60,    'contrat', 0, 10, 1, 1),
  ('book_title',                     'Titre de l''ouvrage',                   'varchar',  300,   'contrat', 0, 20, 1, 1),
  ('book_subtitle',                  'Sous-titre de l''ouvrage',              'varchar',  200,   'contrat', 0, 25, 1, 1),
  ('book_isbn',                      'ISBN',                                  'varchar',  20,    'contrat', 0, 30, 1, 1),
  -- Rémunération de l'auteur
  ('royalty_rate_print',            'Taux royalties papier (%)',             'double',   '5,2', 'contrat', 0, 40, 1, 1),
  ('royalty_rate_digital',          'Taux royalties numérique (%)',          'double',   '5,2', 'contrat', 0, 50, 1, 1),
  ('royalty_threshold',             'Seuil de versement (exemplaires)',      'int',      11,    'contrat', 0, 60, 1, 1),
  ('royalty_digital_threshold_fcfa','Seuil report droits numériques (FCFA)', 'int',      11,    'contrat', 0, 65, 1, 1),
  ('free_author_copies',            'Exemplaires gratuits auteur',           'int',      11,    'contrat', 0, 66, 1, 1),
  -- Engagement d'achat auteur (annexe)
  ('author_purchase_enabled',       'Engagement achat auteur',               'boolean',  1,     'contrat', 0, 70, 1, 1),
  ('author_purchase_qty',           'Quantité achat auteur',                 'int',      11,    'contrat', 0, 71, 1, 1),
  ('author_purchase_discount',      'Remise achat auteur (%)',               'double',   '5,2', 'contrat', 0, 72, 1, 1),
  -- Caractéristiques de fabrication (v2)
  ('tirage_initial',                'Tirage initial',                        'int',      11,    'contrat', 0, 80, 1, 1),
  ('format_ouvrage',                'Format de l''ouvrage',                  'varchar',  60,    'contrat', 0, 81, 1, 1),
  ('prix_public_previsionnel',      'Prix public prévisionnel (€)',          'double',   '9,2', 'contrat', 0, 82, 1, 1),
  ('nombre_pages_estime',           'Nombre de pages estimé',                'int',      11,    'contrat', 0, 83, 1, 1),
  ('exemplaires_sp',                'Exemplaires service de presse',         'int',      11,    'contrat', 0, 84, 1, 1),
  -- Signature
  ('date_signature',                'Date de signature',                     'date',     NULL,  'contrat', 0, 90, 1, 1),
  ('editeur_signataire_nom',        'Nom du signataire éditeur',             'varchar',  120,   'contrat', 0, 91, 1, 1),
  ('editeur_signataire_qualite',    'Qualité du signataire éditeur',         'varchar',  120,   'contrat', 0, 92, 1, 1),
  ('signature_auteur_nom',          'Nom du signataire auteur (PDF signé)',  'varchar',  120,   'contrat', 0, 93, 1, 1),
  ('signature_auteur_date',         'Date de signature auteur (PDF signé)',  'varchar',  20,    'contrat', 0, 94, 1, 1)
ON DUPLICATE KEY UPDATE label = VALUES(label), type = VALUES(type), size = VALUES(size);

-- ─── Colonnes physiques (llx_contrat_extrafields) ───────────────────────
ALTER TABLE llx_contrat_extrafields
  ADD COLUMN IF NOT EXISTS contract_type                   VARCHAR(60)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS book_title                      VARCHAR(300)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS book_subtitle                   VARCHAR(200)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS book_isbn                       VARCHAR(20)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS royalty_rate_print              DECIMAL(5,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS royalty_rate_digital            DECIMAL(5,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS royalty_threshold               INT(11)       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS royalty_digital_threshold_fcfa  INT(11)       DEFAULT 20000,
  ADD COLUMN IF NOT EXISTS free_author_copies              INT(11)       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS author_purchase_enabled         TINYINT(1)    DEFAULT 0,
  ADD COLUMN IF NOT EXISTS author_purchase_qty             INT(11)       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS author_purchase_discount        DECIMAL(5,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tirage_initial                  INT(11)       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS format_ouvrage                  VARCHAR(60)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS prix_public_previsionnel        DECIMAL(9,2)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS nombre_pages_estime             INT(11)       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exemplaires_sp                  INT(11)       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS date_signature                  DATE          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS editeur_signataire_nom          VARCHAR(120)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS editeur_signataire_qualite      VARCHAR(120)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS signature_auteur_nom            VARCHAR(120)  DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS signature_auteur_date           VARCHAR(20)   DEFAULT NULL;
