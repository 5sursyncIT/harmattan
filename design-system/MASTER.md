# L'Harmattan Sénégal — Design System Master

**Version** : 1.0 (23 avril 2026)
**Scope** : charte UI/UX globale du site senharmattan-shop (e-commerce + admin + POS).
**Principe** : toutes les pages/composants lisent ce document. Les déviations d'une page vont dans `design-system/pages/<page>.md` (override partiel).

Référence checklist transverse : `~/.claude/projects/-home-youssoupha/memory/ui_ux_checklist.md`.

---

## 1. Identité

- **Maison d'édition / librairie** basée à Dakar (Sénégal)
- **Public** : francophone, Sénégal + diaspora, desktop 60% / mobile 40% (estimation)
- **Ton** : sobre, éditorial, chaleureux. Ni bling ni corporate. Mise en avant du catalogue et de l'identité africaine.
- **Palette dominante** : vert foncé (feuille) + orange vif (accent commercial)

---

## 2. Couleurs (tokens sémantiques)

Tokens définis dans [src/index.css](../src/index.css). **À utiliser via `var(--token)` — jamais de hex brut dans les composants**.

### Brand

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-green-deep` | `#10531a` | Vert principal (CTA primaires, nav admin active, boutons engage) |
| `--color-green` | `#059669` | Vert émeraude (badges success, indicateurs, hover vert clair) |
| `--color-green-light` | `#0d9488` | Vert cyan (accents secondaires, tags) |
| `--color-orange` | `#ea580c` | Orange principal (CTA secondaires, promo, mise en avant éditoriale) |
| `--color-coral` | `#f97316` | Orange corail (prix, badges "Nouveauté") |

### Neutres

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-dark` | `#1f2937` | Titres principaux |
| `--color-text` | `#374151` | Corps de texte |
| `--color-text-light` | `#6b7280` | Texte secondaire, captions |
| `--color-text-muted` | `#9ca3af` | Texte tertiaire, placeholders |
| `--color-border` | `#e5e7eb` | Bordures, dividers |
| `--color-light-bg` | `#fafafa` | Fond général du site |
| `--color-white` | `#ffffff` | Surfaces élevées (cards, modales, form inputs) |

### États

| Token | Valeur | Usage |
|-------|--------|-------|
| `--color-danger` | `#ef4444` | Erreurs (mais pour CTA destructif utiliser `#b91c1c` — plus sombre = WCAG AA sur blanc) |
| `--color-success` | `#10b981` | Success state (vert plus clair que brand) |
| `warn` | `#d97706` | Warnings (pas en token — à ajouter si utilisé ≥ 3×) |

### Règles

- **Contraste WCAG AA minimum** : texte normal 4.5:1, texte grand 3:1. Les paires `--color-text` / `--color-light-bg` et `--color-white` sont validées.
- **Dark mode** : pas implémenté aujourd'hui. Si un jour : variantes désaturées via media query, tokens `-dark` en surcouche.
- **Danger** : préférer `#b91c1c` au `#dc2626` sur boutons critiques. Jamais `#ef4444` sur fond blanc (seuil ~3.3:1).
- **Pas de couleur seule** pour véhiculer un sens — toujours icône + texte associé (a11y).

---

## 3. Typographie

### Famille

**Lato** (Google Fonts, poids 300/400/700/900) + stack système en fallback :
```
font-family: 'Lato', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
```

### Échelle recommandée

| Usage | Taille | Weight | Line-height |
|-------|-------:|-------:|------------:|
| Display (hero) | 36-48px | 900 | 1.1 |
| H1 (page) | 28-32px | 800 | 1.2 |
| H2 (section) | 20-24px | 700 | 1.3 |
| H3 (card title) | 16-18px | 700 | 1.35 |
| Body | 14-16px | 400 | 1.6 |
| Small / caption | 12-13px | 400 | 1.5 |
| Label / button | 13-14px | 600 | 1.2 |
| Micro (kicker) | 10-11px | 800 | 1.2, `text-transform: uppercase`, `letter-spacing: 0.08em` |

### Règles

- **Base 16px** sur `html` — ne jamais descendre en dessous de 12px pour du texte lisible
- **Line-height** 1.5-1.75 pour le corps, 1.1-1.3 pour les titres
- **Ligne** : 60-75 chars desktop, 35-60 chars mobile (utiliser `max-width: 65ch` sur les textes longs)
- **Chiffres tabulaires** pour colonnes de prix, dates, stocks → `font-variant-numeric: tabular-nums`
- **Accents français directement** (é, è, à, ô) — jamais de `é` dans le JSX (sort en brut)
- **HTML entities Dolibarr** (`&eacute;`, `&acirc;`) → décoder via `decodeEntities()` dans [src/utils/bookForm.js](../src/utils/bookForm.js)

---

## 4. Spacing (rythme 4pt)

| Token | Valeur | Usage |
|-------|-------:|-------|
| `2px` | `.5` | Détails fins (espace entre icône et texte court) |
| `4px` | `1` | Gap minimal entre icône et label |
| `6px` | `1.5` | Interstice boutons groupe |
| `8px` | `2` | Gap standard entre éléments proches |
| `12px` | `3` | Padding interne de cards compactes |
| `16px` | `4` | Padding standard cards/cells |
| `20-24px` | `5-6` | Gap entre sections adjacentes |
| `32px` | `8` | Gap entre blocs majeurs |
| `48px` | `12` | Gap vertical entre sections home |

**Règle** : tout spacing doit être un multiple de 4. Aucune valeur arbitraire (pas de 7px, 13px, etc.).

---

## 5. Radius

| Token | Valeur | Usage |
|-------|--------|-------|
| `--radius-sm` | `6px` | Badges, pills, petits boutons |
| `--radius-md` | `8px` | Inputs, boutons standards |
| `--radius-lg` | `12px` | Cards, tiles produit, panels admin |
| `--radius-xl` | `16px` | Modales, grosses cards |
| Full | `9999px` / `50%` | Chips, avatars, boutons ronds |

---

## 6. Shadows / élévations

| Token | Usage |
|-------|-------|
| `--shadow-sm` | Cards au repos, inputs focus |
| `--shadow-md` | Cards hover, dropdowns |
| `--shadow-lg` | Modales, popovers, hero-preview |
| `0 20px 50px rgba(0,0,0,.25)` | Modales centrées (custom, non-token) |

**Règle** : jamais plus de 3 niveaux d'élévation visibles en même temps. Pas d'ombre arbitraire — utiliser les tokens ou étendre.

---

## 7. Breakpoints

```css
/* Mobile-first */
/* default : < 640px (phone) */
@media (min-width: 640px)  { /* tablet portrait */ }
@media (min-width: 768px)  { /* tablet landscape */ }
@media (min-width: 1024px) { /* desktop */ }
@media (min-width: 1100px) { /* admin split layout s'active */ }
@media (min-width: 1280px) { /* large desktop (max-width container) */ }
```

- `--max-width: 1280px` pour les containers centraux
- Mobile-first obligatoire : écrire le CSS pour < 640px, élargir avec `min-width`
- **Jamais de `100vh`** sur mobile → préférer `100dvh` ou `min-h-dvh`

---

## 8. Animation

| Type | Durée | Easing |
|------|------:|--------|
| Micro-interaction (hover, press) | 150 ms | `ease-out` |
| Transition état (tab, accordion) | 200 ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Modal enter | 200-250 ms | `ease-out` |
| Modal exit | 150-175 ms (60-70% enter) | `ease-in` |
| Page transition | 300-400 ms max | spring / physics |

- **Token global** : `--transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1)` (à utiliser par défaut)
- Toujours animer `transform` et `opacity` — jamais `width`/`height`/`top`/`left`
- **Respect de `prefers-reduced-motion`** : pas encore systématique dans le code actuel → à ajouter
- Spinner : animation `spin` définie dans CSS, 1s linear infinite

---

## 9. Composants standards

### Boutons

```
.btn-primary      → bg var(--color-green-deep), color white, hover: filter brightness(0.92)
.btn-outline      → bg white, border 1px #d1d5db, color var(--color-text), hover: bg #f9fafb
.btn-icon.danger  → bg white, border #fca5a5, color #991b1b, hover: bg #fee2e2
```

- Padding standard : `9px 14px` (medium) ou `10px 18px` (large)
- Font-weight : 600
- Border-radius : 8px (`--radius-md`)
- Icon + label : gap 6px
- Disabled : `opacity: 0.5`, `cursor: not-allowed`

### Pills / badges

- Namespace obligatoire : `.books-pill`, `.activity-item-action`, etc. (jamais `.pill` nue — collision)
- Format : `padding: 2-4px 8-12px`, `border-radius: 999px` ou `4-6px`, `font-size: 0.7-0.78rem`, `font-weight: 700`

### Inputs

- Padding : `8-10px 12px`
- Border : `1px solid #d1d5db`
- Border-radius : `6-8px`
- Focus : `border-color: #3b82f6`, `box-shadow: 0 0 0 3px rgba(59,130,246,0.12)`
- Erreur : `border-color: #b91c1c`, `background: #fef2f2`

### Modales

- Overlay : `background: rgba(0,0,0,0.5)`
- Animation : fade 120 ms + zoom 150 ms (scale 0.95 → 1)
- `role="dialog"`, `aria-modal="true"`, focus trap, Esc pour fermer, restore focus au close
- Composant partagé : [src/components/common/ConfirmModal.jsx](../src/components/common/ConfirmModal.jsx)

### Skeleton loaders

- Gradient : `linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)`
- Animation : `shimmer` 1.4-1.5s infinite ease-in-out

### Fallback image

- Bloc `#f3f4f6` + icône `<FiImage>` centrée en `#9ca3af`
- Jamais `onError` qui cache l'image sans fallback visuel — toujours un substitut

---

## 10. Admin-specific

- **Sidebar** : `240px` fixe, bg `#1e3a2f`, texte `rgba(255,255,255,.72)`
- **Groupes nav** : titre en 11px uppercase 800 + letter-spacing 0.08em
- **Item actif** : bg `rgba(255,255,255,.12)`, border-left 3px `#10b981`
- **Badges notif** : `#ef4444`, 20px rond, font 11px 700

### Panels admin

- `max-width` du contenu : hérite du main (auto)
- Padding : `24px 32px`
- Cards : `bg white`, `border-radius: 12px`, `shadow-sm`, `padding 16-20px`
- Headers de panels : h2 `1.5rem 900`, padding-bottom 16px, border-bottom 2px `var(--color-border)`

---

## 11. Accessibilité — règles projet

- Contraste validé par audit manuel sur chaque composant
- `aria-label` obligatoire sur boutons icon-only (Nav admin, toggles, close)
- `role="dialog"` + focus trap sur toutes les modales (voir ConfirmModal)
- `role="alert"` sur messages d'erreur inline de formulaire
- `<label htmlFor>` sur tous les inputs
- Focus rings **jamais retirés** — box-shadow 0 0 0 3px rgba(bleu, 0.12) par défaut
- Couleurs : doublées d'icônes/texte (success = vert + ✓, danger = rouge + ⚠)
- Navigation clavier testée sur autocomplete auteur (↑↓ Enter Esc)

---

## 12. Performance — règles projet

- **Images produit** : endpoint `/api/image/:id` → sharp resize 800px + WebP si `Accept: image/webp`, ETag sur nom fichier, `max-age=600 must-revalidate`
- **Cache Node SimpleCache** : 2 min catégories, 5 min listes produits, 30 min fiche produit
- **Debounce** : 300 ms sur recherches (books, authors, activity log)
- **AbortController** : systématique sur autocomplete async
- **Lazy loading** : `<img loading="lazy">` partout sauf hero
- **Code splitting** : tous les panels admin sont `lazy()` dans [src/App.jsx](../src/App.jsx)
- **Bundle size** cible : < 450 KB gzipped pour l'index.js principal

---

## 13. Conventions CSS / JSX

- **CSS** : namespacer les classes par composant (`.books-*`, `.activity-*`, `.tag-*`) — jamais de classes globales génériques (ex : `.card` → `.books-card` ou equivalent)
- **Tokens** : toujours `var(--color-xxx)` dans le CSS, jamais `#10531a` hardcodé
- **Inline styles JSX** : à éviter, réservé aux valeurs dynamiques (couleur calculée depuis un token tag, etc.)
- **Icônes** : `react-icons/fi` (Feather) — un seul set pour tout le projet
- **Pas d'emoji** dans les SVG / icônes structurelles (a11y + plateforme)

---

## 14. À éviter (anti-patterns documentés)

Issus de l'historique du projet (voir `feedback_workflow.md` en mémoire) :

- **Hex `#10531a` hardcodé** → utiliser `var(--color-green-deep)`. Déjà corrigé dans BooksPanel/TagsPanel/ActivityLogPanel.
- **`--color-orange` pour CTA admin principal** → réservé e-commerce. Admin utilise `--color-green-deep`.
- **Classes CSS globales** (`.pill`, `.card`, `.btn`) non namespacées → collision. Toujours préfixer.
- **`onError` qui cache l'image** → utiliser fallback `<FiImage>` (pattern CoverImage).
- **Hover comme seule interaction** → toujours doubler par click/tap sur mobile.
- **Texte gris sur gris** → contraste < 4.5:1. Minimum `--color-text-light` (#6b7280) sur `--color-white`.
- **`width` / `height` animés** → toujours `transform: scale()` ou opacity.
- **Cache-Control `immutable`** sur images modifiables → ETag + `must-revalidate`.

---

## 15. Overrides de page

Si une page dévie de cette charte, créer `design-system/pages/<page>.md` en n'écrivant **que les différences**. Exemple :

```markdown
# Home override

## Overrides
- Section title : barre verticale 5px (au lieu 4px) colorée par tag (var(--tag-accent))
- Kicker : 11px 800 uppercase, colored same as barre
- Cards produit : width 200px fixe (mobile : 160px)
```

Pages ayant déjà des conventions dédiées (à documenter au fur et à mesure) :
- `home` — sections dynamiques par tag, prix barré promo
- `admin/books` — split layout 1:1.4, skeleton list pendant load, flash 2.5s après save
- `admin/activity` — timeline groupée par jour, chips top actions colorées
- `pos` — tailwind dédié POS, boutons xxl touch-friendly

---

## 16. Ressources & références

- Checklist UI/UX transverse : `~/.claude/projects/-home-youssoupha/memory/ui_ux_checklist.md` (auto-chargée)
- Charte CSS vars : [src/index.css](../src/index.css) lignes 3-28
- Composants partagés : [src/components/common/](../src/components/common/)
- Hook form binder : [src/hooks/useFormField.js](../src/hooks/useFormField.js)
- Utils : [src/utils/bookForm.js](../src/utils/bookForm.js), [src/utils/excludedCategories.js](../src/utils/excludedCategories.js)

---

## Changelog

- **2026-04-23** — v1.0 : document initial, consolidation des patterns utilisés (tags curation, activity log, books management, confirmation modal partagée)
