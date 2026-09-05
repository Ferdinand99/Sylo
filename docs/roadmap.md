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

## Next — the 3.14 line

Complete. Themes 1–4 shipped across **3.14.0 → 3.17.0**. Same conventions as
above (branch per workstream, `npm test` + `npm run lint` + compose build green,
Conventional-Commit summary).

### Theme 1 — Social feeds → done (`feat/social-feeds`)

Reddit, Mastodon **and** Bluesky in one `feat` (→ **3.14.0**), all as an
extension of the existing `rss` module — no new modules, count stays 30.

- A per-feed **source type** (`url` / `reddit` / `mastodon` / `bluesky`).
  `parseFeedRef(type, ref)` turns a handle into that platform's own RSS/Atom
  URL, which the unchanged poll loop fetches:
  - reddit → `https://www.reddit.com/r/<sub>/new/.rss` (also `u/<user>`, a bare
    name, or any `reddit.com` link)
  - mastodon → `https://<instance>/@<user>.rss` (`@user@instance`, `user@instance`,
    or a profile URL)
  - bluesky → `https://bsky.app/profile/<handle>/rss` (`handle.bsky.social`,
    `@handle`, a `did:…`, or a `bsky.app/profile` link)
- Feeds gained `type` + `ref` (the raw input); `{feed}` and the embed footer now
  show the short handle (`r/programming`, `@user@instance`) rather than the host.
- Back-compat: a pre-3.14 feed with only `url` reads as `type:'url'`, `ref:url`,
  so existing configs keep working with no DB migration.
- Instagram / TikTok / X stayed out — no usable free feed.

### Theme 2 — RuneScape stats adapter → done (`feat/runescape-stats`)

Second game after Battlefield. One `feat` minor.

- New `src/adapters/games/runescape.js` — OSRS **and** RS3, off Jagex's official
  Hiscores `index_lite.json` (no key). Same `{skills[], activities[]}` shape for
  both; `-1` means unranked. Combat level isn't in the feed, so it's computed
  (classic OSRS formula / post-EoC RS3 formula).
- Reuses the **`platform` slot for the account type** — `main` / `ironman` /
  `hardcore` / `ultimate` (OSRS only) — so `runStatsLookup`, the cache key and
  the registry are untouched. Wise Old Man / RuneMetrics skipped: the Hiscores
  are always available and need no pre-tracking.
- Adapter returns the standard core plus RuneScape fields (`combatLevel`,
  `totalLevel`, `totalXp`, `overallRank`, `skills[]`, `activities[]`); new
  `src/bot/embeds/runescapeStats.js` renders them.
- **`/stats` reworked to a flat command** — `game` is now a single dropdown
  (7 Battlefield titles + OSRS + RS3) instead of a `battlefield` subcommand;
  `platform` covers both console platforms and RS account types. This changes the
  command signature (re-registered on boot).

### Theme 3 — Leveling upgrade → done (`feat/leveling-voice-multipliers-periods`)

The biggest single MEE6-parity step in the module. One `feat` minor.

- **Voice XP** — optional; a base XP-per-active-voice-minute, folded into the
  same `xp`/level as chat. A new `voiceStateUpdate` handler opens per-member
  sessions; a 3-minute interval settles open sessions so a long call levels a
  member up mid-session, not only on disconnect. "Active" gate (default on):
  2+ non-bot members in the channel, not deafened, not the AFK channel.
- **XP multipliers** — up to 25 `{ role | channel, factor }` entries.
  `resolveMultiplier()` = highest matching role factor × the channel factor
  (each default 1×), capped at 10×; applies to chat and voice XP on top of the
  global XP rate.
- **Weekly / monthly leaderboards** — migration 33 adds `leveling_periods`
  (`w:<ISO-year>-W<ww>` / `m:<year>-<mm>`, UTC). Every `addXp()` writes the
  all-time row **and** upserts the current week + month rows; the module prunes
  to ~10 weeks / ~6 months. `?period=week|month` on both the public leaderboard
  and the dashboard Leaderboard page; the all-time totals are never reset.
- `leveling.voice_xp` + `voice_minutes` columns keep voice contribution broken
  out; the `/rank` card, the dashboard leaderboard previews and the public
  `/lb` page all surface `{voice XP} · {time}`. `/forget` and the guild-leave
  purge cover `leveling_periods`.

Deferred Theme 3 ideas (not built): a `/history @user` moderation case log, and
generated welcome banner images.

### Theme 4 — Ops / self-hosting niceties → done (`feat/offsite-backups`)

- **Off-site backups** — after every local snapshot, `src/db/offsiteBackup.js`
  gzips it and pushes a copy to whatever env is set: `BACKUP_WEBDAV_URL`
  (+ `_USER`/`_PASS`, an HTTP `PUT` — Nextcloud etc.) and/or `BACKUP_WEBHOOK_URL`
  (a Discord webhook attachment, skipped over ~8 MiB). No new runtime deps —
  `fetch` + `node:zlib`. Best-effort, logged, never blocks the local backup;
  the Health page shows the active targets. S3 was left out — SigV4 without an
  SDK is a lot of code, and WebDAV covers the self-host crowd.
- **Grafana dashboard** — `docs/grafana-dashboard.json`, a 12-panel import
  (gateway health, guilds, HTTP/command/error rates, DB size, module adoption)
  wired to a `${DS_PROMETHEUS}` datasource variable.
- **Route-test teardown** — the ~9s idle stall when running one `routes.*` file
  by hand was undici client keep-alive; `test/helpers/webApp.js` now sets a
  near-zero `keepAliveTimeout` global dispatcher (`undici` pinned as a
  devDependency). The full `node --test` run was never affected (subprocess per
  file), so CI was already fine.

### Suggested order for the line

1. ~~**Social feeds** (Reddit + Bluesky + Mastodon)~~ — shipped (3.14.0).
2. ~~**OSRS / RS3 adapter**~~ — shipped (3.15.0).
3. ~~**Leveling upgrade** (voice XP + multipliers + period leaderboard)~~ — shipped.
4. ~~**Ops bundle** (Grafana JSON, off-site backup, test-teardown fix)~~ — shipped.

The 3.14 line is complete.

---

## Moderation case log → done (`feat/mod-case-log`)

One `feat` → **3.18.0**. The flat `warnings` table is now a MEE6/Dyno-style,
numbered case log covering every moderation action, with `/history` and `/case`
commands and an editable dashboard view. Built exactly to the plan below.

### As built

- **Migration 35 — fold `warnings` into `infractions`.**
  `infractions(guild_id, case_number, user_id, moderator_id, action, reason,
  detail, active, created_at, PK(guild_id, case_number))`. `action` ∈
  `warn | note | timeout | untimeout | kick | ban | unban`. The migration copies
  every existing `warnings` row in as `action='warn'` with a per-guild
  sequential `case_number`, then drops `warnings`. New rows take `MAX(case_number)
  + 1` per guild inside the write transaction.
- **`src/db/modCases.js`** (replaces `warnings.js`): `addCase`, `listUserCases`
  (paginated), `getCase`, `editCaseReason`, `setCaseActive`, `listGuildCases`,
  `clearUserCases`. `warnCount` = active `action='warn'` rows — still drives the
  warn-threshold flow.
- **`/history <user> [page]`** — paginated ephemeral embed, one line per case
  (`#N · action · date · by @mod — reason`).
- **`/case` group** — `view <n>`, `reason <n> <text>` (edit reason),
  `delete <n>` (**soft** — `active=0`, drops out of `/history` and the warn
  count, stays in the DB), `note <user> <text>` (a case with no enforcement / no
  DM).
- **Wire the existing actions**: `ban` / `kick` / `timeout` / `untimeout` /
  `unban` / `warn`, the auto-threshold punishments, and the temp-ban expiry loop
  each call `addCase(...)` next to their `postModLog(...)`; the result embed
  gains a `Case #N` field. `/unban` and `/untimeout` also flip the original
  ban/timeout case to `active=0`.
- **Dashboard**: the moderation page's *Infractions* tab lists every case type
  (not just warnings) with per-row edit-reason + soft-delete. `guilds.js` routes
  + `moderation.ejs` + `purge.js` (`GUILD_TABLES`, `/forget`,
  `describeUserData`) swap `warnings` → `infractions`.
- **Tests**: `test/modCases.test.js` (sequential numbering, active-warn count,
  edit/delete, pagination), a migration test (warnings → numbered cases), and
  the moderation route round-trips.

### Decisions (all as recommended)

1. Fold `warnings` into one `infractions` table — single source of truth; `/warn`
   keeps working, existing warnings become cases.
2. `/case delete` is **soft** (auditable) — no hard delete.
3. Command shape: `/history` + a `/case {view,reason,delete,note}` group.
4. `/unban` / `/untimeout` add a new case **and** mark the original inactive.

---

## Live-alert cleanup → done (`feat/live-alert-cleanup`, issue #110)

One `feat` → **3.19.0**. Twitch / YouTube-live / Kick alerts now clean up the
"went live" message after the stream ends. Built to the plan below.

### As built

- **Per-alert `onEnd` option** — `delete` (default) / `edit` / `keep`. `edit`
  greys the embed and rewrites it to `⏹ {name} — stream ended · was live for …`;
  `keep` is today's behaviour.
- **Remember the posted message.** The alert-dedup rows already sit in
  `posted_keys` (`value` = the announced stream / video id). Store
  `<streamRef>|<channelId>|<messageId>` there instead; the existing
  `announced*Id` readers take `split('|')[0]`, so old rows still parse. Duration
  for the `edit` text comes from the row's `posted_at`.
- **`src/modules/lib/send.js`** — add `postToChannel()` (returns
  `{ channelId, messageId }`), plus `deleteChannelMessage()` /
  `editChannelMessage()`. `sendToChannel()` stays as the boolean wrapper.
- **Wire the three modules** — on the live→offline transition, act on the stored
  message per `onEnd` before `forget()`. YouTube **upload** announcements are
  untouched (only the live post is cleaned up). Missing message / lost channel
  access is swallowed.
- **Dashboard** — a "When the stream ends" `<select>` per alert row in the
  twitch / kick / youtube alert views + the matching `guilds.js` POST branches.
- **Tests** — the `value` parse/round-trip, `normalise*` `onEnd` clamping, and a
  module-level offline-transition test using the fake client sink.

---

## Next — GDPR / data-rights line (planned)

Three independent workstreams that tighten Sylo's data-protection posture. Same
conventions as the lines above (branch per workstream → PR into `main`,
`npm test` + `npm run lint` + compose build green, Conventional-Commit summary).
Sylo already covers a lot here — a published privacy policy, `/forget` for
per-user erasure, admin-assisted erasure with a DM receipt, and full guild-data
purge on kick (guarded by `test/guildTables.test.js`). These close the remaining
gaps: a stated legal basis + retention schedule, a data-access/portability path,
and enforceable retention limits.

### 1 — Legal basis + retention table in `privacy-policy.md` → done (`docs:`, no bump, commit `05d6697`)

Documentation only; no code. As shipped:

- New **section 4 — "Legal basis for processing"**: legitimate interests
  (Art. 6(1)(f)) as the basis throughout, a purpose → interest table, an
  interest-balancing paragraph covering the objection / access / erasure rights,
  and a note that self-hosters set their own basis.
- New **retention schedule** table under section 7 (19 data categories: retention
  period + deletion trigger), plus a **Backups** paragraph on the off-site backup
  path (`BACKUP_WEBDAV_URL` / `BACKUP_WEBHOOK_URL`) and since-deleted rows living
  in snapshots until they rotate out.
- Renumbered sections 4→11; refreshed the section 2 inventory (infractions/case
  log, voice minutes + period rows, birthdays, RSS/social markers); named the
  Operator as controller in the intro; `Last updated` → 4 Sep 2026 + a §11 line.

### 2 — `/mydata` self-service data export → done (`feat:`, minor, commit `5f7ec3d`)

Covers GDPR Art. 15 (access) and Art. 20 (portability) in one command, and gives
a member a way to see their data without going through an admin. As shipped:

- **`exportUserData(guildId, userId)`** in `src/db/purge.js` — the rows behind
  `describeUserData`. Both are now built from one shared `USER_DATA_SOURCES` list
  (which also gained `leveling_periods`, previously missing from the dashboard
  inventory), so counts, export and `forgetUser` can't drift. A test asserts the
  export key set equals the describe key set; another checks the rows come back
  and read empty after `forgetUser`.
- **`/mydata`** (`src/bot/commands/mydata.js`) — DMs the caller a readable
  summary embed (one compact line per category — level/XP, birthday date, who
  invited them, latest case, …) plus `sylo-data-<guildId>-<userId>.json`, the
  full copy keyed by readable labels with empty categories dropped. Falls back to
  the ephemeral reply if DMs are closed; in-memory 10-min per-member cooldown;
  7 MiB guard. Listed under `/help` → Privacy.
- Docs: privacy policy §4 + §7 + §11; README command list + feature line.

### 3 — Configurable auto-prune for transcripts + old infractions → done (`feat:` — minor, branch `feat/retention-autoprune`)

Turns "kept indefinitely" into a stated, enforced retention limit. As shipped:

- **`src/db/retention.js`** — `sweepRetention(now?)` reads every guild's
  `tickets` / `moderation` config straight from `guild_modules`, deletes closed
  tickets + their messages past `transcriptRetentionDays`, and inactive cases
  (`active = 0`) past `infractionRetentionDays`. Whole sweep is one transaction;
  logs a line only when it removed something. `startRetentionSchedule()` runs it
  ~5 min after boot and every 24 h, wired into `src/index.js` next to
  `startBackupSchedule()`.
- Both settings default to **0 = keep forever** (back-compat), capped at 3650
  days. Active warnings, the visible case history and open tickets are never
  touched; a guild with the setting at 0 is skipped entirely.
- Config UIs: a "Delete … after N days" number field on the Tickets and
  Moderation module pages + `clampDays()` in the `guilds.js` POST branches.
- Docs: `docs/modules/tickets.md`, `docs/modules/moderation.md`, and the
  privacy-policy retention table + §11.
- `test/retention.test.js` — past-cutoff rows go, recent / active / open rows
  stay, `0` is a no-op, other guilds untouched.

### Suggested order

1. ~~**#1 legal basis + retention table**~~ — done (commit `05d6697`).
2. ~~**#2 `/mydata` export**~~ — done (commit `5f7ec3d`).
3. ~~**#3 auto-prune**~~ — done (branch `feat/retention-autoprune`).

The GDPR / data-rights line is complete.

---

## Internal sharding → done (`feat:` — minor, branch `feat/internal-sharding`)

Groundwork for the hosted instance growing past Discord's **2,500 guilds per
gateway connection** limit, without disturbing anything about how Sylo runs
today.

- **Internal, not multi-process.** discord.js runs every shard inside the single
  Sylo process — one `Client`, one shared guild cache, one better-sqlite3
  connection. The dashboard (`runtime.client`, `req.guild`, channel/role
  lookups), the module pollers and the DB-wide jobs (backup, retention, insights
  flush, period prune) are all untouched, because there is still exactly one
  process. Multi-process sharding (`ShardingManager` + a client/server DB) is a
  separate, much larger project and stays out of scope.
- **`DISCORD_SHARD_COUNT`** — `auto` (default) asks Discord for the recommended
  count via `GET /gateway/bot`; it returns 1 below ~2,500 guilds, so this is a
  no-op for self-hosters and can be left on. A positive integer pins the count.
- `src/bot/lib/shards.js` `resolveShardOptions('auto' | n)` maps the config to
  discord.js `Client` options (`{ shards: 'auto' }` or
  `{ shardCount, shards: [0..n-1] }`); spread into `new Client(...)` in
  `src/bot/index.js`. A `shardReady` listener logs each shard as it connects.
- Docs: `.env.example`, the `docs/self-hosting.md` env table.
- `test/shards.test.js` covers the mapping and rejects junk counts.

When the hosted instance actually approaches the ceiling, the follow-up line is
Postgres → dashboard/bot process split → `ShardingManager`, in that order.

---

## Public hosted instance opened up → done (`fix/health-owner-only-access`, PR #126)

Sylo's own Discord application is already a Discord-verified bot (approved for
the Message Content privileged intent past the 100-guild threshold), and
`sylobot.com` now points visitors at it directly instead of self-hosting only.

- **"Add to Discord"** — a public install link
  (`https://discord.com/oauth2/authorize?client_id=1374856793469227029`) is now
  the primary CTA in the site nav and hero, replacing "Self-host it"; the
  Guild Install scopes/permissions were set in the Discord Developer Portal's
  **Installation** page (`bot` + `applications.commands`, the same permission
  set `docs/self-hosting.md` lists for self-hosters).
- **`/health` was reachable by anyone signed in, not just admins.** It uses its
  own `requireUser` gate — checked only for *a* session, never for *whose* — so
  any Discord account that completed the dashboard OAuth login could see
  cross-server guild/member counts and module adoption, and could create,
  download, restore or delete database backups. Harmless for a single
  self-hosted server behind trusted admins; not safe once the same dashboard
  serves many strangers' guilds.
- **`OWNER_IDS`** (new env var, comma/space-separated Discord user ids) — gates
  `/health`'s page and all four backup routes to just these accounts via a new
  `requireOwner` / `isOwner` in `src/web/middleware/auth.js`; the sidebar hides
  the Health link from everyone else instead of showing a link that 403s. The
  machine-readable JSON branch (Docker healthcheck / uptime monitors) is
  untouched — it was never gated. Documented in `.env.example` and
  `docs/self-hosting.md`; self-hosters running with `DISCORD_CLIENT_SECRET` set
  now need to set `OWNER_IDS` too, or `/health` is unreachable by anyone.
- Deployed to `sylo-test` with `OWNER_IDS` set to the operator's id.

Postgres (see above) stays out of scope for now — the roadmap's own sequencing
already has it landing later, once guild count approaches the internal-sharding
ceiling, not at hosted launch.

---

## Next — Postgres migration line (planned, not queued)

Written now so the shape of the work is scoped ahead of time — **not** a signal
to start. Per the sequencing note above, this only becomes relevant once the
hosted instance's guild count actually approaches the internal-sharding ceiling
and a multi-process `ShardingManager` split is next. No branch should open here
before that's actually in sight.

Grounded in a codebase read-through: `src/db/` is a real seam — 31
feature-specific wrapper files (`leveling.js`, `modCases.js`, `modules.js`, …,
~3,800 lines total) sit around one connection module
(`src/db/index.js`); the ~30 feature modules call **named functions**
(`addCase()`, `setGuildModule()`, …), not raw SQL. Only one file outside
`src/db` (`src/web/routes/metrics.js`) touches the raw `db` handle. That's why
this is tractable at all — the SQL rewrite is confined to one directory, not
smeared across every module.

### 0 — Decision: self-hosting stays SQLite; Postgres is hosted-only, opt-in

Not built — needs deciding before #1 starts, because it changes the shape of
every piece below.

Sylo's self-hosting pitch is "one container, one SQLite file you control, no
external dependency" (the landing page, `docs/self-hosting.md`). Forcing every
self-hoster onto a separate Postgres instance breaks that promise for the
common case — one bot, one server — where a single SQLite connection is never
going to be the bottleneck. Recommendation: self-hosting stays on
better-sqlite3 **indefinitely**; the hosted instance gets Postgres as an
opt-in, selected by a `DATABASE_URL` env var — unset (the default, and every
self-hosted deployment) keeps today's SQLite path untouched; set (the hosted
instance, once it needs it) switches the driver. This means a driver seam
inside `src/db/`, not a hard cutover — more work than a straight swap, but it's
what keeps the self-hosting story true.

### 1 — Driver + async seam in `src/db/`

The big, mechanical piece; blocks #2 and #3.

- A thin driver abstraction behind each `src/db/*.js` file's existing exported
  function names, so the same call (`addCase(...)`, `setGuildModule(...)`) runs
  against either better-sqlite3 (sync) or a Postgres driver (async) depending on
  `DATABASE_URL`.
- better-sqlite3's API is synchronous end-to-end today — 231 `.prepare(`, 124
  `.run(`, 322 `.get(`, 51 `.all(` calls across those 31 files — and the ~78
  files outside `src/db` that import them (commands, dashboard routes) call
  them with no `await`. Every one of those call sites needs `await` added once
  the Postgres path exists, even though the SQLite path itself stays
  synchronous. Mechanical, but wide — worth a scripted pass (grep + codemod)
  rather than hand-editing 78 files.
- Placeholder style differs: existing statements mix `?` positional and
  `@namedParam` binding; Postgres wire protocol only understands `$1, $2, …`.
  Picking a Postgres client that supports named parameters natively (e.g.
  `postgres` (porsager) over bare `pg`) avoids hand-converting ~231 statements'
  placeholders one at a time.
- `db.transaction((...) => {...})` (better-sqlite3's synchronous wrapper) is
  used in 5 files — `leveling.js`, `modCases.js`, `purge.js`, `retention.js`,
  `index.js` — and callers use it inline for a return value (e.g. `addCase()`
  returns the new case number synchronously). Its Postgres equivalent is async,
  so those call sites need reshaping, not just an `await`.
- No `json_extract`/`strftime` usage anywhere — JSON columns are plain `TEXT`
  parsed in JS. That part is already Postgres-friendly and isn't part of this
  work (could become native `jsonb` later, but doesn't block the migration).

### 2 — Migration runner

Small; can land alongside #1.

- Today: a plain ordered JS array in `src/db/index.js` (36 entries so far),
  each `` (database) => database.exec(`...`) ``, tracked via SQLite's `PRAGMA
  user_version`. Postgres has no equivalent pragma.
- Keep the same shape — it's simple and has worked fine for 36 migrations — but
  track "applied migrations" in a real table (`schema_migrations(version int
  primary key, applied_at)`) instead of a pragma. That works identically on
  both drivers with one small per-driver read/write, instead of adopting a
  migration framework (node-pg-migrate, Knex) that would only ever apply to the
  Postgres half of a dual-driver setup.

### 3 — Backup / restore redesign

Depends on #1 (needs a working Postgres connection to dump from). This is a
real redesign, not a driver swap.

- Today's `/health` backup/restore (`src/db/backup.js`) is built entirely
  around "it's one file": `VACUUM INTO` for compacted snapshots, WAL
  checkpoint/truncate, a SQLite magic-header check on import, and a self-serve
  **Restore** button that `copyFileSync`s a snapshot over the live database and
  exits so the process manager restarts. None of it maps to Postgres.
- Replace with `pg_dump` / `pg_restore` (needs the Postgres client tools
  bundled into the Docker image). The "click Restore on the Health page" UX
  needs rethinking too — a `pg_restore` isn't a fast file copy the way
  `copyFileSync` was; it likely needs to run out-of-band with a progress/done
  state instead of blocking a request.
- The off-site backup path (`src/db/offsiteBackup.js` — gzip + ship to WebDAV
  or a Discord webhook) stays conceptually the same; it just ships whatever
  `runBackup()` produces, so once #3 produces a Postgres dump instead of a
  `.db` file, this piece mostly carries over unchanged.

### Suggested order

1. **#0 decision** — confirm self-hosting stays SQLite-only; hosted becomes
   opt-in via `DATABASE_URL`. Blocks everything else.
2. **#1 driver + async seam** — the big one.
3. **#2 migration runner** — small, land alongside #1.
4. **#3 backup/restore redesign** — last, depends on #1.
5. Ship behind `DATABASE_URL` unset by default, so every self-hosted
   deployment sees no change at all.

---

## Next — Scheduled Channel Cleanup module (planned, not started)

31st module. Bulk-deletes old messages from specific channels on a per-channel
weekly schedule — aimed at high-noise, low-value channels (webhook feeds,
status/alert channels) that would otherwise need manual cleanup forever.
Deliberately **not** named "auto-prune" — that name is already taken by the
existing ticket/infraction retention sweep (`src/db/retention.js`), which is a
different mechanism (age-based deletion of *closed* records) for a different
purpose; reusing the name here would be confusing in the dashboard and docs.

Two scope decisions already made (talked through with the operator):

- **Deletes by age threshold, not "clear everything."** Each schedule entry
  has a `maxAgeHours` — a run only deletes messages older than that, so
  recent activity always survives to the next run. (The simpler
  "wipe the whole channel every run" option was considered and declined —
  more moving parts, but avoids ever nuking a message someone is mid-reading.)
- **Full weekly schedule per entry, not just "every N hours."** Each entry
  picks its own days-of-week + time-of-day to run, not a flat interval. More
  UI/storage than a bare interval, but lets e.g. a low-traffic channel run
  once a week at 3am instead of needlessly checking in every day.

### Config shape

Follows the existing pattern for multi-entry module config (temp-voice hubs,
RSS feeds) — a list inside the module's own JSON blob in `guild_modules`, no
new table needed:

```js
// guild_modules.config for module id 'channel-cleanup'
{
  schedules: [
    {
      id: 'sched_abc123',
      channelId: '123456789012345678',
      enabled: true,
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], // subset ok
      time: '03:00',            // HH:MM, evaluated in the server's TZ env var
      maxAgeHours: 24,          // delete messages older than this
      skipPinned: true,         // default on — never delete a pinned message
    },
  ],
}
```

### Discord API constraint that shapes the delete logic

`channel.bulkDelete()` only accepts messages **under 14 days old** — anything
older must be deleted one at a time (`message.delete()`), which is far more
rate-limited. For a channel actually being cleaned up regularly (like the
24h/daily example that prompted this), everything is always well under 14
days old and bulk delete alone is enough. But a schedule entry with a long
`maxAgeHours` on a low-traffic channel could hit a backlog past 14 days on
its first run — so the delete step needs to:

1. Fetch + filter messages older than `maxAgeHours` (respecting `skipPinned`).
2. Bulk-delete the ones under 14 days old in batches of 100.
3. Individually delete anything older than 14 days, **capped** at some limit
   per run (e.g. 50) so a large one-time backlog doesn't turn into a long
   rate-limited loop blocking the scheduler — it just catches up over
   several runs instead.

### Scheduler

A new `startChannelCleanupSchedule()` next to the existing
`startBackupSchedule()` / `startRetentionSchedule()` in `src/index.js` —
ticks every few minutes, and for every guild with the module enabled, checks
each schedule entry against "is today's day-of-week + current time (± a
small tolerance window) a match, and did this entry not already run today."

### Permissions

No new permission needed — `Manage Messages` is already in Sylo's guild-wide
grant (`internal/discord-server-plan.md`'s guild-wide table), which is all
`bulkDelete`/`message.delete()` require.

### Not yet decided

- Exact dashboard UI for picking days-of-week + time (a row-based builder
  like the RSS-feed / reaction-roles list, presumably).
- Whether to log what got deleted anywhere (a lightweight "cleaned N messages
  from #channel" line to a log channel, similar to other modules' log-channel
  settings) — leaning yes, so it's not a silent black box.
