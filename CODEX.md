# CODEX.md

This file is Codex's working memory for this repository. It is derived from `CLAUDE.md` and should be kept in sync when project conventions change.

## Project Overview

E-commerce + POS web app for L'Harmattan Senegal, a publishing house. React 19 frontend connects to Dolibarr ERP through an Express 5 API proxy. Currency is XOF / FCFA with 0 decimals. The catalog has about 6,200 products and 18 categories. The app includes a public shop, a point-of-sale system, and an admin dashboard.

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

Production deployment:

```bash
pnpm build
sudo systemctl restart senharmattan-shop   # systemd service on VPS 38.242.229.122
```

## Architecture

Development uses two servers, production uses one:

- Vite on port 3000 proxies `/api/*` to Express on port 3001 via `vite.config.js`.
- In production, Express serves both the built `dist/` static files and API routes.
- Data flow is React -> `/api/*` -> Express -> Dolibarr REST API with `DOLAPIKEY` auth.

Backend modules in `server/`:

- `index.js`: main Express server, product API, orders, preorders, newsletter, sync crons, webhook handler.
- `pos-routes.js`: POS system, staff PIN auth, sales, quotes/proforma, cash register, sessions.
- `admin-routes.js`: admin dashboard, site config, slides, FAQs, manuscripts, newsletter, contacts.
- `admin-stats-routes.js`: analytics, sales stats, top products, revenue reports.
- `admin-pos-routes.js`: POS management, staff CRUD, device management, PIN expiry.
- `auth-routes.js`: customer login, registration, password reset, sessions.
- `book-routes.js`: book CRUD, product creation/update, cover upload, extrafield metadata.
- `contract-routes.js`: contract CRUD, manuscript links, document generation with Carbone.
- `preorder-utils.js`: preorder pricing, payment resolution, email templates, status transitions.
- `dolibarr-client.js`: Axios client for Dolibarr API with `DOLAPIKEY` auth and 30s timeout.
- `sync.js`: in-memory cache and sync functions for products, categories, and stock.

Databases:

- MySQL through Dolibarr REST API: products, categories, invoices, orders, customers.
- SQLite `newsletter.sqlite`: newsletter subscribers, customers/local auth, POS staff, POS sessions, admin users, quotes, contact messages, cash movements.

Frontend in `src/`:

- `api/`: Axios clients including `dolibarr.js`, `admin.js`, and `pos.js`.
- `store/`: Zustand stores with persist, including cart, auth, POS auth, POS cart, and POS session.
- `pages/`: route-level components for shop, admin, and POS pages.
- `components/`: feature components under `layout/`, `home/`, `product/`, `common/`, `pos/`, and `auth/`.

## Environment

The project expects a root `.env` loaded with `dotenv/config`.

Required keys:

```bash
MYSQL_HOST
MYSQL_USER
MYSQL_PASSWORD
MYSQL_DATABASE
DOLIBARR_URL
DOLIBARR_API_KEY
DOLIBARR_ADMIN_API_KEY
ADMIN_DEFAULT_PASSWORD
```

Never expose or print secrets from `.env` in final answers.

## Dolibarr Notes

- Auth uses the `DOLAPIKEY` header. There are two keys: read-only in `dolibarr-client.js`, admin in `pos-routes.js`.
- Sort fields use the `t.` prefix, not `p.`: `t.rowid`, `t.ref`, `t.label`.
- SQL filters use `(t.field:operator:'value')`; user input must go through `safeSqlFilter()`.
- Product images have no standard naming. `/api/image/:productId` auto-discovers images through the documents API.

## POS

- POS routes live under `/pos/*`.
- Staff auth uses 6-digit PINs hashed with bcrypt.
- PINs expire after 15 days.
- Session tokens use the `X-POS-Token` header and replace raw staff IDs.
- POS config in `pos-routes.js`: terminal 3, warehouse 4, default customer 13.
- Payment methods: Cash (`LIQ`), Card (`CB`), Check (`CHQ`), Wave, Orange Money. Each maps to a Dolibarr payment ID and bank account.
- Sales create Dolibarr invoices, payments, and stock decrements.
- Quotes / Facture Proforma generate ODT files from `server/templates/devis-librairie.odt`.
- Quote ODT generation unzips the template, replaces XML placeholders, then rezips. It does not use Carbone.

## Security

- CSRF token from `/api/csrf-token`; POST/PUT/DELETE must send `X-CSRF-Token`.
- Customer auth uses `customer_session` cookie.
- Admin auth uses `admin_session` cookie.
- POS auth uses `X-POS-Token`.
- Rate limits exist for auth endpoints, PIN attempts, and sales.
- Use `safeSqlFilter()` for Dolibarr SQL filters.
- Use `escapeHtml()` for email templates.
- `sanitizeBody()` middleware sanitizes request bodies.
- Cookies are `httpOnly` and `sameSite: 'strict'`; `secure` is disabled until SSL is configured.
- Static access to `.sqlite`, `.db`, and `.env` files is blocked by middleware.

## Caching And Sync

`server/sync.js` defines the in-memory `SimpleCache` and sync helpers.

Cron jobs:

- Stock: every 5 minutes.
- Categories: every 1 hour.
- Products: every 6 hours.
- Manual sync: `POST /api/sync/trigger`, requires admin auth.
- Dolibarr webhook: `POST /api/webhooks/dolibarr`, HMAC-signed, invalidates caches for product/category changes.

## Styling

- Vanilla CSS with co-located component CSS files, for example `ProductCard.jsx` + `ProductCard.css`.
- Main CSS variables are in `src/index.css`.
- Brand colors: `--color-green` `#10531a`, `--color-orange` `#f97316`, `--color-dark` `#222222`.
- Font: Lato from Google Fonts.
- Mobile breakpoint: 768px.
- POS uses fullscreen dark UI and separate CSS files in `src/components/pos/`.

## Routes

Shop French URLs:

- `/catalogue`
- `/produit/:id`
- `/panier`
- `/commande`
- `/connexion`
- `/inscription`
- `/compte`
- `/contact`
- `/a-propos`
- `/faq`
- `/cgv`
- `/mentions-legales`
- `/suivi-commande`

POS:

- `/pos/connexion`
- `/pos`

Admin:

- `/admin`
- `/admin/*` for stats, config, slides, FAQ, contacts, manuscripts, newsletter, books, POS, contracts, users, activity log, profile.

## Admin Roles

Role whitelists are in `server/admin-routes.js` under `ROLE_ALLOWED_PATHS`. `super_admin` and `admin` have full access, except `admin` cannot manage users.

| Role | Scope |
| --- | --- |
| `super_admin` | Everything plus user management |
| `admin` | Everything except user management |
| `editor` | Books, manuscripts, contracts, banners, curation tags, stats |
| `support` | Messages, FAQ, newsletter, customers, stats |
| `librarian` | Full book CRUD, cover upload, tag assignment to books, read-only stock. Global tag create/edit/delete remains editor/admin only through `blockLibrarianWrite` on `/admin/tags` writes. |
| `comptable` | Accounting, web payments, stats |
| `vendeur` | POS only through PIN login at `/pos/connexion` |
| `evaluateur`, `correcteur`, `infographiste`, `imprimeur` | Editorial workflow with limited access to assigned step |

## Preorders

- Preorders support unreleased books with discount pricing and estimated release dates.
- Payment methods are resolved through `resolvePaymentMethod()` in `preorder-utils.js`.
- Status flow: `pending` -> `confirmed` -> `released`, or `cancelled`.
- Email notifications are sent on confirmation, release, and cancellation through Nodemailer.
- A cron release check creates invoices and notifies customers when preorders become available.

## Codex Working Notes

- Read nearby code before editing; follow existing React, Express, Zustand, and CSS patterns.
- Keep changes scoped. Avoid broad refactors unless the requested change needs them.
- Prefer `rg` for searching.
- Use `pnpm lint`, `pnpm test`, and `pnpm build` when the change risk warrants it.
- Be careful with `newsletter.sqlite` and generated files; do not modify database files unless explicitly asked.
- Do not revert user changes in this repository.
- When touching security-sensitive flows, check CSRF/session/rate-limit behavior before declaring the task finished.
