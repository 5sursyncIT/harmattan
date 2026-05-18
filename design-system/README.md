# Design System

Charte UI/UX du projet senharmattan-shop.

## Structure

- **[MASTER.md](./MASTER.md)** — Charte globale (couleurs, typographie, spacing, composants, conventions). Source de vérité pour toutes les pages.
- **[pages/](./pages/)** — Overrides par page quand une page dévie du master.

## Usage avec Claude Code

En début de session de développement UI, demander :

> « Lis `design-system/MASTER.md` et `design-system/pages/<page>.md` si existant. Priorise les règles de la page sur celles du master. »

Claude a par ailleurs accès à une checklist UI/UX transversale en mémoire persistante (`ui_ux_checklist.md` — 10 catégories priorisées issues de WCAG / Apple HIG / Material Design).

## Contribution

Si tu trouves un pattern qui n'est pas documenté :
1. Si c'est transverse → ajouter à `MASTER.md` dans la section concernée
2. Si c'est spécifique à une page → créer/enrichir `pages/<page>.md`
3. Mettre à jour le changelog de `MASTER.md`
