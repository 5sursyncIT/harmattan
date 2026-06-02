# Décision — Droits d'auteur (royalties)

**Objet :** Règles validées de calcul des droits d'auteur  
**Date :** 1er juin 2026  
**Statut :** décision appliquée dans le système

## 1. Contrats Harmattan DLL

La lecture contractuelle retenue pour les ouvrages subventionnés par la Direction du Livre et de la Lecture du Sénégal (DLL) est la règle à paliers :

- **15 %** de droits d'auteur sur les **1 000 premiers exemplaires subventionnés** ;
- **10 %** de droits d'auteur sur les exemplaires vendus **au-delà de 1 000**.

Les exemplaires remis gratuitement ou hors assiette ne génèrent pas de droits :

- 100 exemplaires remis à la DLL ;
- 50 exemplaires remis à l'auteur ;
- exemplaires de service de presse ;
- exemplaires cédés à prix réduit hors conditions contractuelles.

Ces exemplaires ne doivent pas être retranchés une seconde fois dans le calcul logiciel lorsqu'ils ne sont pas facturés : ils sont déjà absents du chiffre d'affaires et du volume de ventes.

## 2. Contrats Harmattan classiques et Le Tamarinier

La règle retenue reste un **seuil de déclenchement** :

- **10 %** de droits d'auteur ;
- calculés sur les exemplaires vendus **au-delà de 500 exemplaires**.

Les exemplaires gratuits, service de presse et ventes exclues contractuellement ne sont pas dans l'assiette.

## 3. Numérique

Les droits numériques sont calculés à **10 % du chiffre d'affaires net hors taxes** provenant de l'exploitation numérique.

Les droits numériques inférieurs à **20 000 FCFA** sont reportés sur l'exercice suivant.

## 4. Adaptations et droits annexes

Pour les droits annexes, les adaptations audiovisuelles et les adaptations théâtrales :

- l'auteur perçoit **50 %** des sommes nettes perçues par l'éditeur ;
- les frais et commissions assumés par l'éditeur sont déduits avant partage ;
- les relevés doivent être distincts des relevés de vente papier/numérique.

## 5. Paiement dans Dolibarr

La règle opérationnelle recommandée est :

- créer une **facture fournisseur auteur** pour rendre la dette payable et suivable ;
- laisser la facture fournisseur porter l'écriture comptable standard dans Dolibarr ;
- ne pas importer en plus une OD comptable pour le même montant, sauf validation expresse du comptable.

L'export OD des royalties doit donc être utilisé comme **état de contrôle** ou comme solution exceptionnelle, afin d'éviter une double comptabilisation.

## 6. Références techniques

Le calcul est implémenté dans :

- `server/accounting-routes.js`, routes `/admin/accounting/royalties`, export royalties et export OD ;
- `server/contract-routes.js`, valeurs par défaut des types de contrat ;
- `scripts/build-contract-templates.mjs`, wording des templates ODT.
