# Cahier Des Charges Operationnel

## Pilotage Stock Et Reapprovisionnement

### 1. Contexte

Le systeme actuel dispose deja de plusieurs briques utiles pour la gestion des stocks :

- affichage du stock sur le site public ;
- filtrage catalogue sur la disponibilite ;
- controle de stock dans le POS ;
- KPIs admin de base sur la rupture, le stock bas et la valeur de stock ;
- exploitation des ventes mensuelles via les statistiques.

En revanche, le dispositif reste principalement descriptif. Il permet de voir l'etat du stock, mais pas encore de piloter efficacement le reapprovisionnement, d'anticiper les ruptures ou de prioriser les fournisseurs.

L'objectif de ce document est de definir un cadre de mise en oeuvre concret pour transformer le dispositif actuel en systeme de pilotage stock et reapprovisionnement, adapte a une librairie et a une maison d'edition.

### 2. Objectifs Metier

Les objectifs prioritaires sont les suivants :

1. garantir une visibilite fiable et quasi temps reel du stock vendable sur tous les canaux ;
2. reduire les ruptures sur les references critiques ;
3. diminuer la valeur de stock immobilisee sur les references lentes ou dormantes ;
4. automatiser les alertes et les recommandations de reapprovisionnement ;
5. outiller la prise de decision fournisseur ;
6. ameliorer le taux de service client tout en reduisant les couts de possession.

### 3. Diagnostic Du Systeme Actuel

#### 3.1 Points forts

- Le stock est deja expose sur le site public et dans le POS.
- Le POS travaille sur un depot explicite et verifie la disponibilite avant la vente.
- Le backoffice dispose deja d'indicateurs de base :
  - total produits ;
  - produits en rupture ;
  - produits en stock bas ;
  - valeur de stock au prix de vente ;
  - tops produits du mois.
- Les donnees de ventes sont deja disponibles pour construire une logique de rotation et de couverture.

#### 3.2 Limites structurelles

- Le site public et le POS ne s'appuient pas exactement sur la meme granularite de stock.
- Le seuil de stock bas est fixe et uniforme, ce qui est insuffisant.
- Il n'existe pas de module fournisseur et de commande fournisseur.
- Aucun point de commande n'est calcule par SKU.
- Aucune couverture de stock n'est calculee.
- Aucun moteur d'alertes automatiques n'est visible.
- Il n'existe pas de segmentation ABC/XYZ du catalogue.
- La valeur de stock est calculee au prix de vente et non au cout.

#### 3.3 Risques actuels

- rupture non anticipee sur les references a forte rotation ;
- surstock sur les references lentes ou dormantes ;
- mauvaise priorisation des achats ;
- manque de coherence entre canaux ;
- decisions de reapprovisionnement fondees sur l'intuition plutot que sur des regles ;
- immobilisation de tresorerie non optimisee.

### 4. Cible Fonctionnelle

Le systeme cible doit couvrir 5 couches :

1. visibilite stock ;
2. alertes automatiques ;
3. recommandations de reapprovisionnement ;
4. execution des commandes fournisseur ;
5. pilotage et reporting.

### 5. Modele De Donnees A Ajouter

Les structures ci-dessous peuvent etre implementees dans SQLite pour le pilotage local, ou dans MySQL si le choix est de centraliser la logique dans l'environnement Dolibarr.

#### 5.1 Table `stock_policies`

Finalite : stocker les regles de pilotage par produit.

Champs recommandes :

- `id`
- `product_id`
- `warehouse_id`
- `abc_class` : `A`, `B`, `C`
- `xyz_class` : `X`, `Y`, `Z`
- `service_level_target`
- `lead_time_days`
- `review_period_days`
- `safety_stock`
- `reorder_point`
- `reorder_qty_default`
- `min_order_qty`
- `order_multiple`
- `max_stock_target`
- `is_manual_override`
- `notes`
- `updated_at`

#### 5.2 Table `suppliers`

Finalite : centraliser les fournisseurs prioritaires et leurs regles.

Champs recommandes :

- `id`
- `supplier_name`
- `dolibarr_supplier_id`
- `priority_rank`
- `lead_time_avg_days`
- `lead_time_max_days`
- `minimum_order_amount`
- `minimum_order_qty`
- `order_multiple`
- `freight_free_threshold`
- `reliability_score`
- `quality_score`
- `cost_score`
- `active`
- `notes`

#### 5.3 Table `supplier_products`

Finalite : associer produits et fournisseurs.

Champs recommandes :

- `id`
- `product_id`
- `supplier_id`
- `supplier_sku`
- `purchase_price`
- `currency`
- `lead_time_days_override`
- `is_primary`
- `is_preferred_backup`
- `last_purchase_date`
- `last_purchase_price`

#### 5.4 Table `stock_alerts`

Finalite : historiser les alertes et leur traitement.

Champs recommandes :

- `id`
- `product_id`
- `warehouse_id`
- `alert_type`
- `severity`
- `current_stock`
- `coverage_days`
- `reorder_point_snapshot`
- `recommended_qty`
- `supplier_id`
- `status` : `open`, `acknowledged`, `resolved`, `ignored`
- `created_at`
- `resolved_at`
- `resolved_by`

#### 5.5 Table `purchase_recommendations`

Finalite : generer les propositions de reapprovisionnement.

Champs recommandes :

- `id`
- `product_id`
- `warehouse_id`
- `supplier_id`
- `recommended_qty`
- `recommended_order_date`
- `expected_receipt_date`
- `reason_code`
- `demand_avg_daily`
- `coverage_days`
- `stock_on_hand`
- `stock_on_order`
- `status` : `draft`, `approved`, `ordered`, `received`, `cancelled`
- `created_at`

#### 5.6 Table `purchase_orders_local`

Finalite : suivre les commandes fournisseur si Dolibarr ne couvre pas encore le besoin au bon niveau metier.

Champs recommandes :

- `id`
- `supplier_id`
- `reference`
- `status`
- `ordered_at`
- `expected_at`
- `received_at`
- `amount_estimated`
- `amount_final`
- `notes`

#### 5.7 Table `purchase_order_lines_local`

- `id`
- `purchase_order_id`
- `product_id`
- `ordered_qty`
- `received_qty`
- `unit_cost`
- `line_total`
- `status`

### 6. KPIs A Calculer

#### 6.1 KPIs De Sante Stock

- stock vendable total ;
- stock total par depot ;
- valeur de stock au cout ;
- valeur de stock au prix public ;
- part du stock dormant ;
- part des produits en rupture ;
- part des produits sous point de commande.

#### 6.2 KPIs De Rotation

- rotation annuelle par SKU ;
- rotation par categorie ;
- rotation par collection ;
- rotation par auteur ;
- rotation par fournisseur.

Formule de base :

```text
Rotation = sorties sur periode / stock moyen sur periode
```

#### 6.3 KPIs De Couverture

- couverture moyenne globale ;
- couverture par categorie ;
- couverture par fournisseur ;
- couverture sur top 50 references.

Formule simple :

```text
Couverture (jours) = stock disponible / vente moyenne journaliere
```

#### 6.4 KPIs De Rupture

- nombre de references en rupture ;
- taux de rupture ;
- duree moyenne de rupture ;
- ventes perdues estimees ;
- references en rupture recurrente.

#### 6.5 KPIs Fournisseurs

- delai moyen reel ;
- delai max reel ;
- OTIF fournisseur ;
- taux de retard ;
- taux de conformite ;
- evolution du cout d'achat ;
- taux de substitution fournisseur.

### 7. Regles De Calcul Recommandees

#### 7.1 Demande Moyenne

Calcul minimal :

```text
Demande moyenne journaliere = ventes des 30 derniers jours / 30
```

Calcul cible :

- moyenne mobile 30 jours ;
- moyenne mobile 90 jours ;
- prise en compte saisonnalite ;
- ponderation nouveautes.

#### 7.2 Stock De Securite

Version simple :

```text
Stock de securite = consommation moyenne journaliere x marge de securite en jours
```

Version plus mature :

```text
Stock de securite = z x ecart-type de la demande x racine du lead time
```

#### 7.3 Point De Commande

```text
Point de commande = demande moyenne pendant delai + stock de securite
```

#### 7.4 Quantite Economique De Commande

Applicable surtout aux references stables.

```text
EOQ = racine((2 x D x S) / H)
```

Ou :

- `D` = demande annuelle ;
- `S` = cout de passation d'une commande ;
- `H` = cout de possession annuel par unite.

#### 7.5 Regle Pragmatique Pour Le Livre

Pour le contexte librairie/edition, utiliser une logique hybride :

- classes `A` et `B` : calcul dynamique ;
- classes `C` : reappro manuel ou trimestriel ;
- nouveautes : seuil manuel transitoire ;
- fonds lent : pas d'EOQ automatique, revue ponctuelle.

### 8. Segmentation Recommandee

#### 8.1 Classification ABC

- `A` : fortes ventes et forte valeur ;
- `B` : ventes intermediaires ;
- `C` : faible contribution.

#### 8.2 Classification XYZ

- `X` : demande reguliere ;
- `Y` : demande variable ;
- `Z` : demande erratique.

#### 8.3 Decision Par Classe

- `AX` : suivi quotidien, seuils serres, reappro prioritaire ;
- `AY/BX` : suivi hebdomadaire ;
- `BZ/BZ` : suivi souple ;
- `CZ` : achat a la demande ou arret de reappro.

### 9. Systeme D'Alertes Automatisees

#### 9.1 Alertes A Implementer

- `rupture` ;
- `stock_bas` ;
- `sous_point_de_commande` ;
- `couverture_critique` ;
- `surstock` ;
- `stock_dormant` ;
- `retard_fournisseur`.

#### 9.2 Niveaux De Gravite

- `critique`
- `haute`
- `moyenne`
- `information`

#### 9.3 Canaux De Diffusion

- badge dashboard admin ;
- liste d'alertes dediee ;
- resume quotidien email ;
- resume hebdomadaire appro ;
- webhook ou notification interne a terme.

#### 9.4 Frequence De Calcul

- recalcul rapide toutes les heures pour ruptures et stock critique ;
- recalcul quotidien pour couverture et recommandation ;
- recalcul hebdomadaire pour surstock et stock dormant.

### 10. Tableau De Bord Recommande

#### 10.1 Ecran 1 : Vue Executive

- valeur du stock au cout ;
- taux de rupture ;
- couverture moyenne ;
- stock dormant ;
- nombre de references sous point de commande ;
- risque de rupture sur 7 jours.

#### 10.2 Ecran 2 : Reapprovisionnement

- liste des references critiques ;
- couverture ;
- point de commande ;
- quantite recommandee ;
- fournisseur recommande ;
- date limite de commande ;
- priorite.

#### 10.3 Ecran 3 : Fournisseurs

- score fournisseur ;
- delai moyen ;
- fiabilite ;
- commandes en retard ;
- evolution des prix d'achat ;
- substitution possible.

#### 10.4 Ecran 4 : Analyse Stock

- top ruptures ;
- top ventes perdues estimees ;
- top dormants ;
- rotation par categorie ;
- couverture par categorie ;
- stock par classe ABC.

### 11. Ecrans Backoffice A Creer

#### 11.1 Module `Stock`

- vue liste des produits avec :
  - stock vendable ;
  - couverture ;
  - point de commande ;
  - statut d'alerte ;
  - fournisseur principal ;
  - recommandation de commande.

#### 11.2 Module `Alertes Stock`

- file d'alertes avec filtres :
  - severite ;
  - categorie ;
  - fournisseur ;
  - depot ;
  - statut.

#### 11.3 Module `Reapprovisionnement`

- regroupement des recommandations par fournisseur ;
- validation en lot ;
- emission d'une commande fournisseur ;
- suivi des receptions.

#### 11.4 Module `Fournisseurs`

- fiche fournisseur ;
- KPIs de performance ;
- references servies ;
- delais ;
- conditions d'achat ;
- priorite.

### 12. Regles Metier Cles

#### 12.1 Source De Verite

Le systeme doit definir explicitement un `stock_vendable` unique exploite par :

- site public ;
- panier web ;
- commande web ;
- POS ;
- dashboard.

#### 12.2 Reservation De Stock

Une decision doit etre prise sur la reservation :

- reservation immediate a la commande ;
- reservation a confirmation de paiement ;
- reservation avec expiration automatique.

#### 12.3 Multi-depots

Si plusieurs depots sont utilises, il faut distinguer :

- stock total ;
- stock vendable web ;
- stock vendable POS ;
- stock reserve ;
- stock en transit.

### 13. Optimisation Des Couts De Stockage

#### 13.1 Leviers

- baisse du stock de securite sur fournisseurs fiables ;
- arret du reappro sur references dormantes ;
- regroupement des achats par fournisseur ;
- seuils differencies par vitesse de rotation ;
- suivi de la valeur de stock au cout ;
- liquidation ciblee du stock ancien.

#### 13.2 Politique Recommandee

- references critiques : stock de securite renforce ;
- references moyennes : seuil calcule mensuellement ;
- references lentes : pas de stock systematique ;
- references editoriales specifiques : stock pilote selon calendrier et campagnes.

### 14. Service Client Et Disponibilite

Pour garantir un service client optimal, il est recommande de :

- fiabiliser l'affichage du stock vendable ;
- bloquer la survente sur web et POS ;
- afficher des statuts utiles :
  - en stock ;
  - stock limite ;
  - reappro en cours ;
  - sur commande ;
  - rupture ;
- estimer une date de retour en stock ;
- prioriser les titres a forte attente client.

### 15. Architecture Technique Recommandee

#### 15.1 Batchs Et Cron

- job horaire : alertes critiques ;
- job quotidien : calcul couverture, ROP, recommandations ;
- job hebdomadaire : dormants, surstock, score fournisseur.

#### 15.2 APIs A Ajouter

- `GET /api/admin/stock/dashboard`
- `GET /api/admin/stock/alerts`
- `GET /api/admin/stock/recommendations`
- `POST /api/admin/stock/recommendations/:id/approve`
- `POST /api/admin/purchase-orders`
- `GET /api/admin/suppliers`
- `PUT /api/admin/stock-policies/:productId`

#### 15.3 Cache Et Actualisation

- pas de cache long sur les donnees de stock critique ;
- invalidation immediate apres vente, retour ou reception ;
- TTL court sur dashboard stock ;
- historisation des recalculs.

### 16. Plan De Mise En Oeuvre Par Sprint

#### Sprint 1 - Visibilite Et Hygiene

Objectifs :

- unifier la source du stock vendable ;
- corriger les incoherences web/POS ;
- bloquer la survente POS ;
- preparer les tables de parametrage.

Livrables :

- table `stock_policies` ;
- affichage stock unifie ;
- seuils par defaut ;
- blocage quantites au stock disponible.

#### Sprint 2 - KPIs Et Alertes

Objectifs :

- calculer couverture, rotation simple et alertes ;
- creer la page alertes stock ;
- integrer les badges dashboard.

Livrables :

- moteur d'alertes ;
- dashboard stock V1 ;
- couverture 30 jours ;
- references sous point de commande.

#### Sprint 3 - Fournisseurs Et Recommandations

Objectifs :

- creer le referentiel fournisseurs ;
- lier fournisseurs et produits ;
- calculer fournisseur prioritaire ;
- proposer les quantites de commande.

Livrables :

- tables `suppliers` et `supplier_products` ;
- scoring fournisseur ;
- ecran recommandations ;
- vue par fournisseur.

#### Sprint 4 - Execution Du Reappro

Objectifs :

- creer les commandes fournisseur ;
- suivre les receptions ;
- mettre a jour les alertes ;
- tracer les delais reels.

Livrables :

- `purchase_orders_local` ;
- workflow commande a reception ;
- suivi de retard fournisseur ;
- mise a jour des scores.

#### Sprint 5 - Optimisation Avancee

Objectifs :

- ajouter ABC/XYZ ;
- mettre en place stock dormant et surstock ;
- lancer l'analyse cout/service.

Livrables :

- classification catalogue ;
- ecran d'optimisation ;
- recommandations de reduction de stock ;
- pilotage de la valeur immobilisee.

### 17. Priorites

#### Priorite Haute

- source de stock vendable unique ;
- seuils de reappro par reference ;
- alertes rupture et stock critique ;
- couverture de stock ;
- blocage survente POS et web ;
- tableau de bord stock V1.

#### Priorite Moyenne

- fournisseurs prioritaires ;
- recommandation automatique de commande ;
- commande fournisseur ;
- suivi des delais reels ;
- stock dormant.

#### Priorite Long Terme

- prevision de demande ;
- saisonnalite avancee ;
- optimisation cout/service ;
- recommandation intelligente multi-fournisseur.

### 18. Criteres De Succes

Le projet sera considere comme reussi si les objectifs suivants sont atteints :

- baisse du taux de rupture ;
- hausse du taux de service ;
- baisse de la valeur de stock immobilisee ;
- reduction du stock dormant ;
- reduction des decisions manuelles de reappro ;
- meilleure fiabilite du stock affiche sur tous les canaux.

### 19. Conclusion

Le systeme actuel constitue une bonne base pour un pilotage stock moderne, mais il doit evoluer vers une logique de decision et non plus seulement de consultation.

Le levier principal n'est pas uniquement technique : il consiste a transformer les donnees deja presentes en regles de gestion actionnables, visibles et suivies dans le temps.

La feuille de route recommandee est :

1. fiabiliser la donnee stock ;
2. calculer les bons indicateurs ;
3. automatiser les alertes ;
4. outiller le reapprovisionnement ;
5. piloter la performance fournisseur et la valeur immobilisee.
