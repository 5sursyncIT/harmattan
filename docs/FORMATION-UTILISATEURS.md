# 📘 Guide de formation — Application de gestion L'Harmattan Sénégal

> **Version** : 1.0 — 22 juillet 2026
> **Public** : tout le personnel (direction, édition, production, correction, librairie, stock, comptabilité, vente)
> **Accès** : https://senharmattan.com/admin (back-office) · https://senharmattan.com/pos/connexion (caisse)

---

## Table des matières

1. [Présentation générale](#1-présentation-générale)
2. [Premiers pas (tous les secteurs)](#2-premiers-pas-tous-les-secteurs)
3. [Secteur Direction — Admin / Super Admin](#3-secteur-direction--admin--super-admin)
4. [Secteur Édition — Éditeur](#4-secteur-édition--éditeur)
5. [Secteur Production éditoriale](#5-secteur-production-éditoriale)
6. [Secteur Correction — Correcteur](#6-secteur-correction--correcteur)
7. [Secteur Librairie & Support](#7-secteur-librairie--support)
8. [Secteur Stock — Gestionnaire de stock](#8-secteur-stock--gestionnaire-de-stock)
9. [Secteur Comptabilité — Comptable](#9-secteur-comptabilité--comptable)
10. [Secteur Vente — Vendeur POS](#10-secteur-vente--vendeur-pos)
11. [Intervenants externes (sans compte)](#11-intervenants-externes-sans-compte)
12. [Règles communes et bonnes pratiques](#12-règles-communes-et-bonnes-pratiques)
13. [Glossaire](#13-glossaire)
14. [En cas de problème](#14-en-cas-de-problème)

---

## 1. Présentation générale

L'application couvre l'ensemble de l'activité de la maison :

| Espace | URL | Qui l'utilise |
|---|---|---|
| **Site public** (boutique en ligne) | https://senharmattan.com | Clients, auteurs (soumission de manuscrit via « Se faire éditer ») |
| **Back-office** (administration) | https://senharmattan.com/admin | Tout le personnel selon son rôle |
| **Caisse (POS)** | https://senharmattan.com/pos/connexion | Vendeurs en librairie (connexion par code PIN) |

Chaque membre du personnel dispose d'un **compte avec un rôle** qui détermine les menus visibles et les actions autorisées. Vous ne voyez que ce qui concerne votre travail.

### Les rôles

| Rôle | Secteur | Résumé des accès |
|---|---|---|
| **Super Admin** | Direction | Tout + gestion de l'équipe et des permissions |
| **Admin** | Direction | Tout sauf la gestion de l'équipe |
| **Éditeur** | Édition | Manuscrits, évaluations, corrections, contrats, catalogue, parutions, dépôt légal |
| **Production éditoriale** | Production | Validation éditoriale + conception des couvertures (BAT) |
| **Correcteur** | Correction | Correction des manuscrits qui lui sont affectés |
| **Libraire & Support** | Librairie | Livres, factures, devis, BL, commandes, dépôt-vente (lecture), messages, FAQ, newsletter, clients, site |
| **Gestionnaire de stock** | Stock | Stock & réappro, inventaires, fournisseurs, BL, dépôt-vente, catalogue |
| **Comptable** | Comptabilité | Comptabilité complète, paiements, sorties d'argent, factures, devis, contrats |
| **Vendeur POS** | Vente | Caisse uniquement (PIN dédié) |

> ⚠️ **Règle maison** : tous les montants sont affichés **en un seul montant TTC**. On ne manipule jamais de HT ni de TVA dans l'interface.

---

## 2. Premiers pas (tous les secteurs)

### 2.1 Se connecter au back-office

1. Ouvrir https://senharmattan.com/admin
2. Saisir votre **identifiant** et votre **mot de passe** (fournis par le Super Admin).
3. Si la double authentification (2FA) est activée sur votre compte, saisir le code à 6 chiffres de votre application (Google Authenticator, Aegis…).

À la connexion, vous arrivez sur le **tableau de bord** (ou directement sur votre module principal selon votre rôle).

### 2.2 L'écran d'accueil

- **Barre latérale gauche** : les modules accessibles à votre rôle, regroupés par domaine (Catalogue, Édition, Ventes, Site & contenu, Administration).
- **Badges rouges** : nombre d'éléments en attente (messages non lus, paiements à confirmer, alertes stock, manuscrits reçus). Ils se rafraîchissent automatiquement toutes les 30 secondes.
- **Mon profil** (en bas de la barre) : accessible à tous.

### 2.3 Gérer son profil et sa sécurité

Dans **Administration → Mon profil** :

- Modifier son **mot de passe** (obligatoire au premier usage — choisissez un mot de passe long et unique).
- Activer la **double authentification (2FA)** : scanner le QR code avec une application d'authentification, puis saisir le code de vérification. Fortement recommandé pour les rôles Direction et Comptabilité.

### 2.4 Réflexes de base

- **Déconnectez-vous** sur un poste partagé (menu profil → Déconnexion).
- Ne partagez **jamais** votre mot de passe ni votre PIN de caisse.
- En cas de doute sur une action irréversible (suppression, validation de facture…), l'application demande toujours confirmation : **lisez le message** avant de valider.

---

## 3. Secteur Direction — Admin / Super Admin

**Accès : tous les modules.** Ce chapitre décrit les modules propres à la direction ; pour les modules métiers (édition, stock, compta…), reportez-vous aux chapitres des secteurs concernés — vous y avez les mêmes écrans avec tous les droits.

### 3.1 Tableau de bord

Le tableau de bord affiche les **indicateurs clés** :
- Chiffre d'affaires, encaissements, commandes, panier moyen ;
- Graphiques d'évolution (12 mois), répartition par **canal** (POS, web, autre) et par **moyen de paiement** ;
- Meilleures ventes.

Utilisez les filtres de période pour analyser une journée, un mois ou une année.

### 3.2 Gestion de l'équipe (Super Admin uniquement)

**Administration → Équipe** :
- **Créer un compte** : nom, identifiant, mot de passe initial, rôle. Communiquez le mot de passe par un canal sûr et demandez à l'utilisateur de le changer immédiatement.
- **Modifier / désactiver** un compte (départ d'un collaborateur : désactivez, ne supprimez pas — l'historique reste lisible).
- **Surcharges de permissions** : accorder ou retirer temporairement l'accès d'un rôle à un module précis, sans changer le rôle. La surcharge prime sur la configuration de base.

### 3.3 Journal d'activité

**Administration → Journal** : trace toutes les actions sensibles (connexions, créations, validations, suppressions) avec l'auteur, la date et le détail. C'est l'outil de référence en cas de litige ou d'anomalie.

### 3.4 Gestion du POS (appareils et personnel de caisse)

**Ventes → POS** :
- **Appareils** : enrôler une nouvelle caisse (code d'enrôlement à saisir sur l'appareil), révoquer un appareil perdu ou remplacé.
- **Personnel** : créer les comptes caissiers/managers avec leur **code PIN**, réinitialiser un PIN oublié.
- **Sessions actives** : voir les caisses ouvertes, les montants encaissés en temps réel.

### 3.5 Actions réservées à la direction

- **Réouverture d'un contrat validé** (retour en brouillon) pour correction.
- **Renégociation d'une facture émise impayée** : dévalidation, modification des lignes, réémission sous le même numéro.
- **Correction du moyen de paiement** d'une facture (Wave ↔ espèces) — refusée si le paiement est déjà rapproché en banque ; chaque correction est tracée et réversible.
- Validation des **corrections de manuscrits** effectuées par les correcteurs.

---

## 4. Secteur Édition — Éditeur

**Modules : Manuscrits, Intervenants, Évaluations, Corrections, Production éditoriale, Impression, Dépôt légal, Parutions, Contrats, Livres, Auteurs, Bannières, Actualités, Statistiques.**

L'éditeur pilote **toute la chaîne du manuscrit au livre paru**.

### 4.1 La chaîne éditoriale en un coup d'œil

```
Soumission (site) → Réception → Évaluation → Verdict
   Verdict favorable  → Devis d'édition → Contrat → Signature
   Verdict « à retravailler » → retour à l'auteur → nouvelle soumission
   Verdict défavorable → refus notifié
Signature → Correction → Dossier de production → Couverture (BAT)
   → Impression → Dépôt légal → Parution (relais commercial)
```

Chaque manuscrit possède une **frise chronologique** (journal de bord) : tout événement — dépôt, évaluation, devis, contrat, correction, email envoyé — y est horodaté. C'est votre outil d'audit : consultez-la avant toute relance.

### 4.2 Réception des manuscrits

**Édition → Manuscrits** : liste des soumissions reçues via le formulaire « Se faire éditer » du site (titre, sous-titre, genre, synopsis, fichier).

- **Ouvrages en plusieurs tomes** : une œuvre en N tomes = N manuscrits liés en série ; le lien apparaît sur chaque fiche.
- **Micro-corrections de la fiche** (titre, genre, synopsis) : bouton « Modifier la fiche » — chaque modification est tracée dans la frise.
- **Versions du manuscrit** : chaque dépôt de fichier crée une **version** (empreinte SHA-256). Vous pouvez déposer une version à toute étape, ou envoyer à l'auteur un **lien de dépôt** pour qu'il téléverse lui-même. Le marquage « version définitive » purge les versions intermédiaires.

### 4.3 Intervenants et affectations

**Édition → Intervenants** : carnet des évaluateurs, correcteurs, infographistes et imprimeurs **externes**. Ils n'ont pas de compte : ils reçoivent un **email avec un lien sécurisé (à durée limitée)** pour rendre leur travail.

- Affecter un évaluateur ou un correcteur depuis la fiche du manuscrit ; l'intervenant est notifié automatiquement par email.
- Les correcteurs **internes** (rôle Correcteur) sont affectés de la même manière mais travaillent dans leur propre espace (voir chapitre 6).

### 4.4 Évaluation et verdict

**Édition → Évaluations** : suivi des rapports de lecture.

Trois verdicts possibles :
1. **Favorable** → passage au devis d'édition. Vous pouvez cocher l'option **« joindre le rapport de lecture »** à l'email d'acceptation envoyé à l'auteur. Le comptable reçoit automatiquement le manuscrit (pièce jointe ou lien sécurisé 30 jours).
2. **À retravailler** → l'auteur reçoit un email dédié l'invitant à retravailler son texte ; un bouton permet de **relancer** le circuit à réception de la nouvelle version.
3. **Défavorable** → refus notifié à l'auteur.

### 4.5 Devis d'édition et contrat

- Le **devis de contribution** est généré puis **envoyé à l'auteur par bouton** (« Envoyer le devis » — le PDF part par email).
- **Révision d'un devis négocié** : tant qu'il n'est pas facturé, un devis peut être révisé (même référence, prix négocié conservé).
- L'**encaissement du devis** (chapitre comptable) n'est **pas** un préalable obligatoire à la correction : le bouton « Démarrer la correction » permet d'avancer sans attendre le paiement si la direction l'accepte.

**Édition → Contrats** :
- **Créer un contrat** : assistant en 3 étapes (auteur, œuvre, conditions — taux de droits d'auteur papier/numérique, seuil, exemplaires gratuits).
- **Générer le PDF** du contrat (modèles officiels avec filigrane et zone de signature).
- **Signature** : soit **en ligne** (lien de signature envoyé à l'auteur), soit **manuscrite** (impression, signature papier, puis dépôt du scan — l'application archive le scan avec son empreinte SHA-256 et une attestation).
- Suivi, tri, filtres et **export CSV** de tous les contrats.

### 4.6 Correction

**Édition → Corrections** : suivi des corrections en cours (interne ou externe). À la remise du correcteur, la **validation finale appartient à l'admin/éditeur**. Le fichier corrigé rejoint la chaîne de versions du manuscrit.

### 4.7 Dossier de production et couverture

Après correction :
- **Dossier de production** : téléversez les fichiers définitifs (intérieur, annexes, lien externe éventuel) — multi-fichiers, multi-types.
- **Production éditoriale** (espace partagé avec le rôle Production) : onglets **Éditorial** (validation du texte) et **Couvertures** (allers-retours BAT avec l'infographiste, validation de la couverture).

### 4.8 Impression et dépôt légal

- **Édition → Impression** : suivi des ordres d'impression.
- **Édition → Dépôt légal** : enregistrement des dépôts légaux (obligation BNS).

### 4.9 Parutions (relais commercial)

**Édition → Parutions** : à l'approche de la sortie d'un livre :
- **Checklist de lancement** (17 points) : fiche livre complète, visuels, kit presse, annonce…
- **Kit de parution** : visuels réseaux sociaux générés, texte d'annonce.
- **Newsletter** de parution et bascule automatique du livre le jour J (il quitte « à paraître » et devient commandable).

### 4.10 Catalogue (livres et auteurs)

**Catalogue → Livres** :
- Créer/modifier une fiche livre : titre, sous-titre, auteur (autocomplétion), ISBN (contrôle de validité automatique), année, pages, prix (TTC unique), description, couverture, **genre** (liste gérable : créer, renommer, fusionner).
- Case **« à paraître »** : le livre apparaît dans la vitrine « À paraître » du site sans être commandable.
- Carte **« Ventes & stock »** sur chaque fiche : quantité écoulée, stock restant.
- Les ISBN multiples d'un même titre sont reconnus par la recherche (admin et caisse).

**Catalogue → Auteurs** : fiches auteurs, liées aux livres et aux contrats. La recherche accepte « Prénom Nom » complet. Un bouton sur la fiche d'un tiers permet de le **transformer en auteur**.

### 4.11 Vitrine du site

- **Bannières** : visuels du carrousel d'accueil.
- **Actualités** : articles et annonces du site.

---

## 5. Secteur Production éditoriale

**Modules : Production éditoriale (Éditorial + Couvertures), consultation des manuscrits.**

Le rôle Production intervient **après la correction**, sur deux volets réunis dans un espace à onglets :

### 5.1 Onglet Éditorial

- Recevoir les dossiers de production transmis par l'édition.
- Vérifier la complétude (fichier intérieur définitif, métadonnées).
- Valider l'étape éditoriale ou renvoyer avec commentaires.

### 5.2 Onglet Couvertures

- Suivre les demandes de couverture ;
- Consulter chaque proposition (BAT), demander des retouches ou **valider le BAT** ;
- L'historique des versions de couverture reste attaché au manuscrit.

### 5.3 Consultation

Vous pouvez ouvrir la **fiche détaillée d'un manuscrit** (bouton « Détail ») et sa frise chronologique, en lecture seule, pour comprendre le contexte. Vous ne modifiez ni la fiche, ni les contrats, ni le catalogue.

---

## 6. Secteur Correction — Correcteur

**Modules : Mes corrections, consultation des manuscrits affectés.**

### 6.1 Votre espace

À la connexion, vous voyez **uniquement les manuscrits qui vous sont affectés**. Pour chacun :

1. **Notification** : vous recevez un email à chaque nouvelle affectation.
2. **Télécharger** le manuscrit (dernière version) depuis la fiche.
3. Travailler la correction dans votre outil habituel.
4. **Déposer le fichier corrigé** dans l'application (il devient une nouvelle version, avec empreinte).
5. Marquer la correction comme **terminée** : l'éditeur/admin est notifié et **valide** votre travail (ou vous le renvoie avec remarques).

### 6.2 Règles

- Ne diffusez jamais un manuscrit hors de l'application (confidentialité auteur).
- En cas de fichier illisible ou incomplet, signalez-le via la fiche plutôt que par email personnel : tout doit rester tracé dans la frise.

---

## 7. Secteur Librairie & Support

**Modules : Livres, Auteurs, Stock (lecture), Inventaire (comptage), Factures, Devis, Bons de livraison, Commandes web (lecture), Commandes spéciales, Dépôt-vente (lecture), Tiers, Parutions, Messages, FAQ, Newsletter, Comptes web, Configuration, Bannières, Actualités, Statistiques.**

Ce rôle couvre **le comptoir de la librairie et la relation client** du site.

### 7.1 Volet librairie

#### Livres et catalogue
- Création et mise à jour des fiches livres (mêmes écrans que l'édition, voir §4.10) ; vous pouvez poser des **tags de curation** (« Sélection », « Livre du mois »…) sur les livres.
- **Stock en lecture** : consulter les niveaux, alertes et couvertures de stock — les mouvements sont réservés au gestionnaire de stock.

#### Inventaire (comptage)
Lors d'un inventaire lancé par le gestionnaire de stock, le libraire participe au **comptage physique** : scanner ou saisir les quantités comptées rayon par rayon. Le démarrage, l'import et la clôture de l'inventaire restent chez le gestionnaire.

#### Factures et devis
- **Ventes → Factures** : consulter, rechercher, rééditer le PDF d'une facture.
- **Ventes → Devis** : les proformas de la caisse et les devis remontent ici. Boutons **« Valider + facturer »** (crée la facture et décrémente le stock) ou **« Refuser »**.

#### Bons de livraison
**Ventes → Bons de livraison** : établir un BL pour toute sortie de marchandise vers un client ou partenaire (PDF imprimable). Le BL gère le stock proprement : pas de double décrémentation si une facture suit.

#### Commandes web
**Ventes → Commandes web** (lecture) : suivi des commandes passées sur le site, détail cliquable (articles, paiement, statut). La confirmation des paiements appartient au comptable/admin.

#### Commandes spéciales (livres indisponibles)
**Ventes → Commandes spéciales** : quand un client demande un livre non disponible :
1. **Créer la commande spéciale** (référence CS + année/mois) : client, livre demandé, quantité, prix estimé.
2. Suivre ses **états** (demande → sourcing → commandé → reçu → client prévenu → retiré/soldé…).
3. Enregistrer **l'avance** éventuelle du client puis le **solde** au retrait ; un **bon PDF** est remis au client.

#### Dépôt-vente (lecture)
Consulter les dépôts de déposants (livres confiés à la vente) et leur état. La gestion (entrées, reversements) appartient au gestionnaire de stock et au comptable.

### 7.2 Volet support / relation client

- **Messages** : formulaire de contact du site — répondre, marquer traité.
- **FAQ** : questions/réponses publiées sur le site.
- **Newsletter** : liste des abonnés, envois.
- **Comptes web** : comptes clients du site (aide à la connexion, vérification d'une commande).
- **Actualités / Bannières / Configuration** : mise à jour de la vitrine (carrousel, infos de contact, horaires).
- **Parutions** : le libraire participe au **relais commercial** des nouveautés (checklist, kit de communication — voir §4.9).

---

## 8. Secteur Stock — Gestionnaire de stock

**Modules : Stock & réappro, Inventaire, Fournisseurs, Livres, Auteurs, Tags, Bons de livraison, Dépôt-vente, Commandes spéciales, Dépôt légal, Tiers, Statistiques.**

### 8.1 Tableau de bord stock

**Catalogue → Stock** : vue d'ensemble — valeur du stock, alertes (7 types : rupture, sous le point de commande, surstock, dormant…), couverture en jours, classement ABC/XYZ des titres.

Les calculs (demande moyenne, stock de sécurité, point de commande) tournent automatiquement chaque nuit ; la classification ABC/XYZ chaque lundi.

### 8.2 Réapprovisionnement

Depuis la liste des produits en alerte, deux boutons d'action directe :

| Bouton | Cas | Effet |
|---|---|---|
| **Réimpr.** | Livre édité par L'Harmattan Sénégal (ISBN 978-2-336…) | Crée un **ordre de réimpression** (délai ~14 j) |
| **Cmd.** | Livre acheté (Paris ~45 j, autre fournisseur ~60 j) | Crée une **commande fournisseur** |

La quantité proposée est pré-remplie (point de commande − stock actuel) ; ajustez avant de valider. Des **recommandations d'achat** hebdomadaires listent les titres à commander en priorité.

### 8.3 Entrées, transferts et mouvements

- **Entrée en stock** : réception d'une livraison (réimpression ou commande fournisseur) avec le **prix d'achat réel**.
- **Transfert entre entrepôts** : déplacer du stock d'un dépôt vers un autre (magasin ↔ réserve ↔ dépôt partenaire). Chaque transfert crée deux mouvements liés et peut être annulé (rollback). L'onglet **Historique** montre tous les transferts, y compris ceux effectués en amont dans l'ERP.
- Toute vente caisse/web décrémente le stock automatiquement ; un **avoir** (retour client) le restitue.

### 8.4 Inventaire physique

**Catalogue → Inventaire** :
1. **Créer une session** d'inventaire (périmètre : tout ou une sélection) — l'application fige un **instantané** du stock théorique.
2. **Compter** : scan ISBN ou saisie (le libraire peut aider au comptage).
3. **Écarts** : l'écran compare compté vs théorique et met en évidence les écarts.
4. **Clôturer** : les ajustements de stock sont appliqués et tracés. (Import CSV possible pour un comptage fait hors ligne.)

### 8.5 Fournisseurs

**Catalogue → Fournisseurs** : fiches fournisseurs (contacts, délais), liaison produits-fournisseurs, historique des commandes.

### 8.6 Dépôt-vente (consignation)

**Ventes → Dépôt-vente** : gestion des livres confiés par des déposants :
1. Créer le **déposant** puis le **dépôt** (liste des titres, quantités, prix, taux de reversement) → **bon de dépôt PDF** signé.
2. Les ventes s'imputent au dépôt ; l'écran suit vendu / restant.
3. Au moment du règlement du déposant : générer le **reversement** (le comptable établit la facture du montant net à reverser).

### 8.7 Bons de livraison et dépôt légal

- **BL** : mêmes écrans que le libraire (§7.1) — vous les utilisez pour toute sortie de stock hors caisse.
- **Dépôt légal** : enregistrement des exemplaires déposés (avec l'édition).

---

## 9. Secteur Comptabilité — Comptable

**Modules : Comptabilité, Paiements, Sorties d'argent, Factures, Devis, Commandes web, Commandes spéciales, Dépôt-vente, Bons de livraison, Contrats, Tiers, Statistiques.**

### 9.1 Tableau de bord comptable

**Ventes → Comptabilité** : 4 indicateurs (CA, encaissements, créances, trésorerie), courbe CA vs encaissements sur 12 mois, dernières factures et derniers paiements.

> 📌 **Règle d'or des dates** : un **encaissement** se rapporte à sa **date de paiement** ; le **chiffre d'affaires** à la **date de facture**. Les écrans de rapport journalier proposent les deux vues — ne les confondez pas.

### 9.2 Suivi quotidien

| Écran | Usage |
|---|---|
| **Journal des ventes** | Factures par période/canal/client, totaux du filtre |
| **Journal des paiements** | Encaissements par méthode (espèces, Wave, OM, carte, chèque, virement) et par compte |
| **Créances** | Balance âgée (non échu / 0-30 / 30-60 / 60-90 / +90 jours), par facture ou par client |
| **Trésorerie** | Soldes par compte, flux 30 jours, derniers mouvements |
| **Droits d'auteur** | Calcul par ISBN : `droits = (exemplaires vendus − seuil − gratuits) × prix moyen × taux` ; détail par contrat |

Chaque journal s'**exporte en CSV**.

### 9.3 Paiements web (Wave / Orange Money / PayTech)

**Ventes → Paiements** : les commandes du site arrivent avec un paiement **« en attente »** :
1. Vérifier la référence de transaction et le montant reçu.
2. **Confirmer** → la facture est générée automatiquement et le stock décrémenté. **Rejeter** → saisir le motif (le client est informé).

Les paiements PayTech confirmés par la passerelle sont rapprochés automatiquement ; contrôlez les écarts éventuels de montant/devise.

### 9.4 Encaissements liés à l'édition

- **Encaisser un devis d'édition** : bouton « Encaisser » sur le devis de fabrication → crée la facture de l'auteur et enregistre le règlement.
- **Manuscrits acceptés** : à chaque évaluation favorable vous recevez le manuscrit (pièce jointe ou lien 30 jours) pour établir le devis de contribution.
- **Paiements fractionnés / acomptes** : une facture peut être réglée en plusieurs fois (acomptes) ; la frise de la facture montre chaque versement. Saisissez toujours le **montant exact** de chaque versement.

### 9.5 Sorties d'argent (dépenses)

**Ventes → Sorties d'argent** : toute dépense (achat, transport, service) :
- Saisie avec **justificatif obligatoire** (photo/scan) ;
- Journal **immuable** (pas de suppression : une erreur se corrige par contre-écriture) ;
- Les admins sont notifiés de chaque sortie ; un **rapport de caisse** consolide les mouvements.

### 9.6 Comptabilité générale (SYSCOHADA)

Écrans **Écritures / Grand livre / Balance / États / Plan comptable** :
1. **Transfert en comptabilité** : génère les écritures en partie double à partir des ventes/paiements (opération idempotente : relançable sans doublon).
2. **Écritures OD manuelles** : ajustements, salaires, opérations diverses.
3. **Factures fournisseurs** : saisie et suivi.
4. **États** : compte de résultat, bilan ; **export FEC** pour l'expert-comptable.

### 9.7 Contrats et droits d'auteur

Le comptable accède aux **contrats** (conditions de droits) pour vérifier les calculs de royalties et préparer les relevés annuels des auteurs.

---

## 10. Secteur Vente — Vendeur POS

**Accès : la caisse uniquement** (https://senharmattan.com/pos/connexion). Le compte back-office du vendeur ne sert qu'à gérer son profil.

### 10.1 Ouvrir sa session de caisse

1. Sur la caisse, saisir votre **code PIN** personnel.
2. **Ouvrir la session** en comptant le **fonds de caisse** initial.
3. En fin de service : **clôturer la session** en comptant la caisse — l'écart éventuel est affiché et enregistré.

### 10.2 Encaisser une vente

1. **Ajouter les articles** : scan du code-barres ISBN, ou recherche par titre/auteur/ISBN (la recherche reconnaît aussi les ISBN alternatifs d'un titre).
2. Vérifier le panier (quantités, remises éventuelles).
3. **Choisir le client** si nécessaire (vente à un client identifié, facture nominative).
4. **Encaisser** : espèces, Wave, Orange Money, carte, chèque. Le ticket / la facture s'imprime ; le stock est décrémenté automatiquement.

### 10.3 Cas particuliers

| Cas | Comment faire |
|---|---|
| **Devis / proforma** | Créer une **proforma** au lieu d'encaisser : le client reçoit un PDF avec les coordonnées bancaires. La validation/facturation se fait ensuite au back-office (Devis). |
| **Vente à crédit** | Encaisser en mode **crédit** : la facture est émise **impayée** au nom du client. |
| **Encaisser un impayé** | Écran dédié **« Encaisser un impayé »** : retrouver la facture du client et enregistrer son règlement (total ou partiel). |
| **Service de presse** | Vente à 0 F au client « SERVICE PRESSE » — sort le livre du stock sans chiffre d'affaires (exemplaires presse/officiels). |
| **Retour client** | Établir un **avoir** : le stock est restitué automatiquement. |
| **Livre indisponible** | Orienter vers une **commande spéciale** (prise au comptoir par le libraire, voir §7.1). |
| **Coupure réseau** | La caisse dispose d'un mode hors-ligne : continuez à vendre, la synchronisation reprend au retour du réseau. Ne fermez pas l'onglet. |

### 10.4 Mouvements de caisse

Entrées/sorties d'espèces hors vente (monnaie, remise en banque) : utilisez **Mouvement de caisse** avec un motif — jamais de sortie d'espèces non enregistrée.

### 10.5 Règles d'or de la caisse

- Un PIN = une personne. Ne prêtez jamais votre PIN.
- Toute vente passe par la caisse — aucun encaissement « de la main à la main ».
- En cas d'erreur d'encaissement (Wave saisi en espèces…), ne « bricolez » pas : signalez au comptable/admin qui dispose d'un outil de **correction du moyen de paiement** tracé.
- Si l'écran semble bloqué au moment de valider, **n'insistez pas en cliquant plusieurs fois** (risque de doublon) : attendez, puis vérifiez dans l'historique si la vente est passée.

---

## 11. Intervenants externes (sans compte)

Les **évaluateurs, infographistes et imprimeurs externes** (et certains correcteurs) ne se connectent pas à l'application :

1. L'éditeur les enregistre dans le **carnet d'intervenants**.
2. À chaque affectation, ils reçoivent un **email** avec les consignes et un **lien sécurisé à durée limitée** pour télécharger le manuscrit et/ou déposer leur travail.
3. Leur remise apparaît automatiquement dans l'application, tracée dans la frise du manuscrit.

Aucun identifiant à gérer pour eux ; si le lien a expiré, l'éditeur le renvoie depuis la fiche.

---

## 12. Règles communes et bonnes pratiques

1. **Un seul montant** : tous les prix et totaux sont TTC. Ne calculez jamais de TVA dans l'application.
2. **Tout est tracé** : journal d'activité, frises chronologiques, audits de paiement. Travaillez dans l'application plutôt que par canaux parallèles (WhatsApp, papier volant) : ce qui n'est pas dans l'outil n'existe pas.
3. **Ne supprimez pas, corrigez** : avoirs pour les ventes, contre-écritures pour la compta, désactivation pour les comptes. La suppression est l'exception.
4. **Justificatifs** : toute sortie d'argent exige un justificatif ; tout paiement web exige une référence de transaction.
5. **Confidentialité** : manuscrits, contrats et données clients ne sortent pas de l'application.
6. **Doublons clients/tiers** : avant de créer un client ou un auteur, **cherchez-le d'abord** (nom complet « Prénom Nom » accepté). Attention aux homonymes fréquents des patronymes sénégalais : vérifiez le téléphone/email avant de fusionner quoi que ce soit.
7. **Mots de passe** : longs, uniques, jamais partagés ; 2FA recommandée (obligatoire pour direction et comptabilité).
8. **Sauvegardes** : automatiques chaque nuit — mais signalez immédiatement toute anomalie de données constatée.

---

## 13. Glossaire

| Terme | Définition |
|---|---|
| **BAT** | « Bon à tirer » : version finale de la couverture/du livre validée avant impression |
| **BL** | Bon de livraison : document accompagnant une sortie de marchandise |
| **Proforma** | Devis de caisse : document non comptable remis avant paiement |
| **Avoir** | Facture négative annulant tout ou partie d'une vente (retour) |
| **Dépôt-vente** | Livres confiés par un déposant, payés au déposant après vente (reversement du net) |
| **Commande spéciale (CS)** | Commande client d'un livre non disponible en stock |
| **Point de commande (ROP)** | Niveau de stock qui déclenche une alerte de réapprovisionnement |
| **ABC/XYZ** | Classement des titres par importance des ventes (ABC) et régularité (XYZ) |
| **Balance âgée** | Créances classées par ancienneté du retard |
| **OD** | « Opérations diverses » : écriture comptable manuelle |
| **FEC** | Fichier des écritures comptables (export pour l'expert-comptable) |
| **2FA** | Double authentification par code à 6 chiffres |
| **Frise** | Journal chronologique d'un manuscrit ou d'une facture |
| **Seuil (droits d'auteur)** | Nombre d'exemplaires vendus avant que les droits ne commencent à courir |

---

## 14. En cas de problème

| Situation | Réflexe |
|---|---|
| Mot de passe oublié | Demander la réinitialisation au Super Admin |
| PIN caisse oublié | Demander la réinitialisation à un admin (module POS → Personnel) |
| Accès refusé sur un écran | Normal si hors de votre rôle ; sinon contacter le Super Admin (surcharge de permission possible) |
| Erreur d'encaissement | Ne pas corriger soi-même : signaler au comptable/admin (outil de correction tracé) |
| Vente en double suspectée | Vérifier l'historique de la caisse avant de ressaisir ; signaler à l'admin |
| Données incohérentes (stock, facture) | Noter la référence exacte + capture d'écran, transmettre à l'administrateur |
| Panne / lenteur générale | Prévenir l'administrateur technique ; la caisse continue en mode hors-ligne |

**Contact support technique** : administrateur du système (Sync IT).

---

*Document généré le 22 juillet 2026 à partir de la configuration réelle des rôles et modules de l'application. À mettre à jour à chaque évolution majeure des modules ou des permissions.*
