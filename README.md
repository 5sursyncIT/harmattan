# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## Guide de style

### Boutons (accessibilité)

- Taille cible minimum (WCAG) : 44x44 px pour les éléments cliquables.
- Implémentation :
  - Boutons d’actions sur la page Événements : `min-height: 44px` avec `padding: 0 14px` (voir [EvenementsPage.css](file:///var/www/html/senharmattan-shop/src/pages/EvenementsPage.css)).
  - Boutons de filtres (chips) : `min-height: 44px` avec `padding: 0 16px` (voir [EvenementsPage.css](file:///var/www/html/senharmattan-shop/src/pages/EvenementsPage.css)).

### POS — mode Ticket

- Composant principal : [POSCart.jsx](file:///var/www/html/senharmattan-shop/src/components/pos/POSCart.jsx)
- Styles dédiés : [POSCart.css](file:///var/www/html/senharmattan-shop/src/components/pos/POSCart.css)
- Activation du mode caisse pro : [POSPage.jsx](file:///var/www/html/senharmattan-shop/src/pages/pos/POSPage.jsx)

#### Principes de conception

- Garder une hiérarchie stable en 4 zones : en-tête, client, lignes du ticket, actions de règlement.
- Réserver le panneau latéral droit au clavier opérateur et aux raccourcis de caisse quand la vue Ticket est active.
- Utiliser les couleurs du design system existant : vert de validation, neutres froids, accent orange pour les tickets en attente.
- Maintenir des zones cliquables généreuses et des transitions courtes pour les micro-interactions.

#### Changements appliqués

- Ajout d’un résumé visuel du ticket en en-tête avec articles, lignes et total.
- Réorganisation du contenu pour séparer clairement la sélection client, les lignes panier et les actions d’encaissement.
- Refonte des cartes ligne article avec état sélectionné plus lisible et actions plus accessibles.
- Repositionnement du bouton principal d’encaissement dans le footer, avec carte de synthèse dédiée.
- Amélioration des retours visuels : hover, sélection, pression, états actifs et désactivés.

#### Validation

- Vérification technique locale : diagnostics éditeur, lint ciblé et build Vite.
- Responsive à contrôler systématiquement sur desktop et mobile après chaque ajustement CSS.
- Test utilisateur réel non automatisable ici : prévoir un passage terrain avec caissiers et relever au minimum le temps d’encaissement, le taux d’erreur sur quantité/remise et le nombre d’actions nécessaires par ticket.
