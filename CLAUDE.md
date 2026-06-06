# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

E-commerce + POS web app for L'Harmattan Senegal (publishing house). React 19 frontend connects to a Dolibarr ERP via an Express 5 API proxy. Currency is XOF (FCFA, 0 decimals). ~6,200 products, 18 categories. Includes a Point-of-Sale system and an admin dashboard.

## Commands

```bash
pnpm dev:all       # Starts Vite (:3000) + Express (:3001) in parallel
pnpm dev           # Vite dev server only (port 3000)
pnpm dev:server    # Express API server only (port 3001)
pnpm build         # Build to dist/
pnpm start         # NODE_ENV=production, Express serves dist/ + API
pnpm lint          # ESLint check
pnpm test          # Vitest run (src/utils/**/*.test.js, server/**/*.test.js)
pnpm test:watch    # Vitest watch mode
```

**Production deployment:**
```bash
pnpm build
sudo systemctl restart senharmattan-shop   # systemd service on VPS 38.242.229.122
```

**Contract ODT templates regeneration:**
```bash
node scripts/build-contract-templates.mjs        # génère les 15 ODT dans /tmp/contract-templates-v2/
sudo bash scripts/deploy-contract-templates.sh   # backup horodaté + copie vers Dolibarr + chown www-data
# si nouveaux extrafields :
mysql -u dolibarr -p dolibarr < scripts/add-contract-subtitle-extrafield.sql
```
Le déploiement nécessite sudo (dossier Dolibarr appartenant à `www-data`). Les contrats déjà générés gardent leur ancien PDF/ODT : régénérer le document (bouton PDF de la fiche) pour reprendre le nouveau template.

## Architecture

**Dual-server in dev, single-server in production:**
- Vite (port 3000) proxies `/api/*` to Express (port 3001) via `vite.config.js`
- In production, Express serves both built `dist/` static files and the API

**Data flow:** React -> `/api/*` -> Express -> Dolibarr REST API (`DOLAPIKEY` auth)

**Backend modules (server/):**
- `index.js` — Main Express server: product API, orders, preorders, newsletter, sync crons, webhook handler
- `pos-routes.js` — POS system: staff PIN auth, sales (invoice + payment + stock), quotes/proforma, cash register, sessions
- `admin-routes.js` — Admin dashboard: site config, slides, FAQs, manuscripts, newsletter, contact messages
- `admin-stats-routes.js` — Analytics: sales stats, top products, revenue reports
- `admin-pos-routes.js` — POS management: staff CRUD, device management, PIN expiry
- `auth-routes.js` — Customer authentication: login, register, password reset, sessions
- `book-routes.js` — Book CRUD: create/update products, cover image upload, extrafield metadata
- `contract-routes.js` — Contract management: CRUD, manuscript linking, ODT-driven PDF generation via Dolibarr extrafields, inline thirdparty (author) creation
- `preorder-utils.js` — Preorder helpers: pricing, payment resolution, email templates, status transitions
- `dolibarr-client.js` — Axios client for Dolibarr API with DOLAPIKEY auth, 30s timeout
- `sync.js` — In-memory cache (SimpleCache) + sync functions for products/categories/stock

**Dual database architecture:**
- MySQL (Dolibarr): products, categories, invoices, orders, customers (read/write via Dolibarr REST API)
- SQLite (`newsletter.sqlite`): newsletter subscribers, customers (local auth), POS staff, POS sessions, admin users, quotes, contact messages, cash movements

**Frontend (src/):**
- `api/` — Axios clients: `dolibarr.js` (main + CSRF), `admin.js`, `pos.js`
- `store/` — Zustand stores with persist: `cartStore`, `authStore`, `posAuthStore`, `posCartStore`, `posSessionStore`
- `pages/` — Route-level components: shop pages, admin panels, POS pages
- `components/` — By feature: `layout/`, `home/`, `product/`, `common/`, `pos/`, `auth/`

## Environment Configuration

Requires `.env` at project root (loaded via `dotenv/config`):
```
MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
DOLIBARR_URL, DOLIBARR_API_KEY, DOLIBARR_ADMIN_API_KEY
ADMIN_DEFAULT_PASSWORD
```

## Dolibarr API Specifics

- Auth: `DOLAPIKEY` header (two keys: read-only in `dolibarr-client.js`, admin in `pos-routes.js`)
- **Sort fields use `t.` prefix** (not `p.`): `t.rowid`, `t.ref`, `t.label`
- SQL filters syntax: `(t.field:operator:'value')` — user input must go through `safeSqlFilter()`
- Product images: no standard naming; `/api/image/:productId` auto-discovers via documents API

## POS System (/pos/*)

- Staff auth via 6-digit PIN (bcrypt hashed), with 15-day PIN expiry
- Session tokens (`X-POS-Token` header) replace raw staff IDs
- POS config in `pos-routes.js`: terminal=3, warehouse=4, default customer=13
- Payment methods: Cash (LIQ), Card (CB), Check (CHQ), Wave, Orange Money — each maps to Dolibarr payment ID + bank account
- Sales create Dolibarr invoices + payments + stock decrements
- Quotes (Facture Proforma) generate ODT files from `server/templates/devis-librairie.odt`
- ODT generation: unzip template, replace XML placeholders, rezip (no Carbone for quotes)

## Contract System (/admin/contracts/*)

- Wizard `ContractCreate.jsx` en 3 étapes : auteur → type/conditions → vérification.
- **Auteur** : recherche + création inline (POST `/api/contracts/thirdparties`, nom + email + téléphone tous obligatoires, dédup par nom).
- **Type de contrat** = combinaison **modèle × étendue de droits** stockée dans `options_contract_type` au format `modele_scope` (ex : `harmattan_2024_edition_numerique`) :
  - **Modèles** : `harmattan_2024` (classique), `harmattan_dll` (subventionné DLL), `tamarinier` (collection).
  - **Étendues** : `edition_simple` (papier), `edition_numerique` (+ avenant numérique), `edition_complete` (+ adaptations audiovisuelle & théâtrale).
- Extrafields Dolibarr propres aux contrats (table `llx_contrat_extrafields`) : `book_title`, `book_subtitle`, `book_isbn`, `royalty_rate_print/digital`, `royalty_threshold`, `royalty_digital_threshold_fcfa` (seuil de report num.), `free_author_copies`, `tirage_initial`, `format_ouvrage`, `nombre_pages_estime`, `prix_public_previsionnel` (€), `exemplaires_sp`, `author_purchase_enabled/qty/discount` (annexe achat auteur), `date_signature`, `editeur_signataire_nom/qualite`.
- Migration SQL des extrafields : `scripts/add-contract-subtitle-extrafield.sql` (idempotent — `ON DUPLICATE KEY` + `ADD COLUMN IF NOT EXISTS`).
- **Templates ODT** générés par `scripts/build-contract-templates.mjs` (9 combinaisons + 6 alias legacy = 15 fichiers), déployés via `scripts/deploy-contract-templates.sh` dans `/var/www/html/dolibarr/documents/doctemplates/contracts/`. Wording Article 4 spécifique pour DLL (15 % sur 1000 premiers ex. subventionnés, puis 10 %). Placeholders `{object_options_*}` + `{__THIRDPARTY_NAME/PHONE/EMAIL__}` + `{__ONLINE_SIGN_URL__}`. **Dolibarr ne supporte pas les blocs conditionnels** → l'annexe d'achat auteur apparaît toujours (avec `qty=0` si non activée).
- **Logo en-tête** : chaque ODT embarque `public/images/logo.png` sous `Pictures/logo.png` (entrée manifest + `draw:frame`/`draw:image` `as-char` en tête de l'ouverture, 4,5 × 2,29 cm). Le chemin source et les dimensions sont en constantes (`LOGO_SRC`, `LOGO_WIDTH_CM`, `LOGO_HEIGHT_CM`) en tête du script. Format ouvrage standard : `15,5 × 24 cm`.
- Workflow manuscrit : la création auto de contrat (`server/index.js`) bascule sur `harmattan_2024_edition_simple` par défaut.
- Signature en ligne : URL générée via `generateSignatureUrl(ref)` (HMAC bcrypt avec `DOLIBARR_INSTANCE_KEY` + `DOLIBARR_SIGN_TOKEN`).

## Security Patterns

- **CSRF**: Token via `/api/csrf-token`, validated on POST/PUT/DELETE via `X-CSRF-Token` header
- **Auth**: Server-side sessions for customers (`customer_session` cookie), POS (`X-POS-Token` header), admin (`admin_session` cookie)
- **Rate limiting**: Auth endpoints (5 per 15 min), PIN attempts (5 per 5 min), sales (120 per hour)
- **Input sanitization**: `safeSqlFilter()` for Dolibarr sqlfilters, `escapeHtml()` for email templates, `sanitizeBody()` middleware
- **Cookies**: `httpOnly: true`, `sameSite: 'strict'` — `secure` flag disabled until SSL is configured
- **Static file blocking**: `.sqlite`, `.db`, `.env` files blocked via middleware

## Caching & Sync

In-memory cache (`server/sync.js` SimpleCache) with TTL. Cron jobs:
- Stock: every 5 min | Categories: every 1 hour | Products: every 6 hours
- Manual: `POST /api/sync/trigger` (requires admin auth)
- Webhook: Dolibarr posts product/category changes to `POST /api/webhooks/dolibarr` (HMAC-signed) → cache invalidation

## Styling

- Vanilla CSS with co-located files (e.g., `ProductCard.jsx` + `ProductCard.css`)
- CSS variables in `src/index.css`: `--color-green (#10531a)`, `--color-orange (#f97316)`, `--color-dark (#222222)`
- Font: Lato (Google Fonts). Mobile breakpoint: 768px
- POS: fullscreen dark UI, separate CSS files in `src/components/pos/`

## Routes

**Shop (French URLs):** `/catalogue`, `/produit/:id`, `/panier`, `/commande`, `/connexion`, `/inscription`, `/compte`, `/contact`, `/a-propos`, `/faq`, `/cgv`, `/mentions-legales`, `/suivi-commande`

**POS:** `/pos/connexion` (PIN login), `/pos` (main POS interface)

**Admin:** `/admin` (login), `/admin/*` (stats, config, slides, faq, contacts, manuscripts, newsletter, books, pos, contracts, users, activity-log, profile)

## Admin Roles (RBAC)

Whitelist par rôle dans `server/admin-routes.js` (`ROLE_ALLOWED_PATHS`). `super_admin` et `admin` ont accès complet.

| Rôle | Périmètre |
|------|-----------|
| `super_admin` | Tout + gestion utilisateurs |
| `admin` | Tout sauf gestion utilisateurs |
| `editor` | Livres, manuscrits, contrats, bannières, tags de curation, stats |
| `support` | Messages, FAQ, newsletter, clients, stats |
| `librarian` | **Livres CRUD complet** (création, édition, suppression, upload couverture, assignation des tags de curation aux livres) + Stock en lecture seule. Création/édition/suppression des tags globaux reste réservée aux éditeurs/admins (middleware `blockLibrarianWrite` conservé sur POST/PUT/DELETE `/admin/tags`). |
| `comptable` | Comptabilité (lecture + écriture), paiements web, stats |
| `vendeur` | POS uniquement (via PIN dédié sur `/pos/connexion`) |
| `evaluateur` / `correcteur` / `infographiste` / `imprimeur` | Workflow éditorial — accès limité à leur étape |

## Preorder System

- Preorders for unreleased books with discount pricing and estimated release dates
- Payment methods resolved via `resolvePaymentMethod()` in `preorder-utils.js`
- Status flow: `pending` → `confirmed` → `released` (or `cancelled`)
- Email notifications on confirmation, release, and cancellation via Nodemailer
- Cron-based release check triggers invoice creation and customer notification
