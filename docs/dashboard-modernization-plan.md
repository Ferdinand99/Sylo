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
  `tv-builder.js`, `msg-builder.js`, `reminder-builder.js`, `cc-builder.js`.
  *(Phase 2 update: all ported to Alpine and deleted except `cc-builder.js`;
  `alpine-components.js` now holds `chipPicker` / `rrRows` / `embedEditor` /
  `embedList` / `reminderBuilder` / `tvName`.)*
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

## Phase 1 — Route/view refactor for fragments — DONE (bar 2 Phase-2-blocked forms)

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

### Done (commit 6 — command overrides)

- `guild/commands.ejs` per-command forms (`POST /guilds/:id/commands/:command`)
  post via htmx (`hx-target="this" hx-swap="none"`); the route returns
  `204 + HX-Trigger toast` (and a `404 + bad toast` for an unknown command).
  Covers both the standalone `/commands` page and the Moderator → Commands tab.

### Still to do

- **Moderator → Infractions tab** (warn a member / remove a ban) — still
  full-reload. Intentional: these are *actions* with Discord side effects
  (mod-log embed, real unban) and the warnings/bans list needs to refresh, so a
  reload is fine feedback. Convert later by re-rendering the tab partial if
  wanted.
- **`polls` config form:** done — Phase 2 embed-editor port added `hx-post` to
  `#module-config`. **`welcome-channel`:** ported to `embedList` in Phase 2; the
  form stays full-nav (Save reloads the panel, Publish early-returns a redirect),
  which is fine for a heavy builder page.

**Phase 1 is effectively done** — every settings save on the dashboard is now a
fragment swap + toast, with the no-JS fallback intact. The two remaining items
are an action page (Infractions) and two forms blocked on Phase 2.
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

**Done:**
- **chip-picker** → `chipPicker` in `alpine-components.js`; `partials/chip-picker.ejs`
  is x-for driven; the 3 hand-written `.role-picker` blocks now use the partial;
  `makeRoleChip` + the two chip handlers gone from `app.js`.
- **reaction-role builder rows + style toggle** → `rrRows` in
  `alpine-components.js`; `rr-builder.ejs` rows/style radios/conditional sections
  are `x-model` / `x-for` / `x-show`. The emoji picker in `app.js` now dispatches
  an `input` event so `x-model` sees the pick.
- **shared WYSIWYG embed editor** → `embedEditor` in `alpine-components.js` +
  `partials/embed-editor.ejs`. One config-driven component: feature flags
  (`content` / `author` / `description` / `fields` / `thumb` / `footerIcon`),
  `footerKey` (`footerText` vs `footer`), `fixedBody` (greyed poll preview),
  `vars` (insert-token buttons), `ph` (placeholder overrides). Contenteditable
  fields use `x-init` (seed once) + `@input` (write-only) — no cursor jump. A
  `$watch('e')` keeps the hidden `<input>` populated so htmx serialisation sees
  it. **`reaction-role.js` and `polls.js` deleted.** `rr-builder.ejs` and
  `polls.ejs` both `include('partials/embed-editor', …)`; this also finishes the
  Phase-1-deferred `polls` config form (now `hx-post` to `#module-config`).

- **welcome-channel + msg-builder** → shared `embedList` in `alpine-components.js`
  + `partials/embed-block.ejs` (one `.wc-embed` preview row, `banner` flag adds the
  banner-kind branch as sibling `<template x-if>` so the CSS grid children stay
  direct). `embedList` owns `content` + an ordered `items` list: `x-model`
  textarea, `x-for` rows, splice reorder, `move`/`remove`/`addEmbed`/`addPreset`/
  `add`+`removeField`/`pickImg(row,key)`. `$watch('items'|'content'|'links')`
  writes the surrounding form's `<input name="spec">` (+ an init pass so an
  untouched Save round-trips). Form lookup is generic (`$el` is the form, or the
  first `<form>` under `$root`).
  - welcome-channel: `banner: true`, preset "Add element" cards, `reset()`; form
    stays full-nav (Save reloads the panel, Publish early-returns a redirect).
  - msg-builder: `banner: false`, plain "Add embed", plus `links: true` — a
    `links` sub-list (max 5, `x-model` inputs) serialised as a `{type:'buttons'}`
    row alongside preserved non-link `keepRows`; output is `{content, embeds, rows}`.
  **`welcome-channel.js` and `msg-builder.js` deleted.**

- **reminder-builder** → `reminderBuilder` in `alpine-components.js` (tiny: just
  `msgType` / `mode` / `enableStart` / `enableEnd` toggle state). Tabs are
  `@click` + `:class`, panes `x-show`, the two `name="content"` textareas use
  `:disabled` so only the active one submits, the hidden `msgType` / `mode`
  inputs are `:value`-bound, start/end datetime inputs `:disabled="!enable…"`,
  weekday chips carry their own `x-data="{ on }"` for the `.on` highlight. The
  in-place embed editor is now `include('partials/embed-editor', { hidden:'embed' })`.
  **`reminder-builder.js` deleted.**
- **temp-voice builder** → `tvName` in `alpine-components.js` (one getter for the
  live name preview); `tv-builder.ejs` wraps the input + preview in
  `x-data="tvName(…)"` with `x-model` + `x-text="preview"`. **`tv-builder.js` and
  `window.TV_NAME` deleted.**

- **cc-builder** (custom-command action tree) → `ccBuilder` in
  `alpine-components.js`. Reactive `actions` list (synthetic ids for `:key`);
  `x-for` action cards → `x-if` per type (`reply`/`send` vs `add-role`/
  `remove-role`), nested `x-for` message blocks, nested `x-for` embed fields; all
  fields are `x-model` (the compact `.cc-*` form-style embed editor, not the
  WYSIWYG one), `pickUrl()` prompts for image URLs, `title()` maps type→label,
  `picking` toggles the add-action type picker. `$watch('actions')` + submit +
  init write `<input name="actions">`. Type-branch wrappers use
  `style="display:contents"` so the `.stack` grid stays flat. The advanced-options
  `chip-picker`s are unchanged. **`cc-builder.js` + its 5 `window.CC*` globals
  deleted.**

**Done — every builder runs on Alpine; all per-builder scripts are gone.** Only
`app.js` (Phase 3 target), `htmx-setup.js` and `alpine-components.js` remain in
`src/web/public/`.

---

## Phase 3 — Trim `app.js` — DONE

`app.js` 176 → 52 lines. It now holds only the CSRF plumbing (`_csrf` hidden-input
injection on plain-form submit + a `window.fetch` wrapper that adds the header for
raw `fetch` callers like `/health` backup import) and the `data-confirm`
confirm-on-submit/click handler (~16 plain delete/reset forms opt in; not worth
converting to htmx).

- **`syloAction`** — deleted (zero callers; htmx replaced it).
- **toasts** (`window.syloToast` + the toast DOM builder) → moved into
  `htmx-setup.js`, which was already its only consumer.
- **emoji picker** → `emojiPicker(guildId)` Alpine component + inline markup in
  `rr-builder.ejs`. Wrapper carries `x-data` + `@emoji-pick`; the component
  `$dispatch('emoji-pick', value)` on choose so the wrapper writes `row.emoji`.
  `@click.outside` closes it; custom emoji fetched once per picker on first open.
- **server switcher** close-on-outside/Escape → `x-data @click.outside …
  @keydown.escape.window` on the `<details class="srv-switch">` in `header.ejs`.
- Added `[x-cloak]{display:none!important}` to `styles.css` and `position:relative`
  to `.emoji-cellwrap`.

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
- Decision: **hand-written CSS + tokens** (no Tailwind). Dark-only for now, but
  every colour routes through a semantic token so a light palette is a later
  drop-in. No theme toggle added.

### 4a — foundation — DONE

- **Tokens** added to `:root` in `styles.css`: a 4px spacing scale (`--sp-1..6`),
  standard field/content widths (`--w-num`, `--w-field-sm`, `--w-field`,
  `--mw-xs..2xl`), motion (`--dur-1/2`, `--ease`).
- **Utility layer** (`.u-*`): `u-m0`, `u-mt-0..6`, `u-mb-1..3`, `u-my-1`,
  `u-grow`, `u-inline`, `u-nowrap`, `u-text-right`, `u-w-num/-field-sm/-field`,
  `u-mw-xs..2xl`, `u-list`. Plus `[x-cloak]{display:none!important}` (from 3).
- **Inline-style sweep:** 243 of 265 `style=""` attributes across 42 views
  replaced with utility classes (values snapped to the scale — 6/10/14px → 8/12/16).
  The 22 kept are dynamic (`:style` / `<%= %>`), structural (`display:contents`),
  or genuine one-offs. Done with a char-scanning script (regex over-matched EJS
  islands on the first try).

### 4b — component polish — DONE

Conservative, no-markup-churn tightening in `styles.css` (applies to every page by
inheritance):

- **Utility block moved to end of file** so `.u-mw-*` etc. win over component
  rules — fixes forms that `.stack`'s `max-width:460px` was clipping after the 4a
  sweep (reminder/automod/settings/polls/tv/msg builders). Added `.u-stack`.
- **Form controls:** `:focus` now sets an accent border (not just the global
  `:focus-visible` ring); `:disabled` dims to 0.55 + not-allowed; `select` gets
  `cursor:pointer`; `datetime-local` picks up the shared control styling;
  transitions use the motion tokens.
- **Buttons:** `.btn` (bare, on `<a>` "Discard" links) now has a real ghost look
  (surface bg, border, inline-flex) instead of rendering as plain link text;
  grouped with `button.secondary` / `.btn-secondary`. Primary rule re-ordered
  after ghost so `.btn.btn-primary` still resolves to the gradient. Added
  `:disabled` opacity to the base.
- **Cards:** `.card h3` normalised (14px/700); last card in a form/stack drops its
  bottom margin.

The **overview** and **module-page shell** were reviewed and left as-is — already
close to the target (sticky nav card, health strip, coloured plugin cards).

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
