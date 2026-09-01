# Dashboard modernization plan

Status: **Phase 0 done** · Owner: Ferdinand99 · Created 2026-09-01 (Sylo 3.0.0)

Branch: `feat/dashboard-htmx-alpine`.

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

## Phase 0 — Foundations — DONE

**Goal:** htmx + Alpine loaded, CSRF works over htmx, conventions decided. No
behaviour change yet.

Shipped:

- `src/web/public/vendor/{htmx.min.js@2.0.4, alpine.min.js@3.14.8}` + a
  `vendor/README.md` with source URLs and the upgrade command.
- `partials/header.ejs`: `<script defer>` for `/vendor/htmx.min.js`,
  `/htmx-setup.js`, `/vendor/alpine.min.js` (in that order). Only dashboard pages
  use this partial; the public pages (`/leaderboard`, `/lb`, `/verify`,
  `/appeal`) have their own `<head>` and stay framework-free.
- `src/web/public/htmx-setup.js`: adds `X-CSRF-Token` (from the meta tag) to every
  htmx request via `htmx:configRequest`; bridges an `HX-Trigger` `toast` event to
  `window.syloToast`; surfaces `htmx:responseError` / `htmx:sendError` as a bad
  toast so a failed save is never silent.
- **Convention decided:** a config POST responds — on `HX-Request` — with the
  re-rendered panel/card fragment (`hx-target` on the panel wrapper,
  `hx-swap="outerHTML"`) and sets
  `HX-Trigger: {"toast":{"msg":"…","kind":"ok|bad|info"}}`. Non-htmx requests keep
  the `res.redirect('?msg=…')` fallback. This replaces the `?msg=` banner dance.
- **Dev-only sanity route** `GET/POST /__htmx-check` (in `dashboard.js`, gated on
  `NODE_ENV !== 'production'`) + `views/htmx-check.ejs` +
  `partials/htmx-check-body.ejs`. Clicking *Bump* swaps the fragment with no
  reload, pops a toast, and reports that the CSRF header reached the server; an
  Alpine `x-data` counter is on the same page. **Remove in Phase 5.**

**Verify:** open `/__htmx-check` while logged in → Bump swaps the box, toast
appears, "Server received X-CSRF-Token: yes"; the Alpine button increments.

---

## Phase 1 — Route/view refactor for fragments — IN PROGRESS

**Goal:** module-config pages save without a full reload.

### Done (commit 1 — pattern established)

- **`moduleViewLocals(mod, req, configOverride)`** in `guilds.js`: one function
  builds the full render context for a module panel (all keys, defaulted).
  Replaces the ~30-key `include(configView, {…})` passthrough in `guild.ejs` —
  EJS 3 bare `include()` inherits all parent locals, so the passthrough was pure
  ceremony. Used by the GET page, the htmx fragment render, and the config-POST
  re-render.
- **`views/guild/_module-config.ejs`**: `<div id="module-config">` wrapper around
  `include(configPartialRel)`. `guild.ejs` includes it; the routes render it
  standalone.
- **`GET /:guildId/m/:moduleId`**: on `HX-Request` → `res.render('guild/_module-config')`
  (fragment only); otherwise the full page.
- **`POST /:guildId/m/:moduleId/config`**: on `HX-Request` → re-render the
  fragment + `HX-Trigger: {"toast":{"msg":"Saved","kind":"ok"}}`; otherwise the
  existing `res.redirect('?msg=saved')`.
- **Converted so far (17 module config forms):** counting, afk, free-games
  (commit 1); sticky, server-stats, autoresponder, logging, tickets,
  invite-tracker, verification, leveling, giveaways, twitch-alerts,
  youtube-alerts, roles, appeals, welcome (commit 2). All: `hx-post` /
  `hx-target="#module-config"` / `hx-swap="outerHTML"`; `method`/`action` stay as
  the no-JS fallback. verification / invite-tracker / welcome have fire-and-
  forget side-effects but no early `res.redirect`, so the shared `HX-Request`
  branch handles them.

### Done (commit 3 — module-page toggle)

- The enable/disable switch on a module's settings page is now
  `views/guild/_module-toggle.ejs`: an htmx checkbox that posts to
  `/guilds/:id/modules/:id` on change and swaps itself with the server-truth
  state. `POST /:guildId/modules/:moduleId` gains an `HX-Request` branch that
  renders that fragment + `HX-Trigger: {moduleToggled, toast}`; the JSON response
  stays for any non-htmx caller. `htmx-setup.js` listens for `moduleToggled` and
  updates the sidebar dot. app.js's `.module-toggle` handler is now dead (the
  fragment dropped that class) — removed in Phase 3.

### Done (commit 4 — plugin-grid Enable buttons)

- Overview "+ Enable" buttons post via htmx (`hx-vals` carries
  `enabled:true, view:grid`); the shared `POST /:guildId/modules/:moduleId`
  HX-Request branch renders `guild/_plugin-cta.ejs` (the "✓ Active" link) for
  `view=grid`, `_module-toggle.ejs` otherwise. Cards got
  `id="plugin-card-<id>"`; the `moduleToggled` listener toggles their `is-on`
  class alongside the sidebar dot.
- **Both dead `app.js` blocks removed** (`.module-toggle` change handler +
  `.plugin-btn.enable` click handler). `syloAction` / `toast` remain for Phase 3.

### Done (commit 5 — Moderator page settings tabs)

- The Automod, Auto-actions and Immunity forms on the tabbed `panel === 'moderation'`
  page now save via htmx. Shared partials (`automod.ejs`, `logging.ejs`) take
  optional `fragTarget` / `fragSwap` locals: default `#module-config` /
  `outerHTML` (module page), `this` / `none` when included on the Moderator page —
  so on the Moderator page the save just fires + toasts (the tab's visible state
  is already what the user set). Only new route work: `/m/automod/immunity` got a
  `204 + HX-Trigger toast` branch; automod/moderation config ride the existing
  generic `/config` HX-Request branch (response discarded under `hx-swap="none"`).
- This also fixes the batch-2 edge where `logging.ejs`'s hard-coded
  `hx-target="#module-config"` failed on the Moderator page.

### Still to do

- Moderator page **Infractions** tab (warn / remove-ban forms) and **Commands**
  tab (per-command overrides) — still full-reload; lower priority.
- **`polls` and `welcome-channel` config forms:** submit-time JS populates hidden
  fields — finish these with the Phase 2 builders (`welcome-channel` publish also
  early-returns a redirect).
- Convert the standalone builder pages (rr / sb / cc / msg / reminder / tv).
- Convert module enable/disable toggles + plugin-grid "Enable" from the
  `syloAction` fetch to `hx-post` returning the updated card/dot.
- Split the other `guild.ejs` panels (`overview`, `settings`, `leaderboard`,
  `appeals`, `moderation`, `audit`, `commands`) into standalone partials for
  fragment nav — optional, lower priority.

**Done when:** all 26 module pages + overview save via htmx, no-JS fallback intact.

---

## Phase 2 — Alpine for the builders

**Goal:** replace hand-rolled DOM JS with declarative reactive state.

- `Alpine.data('<name>', () => ({…}))` in JS files, referenced with `x-data`.
  Server renders initial HTML + a JSON blob for hydration.
- Order (simplest → hardest): **chip-picker** (used everywhere) → reaction-role
  builder → poll builder → reminder builder → temp-voice builder → **WYSIWYG
  embed editor** (longest pole, last).
- Delete the corresponding `src/web/public/*.js` as each is ported.

**Done when:** every builder runs on Alpine; the old builder scripts are gone.

---

## Phase 3 — Trim `app.js`

- After Phases 1–2 `app.js` is nearly empty. `syloAction` → gone (htmx).
  confirm-on-submit → `hx-confirm`. chip/emoji picker → Alpine. Server switcher +
  toasts → `htmx-setup.js` / small Alpine directives.
- Keep the `_csrf` form injection only for the remaining plain forms (public
  pages).

---

## Phase 4 — Design system + cleanup

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

## Phase 5 — Verify + docs

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
