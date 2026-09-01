# Dashboard modernization plan

Status: **not started** · Owner: Ferdinand99 · Created 2026-09-01 (Sylo 3.0.0)

## Goal

Make the dashboard feel more interactive (no full-page reloads, reactive
builders) and visually cleaner — closer to MEE6's polish — **without** giving up
Sylo's core constraints:

- one Node process, run with `node src/index.js`
- **no build step**
- one Docker container, deployable on Unraid unchanged

Approach: **htmx + Alpine.js first** (behaviour layer), **then a design-system
pass** (CSS/markup). The two are independent — htmx/Alpine change how pages
*behave*, not how they *look*. The design cleanup could be done first, but the
chosen order is: get the interaction patterns stable, then style them once.

Both libraries are **vendored as static files** in `src/web/public/vendor/`
(pinned versions), not loaded from a CDN — matches the self-hosted / offline
ethos and keeps CSP simple.

Each phase is independently shippable and reversible. Work on a branch, merge per
phase.

---

## Current state (what we're changing)

- Express + EJS, server-rendered. ~30 views under `src/web/views/`.
- `src/web/routes/guilds.js` is huge; module pages do `res.render('guild', {…})`
  and `guild.ejs` fans the data out to `guild/modules/<id>.ejs` via a single
  ~30-key `include(configView, {…})` line (known tech debt).
- POST handlers `res.redirect('…?msg=saved')`; `guild.ejs` maps `?msg=` to a
  banner.
- `src/web/public/app.js` — vanilla JS: toasts, confirm-on-submit, module
  enable/disable via a `syloAction()` fetch helper, chip picker, emoji picker,
  server switcher. Plus per-builder scripts: `reaction-role.js`, `polls.js`,
  `tv-builder.js`, `msg-builder.js`, `reminder-builder.js`.
- CSRF: `src/web/middleware/csrf.js`; token in `<meta name="csrf-token">`;
  `app.js` injects `_csrf` into forms and an `x-csrf-token` header on fetch.
- Public, zero-JS pages that must stay server-rendered and framework-free:
  `/leaderboard/:id`, `/lb/:slug`, `/verify`, `/appeal`.

---

## Phase 0 — Foundations (~½ day)

**Goal:** htmx + Alpine loaded, CSRF works over htmx, conventions decided. No
behaviour change yet.

- Vendor `htmx.min.js` + `alpine.min.js` (pin versions) into
  `src/web/public/vendor/`. Add `<script defer>` tags to `partials/header.ejs`.
- `src/web/public/htmx-setup.js`: on `htmx:configRequest`, add `X-CSRF-Token`
  from the meta tag to every htmx request.
- Decide the response convention: a module-config POST returns the re-rendered
  panel fragment (`hx-target="#guild-panel"`, `hx-swap="outerHTML"`) plus a toast
  via an `HX-Trigger: {"toast":{"msg":"Saved","kind":"ok"}}` response header. A
  small client listener renders the toast — this replaces the `?msg=` querystring
  dance.
- `app.js` and htmx coexist during the migration.

**Done when:** a throwaway route can return a fragment htmx swaps in, with CSRF
and a toast.

---

## Phase 1 — Route/view refactor for fragments (bulk, ~1 week spread)

**Goal:** module-config pages save without a full reload.

- **Split `guild.ejs`** so each panel (`overview`, `settings`, `m/<id>`,
  `leaderboard`, …) is an includable partial that can render standalone.
- **Remove the `include(configView, {30 keys})` passthrough:** move the
  per-module context vars into `res.locals` in the route so partials read them
  directly. (Already on the 3.0 backlog — do it here as a prerequisite.)
- Route checks `req.header('HX-Request')`: htmx → render just the partial; normal
  request → the full page (progressive enhancement preserved).
- POST handlers: on `HX-Request`, respond with the re-rendered partial +
  `HX-Trigger` toast instead of `res.redirect('?msg=…')`. Keep the redirect path
  as the no-JS fallback.
- **Module by module.** Start with 3 simple ones (`counting`, `afk`,
  `free-games`), prove the pattern, then roll through the rest (~2–3 per session).
- Convert module toggles + plugin-grid "Enable" buttons from the `syloAction`
  fetch to `hx-post` returning the updated card/dot.

**Done when:** all 26 module pages + overview save via htmx, no-JS fallback intact.

---

## Phase 2 — Alpine for the builders (~3–4 days)

**Goal:** replace hand-rolled DOM JS with declarative reactive state.

- `Alpine.data('<name>', () => ({…}))` in JS files, referenced with `x-data`.
  Server renders initial HTML + a JSON blob for hydration.
- Order (simplest → hardest): **chip-picker** (used everywhere) → reaction-role
  builder → poll builder → reminder builder → temp-voice builder → **WYSIWYG
  embed editor** (longest pole, last).
- Delete the corresponding `src/web/public/*.js` as each is ported.

**Done when:** every builder runs on Alpine; the old builder scripts are gone.

---

## Phase 3 — Trim `app.js` (~½ day)

- After Phases 1–2 `app.js` is nearly empty. `syloAction` → gone (htmx).
  confirm-on-submit → `hx-confirm`. chip/emoji picker → Alpine. Server switcher +
  toasts → `htmx-setup.js` / small Alpine directives.
- Keep the `_csrf` form injection only for the remaining plain forms (public
  pages).

---

## Phase 4 — Design system + cleanup (~1 week, iterative)

**Goal:** "clean like MEE6". Now the interaction patterns are stable, style them
once.

- **Tokens in `:root`:** spacing scale (8px), radius, shadows, a fuller colour
  set (surface levels, borders, state colours). Dark-first; keep the theme
  toggle.
- **Remove every inline `style="…"`** in the EJS → utility / component classes.
- **Component pass:** one `.card`, `.field` / `.field-row`, `.btn` variants,
  `.table`, `.toggle`, `.pill`, `.empty-state`, used consistently. Rebuild the
  module-page shell, the overview grid, the sidebar polish.
- **Motion:** consistent focus rings, hover transitions, smooth panel swaps
  (htmx `transition:true` / View Transitions API).
- Do the template pages first (overview + one module-page template) so the 26
  module pages inherit.
- Optional: Tailwind play-CDN for utility consistency without a real build —
  otherwise disciplined hand-written CSS with the tokens.

---

## Phase 5 — Verify + docs (~1 day)

- Public pages (`/lb`, `/verify`, `/appeal`) still work with JS disabled.
- CSRF enforced on htmx requests.
- Add route tests via `createApp()` (also on the 3.0 backlog): a few
  `HX-Request` fragment assertions.
- Update the README dashboard/architecture section.

---

## Practical notes

- **Commits:** `refactor:` for Phases 0–3 (no user-visible change → patch bumps);
  Phase 4 can be one `feat:` "dashboard redesign" → minor.
- **Effort:** ~3–4 weeks part-time, shippable in increments the whole way.
- Nothing changes about the Docker image or Unraid deployment. If Tailwind
  play-CDN is adopted, that is still no build step.
- Risk management: Phase 1 is module-by-module, so the dashboard is never
  half-broken.
