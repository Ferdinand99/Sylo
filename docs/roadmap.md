# Roadmap — the 3.6 line (complete)

The post-3.5.0 backlog, run as one branch/PR per workstream into `main`. It
shipped across **3.6.0 → 3.11.1** and is done. This file is now the record: what
shipped, and the design decisions and deviations behind each piece. New work
gets its own plan; the next candidate line is sketched at the end.

Conventions used (still current):

- Branch per workstream → PR into `main`; `npm test` + `npm run lint` +
  `docker compose up -d --build` green before a PR is ready; one commit per chunk
  with a Conventional-Commit summary (release-please derives the version).
- New module ⇒ `registry.js` + `modules/index.js` + config view + `CONFIG_VIEWS`
  + `MODULE_ICONS` + `#i-<name>` sprite + `sidebarNav.js` + `overviewSummary.js`
  + `docs/modules/`.
- New guild-scoped table ⇒ `GUILD_TABLES` (a test enforces it); add to
  `forgetUser` / `describeUserData` if it holds per-user data.

Runtime at kickoff: `express@^4.21.2`, `discord.js@^14.16.3`. Now: `express@^5.1.0`,
`discord.js@^14` (v15 not yet released — a `dependabot.yml` ignore keeps its major
out of auto-bumps).

---

## What shipped

| #   | Workstream                                                     | Type       | Result           |
| --- | ------------------------------------------------------------- | ---------- | ---------------- |
| 1   | Dashboard UX polish                                          | `feat:`    | **3.6.0**        |
| 2   | Route-test harness                                          | `test:`    | no bump (PR #73) |
| 3   | Observability — `/metrics`, request log, richer `/health`   | `feat:`    | **3.7.0**        |
| 4   | Native Discord AutoMod push                                 | `feat:`    | **3.8.0**        |
| 5a  | `posted_keys` dedupe helper                                 | `refactor:`| no bump (PR #79) |
| —   | Kick.com alerts + plain-text alert mode (issue #78)         | `feat:`    | **3.9.0**        |
| 5b  | RSS / Atom feed alerts                                      | `feat:`    | **3.10.0**       |
| 6   | Server insights page                                        | `feat:`    | **3.11.0**       |
| —   | Sticky messages: bump for other apps + cooldown (issue #85) | `fix:`     | **3.11.1**       |
| 7   | Express 5 upgrade + discord.js v15 watch                    | `chore:`   | no bump          |

Kick alerts (issue #78) was slotted between 5a and 5b and took the 3.9.0 minor RSS
had been pencilled in for, so 5b onward each shifted one minor. The module count
went 27 → 30 (Kick = 28th, RSS = 29th, insights = 30th).

---

## Design notes

### 1 — Dashboard UX polish → 3.6.0 (`feat/dashboard-ux`)

Four independent pieces, shipped together, all as planned: module search/filter
(Alpine, on the overview grid and the sidebar), a light theme + header toggle
(`:root[data-theme]` + `prefers-color-scheme`, remembered in `localStorage`, read
in the no-flash `<head>` script), a per-module **Send test** button
(`POST /:guildId/m/:moduleId/test`), and bulk enable/disable on the overview
(`POST /:guildId/modules/bulk`).

### 2 — Route-test harness → no bump (`test/route-harness`, PR #73)

`test/helpers/webApp.js` (boots the Express app in open mode with a faked Discord
client + a sink) and `test/helpers/fakeGuild.js` (snowflake-shaped fake
Guild/Client). New `test/routes.guilds.test.js` and `test/routes.misc.test.js`;
`dashboardRoutes.test.js` migrated onto the shared harness. Suite 205 → 243. This
harness is what caught the Express 5 breakage in #7 immediately.

### 3 — Observability → 3.7.0 (`feat/observability`)

`src/lib/metrics.js` is a counters-only registry (`inc` + `renderCounters`); live
gauges are computed in the `/metrics` route, not stored. Series went slightly
beyond plan — added `sylo_component_interactions_total{scope}` and
`sylo_errors_recorded`. `/health` JSON gained `errorsByScope`, `commands`,
`discord.gatewayPingMs` and `gatewayPingHistory`; the status page shows an inline
`<svg>` ping sparkline. Request-log middleware (`method path status durationMs`,
`debug` level, mounted first) also feeds `sylo_http_requests_total{route,status}`.

### 4 — Native Discord AutoMod push → 3.8.0 (`feat/automod-native`)

A master `native_enabled` switch plus per-check toggles for the mappable rules
(`words` → Keyword, `mentions` → MentionSpam, `spam` → Spam) and a keyword-preset
multi-select (profanity / sexual / slurs). Reconcile logic lives in
`src/bot/lib/automodSync.js` (`desiredRules` + `planSync` + `syncGuildAutomod`)
and owns only `Sylo:`-named rules. No `AutoModerationActionExecution` bridge —
native blocks show in Discord's audit log and an optional `SendAlertMessage` to
the mod-log channel; `warn` does not escalate for natively-enforced checks.
Unmappable checks (repeat, zalgo, caps, emojis, spoilers, invites, links) stay in
the in-process scanner. Needs **Manage Server**; degrades to a toast without it.

### 5a — `posted_keys` dedupe helper → no bump (`refactor/posted-keys`, PR #79)

One `posted_keys(guild_id, scope, key, value, posted_at)` table replaces four
near-identical dedupe tables. The `value` column carries the announced Twitch
stream id / YouTube live video id. Migration 30 folds in `free_games_posted`,
`twitch_live`, `youtube_live`, `youtube_video_seen` and drops them. **`starboard_posts`
was kept** — it holds mutable state (star counts, the posted message id, a reverse
lookup), not a plain key. `src/db/{twitchAlerts,youtubeAlerts,freeGames}.js` are
now thin wrappers with unchanged exports, so the alert modules were untouched.
`GUILD_TABLES` swapped the four for `posted_keys`; unused `clearGuild*` helpers
removed.

### Kick.com alerts + plain-text alert mode → 3.9.0 (`feat/kick-alerts`, PRs #80/#81)

Unplanned (issue #78), slotted between 5a and 5b because it reused the new
`posted_keys` helper directly.

- **`kick-alerts`** (28th module) — a clone of `twitch-alerts` for Kick.com.
  Official Kick API: app token from `id.kick.com/oauth/token` (client
  credentials), live check `GET api.kick.com/public/v1/channels?slug=…` (≤50).
  `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET`; poll no-ops when unset. Dedupe via
  `posted_keys` scope `kick`, keyed by slug with the broadcast `start_time` as
  the value (Kick exposes no per-stream id).
- **Plain-text alert mode** — a per-streamer "Post as: Embed / Plain text" choice
  on **both** Twitch and Kick alerts. Plain mode sends no embed and always
  appends the stream link, for channels transcribed into another app (e.g. a
  RuneLite Discord→game-chat plugin). `buildPayload` is exported from both
  modules and branches on `alert.plainText`; markdown-free `DEFAULT_PLAIN_MESSAGE`.

### 5b — RSS / Atom feed alerts → 3.10.0 (`feat/rss-alerts`)

**No `rss_feeds` table** — feeds live in the module's JSON config like
`twitch-alerts` / `kick-alerts`, each with a stable 8-hex `id` assigned on first
save so `posted_keys` scope `rss:<feedId>` stays collision-free. Removing a feed
clears its scope in the save route. `src/bot/lib/feed.js` is the shared RSS 2.0 +
Atom parser (`guid` / `id` / alternate-link / title as the key; also surfaces
`author` from `<dc:creator>` or `<author><name>`, a media/enclosure `image`, and
the raw entry `block`); `youtubeAlerts.js` now maps it onto its videoId shape.
`posted_keys` gained `anySeen` + `pruneScopePrefixOlderThan`. Poll every ~5 min
with a global fetch budget; the first look at a feed only seeds (no backlog
dump); a burst is capped at 3 posts/feed/tick (the rest still marked seen). 29th
module.

### 6 — Server insights page → 3.11.0 (`feat/insights`)

`guild_daily(guild_id, day, joins, leaves, messages, active_members, channels)` —
`channels` is a JSON map of channelId → daily message count, so "top channels"
needs no second table. `insights` is a `configurable: false` module: its overview
card and sidebar row link straight to `/guilds/:id/insights` (the data page);
there is no `/m/insights` config panel. Counting needs **no privileged intent** —
only the message count, author id and channel id are read, never content.
`active_members` is a running `MAX` of the in-memory distinct-sender set (a
mid-day restart can undercount slightly). Counters flush hourly and on the UTC
day roll. Charts are inline `<svg>` in `guild/insights.ejs` (message bars,
cumulative growth line, joins-vs-leaves lines) plus CSS bars for top channels,
with a 7/30/90-day range switch. No `forgetUser` — rows are aggregate. 30th
module.

### Sticky messages: other-app bump + cooldown → 3.11.1 (`fix/sticky-app-messages`)

Issue #85. Sticky messages never saw other apps' messages because the module
dispatcher drops all bot messages before any module runs. Added a
`messageCreateAny` dispatch event that also carries bot/app/webhook messages
(only the sticky module opts in; `messageCreate` stays human-only). Each sticky
gains **repostOnBots** (default off — when on, other apps _and_ Sylo's own
non-sticky messages bump it) and **cooldownSeconds** (0 = 4s default, clamped
3–3600). "Our own message" is specifically the sticky Sylo last posted (matched
by message id), so the repost never loops. Existing stickies unchanged until
re-saved.

### 7 — Express 5 upgrade + discord.js v15 watch → no bump (`chore/express5-spike`)

Bumped `express@^4.21.2` → `^5.1.0` (resolved to 5.2.1, path-to-regexp v8), merged
as-is. The **only** break was inline path regex — 8 routes (`guildMessages.js` ×4,
reminders ×4) used `/:id(\d+)` / `/:id(new|\d+)`; rewritten as plain `:id` with a
`/^\d+$/` (and `'new'`) guard in the handler. None of the other Express 5 concerns
applied: no `res.redirect('back')`, no `app.del`, no `*` wildcards, no
`req.query` / `req.body` prototype assumptions. `asyncHandler` kept as-is. The #2
route harness surfaced the breakage instantly (4 test files failed to build the
app) and confirmed the fix (311/311 green on Express 5). discord.js v15 is not
released — a `dependabot.yml` ignore holds its semver-major for a dedicated
migration when it ships.

---

## Next — the 3.14 line (proposed)

Not committed to yet — a sketch of candidate workstreams for the line after
3.13.0. Same conventions as above (branch per workstream, `npm test` +
`npm run lint` + compose build green, Conventional-Commit summary).

### Theme 1 — Social feeds (builds straight on the feed parser + `posted_keys`)

| Idea                                             | Why                                                          | Effort                                     |
| ----------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| **Reddit feed** (`/r/<sub>/new.json` or `.rss`) | MEE6 has it, Sylo doesn't, fits the parser 1:1              | Small — a new `feedSource` branch + panel |
| **Bluesky / Mastodon feed**                     | Both expose open RSS/JSON endpoints; a real parity gap      | Small–medium                              |

→ One `feat` minor (**3.14.0**). Low risk, reuses everything from the RSS module.
Instagram / TikTok / X are out of scope — no usable free API, scraping too brittle.

### Theme 2 — The game-stats pillar (Battlefield only today)

**OSRS + RS3 adapter** — one file in `src/adapters/games/` (Wise Old Man /
Hiscores + RuneMetrics). Self-contained, extends a core pillar without touching
the rest. → `feat` minor.

### Theme 3 — Close MEE6 gaps in existing modules

- **Leveling**: no voice XP, no XP multipliers (per role / channel), no
  weekly/monthly leaderboard. MEE6 has all three; the insights module already
  tracks voice minutes, so the plumbing exists.
- **Moderation**: `/history @user` with a case log — numbered cases across
  warn / timeout / kick / ban, editable reason, delete case. Today there are
  warnings + a mod-log channel but no single lookup.
- **Welcome images**: a generated banner (avatar + text + background) via
  `@napi-rs/canvas`, already a dependency for rank cards. MEE6's signature
  feature.

### Theme 4 — Ops / self-hosting niceties (a small `chore` / `feat` bundle)

- A Grafana dashboard JSON in the repo for `/metrics` (the Unraid crowd will use it).
- An off-box backup target (S3 / WebDAV / Discord webhook) alongside the local snapshots.
- Fix the ~25s teardown hang in the route tests (faster CI).

### Suggested order for the line

1. **Social feeds** (Reddit + Bluesky + Mastodon) — cheapest, clearest parity win.
2. **OSRS / RS3 adapter** — self-contained, already wanted.
3. **Leveling upgrade** (voice XP + multipliers + period leaderboard) — the
   biggest single step toward MEE6.

Welcome images and moderation history are solid #4/#5 for a longer line.
