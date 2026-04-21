# Cahier des Charges Opérationnel : Optimisation du Pilotage Stock et Réapprovisionnement

## 1. Diagnostic du Système Actuel

### 1.1. Points Forts
- **Visibilité stock public** : Fiche produit affiche niveau de stock (`En stock` / `Rupture`, message de tension si faible).
- **Recherche catalogue** : Filtre "en stock uniquement" disponible (`p.stock > 0`).
- **POS plus précis** : Interroge `llx_product_stock` sur un entrepôt spécifique (`POS_CONFIG.warehouse = 4`).
- **KPIs admin existants** : `products_total`, `products_out_of_stock`, `low_stock_count`, `stock_value_retail`.
- **Données de vente** : Tops produits, auteurs, catégories du mois disponibles pour calculer la vélocité.

### 1.2. Points Faibles / Goulots d'Étranglement
- **Incohérence source de vérité** : Web (`llx_product.stock`) vs POS (`llx_product_stock` par entrepôt).
- **Vision "temps réel" incomplète** : Cache in-memory mono-instance, pas de moteur d'événements stock multi-canal.
- **Absence de moteur de réapprovisionnement** : Pas de module fournisseurs, commande fournisseur, point de commande, lead time, priorité fournisseur.
- **Seuil de stock bas trop simpliste** : `< 5` pour tous les produits, inadapté aux variations de rythme de vente.
- **Valeur de stock peu exploitable** : `SUM(stock * price_ttc)` (prix de vente) au lieu du coût d'acquisition.
- **Pas de prévention survente e-commerce** : Pas de contrôle de stock explicite à la création de commande web.
- **POS perfectible** : Affichage rupture mais ajout possible au panier, pas de blocage comportemental.
- **Canaux non homogènes** : Web et POS ne raisonnent pas sur la même granularité de stock.
- **Entrepôt codé en dur** : Logique POS dépend d'un dépôt fixe.
- **Alertes absentes** : Pas de système d'alerte automatique stock faible / rupture / surstock.
- **Pas de segmentation ABC** : Tous les livres traités pareil.
- **Stock non réservé** : Commande web sans mécanisme de réservation/déduction préventive.

### 1.3. KPIs Actuels (et Manquants)
- **Présents** : Nombre total de produits, produits en rupture, produits en stock bas (< 5), valeur du stock au prix de vente, top produits du mois.
- **Manquants** : Taux de rotation, couverture de stock, taux de rupture sur période, taux de service, âge du stock, délai moyen de réapprovisionnement, fiabilité fournisseur, valeur du stock au coût, marge immobilisée, coût de possession.

## 2. Modèle de Données Cible (Extensions)

### 2.1. Table `llx_product` (Dolibarr) - Extensions
- `stock_min_seuil` (INTEGER) : Seuil de stock minimum pour alerte (par défaut 5, mais configurable).
- `stock_reorder_point` (INTEGER) : Point de commande calculé (ROP).
- `stock_safety_level` (INTEGER) : Stock de sécurité.
- `stock_lead_time_days` (INTEGER) : Délai d'approvisionnement en jours.
- `stock_supplier_priority_id` (INTEGER) : FK vers `llx_societe` (fournisseur prioritaire).
- `stock_moq` (INTEGER) : Minimum Order Quantity.
- `stock_eoq` (INTEGER) : Economic Order Quantity.
- `stock_abc_class` (VARCHAR(1)) : Classe ABC (A, B, C).
- `stock_xyz_class` (VARCHAR(1)) : Classe XYZ (X, Y, Z).
- `stock_status` (VARCHAR(20)) : Statut calculé (e.g., 'in_stock', 'low_stock', 'reorder', 'out_of_stock', 'dormant').

### 2.2. Nouvelle Table `llx_stock_alert_history`
- `id` (PK)
- `fk_product` (INTEGER)
- `alert_type` (VARCHAR(50)) : 'low_stock', 'reorder_point', 'out_of_stock', 'overstock', 'dormant'.
- `current_stock` (INTEGER)
- `threshold_value` (INTEGER)
- `alert_date` (DATETIME)
- `is_resolved` (BOOLEAN)
- `resolved_date` (DATETIME)
- `fk_user_resolved` (INTEGER)

### 2.3. Nouvelle Table `llx_supplier_product_info` (pour chaque produit/fournisseur)
- `id` (PK)
- `fk_product` (INTEGER)
- `fk_supplier` (INTEGER)
- `supplier_ref` (VARCHAR(100))
- `purchase_price` (REAL)
- `moq` (INTEGER)
- `lead_time_days` (INTEGER)
- `priority_rank` (INTEGER)

## 3. KPIs Cibles et Calculs

### 3.1. Taux de Rotation
- **Formule** : `(Ventes Annuelles en Unités / Stock Moyen en Unités)`
- **Calcul** : Nécessite l'historique des ventes et le stock moyen sur la période.

### 3.2. Couverture de Stock
- **Formule** : `(Stock Disponible en Unités / Vente Moyenne Journalière en Unités)`
- **Calcul** : Stock actuel divisé par la moyenne des ventes des 30, 60 ou 90 derniers jours.

### 3.3. Point de Commande (ROP - Reorder Point)
- **Formule** : `(Vente Moyenne Journalière * Délai d'Approvisionnement) + Stock de Sécurité`
- **Calcul** : Basé sur les données de vente et les paramètres produit/fournisseur.

### 3.4. Quantité Économique de Commande (EOQ - Economic Order Quantity)
- **Formule** : `sqrt((2 * Demande Annuelle * Coût de Passation Commande) / Coût Annuel Possession)`
- **Calcul** : Applicable aux titres à flux régulier.

### 3.5. Taux de Rupture
- **Formule** : `(Nombre de jours en rupture / Nombre total de jours sur la période) * 100`
- **Calcul** : Nécessite un suivi historique des états de stock.

### 3.6. Valeur du Stock au Coût
- **Formule** : `SUM(stock_reel * purchase_price)`
- **Calcul** : Nécessite le prix d'achat par produit.

## 4. Système d'Alertes Automatisées

### 4.1. Types d'Alertes
- **Rupture** : Stock = 0.
- **Sous Point de Commande** : Stock < ROP.
- **Couverture Critique** : Couverture < X jours.
- **Surstock** : Stock > Y fois la vente moyenne.
- **Dormant** : Aucune vente depuis Z jours.

### 4.2. Canaux de Diffusion
- **Tableau de bord admin** : Panneau dédié "Alertes Stock".
- **Email quotidien/hebdomadaire** : Synthèse des alertes critiques.
- **Notifications in-app** : Pour les alertes urgentes.

## 5. Tableau de Bord de Suivi (Backoffice)

### 5.1. Vue d'Ensemble "Santé du Stock"
- Stock total vendable (unités et valeur au coût/prix public).
- Taux de rupture global.
- Couverture moyenne en jours.
- Nombre de SKU en rupture, sous ROP, en surstock, dormant.

### 5.2. Vue "Alertes et Actions"
- Liste des produits nécessitant une action (rupture, sous ROP, surstock, dormant).
- Pour chaque alerte : produit, stock actuel, seuil, ROP, couverture, fournisseur prioritaire, action recommandée (commander X unités).
- Boutons d'action rapide : "Créer commande fournisseur", "Ignorer alerte", "Mettre en promo".

### 5.3. Vue "Performance Stock"
- Graphiques de rotation par catégorie/auteur.
- Évolution de la couverture de stock.
- Coût de possession du stock.
- Ventes perdues estimées (pour ruptures).

### 5.4. Vue "Fournisseurs"
- Liste des fournisseurs avec leurs KPIs (délai moyen, taux de service, fiabilité).
- Historique des commandes fournisseurs.

## 6. Processus de Réapprovisionnement Cible

### 6.1. Étape 1 : Collecte et Calcul Quotidien (Batch Cron)
- Consolider ventes par SKU, canal, dépôt.
- Recalculer : demande moyenne, variabilité, couverture, ROP, stock de sécurité, EOQ.
- Mettre à jour `llx_product` et `llx_stock_alert_history`.

### 6.2. Étape 2 : Génération des Recommandations (Backoffice)
- Afficher les recommandations de commande dans le tableau de bord "Alertes et Actions".
- Proposer automatiquement le fournisseur prioritaire.
- Suggérer les quantités à commander (EOQ ou ROP).

### 6.3. Étape 3 : Validation et Création Commande Fournisseur (Backoffice)
- Interface pour valider les recommandations.
- Génération automatique d'un bon de commande fournisseur dans Dolibarr.
- Suivi du statut de la commande fournisseur (envoyé, confirmé, partiellement livré, reçu, litige).

### 6.4. Étape 4 : Réception et Mise à Jour Stock (Backoffice)
- Enregistrement des réceptions de marchandises.
- Mise à jour automatique du stock Dolibarr.

## 7. Préconisations Stratégiques

### 7.1. Réduire les Coûts de Stock
- Basculer de seuils fixes à seuils calculés par vitesse de vente.
- Réduire le stock de sécurité sur les références à faible criticité et fournisseurs fiables.
- Identifier le stock dormant par âge et lancer une stratégie (promotion, bundle, transfert, arrêt de réappro).
- Mesurer la valeur du stock au coût d'achat.

### 7.2. Garantir le Service Client
- Unifier la source de stock "vendable" fiable par canal.
- Bloquer les ventes POS impossibles et plafonner les quantités au stock disponible.
- Mettre une réserve de sécurité sur les titres critiques.
- Ajouter des statuts intermédiaires côté web (`stock limité`, `réappro en cours`, `sur commande`).

## 8. Plan de Mise en Œuvre (Sprints)

### Sprint 1 (0-30 jours) : Unification et Alertes Basiques
- **Backend** :
    - Unifier la logique de récupération du stock pour le web et le POS (utiliser `llx_product_stock` sur un entrepôt par défaut configurable).
    - Ajouter les champs `stock_min_seuil`, `stock_reorder_point`, `stock_safety_level` à `llx_product`.
    - Créer la table `llx_stock_alert_history`.
    - Implémenter un batch quotidien pour calculer `stock_reorder_point` (version simple) et générer les alertes `rupture` et `sous_seuil` dans `llx_stock_alert_history`.
    - API pour récupérer les alertes stock.
- **Frontend** :
    - Modifier le POS pour bloquer l'ajout au panier ou limiter la quantité au stock disponible.
    - Ajouter un panneau "Alertes Stock" simple dans l'admin (liste des produits en rupture/sous seuil).
    - Afficher la couverture simple (`stock / ventes 30 jours`) sur la fiche produit admin.

### Sprint 2 (30-60 jours) : Fournisseurs et Recommandations
- **Backend** :
    - Créer la table `llx_supplier_product_info`.
    - API pour gérer les fournisseurs et leurs infos produit (prix d'achat, MOQ, lead time).
    - Améliorer le batch quotidien pour calculer la couverture, la rotation, et générer des recommandations de commande (quantité, fournisseur) basées sur ROP et EOQ simple.
    - API pour récupérer les recommandations de commande.
- **Frontend** :
    - Écran "Gestion Fournisseurs" dans l'admin.
    - Panneau "Recommandations de Commande" dans l'admin avec filtres et actions (créer BC).
    - Afficher la valeur du stock au coût dans le dashboard admin.

### Sprint 3 (60-90 jours) : Automatisation et Analytics
- **Backend** :
    - Implémenter la création de bons de commande fournisseurs Dolibarr via API.
    - API pour suivre le statut des commandes fournisseurs.
    - Batch hebdomadaire pour la classification ABC/XYZ.
    - API pour les KPIs avancés (taux de rupture, âge du stock, etc.).
- **Frontend** :
    - Écran "Suivi Commandes Fournisseurs" dans l'admin.
    - Intégrer les KPIs avancés dans le dashboard.
    - Interface pour gérer la classification ABC/XYZ.
    - Mettre en place des notifications email pour les alertes critiques.
