# Roadmap

The living post-3.5.0 roadmap. The original 5-release plan (3.1.1 → 3.5.0) and the
documentation pass are done; this file tracks the backlog after that.

Each `feat:` workstream below is its own branch → PR → release-please, so it cuts
its own minor — there is no single umbrella release. The first batch was scoped as
a "**3.6 line**" and has run **3.6.0 → 3.9.0** so far (with one unplanned feature
inserted); see **Progress** below.

Base: `main` at **3.5.0**. `express@^4.21.2`, `discord.js@^14.16.3`.

Working conventions unchanged: branch per workstream, PR into `main`; `npm test`
+ `npm run lint` + `npm run format:check` + `docker compose up -d --build`
healthy before a PR is marked ready; one commit per chunk with a
Conventional-Commit summary; new guild-scoped table ⇒ `GUILD_TABLES` (a test
enforces it) and `forgetUser` / `describeUserData` if user-scoped; new module ⇒
`registry.js` + `modules/index.js` + config view + `CONFIG_VIEWS` + `MODULE_ICONS`
+ `#i-<name>` sprite + `sidebarNav.js` + `overviewSummary.js` + `docs/modules/`.

---

## Progress (as of 3.9.0)

| # | Workstream | Status |
|---|---|---|
| 1 | Dashboard UX polish | ✅ shipped in **3.6.0** |
| 2 | Route-test harness | ✅ shipped (no bump, PR #73) |
| 3 | Observability | ✅ shipped in **3.7.0** |
| 4 | Native Discord AutoMod push | ✅ shipped in **3.8.0** |
| 5a | `posted_keys` dedupe helper | ✅ shipped (`refactor:`, no bump, PR #79) |
| — | **Kick.com alerts + plain-text alert mode** (unplanned, issue #78) | ✅ shipped in **3.9.0** |
| 5b | RSS module | ⏳ next — now targets **3.10.0** |
| 6 | Server insights page | targets **3.11.0** |
| 7 | Express 5 spike + discord.js v15 watch | no bump, slot in anytime |

The Kick-alerts feature (issue #78) was slotted in between 5a and 5b and took the
**3.9.0** minor the RSS module was originally pencilled in for, so everything from
5b down shifts one minor. Kick alerts is the 28th module, so **RSS is the 29th**.

---

## Order & sizing

| # | Workstream | Type | Size | Expected | Actual |
|---|---|---|---|---|---|
| 1 | Dashboard UX polish | `feat:` | M | **3.6.0** | ✅ 3.6.0 |
| 2 | Route-test harness | `test:` | M | no bump (merge just before #3) | ✅ no bump |
| 3 | Observability | `feat:` | M | **3.7.0** | ✅ 3.7.0 |
| 4 | Native Discord AutoMod push | `feat:` | M–L | **3.8.0** | ✅ 3.8.0 |
| 5a | `posted_keys` dedupe helper | `refactor:` | M | no bump | ✅ no bump |
| — | Kick.com alerts + plain-text mode (issue #78) | `feat:` | M | — | ✅ 3.9.0 |
| 5b | RSS module | `feat:` | L | ~~3.9.0~~ **3.10.0** | — |
| 6 | Server insights page | `feat:` | L | ~~3.10.0~~ **3.11.0** | — |
| 7 | Express 5 spike + discord.js v15 watch | `chore:` / spike | M | no bump | — |

Rationale for the order: #1 is small and visible; #2 makes everything after it
safer to change and should merge just before #3; #3–#4 are contained; #5–#6 are
the big ones; #7 is infra housekeeping that can slot in whenever.

---

## 1 — Dashboard UX polish → 3.6.0

> ✅ **Shipped in 3.6.0** (`feat/dashboard-ux`). All four pieces as planned.

Branch `feat/dashboard-ux`. Four independent pieces; ship together.

### 1a. Module search / filter
- On the overview grid and the sidebar: a small Alpine component filtering
  `.plugin-card` (overview) and `.sb-link[data-module]` (sidebar) by name
  substring, live as you type.
- New `x-data="moduleFilter"` in `alpine-components.js`; a search `<input>` above
  the grid in `guild.ejs` (overview panel) and one in `partials/header.ejs` above
  `.sb-nav`. Non-matching cards/rows hidden via `x-show` / a class.
- Optionally persist the last query in `localStorage` (`sylo:modfilter`).
- No route changes.

### 1b. Light theme + toggle
- `styles.css` already routes every colour through semantic tokens on `:root`
  (`--bg`, `--surface`, `--text`, `--border`, `--accent`, …) — dark-first.
- Add `:root[data-theme="light"] { … }` redefining only those tokens for a light
  palette, plus `@media (prefers-color-scheme: light)` guarded as
  `:root:not([data-theme="dark"])` so "system" works.
- Header toggle in `.sb-foot` that flips `document.documentElement.dataset.theme`
  and writes `localStorage` `sylo:theme`. Read it in the existing inline `<head>`
  script (the one that adds `has-js`) so there's no flash.
- Check toast, banner, plugin-card, table and embed-preview colours in both.
- `styles.css` is in `.prettierignore` (no format gate); still do the visual
  pass in the container.

### 1c. Per-module "Send test"
- A "Send test" button on `guild/_module-config.ejs` (or per applicable partial)
  that fires the module's output once with sample data — welcome message,
  birthday greeting, log-event embed, autoresponder reply, twitch/yt alert,
  starboard post, reminder.
- New route `POST /:guildId/m/:moduleId/test` → `switch (moduleId)` calling the
  module's send path with a fabricated payload; returns `204 + HX-Trigger` toast
  ("Test sent to #channel" / "Nothing to test — set a channel first").
- Only wire modules where a test is meaningful (skip counting, afk, temp-voice,
  game-stats). Guard on the module being configured.

### 1d. Bulk enable / disable
- Overview: a "select mode" showing a checkbox on each `.plugin-card`, then
  "Enable selected" / "Disable selected".
- New route `POST /:guildId/modules/bulk` taking `ids[]` + `enabled` → loops
  `setGuildModule`, runs the same post-toggle side-effects the single route does
  (invite-cache prime, custom-command sync), returns the re-rendered grid
  fragment + one toast.
- Alpine `x-data="bulkModules"` on the grid manages the selection set.

**Verify:** `npm test`; toggle the theme and eyeball every panel; send a test for
each wired module into a real channel; bulk-enable 3 modules and confirm the
sidebar dots + cards update without a reload.

---

## 2 — Route-test harness → no bump (merge just before #3)

> ✅ **Shipped** (`test/route-harness`, PR #73). `test/helpers/webApp.js` +
> `test/helpers/fakeGuild.js`; new `test/routes.guilds.test.js` and
> `test/routes.misc.test.js`; `dashboardRoutes.test.js` migrated onto the shared
> harness. Suite 205 → 243.

Branch `test/route-harness`. Grow `test/dashboardRoutes.test.js` (~169 lines,
covers `/m/afk` + member-data only) into a real harness.

- `test/helpers/webApp.js`: builds the Express app in open mode with a
  fully-faked `runtime.client` (guilds, channels, roles, members, users, bans)
  and returns `{ base, close, sentDms, sentMessages }`. Factor the fake out of
  the current test file.
- `test/helpers/fakeGuild.js`: a richer fake guild factory (channels of each
  type, a role list, `members.me` with permissions, `bans.fetch`).
- Cover, per route file, the happy path + the main guard:
  - `guilds.js`: `GET /overview`, `GET /settings`, `POST /settings`,
    `GET /moderation`, `POST /warnings` + `/warnings/:id/delete` + `/unban` +
    `/moderation/lock-all` (fake channel), a couple of `/m/:id/config` round-trips
    (fragment + toast), `GET /m/:id/card-preview` (204 when canvas absent is
    fine), `GET /member-data`.
  - `health.js`: `GET /health` JSON shape; `POST /backups` create (temp dir).
  - `settings.js`: identity + presence POST validation.
  - `guildTickets.js` / `guildMessages.js`: list + one action each.
  - `commands.js`, `stats.js`, `leaderboard.js`, `verify.js`, `appeal.js`:
    render + 404 / invalid-token paths.
- Assert the `hx-boost` guard from 3.4.1 stays: `GET /m/:id` with
  `HX-Request` + `HX-Boosted` → full document.

**Verify:** `npm test` — the suite roughly doubles; run on an idle machine
(`node --test --test-timeout=20000`).

---

## 3 — Observability → 3.7.0

> ✅ **Shipped in 3.7.0** (`feat/observability`). As-built notes: the registry
> (`src/lib/metrics.js`) is counters-only (`inc` + `renderCounters`); live gauges
> are computed in the `/metrics` route, not stored. Added
> `sylo_component_interactions_total{scope}` and `sylo_errors_recorded` beyond
> the planned series. `/health` JSON gained `errorsByScope`, `commands`,
> `discord.gatewayPingMs` + `gatewayPingHistory`; status page shows an inline
> `<svg>` sparkline.

Branch `feat/observability`.

### 3a. Request-logging middleware
- `src/web/middleware/requestLog.js`: logs `method path status durationMs` at
  `debug` (off by default), skips `/health` and static assets, one line per
  response via `res.on('finish')`. Mount first in `createApp()`.

### 3b. `/metrics` endpoint
- `GET /metrics` (new `src/web/routes/metrics.js`), Prometheus text format, no
  auth (same as the `/health` JSON), rate-limited.
- Series: `sylo_up`, `sylo_uptime_seconds`, `sylo_guilds`, `sylo_gateway_ping_ms`,
  `sylo_commands_total{command}`, `sylo_errors_total{scope}`, `sylo_db_bytes`,
  `sylo_module_enabled{module}` (sum across guilds),
  `sylo_http_requests_total{route,status}` (bucketed by mount).
- In-memory registry `src/lib/metrics.js`: `inc(name, labels)`, `set(name,
  value)`, `render()`. Wire `inc` into the command dispatcher, the component
  router, `log.error`, and the request-log middleware.

### 3c. Richer `/health` JSON
- Add per-scope error counts, command counts, and a gateway-ping history
  (last N) to the JSON body. The status page can show the ping history as a
  sparkline (plain inline `<svg>` unless the `dataviz` skill's approach is
  clearly worth it).

**Verify:** `npm test` (metrics render + counter unit tests); `curl /metrics`
scrapes cleanly; `LOG_LEVEL=debug` shows request lines; `/health` JSON diff.

---

## 4 — Native Discord AutoMod push → 3.8.0

> ✅ **Shipped in 3.8.0** (`feat/automod-native`). As-built: a master
> `native_enabled` switch plus per-check toggles for the mappable rules
> (`words` → Keyword, `mentions` → MentionSpam, `spam` → Spam) and a
> keyword-preset multi-select (profanity / sexual / slurs). Reconcile lives in
> `src/bot/lib/automodSync.js` (`desiredRules` + `planSync` + `syncGuildAutomod`),
> owning only `Sylo:`-named rules. No `AutoModerationActionExecution` bridge —
> native blocks are visible via Discord's audit log + an optional
> `SendAlertMessage` to the mod-log channel; `warn` does not escalate for
> natively-enforced checks (documented).

Branch `feat/automod-native`.

- Map Sylo's `AUTOMOD_RULES` onto `guild.autoModerationRules` where Discord has a
  native equivalent: **keyword** (bad words), **keyword-preset** (profanity /
  slurs / sexual), **mention-spam**, **spam**. Sylo-only checks (`repeat`,
  `zalgo`, `caps`, `emojis`, `spoilers`, invite/link nuance) stay in the
  in-process scanner and are flagged "scan-only" in the UI.
- `automod.ejs`: an "Also enforce natively" toggle per mappable rule + a global
  one. On save, `src/modules/automod.js` reconciles: create/update/delete the
  managed rules (tagged by name prefix `Sylo:`), never touch rules it didn't
  create.
- New `src/bot/lib/automodSync.js` with the reconcile logic + `test/automodSync.test.js`
  (pure diff: desired vs existing → create / patch / delete lists).
- Needs **Manage Server**; degrade gracefully (toast) without it.
- Keep the in-process action (delete + timeout + mod-log) for non-native rules
  and as a fallback.

**Verify:** `npm test`; enable native enforcement, check the rules appear in
*Server Settings → AutoMod*, edit one in Discord and confirm Sylo doesn't stomp
it, disable the toggle and confirm only the `Sylo:`-tagged rules are removed.

---

## 5 — Alerts: RSS + a dedupe helper

Branch `feat/rss-alerts` for 5b (5a shipped on its own branch `refactor/posted-keys`).

### 5a. "Posted keys" helper (`refactor:`, no behaviour change)

> ✅ **Shipped** (`refactor/posted-keys`, PR #79, no bump). As-built:
> `posted_keys(guild_id, scope, key, value, posted_at)` — a `value` column was
> added to carry the announced Twitch stream id / YouTube live video id.
> Migration 30 folds in `free_games_posted`, `twitch_live`, `youtube_live`,
> `youtube_video_seen` and drops them. **`starboard_posts` was kept** — it stores
> mutable state (star counts, the posted message id, a reverse lookup), not a
> plain key. `src/db/{twitchAlerts,youtubeAlerts,freeGames}.js` are now thin
> wrappers with unchanged exports; `GUILD_TABLES` swapped the four for
> `posted_keys`; unused `clearGuild*` helpers removed.

### 5b. RSS module (`feat:`) → 3.10.0 — **next**
- New module `rss` (**29th**, since Kick alerts took the 28th slot):
  `src/modules/rss.js`, `src/db/rssFeeds.js`, migration for
  `rss_feeds(id, guild_id, url, channel_id, role_id, last_guid, template,
  added_at)`, `src/web/views/guild/modules/rss.ejs`, all the new-module wiring
  (registry, `modules/index.js`, `CONFIG_VIEWS`, `MODULE_ICONS` + `#i-rss`
  sprite, `sidebarNav.js`, `overviewSummary.js`, `docs/modules/rss.md`,
  `GUILD_TABLES`).
- Parser: extract the hand-rolled Atom parser from `youtubeAlerts.js`
  (`parseFeed`, currently `String(xml).split('<entry>')` + `grab(/…/)`) to
  `src/bot/lib/feed.js` and generalise — RSS 2.0 `<item>` **and** Atom `<entry>`;
  `guid` / `id` / `link` as the key. `youtubeAlerts.js` then uses the shared one.
- A poll tick (`twitchAlerts.js` `setInterval` pattern), per feed: fetch, diff
  new entries against `posted_keys` scope `rss:<feedId>` (helper is done),
  post an embed (title, link, source, published), per-guild feed cap (~15) and a
  global fetch budget. Fail soft per feed — a broken feed must not kill the tick.
- Covers blogs, news, Reddit `.rss`, Mastodon feeds, GitHub releases `.atom`.
  Twitter/X and TikTok proper are a later follow-up.
- `/rss add|remove|list` optional — dashboard-only is fine for v1.

**Verify:** `npm test` (`feed.js` parser tests with sample RSS + Atom; existing
`youtubeAlerts` tests stay green); add a real feed, confirm one post per new
entry and no repeats across a restart.

---

## Unplanned — Kick.com alerts + plain-text alert mode → 3.9.0

> ✅ **Shipped in 3.9.0** (`feat/kick-alerts`, PRs #80/#81). Requested in issue
> #78, slotted in between 5a and 5b because it directly reused the new
> `posted_keys` helper.

- **`kick-alerts` module** (28th) — a clone of `twitch-alerts` for Kick.com.
  Official Kick API: app token from `id.kick.com/oauth/token` (client
  credentials), live check `GET api.kick.com/public/v1/channels?slug=…` (≤50).
  `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET`; poll no-ops when unset. Dedupe via
  `posted_keys` scope `kick`, keyed by slug with the broadcast `start_time` as
  the value (Kick has no per-stream id).
- **Plain-text alert mode** — a per-streamer "Post as: Embed / Plain text"
  choice on **both** Twitch and Kick alerts. Plain mode sends no embed and always
  appends the stream link, for channels transcribed into another app (e.g. a
  RuneLite Discord→game-chat plugin). `buildPayload` exported from both modules
  and branches on `alert.plainText`; markdown-free `DEFAULT_PLAIN_MESSAGE`.

---

## 6 — Server insights page → 3.11.0

Branch `feat/insights`.

- **Rollup table** `guild_daily(guild_id, day TEXT, joins, leaves, messages,
  active_members, PRIMARY KEY(guild_id, day))` + `GUILD_TABLES`.
- **Aggregation tick** (`src/modules/insights.js`): once a day, roll the previous
  day's counters. Message counts from a `messageCreate` handler (gated on the
  module being on — respects the Message Content intent); joins/leaves from
  `guildMemberAdd` / `Remove`. Keep it cheap: an in-memory `Map<guildId,
  {messages, …}>` flushed hourly + on the daily roll.
- **Page** `GET /guilds/:id/insights` → new panel in `guild.ejs` + sidebar entry
  (`page: 'insights'`, `#i-trending-up`). Charts: member growth (cumulative),
  daily messages, joins vs leaves, top channels (last 30d). Inline `<svg>`
  server-side or a tiny Alpine chart — no chart library (no build step, CSP).
- Retention: keep ~180 days, prune in the daily tick.
- It's a **module** (`insights`, off by default) so a server opts in to the
  message counting.

**Verify:** `npm test` (rollup math + prune); enable it, send messages / simulate
joins, force a roll, check the page renders with real numbers in both themes.

---

## 7 — Express 5 spike + discord.js v15 watch → no bump

Branch `chore/express5-spike` (spike — may not merge as-is).

- Express 5 changes: `path-to-regexp@6` (no inline `/:id(\\d+)` — Sylo uses these
  in the `reminders` routes; rewrite as validated params), `req.query` / `req.body`
  are `null`-proto objects, `res.redirect('back')` removed, `app.del` removed,
  rejected promises in middleware auto-forwarded to `next(err)` (can simplify
  `asyncHandler`).
- Approach: bump `express@5`, run the #2 harness (this is *why* #2 comes first),
  fix each break, keep `asyncHandler` for clarity even if redundant. Land as
  `chore:` once green.
- discord.js v15: no release yet. Add a note + a dependabot ignore for the major;
  revisit when it ships.

**Verify:** the full harness passes on Express 5; `docker compose up` healthy;
every regex route still resolves.

---

## Not in scope here (revisit after)

Twitter/X + TikTok alerts (scraping / paid API), report-a-message + mod queue,
Discord server backup/templates, voice XP, auto-publish announcement channels.
