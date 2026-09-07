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

### 0 — Decision: self-hosting stays SQLite; Postgres is hosted-only, opt-in — done

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

### Phase 1 shipped — config + CI scaffolding

`DATABASE_URL` now exists in `src/config.js` (validated as a `postgres://` /
`postgresql://` URL when set) and CI now runs the full suite twice — once
with no `DATABASE_URL` (`sqlite`), once against a real `postgres:16-alpine`
service container (`postgres`), via a matrix in `.github/workflows/test.yml`
plus `test/postgresSmoke.test.js`. The `postgres` (porsager) npm dependency
is installed.

**None of this makes Postgres actually work yet.** Nothing in `src/db/`
reads `databaseUrl` — every self-hosted deployment (and the hosted instance,
today) is byte-identical to before this landed. Still ahead, unstarted:
the driver shim and per-file conversion (#1), the migration-runner table
swap (#2), and the backup/restore redesign (#3).

### Phase 2 shipped — driver shim + one converted file (`src/db/channelCleanup.js`)

`src/db/driver.js` now exists: `prepare(sql)` returns `{ get, all, run }`,
always `async` regardless of driver; the SQLite branch thin-wraps the
existing `db.prepare()`, the Postgres branch translates `?`/`@name`
placeholders to `$n`, auto-appends `RETURNING id` to bare INSERTs to recover
`lastInsertRowid` (Postgres has no native equivalent), and uses `sql.unsafe()`
for execution (still safely parameterized — confirmed via the porsager/postgres
README, which also confirms it has **no native named-parameter support**, only
positional `$n` and tagged templates). `registerPostgresBootstrap(ddl)` lets
each converted file register its own `CREATE TABLE IF NOT EXISTS`, run once
lazily on first real Postgres query.

Exactly **one** file is converted end-to-end — `src/db/channelCleanup.js` —
proven against a real Postgres connection by
`test/channelCleanup.postgres.test.js`, plus every call site that touches it
(`src/modules/channelCleanup.js`'s tick loop, and `src/web/routes/guilds.js`'s
5 channel-cleanup routes + the **shared** `moduleViewLocals()` used by every
module's config page — this one file's conversion had a wider blast radius
than expected because of that shared helper; worth checking for that kind of
thing before assuming a single-file conversion is contained). The other 31
`src/db/*.js` files, and the ~77 remaining external call sites, are
**untouched** — same "many small PRs" approach, not a single big-bang
conversion.

**Do not set `DATABASE_URL` on a real deployment yet.** `src/db/index.js`'s
`db` export is still always SQLite, unconditionally, because the 31
unconverted files still depend on it directly — turning the flag on before
every file is converted would split a guild's data across both databases.
This only becomes safe to flip on for real once the *last* file-conversion
PR lands.

Two things worth knowing before converting the next file:
- SQLite's `INTEGER` is 64-bit; Postgres's plain `INTEGER` is only 32-bit.
  Any column storing a `Date.now()` millisecond timestamp (already ~13
  digits) needs `BIGINT` in its Postgres bootstrap DDL, not a blind type
  copy — caught while writing `channel_cleanup_schedules`' bootstrap for its
  `created_at` column.
- `lastInsertRowid` → `RETURNING id` **must be opt-in per statement**
  (`prepare(sql, { returningId: true })`), not inferred from "starts with
  INSERT INTO" — most tables here use a natural/composite key with no `id`
  column at all (confirmed the hard way converting `afk`, whose PK is
  `(guild_id, user_id)`: a blind `RETURNING id` append errored with
  `column "id" does not exist`). Only pass `returningId: true` for the 8
  tables that actually have a surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT`
  key (`tickets`, `ticket_messages`, `composed_messages`,
  `scheduled_messages`, `config_audit`, `appeals`, `giveaways`,
  `channel_cleanup_schedules`) **and** whose `.run().lastInsertRowid` is
  actually read.

### Phase 3 shipped — second converted file (`src/db/afk.js`)

Confirms the shim generalizes beyond channel-cleanup: `afk` has a natural
composite PK (no surrogate `id`) and an `INSERT ... ON CONFLICT (...) DO
UPDATE SET ...` upsert, which translates to Postgres with no SQL text changes
beyond the usual `?`/`@name` → `$n` placeholder rewrite (Postgres originated
this syntax; SQLite's is compatible). This is also where the `returningId`
opt-in fix above was found and made — `src/db/driver.js`'s `prepare()` now
takes a second `{ returningId }` argument instead of guessing from the SQL
text; `channelCleanup.js`'s insert was updated to pass it explicitly.
2 of 32 files converted; same untouched-31-files caveat as Phase 2 still
applies.

### Phase 4 shipped — third converted file (`src/db/birthdays.js`)

Same shape as `afk` (natural composite PK, `ON CONFLICT` upsert), no new
shim changes needed this time — a good sign the `returningId` fix from
Phase 3 is now solid. One extra wrinkle worth naming for future conversions:
`src/modules/birthdays.js` had a plain **synchronous** helper
(`celebrantsToday`) sitting between the already-async `celebrateGuild` and
the newly-async `birthdaysOnDay` — converting a leaf db file can still
require walking a short chain of callers upward to find where `async`
already stops, not just the file's single direct caller. 3 of 32 files
converted; the untouched-29-files and "don't set `DATABASE_URL` on a real
deployment yet" caveats still apply.

### Phase 5 shipped — fourth converted file (`src/db/appSettings.js`)

Bot-wide (not per-guild) key/value store — single-column `TEXT` PRIMARY KEY,
same `ON CONFLICT` upsert shape as the last two. New wrinkle:
`src/bot/lib/presence.js`'s `applyPresence()` was already fire-and-forget
(called with no `await`, its own internal `try/catch` swallows every
failure) — converting its body to `async` needed **no change at either call
site** (`ready.js`'s startup/interval calls, `settings.js`'s POST route),
since a promise that always resolves (errors caught internally, never
rethrown) is exactly as safe to leave un-awaited as the sync version was.
Not every async conversion needs to ripple upward through its callers —
worth checking whether the caller already treats the result as
fire-and-forget before assuming propagation is required. 4 of 32 files
converted; same caveats as before still apply.

**Test-infra bug found + fixed here**: every `*.postgres.test.js` file
imports `closePostgres` from `src/db/driver.js`, which transitively imports
`src/db/index.js` — triggering its eager `migrate()` against the *default*
`./data/sylo.db`, purely as an unavoidable side effect of the import graph,
regardless of whether that file's test body ends up skipped. With 4 such
files now, two of their subprocesses raced to migrate the same shared file
concurrently (`SqliteError: table X already exists` in CI — low enough odds
with 1–3 files to not manifest before this). Fixed with a new
`test/helpers/isolateSqlite.js`, imported first in every `*.postgres.test.js`
file: same `DATABASE_PATH`-to-temp-file trick as `tmpDb.js`, but — unlike
`tmpDb.js` — it deliberately leaves `DATABASE_URL` untouched, since these
files need the real ambient value to decide whether to run for real.

### Phase 6 shipped — fifth converted file (`src/db/leaderboardVanity.js`)

Single-column `TEXT` PRIMARY KEY again, same shape as `appSettings`. Two
things worth naming: `src/web/routes/leaderboard.js` uses a manual
`try/catch` + `next(err)` pattern instead of the `asyncHandler` helper used
in `guilds.js` — converted its route to match that file's *own* existing
idiom rather than importing `asyncHandler` in inconsistently. Also caught
(locally, before it ever reached CI) a self-inflicted test bug: unlike every
other converted table, `leaderboard_vanity.slug` is **UNIQUE across every
guild**, not scoped — the first draft of `leaderboardVanity.postgres.test.js`
hardcoded the literal slug text, which collided with a leftover row when run
twice against the same *persistent* Postgres (fine against CI's per-run
ephemeral container, but broke immediately under local iteration against a
long-lived dev container). Fixed by making the slug text itself unique per
run, not just the guild ids — a reminder that "give ids a per-run stamp" isn't
automatically enough when a table has a uniqueness constraint on a
*different* column too. 5 of 32 files converted; same caveats as before
still apply.

### Phase 7 shipped — sixth converted file (`src/db/tempBans.js`)

Widest call-site fan-out yet — 4 files (`ban.js`, `unban.js`,
`moderation.js`, `guilds.js`), 8 call sites — but every one was already
inside an async function except `moderation.js`'s `setInterval(() => {...},
30_000)` expiry-tick callback, which needed converting to
`setInterval(async () => {...}, ...)` to `await dueTempBans(...)`. Applied
the same lesson from Phase 6 proactively this time: the Postgres test uses
per-run-unique guild ids, and — since `dueTempBans` scans across *all*
guilds, not just one — asserts with `.some()`/`.every()` scoped to this
run's own guild ids rather than exact array equality, so leftover rows from
other runs against a persistent Postgres can't cause a false failure. Also
caught (locally) a copy-paste gap in the Postgres test itself — a
"guild B is untouched" assertion with no row ever inserted into guild B —
same self-review habit that caught the slug bug last time. 6 of 32 files
converted; same caveats as before still apply.

### Phase 8 shipped — two files at once (`src/db/channelLocks.js`, `src/db/starboard.js`)

First batch of **two independent files in one PR**, now that the shim has
proven itself across 6 varied conversions — extra single-file caution had
diminishing returns. Picked deliberately to avoid any shared blast radius:
`channelLocks.js` (composite natural PK, 11 call sites across 4 files, all
already inside async functions — purely mechanical) and `starboard.js`
(composite natural PK, an `ON CONFLICT` upsert whose `UPDATE SET` includes a
`COALESCE` to keep `posted_at` sticky, ~15 call sites concentrated in one
module file). Neither touches a shared helper the other depends on.

Two candidates were considered and explicitly **rejected** for this batch
after inspection, both worth a dedicated future PR instead:
- `commandOverrides.js` — enforced in `bot/events/interactionCreate.js`
  (runs on every interaction bot-wide) *and* feeds the same shared
  `overviewSummary.js` helper `counting.js` does (below) — too much blast
  radius to pair casually.
- `counting.js` — its dashboard-overview line lives inside
  `overviewSummary.js`'s `moduleLines()`, itself called from a **double**
  `.map()` chain in `buildOverview()`/`buildCard()` for *every* module's
  summary card. Converting just the `counting` branch to async means
  `moduleLines` → `buildCard` → the `LAYOUT.map()`/`g.ids.map()` chain all
  need to become `Promise.all`-aware — a real, deep ripple discovered by
  reading the call chain, not by trial and error. Deserves the same
  dedicated attention channel-cleanup's `moduleViewLocals` ripple got.

Also caught (locally) two of my own test-writing mistakes before they
reached CI: an incorrect assumption that `upsertStarboardEntry` gets called
again after a post is made (it doesn't — production code calls
`setStarboardCount` instead, which is why `posted_at`'s `COALESCE` guard
exists at all), and confirmed `setStarboardCount`'s real "update in place"
contract instead. 8 of 32 files converted; same caveats as before still
apply.

### Phase 9 shipped — `src/db/postedKeys.js` (solo, not paired — real dialect work)

Four candidates considered for this round (`counting.js`, `polls.js`,
`composedMessages.js`, `guildSettings.js`) were all rejected after
inspection — every one of them feeds `src/web/lib/overviewSummary.js`'s
`moduleLines()`/`buildCard()`, which are reached through a **double**
`.map()` chain in `buildOverview()`. Converting any one of them forces that
whole chain to become `Promise.all`-aware at once — real, contained work,
but deserving its own dedicated PR rather than a repeat surprise across four
separate ones. `guildSettings.js` additionally touches
`src/web/middleware/auth.js` (the dashboard's auth check, run on every
request) — outside scope for a casual pick regardless.

`postedKeys.js` — the shared dedup store behind free-games, Twitch, YouTube,
Kick, and RSS alerts — had no such entanglement, so it became this round's
sole focus (not paired, given real work below beyond the usual
placeholder-translation pattern):

- `INSERT OR IGNORE` (SQLite-only) rewritten to `INSERT ... ON CONFLICT
  (guild_id, scope, key) DO NOTHING` — SQLite has supported that standard
  syntax since 3.24, so this is now the *same* statement on both drivers,
  not a driver-specific branch.
- `key GLOB ?` (SQLite-only pattern matching) rewritten to `key LIKE ?`; the
  one real caller (`youtubeAlerts.js`'s `hasSeenAny`) always passes a
  literal-prefix-plus-`*` pattern, so `anySeenMatching()` now converts the
  `*` to `%` in JS before binding — the exported function's signature is
  unchanged, only the SQL text and one internal translation line moved.
- 24 call sites across `freeGames.js`, `twitchAlerts.js`, `youtubeAlerts.js`
  (thin per-module wrappers around `postedKeys.js`), `kickAlerts.js`,
  `rss.js`, and one site in `guilds.js` — every one already inside an async
  function, so purely mechanical once the two dialect rewrites above were
  settled. `rss.js`'s `entries.filter((e) => !seen(...))` needed converting
  to an explicit loop, since a filter predicate can't `await`.

9 of 32 files converted; same caveats as before still apply.

### Phase 10 shipped — `src/db/counting.js`, and `overviewSummary.js` unblocked for good

Went after the actual blocker from Phase 9 instead of routing around it
again: `src/web/lib/overviewSummary.js`'s `buildOverview()` → `buildCard()`
→ `moduleLines()` chain is now fully async, fixed **once**, in the same PR
as the file whose conversion originally needed it (`counting.js`, single-
column `TEXT` PK, same upsert shape as `appSettings`/`leaderboardVanity`).

The fix: `buildCard`/`moduleLines` became `async`; `buildOverview`'s two
nested `.map()`s (`LAYOUT.map` building groups, `g.ids.map` building each
group's cards) became `Promise.all(...map(async ...))` pairs, since neither
can `await` inline. Every *other* `moduleLines` switch case
(`tickets`/`polls`/`giveaways`/`insights`/… — all still backed by
unconverted db files) needed **no changes at all**: `await` on a
non-promise value just resolves immediately, so a still-synchronous
`openTicketCount()`-style call works fine inside the now-`async` function
without itself being touched. This is the payoff — `polls.js`,
`composedMessages.js`, `guildSettings.js`, and eventually `tickets.js`,
`appeals.js`, `inviteTracker.js`, `cache.js`, `giveaways.js`,
`scheduledMessages.js`, `leveling.js`, `insights.js` can each be converted
later touching only their own one-line case in `moduleLines`, never
`buildOverview`/`buildCard` again.

10 of 32 files converted; same caveats as before still apply.

### Phase 11 shipped — two files (`src/db/polls.js`, `src/db/composedMessages.js`), cashing in the Phase 10 fix

First files converted since `overviewSummary.js` became fully async — and it
paid off exactly as expected: both files' one-line `moduleLines`/`buildCard`
cases (`polls`, `messages`) needed only a bare `await` added, no further
propagation. `composedMessages.js` is one of the 8 `returningId: true`
tables, first real exercise of that path since `channelCleanup.js`.

Two new, generalizable bugs found (both locally, before CI):
- **`COUNT(*)` comes back as a string from postgres.js**, not a number
  (bigint safety), while better-sqlite3 returns a plain JS number.
  `polls.js`'s `guildPollCount()` needed a `Number(...)` coercion — and the
  same latent bug was found and fixed in the *already-shipped*
  `birthdays.js`'s `birthdayCount()` (unused externally today, but wrong
  regardless). Worth checking any future `COUNT(*) AS n` statement for this.
- **A bootstrap DDL must account for every migration touching a table, not
  just its original `CREATE TABLE`** — `composed_messages` gained a `name`
  column via a *later* `ALTER TABLE` migration that the first draft of the
  bootstrap DDL missed entirely, caught by a real Postgres insert error
  ("column name does not exist") rather than by inspection. Audited every
  `ALTER TABLE` in `MIGRATIONS` against the 10 files converted so far —
  none of the other 9 tables have a matching `ALTER TABLE`, so this was an
  isolated miss, not a systemic one — but it's now the standard step before
  writing any future bootstrap: grep `ALTER TABLE <table>` across the whole
  migrations file, not just its `CREATE TABLE`.

12 of 32 files converted (correcting an off-by-one in this section — two
files shipped in this phase, not one); same caveats as before still apply.

### Phase 12 shipped — `src/db/guildSettings.js` (solo — widest fan-out yet, 9 files)

Both of the two entanglements flagged when this was rejected back in Phase 9
turned out to be non-issues once actually inspected: `overviewSummary.js`
was already fixed in Phase 10, and `web/middleware/auth.js`'s `isBotMaster()`
— gating every admin-only dashboard request — was **already async**, with
its only caller already treating it as a promise via `.then()/.catch()`
(`requireGuildAdmin` never needed to change at all). The lesson from Phase 8
generalizes: inspect the actual call site before rejecting a file as
"too entangled" — sometimes the entanglement is already handled.

Real find this time: `src/modules/welcome.js` had `guildEmbedColor(...)`
called *inline inside an `EmbedBuilder` chain*
(`.setColor(guildEmbedColor(...))`). `await` works fine as a plain argument
expression even inside a chained call (`.setColor(await
guildEmbedColor(...))`), so no extraction to a temporary variable was
needed — but the containing `payloadFor()` helper and one of its two
callers (`guildMemberRemove`, previously a bare non-async arrow returning a
promise implicitly) both had to become `async` to allow that `await` at all.

Also: while auditing every call site, `test/exportConfig.test.js` was
calling `setModlogChannel(...)` with no `await` and immediately reading the
result back via `exportGuildConfig()` (a raw-SQL function, untouched by this
migration) — a genuine race the async conversion exposed on the **SQLite**
path too, not just Postgres, caught before it could flake in CI.

13 of 32 files converted; same caveats as before still apply.

### Phase 13 shipped — two files (`src/db/commandOverrides.js`, `src/db/cache.js`)

Went back for `commandOverrides.js`, rejected in Phase 9 over its
`bot/events/interactionCreate.js` entanglement (runs on every slash-command
interaction bot-wide) — same lesson as Phase 12's `auth.js`: the actual
call site, `overrideBlockReason()`, was a plain function whose one caller
was already `async` and already treated it as a synchronous return value
sitting inside an already-`await`-ing flow, so making it `async` + adding
one `await` at the call site was the entire fix. Paired with `cache.js`
(game-stats lookups) — independent, no shared files with the other beyond
`overviewSummary.js` (already async).

One real restructure: `src/web/routes/guilds.js`'s `levelingCommands`
block called `getCommandOverrides(req.guild.id)` **inside** a synchronous
`.map()` callback, once per iteration — hoisted to a single `await`ed
lookup before the map, same "precompute before the ternary" pattern used
for `channel-cleanup`'s `cleanupSchedules` back in Phase 2.

Also caught (locally): a test-only race in the new `cache.js` tests
themselves — `stats_cache` has no guild scoping, so two tests in the same
file both assuming their row would be "the most recent overall" collided
when an unrelated upsert refreshed another row's `created_at` to nearly the
same instant. Fixed by filtering results to each test's own keys rather
than asserting on the raw top-N — a reusable pattern for any future test
touching a non-guild-scoped shared table.

**A real bug reached `sylo-test` this time, caught only by manually running
`/stats`**: `src/bot/commands/stats.js`'s `runStatsLookup()` — identified
during planning as "already async, easy" — never actually got its `await
getCached(key)` edit applied. Since a pending Promise is always truthy,
the cache-hit branch fired unconditionally and returned the Promise object
itself as `stats`, crashing every `/stats` call downstream at `stats.kd`.
The existing `cache.js` DB-layer tests didn't catch it because none of them
exercised `runStatsLookup()`'s own logic, only the driver functions it
calls — added `test/statsLookup.test.js` (exporting `runStatsLookup` for
the purpose) as a regression guard, and re-ran a full grep of every call
site named during planning against the actual diff before calling a phase
done, not just trusting the plan.

15 of 32 files converted; same caveats as before still apply.

### Phase 14 shipped — `src/db/inviteTracker.js`

Three tables in one file (`invite_counts`, `invite_joins`, `invite_personal`).
Call sites: `src/bot/commands/inviter.js`, `invites-leaderboard.js`,
`invites.js`, `src/modules/inviteTracker.js` (the `guildMemberAdd`/
`guildMemberRemove` handlers were already `async`, no restructuring needed),
plus the usual `overviewSummary.js`/`guilds.js` dashboard hooks.

Deliberately did **not** take `tempVoice.js` alongside it even though it was
next in line: `getTempChannel()` is called from `insights.js`'s
`voiceBucket()` → `settleVoice()` → `flushSlot()` → `slot()` chain, itself
invoked from currently-synchronous `messageCreate`/`guildMemberAdd`/
`guildMemberRemove`/`voiceStateUpdate` handlers — a ripple on the same order
as the Phase 10 `overviewSummary.js` fix. Left as its own dedicated phase
rather than rushed alongside an unrelated file.

**New cross-dialect gotcha, found by a failing Postgres test that an
aliasing fix did *not* actually resolve (worth recording so the misdiagnosis
isn't repeated)**: `bumpRegular`/`bumpLeaves` upsert with
`ON CONFLICT (...) DO UPDATE SET regular = regular + @delta` — an
**unqualified** self-reference on the right-hand side. SQLite accepts this
without complaint, but Postgres raises `column reference "regular" is
ambiguous` (42702), reproduced even on a bare two-column scratch table with
no self-join anywhere in sight: `DO UPDATE SET`'s scope sees both the target
table's current row and the proposed `excluded` row, both exposing a
`regular` column, so the bare name is genuinely ambiguous per the SQL
standard — Postgres just enforces it and SQLite doesn't. Fix is to qualify
the target-table side with the real table name (no alias needed, since none
is declared on the `INSERT`): `regular = invite_counts.regular + @delta`.
Portable — SQLite accepts the qualified form too. (Every *other* already-converted
file's `ON CONFLICT` clauses were re-grepped and confirmed clean — they all
already use `excluded.col` exclusively, never a bare self-reference.)

Separately (harmless, but worth keeping since it's correct standard SQL
either way): `inviterRank()`'s correlated subquery re-references
`invite_counts` in both the outer query and the inner subquery. Aliased both
sides (`outer_ic`/`inner_ic`) for clarity — SQLite resolves the unaliased
form's bare columns to the innermost scope without complaint, so this one
was never actually the cause of the test failure above, just good hygiene
once spotted.

16 of 32 files converted; same caveats as before still apply.

### Phase 15 shipped — two files (`src/db/scheduledMessages.js`, `src/db/audit.js`)

`scheduledMessages.js` (reminders — 3 timestamp-heavy columns beyond the
usual: `start_at`/`end_at`/`run_at`, all `BIGINT`, plus the existing
`next_run_at`/`last_run_at`/`created_at`) paired with `audit.js` (the
dashboard's config-change log) — independent of each other, but `audit.js`
turned into the widest single-PR ripple so far: `recordAudit()` is called
from 36 places across `src/web/routes/guilds.js`, 7 of which were still
plain synchronous route handlers (`leaderboard/public`,
`m/automod/immunity`, both `m/temp-voice/hub*` routes, `m/starboard/sb`, and
both `modules/bulk` / `modules/:moduleId` toggle routes) and needed the
usual `asyncHandler` wrap; the other 29 were already inside `asyncHandler`d
routes, so `await` was the whole fix there. Mechanical, but re-grepped every
one of the 36 call sites against the actual diff before calling this done —
the `stats.js` lesson from Phase 13.

Went looking for more low-hanging files and found three that turned out to
already be fully async-safe with **zero changes needed**: `freeGames.js`,
`twitchAlerts.js`, `youtubeAlerts.js` — each is a thin wrapper over
`postedKeys.js` (converted back in an earlier phase) with no SQL of its own,
so their own `async` exports were already just forwarding an already-async
call. Worth remembering for future phases: not every file in the "not yet
converted" list actually needs work — check whether it owns any SQL before
assuming it does.

**Deliberately deferred `src/db/exportConfig.js`, `src/db/dashboardStats.js`,
and `src/db/modules.js` together** — `exportConfig.js` reads
`guild_modules` directly (among other already-converted tables), and
`dashboardStats.js` reads `guild_modules`, `infractions`, and `tickets`, none
of which are bootstrapped in Postgres yet since `modules.js` isn't converted.
`modules.js`'s `getGuildModule()`/`isModuleEnabled()` are called synchronously
from what looks like the widest blast radius of any remaining file — nearly
every module's event handler checks it before doing anything — so it gets
its own dedicated phase (like `tempVoice.js`/`insights.js`), and
`exportConfig.js`/`dashboardStats.js` wait for that to land first rather than
shipping with a Postgres-path query against a table that doesn't exist yet.

18 of 32 files converted; same caveats as before still apply.

### Phase 16 shipped — `src/db/appeals.js`

The widest structural ripple since Phase 10's `overviewSummary.js` fix:
`countOpenAppeals()` is read inside `baseContext()`
(`src/web/lib/guildContext.js`), the shared sidebar/nav view-model built by
**every** dashboard page — 20 call sites once `guildTickets.js` and
`guildMessages.js` (missed on the first grep, since it only covered
`guilds.js`) were counted too. Made `baseContext()` async (same
"fix it once" approach as Phase 10) and `await`ed every call site; 6 of them
were local `render*Builder` helpers (reminders, channel-cleanup, temp-voice,
reaction-roles, starboard, custom-commands, plus messages' own builder) that
were themselves plain sync functions spreading `...baseContext(...)` — each
had to become `async` too, which then meant `await`ing *their* two call
sites each (a one-liner "new" route and an "/:id" route, half already
`asyncHandler`-wrapped from earlier phases, half not). `getGuildModules()`
(modules.js) and `openTicketCount()` (tickets.js) stay sync-called inside
the now-async `baseContext()` — unconverted-but-synchronous calls don't need
an `await`, and this unblocks both of those files' own future conversions
the same way Phase 10 unblocked several `src/db/*.js` files.

**New cross-dialect gotcha**: `createAppeal()` relies on a partial unique
index (`CREATE UNIQUE INDEX ... WHERE status = 'open'`, one open appeal per
guild+user) and catches the constraint violation to return `null` instead of
throwing. The old check was `err.message.includes('UNIQUE')` —
SQLite-specific wording ("UNIQUE constraint failed: …"). Postgres reports
the same violation as "duplicate key value violates unique constraint …"
(error code `23505`), which doesn't contain the substring `UNIQUE`, so the
old check would have silently stopped catching the case on Postgres and
thrown instead of returning `null`. Fixed with a portable check: Postgres's
error code OR a case-insensitive `unique` substring match, which covers both
drivers' wording. Verified against a real Postgres connection (not just
reasoned about) before considering this fixed — reproduced the wrong
behavior first, confirmed the fix, per the "measure twice" habit from the
`inviteTracker.js` incident in Phase 14.

19 of 32 files converted; same caveats as before still apply.

### Phase 17 shipped — `src/db/tickets.js`

Two tables (`tickets`, `ticket_messages`); `tickets` carries the same
partial-unique-index shape as `appeals.js` (one open ticket per guild+user)
but — unlike `appeals.js` — `createTicket()` never catches a constraint
violation itself; callers are expected to check `getOpenTicket()` first, so
there was no SQLite-vs-Postgres error-message text to port this time.

`openTicketCount()`/`unreadTicketCount()` feed `baseContext()` (already
async since Phase 16) and `overviewSummary.js`'s `buildHealth()` (previously
sync, one call site — made async the same way, unblocking it for any future
file that needs it). Also caught a `.filter()` callback in
`src/bot/events/dmTickets.js` calling the now-async `getOpenTicket()`
synchronously per guild — restructured to `Promise.all(...map(...))` then
`.filter()` on the resolved flags, the same pattern used for
`overviewSummary.js`'s nested maps back in Phase 10.

No pre-existing test file covered `src/db/tickets.js` directly (only
indirect coverage via `purge.test.js`/`retention.test.js`, which write rows
with raw SQL against the untouched SQLite table, and `routes.misc.test.js`'s
HTTP-level dashboard checks) — added `test/tickets.test.js` and
`test/tickets.postgres.test.js` from scratch. Found and fixed a bug in the
Postgres test itself before it shipped: an early draft reused the same guild
id across all three subtests, so `openTicketCount` picked up tickets created
by an *earlier* subtest and asserted the wrong total — fixed by giving the
count-assertions subtest its own guild id, same "each test brings its own
guild id" discipline as every other phase.

20 of 32 files converted; same caveats as before still apply.

### Phase 18 shipped — `src/db/giveaways.js`

Two tables (`giveaways`, `giveaway_entries`); `addGiveawayEntry`'s
`INSERT OR IGNORE` rewritten to `ON CONFLICT (giveaway_id, user_id) DO
NOTHING` — same portable pattern as `postedKeys.js`.

Widest set of small restructures yet for one file: `giveawayEntryCount()`
going async forced three separate `.map()` callbacks that read it into
`Promise.all(...map(async ...))` pairs — `/giveaway list`'s embed lines,
the dashboard's giveaway-history table in `guilds.js`, and
`scheduleCountRefresh()`'s footer-edit timer in `modules/giveaways.js`
(a `setTimeout` callback, made `async` directly — `setTimeout` doesn't care
whether its callback returns a promise, matching the existing
fire-and-forget `.catch(() => {})` style already used throughout this
module). The expiry-sweep `setInterval` loop got the same
`tick().catch(...)` wrapper used for every other polling loop in this
migration (`scheduledMessages.js`, Phase 15).

**Explicitly ruled three other files out of this batch, each for a
different reason worth recording:**
- `leveling.js` and `modCases.js` both wrap their writes in
  `db.transaction(...)` — better-sqlite3's synchronous atomic-multi-statement
  primitive. `driver.js` has no Postgres equivalent yet; building one
  properly (safe under concurrent requests) needs `AsyncLocalStorage` to
  thread the active transaction connection through already-`prepare()`d
  statements, not just a module-level "current transaction" variable — that
  would leak across concurrently in-flight guild operations. This is new
  driver.js infrastructure, not an application of the existing pattern, so
  it isn't being bolted on under time pressure. Both files stay on hold
  until that primitive exists.
- `purge.js` and `retention.js` also use `db.transaction(...)`, and
  additionally sweep across nearly every table in the database — several
  still unconverted (`guild_modules`, `infractions`) — so they're
  doubly blocked: on the transaction primitive above, and on `modules.js`
  and `modCases.js` landing first.
- `backup.js` and `offsiteBackup.js` turned out not to belong in the
  32-file count at all: they're SQLite-file-specific tooling (`VACUUM INTO`,
  WAL checkpointing, replacing the live `.db` file, gzip-and-upload of that
  file) with no per-guild data table to migrate. A hosted Postgres instance
  will need its own backup strategy (`pg_dump` or similar) — a separate,
  future piece of work, not a driver-shim conversion.

21 of 30 files converted — the running total drops from 32 to 30 here:
`backup.js`/`offsiteBackup.js` are removed from the count as out-of-scope
infra (see above), not counted as remaining work. Same caveats as before
still apply.

### Phase 19 shipped — `src/db/modCases.js` and `src/db/leveling.js`

The two files deferred in Phase 18 over their `db.transaction()` usage —
done without ever building a transaction primitive. Both turned out to be
solvable by redesigning the write around a single atomic statement instead of
a multi-statement app-level transaction:

- **`modCases.js`**: the transaction only existed to make
  `SELECT MAX(case_number)+1` race-free under concurrent writers. Replaced
  with a new `case_counters` table and a single
  `INSERT ... ON CONFLICT DO UPDATE SET next_number = next_number + 1
  RETURNING next_number` claim — the same upsert-with-increment shape as
  `inviteTracker.js`'s `bumpRegular` (Phase 14), just read back via
  `RETURNING` instead of a blind write. A new migration (37) backfills
  `case_counters` from `MAX(case_number)` per guild for existing
  SQLite installs, so the counter picks up exactly where real history left
  off instead of colliding with it. Verified with a dedicated stress test:
  25 concurrent `addCase()` calls for the same guild against real Postgres,
  asserting the claimed numbers are exactly `1..25` with zero duplicates or
  gaps — passed first try.
- **`leveling.js`**: `xp`/`messages`/`voice_xp`/`voice_minutes` are now a
  single atomic increment-upsert (`RETURNING` the post-increment row);
  `level` — a JS curve lookup (`levelFromXp`) with no practical single-SQL-
  expression equivalent — is derived from that returned xp and written by a
  second, self-guarding statement (`WHERE level < @level`, so an
  out-of-order concurrent write can never regress it). `previousLevel` (for
  the `leveledUp` check) is computed as `levelFromXp(newXp - add)` instead of
  read before the write — mathematically exact for *this* call's own delta
  regardless of what any concurrent caller does, so no pre-read is needed at
  all. Also caught and fixed the exact Phase 14 bug in
  `leveling_periods`'s *existing* upsert (`xp = xp + excluded.xp`, unqualified
  — ambiguous on Postgres) while touching the file; qualified it to
  `leveling_periods.xp + excluded.xp` like everything else. Verified with 50
  concurrent `addXp()` calls for the same member against real Postgres,
  asserting the final total is exactly 50×10 with nothing lost — passed
  first try.

Both fixes generalize the lesson from this pair: a `db.transaction()` in this
codebase has, so far, always existed to guard exactly one thing (a
read-compute-write or a claim-next-number race), and that thing has always
turned out to be expressible as a single atomic SQL statement once you look
for it — cheaper and safer than building a portable transaction primitive
(which would have needed `AsyncLocalStorage` to thread a Postgres transaction
connection through already-`prepare()`d statements, and still couldn't stop
an unrelated statement from a different request interleaving on SQLite's
single shared connection). `purge.js` and `retention.js` — the two remaining
`db.transaction()` users — are worth re-examining with this same lens before
assuming they need a transaction primitive either, when their turn comes.

23 of 30 files converted; same caveats as before still apply.

### Phase 20 shipped — `src/db/modules.js`

By far the widest single-PR change in this migration: 44 files, ~130+ call
sites to `isModuleEnabled`/`getGuildModule`/`getGuildModules`/
`setGuildModule` — dwarfing the previous record (Phase 16's `baseContext`,
20 sites in 3 files). Had to land as one PR since every call site shares the
same underlying functions; a partial conversion would have left the
un-updated sites silently reading `.config`/`.enabled` off a pending Promise.

The core risk was `dispatch.js` — the event fan-out every module's Discord.js
handler routes through — but it turned out to already be `async` with an
existing `await fn(...)` in its loop, so unblocking it took two words. That
de-risked the rest: the ~40 remaining files were almost entirely mechanical
`await` insertions inside already-async contexts (Discord command
`execute()`, `on(...)` event handlers, `asyncHandler`-wrapped routes) — the
same pattern proven repeatedly since Phase 14. A handful of local sync
helpers had to become `async` and get their own call sites updated in turn:
`resolveContext()` (shared by all 12 `/voice-*` commands),
`tempVoiceConfig()`/`hubForChannel()`, `roleMessageById()`, `tvHubs()`,
`starboardBoards()`, `ccCommands()`, and `buildSidebar()` (the whole
dashboard's nav, wired through a new `async` auth middleware — safe on
Express 5, which forwards a rejected promise from an async middleware to the
error handler the same way it does for route handlers). Two `.some()`/`.find()`
callbacks that called an now-async helper became `Promise.all(...)` +
a plain synchronous check on the resolved results, same restructure as
Phase 14/18's `Promise.all(...map(async ...))` pairs.

**Two real, unrelated bugs found and fixed while re-auditing every call
site (the `stats.js` lesson from Phase 13, still paying off):**
- `birthdays.js`'s `runBirthdaySweep()` compared `getAppSetting(...)`
  (converted to async in an earlier phase) directly against a date string
  with no `await` — always false, silently defeating the "only run once
  after midnight" guard and making the birthday sweep+announcement re-run
  every hour, all day, since a much earlier phase. Fixed.
- 4 more un-awaited `setGuildModule`/`getGuildModule` calls turned up in
  test files during the full-suite run (`insights.test.js`,
  `retention.test.js`, `routes.guilds.test.js`, `exportConfig.test.js`,
  `overviewSummary.test.js`, `routes.misc.test.js`) — all fixed, and one
  (`insights.test.js`) also needed `await` added on its own direct
  `dispatch(...)` calls, since dispatch's internal work is now genuinely
  asynchronous instead of resolving within the same tick.

Also hardened `dispatch()` itself while in there: `isModuleEnabled()` was
being called *outside* the per-handler `try/catch`, safe when it was a
synchronous SQLite read that couldn't throw asynchronously, less so now that
it's real (if normally fast) I/O — moved inside the same try/catch as the
handler call, so a hiccup on one module's guard check can't abort the
dispatch loop for every other module listening to that event.

This unblocks `exportConfig.js`, `dashboardStats.js`, `purge.js`, and
`retention.js` for a future phase — all previously deferred specifically
because they read `guild_modules`, which had no Postgres bootstrap DDL until
now. They're not converted themselves yet; only `modules.js` shipped in this
phase.

24 of 30 files converted; same caveats as before still apply.

### Phase 21 shipped — `src/db/exportConfig.js` and `src/db/dashboardStats.js`

The two files Phase 20's note flagged as unblocked-but-not-converted, plus
`purge.js`/`retention.js` which are left for a later phase. Both files own no
table of their own — they only `SELECT` from tables bootstrapped by their
owning files (`guild_settings`, `guild_modules`, `command_overrides`,
`scheduled_messages`, `counting` for `exportConfig.js`; `infractions`,
`tickets`, `stats_cache`, `composed_messages`, `guild_modules` for
`dashboardStats.js`) — so no `registerPostgresBootstrap()` call and no new
migration were needed, just `prepare()` + `async`/`await` on every export.
The only cross-dialect gotcha was the familiar one (checklist item 4):
`dashboardStats()`'s six `COUNT(*)` queries each got wrapped in `Number(...)`
since postgres.js returns bigint counts as strings.

3 call sites outside `src/db` needed updating: `src/web/routes/guilds.js`'s
`/:guildId/export` route (was plain sync, wrapped in `asyncHandler`) and two
`moduleUsage()` reads in `src/web/routes/health.js` and
`src/web/routes/metrics.js` (neither route was `asyncHandler`-wrapped before;
both are now). `dashboardStats()`'s one call site (also in `health.js`) got
the same treatment in the same pass.

New `test/exportConfig.postgres.test.js` and `test/dashboardStats.postgres.test.js`
verify both files end-to-end against a real Postgres connection, seeding
through the already-converted owning modules (`modules.js`, `guildSettings.js`,
`scheduledMessages.js`, `modCases.js`, `tickets.js`, `cache.js`,
`composedMessages.js`) rather than raw SQL, so the tests exercise the same
cross-file composition the app does in production.

26 of 30 files converted; same caveats as before still apply. Remaining:
`purge.js`, `retention.js` (both use `db.transaction()` for bulk/idempotent
DELETEs, not concurrency races — worth re-examining with the Phase 19 lens
before assuming they need a transaction primitive), `tempVoice.js`, and
`insights.js`.

### Phase 22 shipped — `src/db/purge.js` and `src/db/retention.js`

The two `db.transaction()` users flagged since Phase 19 as likely convertible
without a transaction primitive — confirmed here. Neither `purgeGuild`/
`forgetUser` (purge.js) nor `sweepRetention` (retention.js) needs atomicity:
every statement is a DELETE (or an anonymising UPDATE) scoped to rows that are
either already gone or already past their cutoff, so an interrupted run just
leaves work for the next attempt — self-healing, not a race. Both now run as
a plain sequence of awaited statements instead of a `db.transaction()`
callback.

**Real gap found while wiring this up, not a bug in the new code but a
pre-existing one it exposed**: `GUILD_TABLES` (`purge.js`'s guild-scoped table
list, checked against the schema by `test/guildTables.test.js`) includes
`temp_voice_channels`, `guild_daily`, and `guild_hourly` — owned by
`tempVoice.js` and `insights.js`, neither converted yet, so neither had ever
registered Postgres bootstrap DDL for its table. `purgeGuild` used to run
against the raw SQLite `db` unconditionally regardless of `DATABASE_URL`
(same split-brain caveat as every unconverted file), so this never surfaced;
switching it to the shared driver made every `DELETE FROM temp_voice_channels
...` a real Postgres query for the first time, and it 42P01'd against a table
that didn't exist. Fixed by having `purge.js` itself register bootstrap DDL
for those three tables (schema copied verbatim from their SQLite migrations
in `index.js`) — scoped deliberately to *just* creating the tables so
`purgeGuild`'s DELETEs succeed, not to converting `tempVoice.js`/`insights.js`'s
own read/write logic, which stays future work. Drop that bootstrap block once
those two files are converted and register the same DDL there instead.

**Two more gaps found by CI, both fixed at the driver level, not worked
around locally in purge.js:**

- `registerPostgresBootstrap()` only runs when the *calling file* is actually
  imported in the current process, and `node --test` runs every test file as
  its own process. `test/purge.postgres.test.js` imports `purge.js` but not
  `starboard.js`, so its process's bootstrap list never included
  `starboard_posts` — a 42P01 the CI run caught that a locally-run full suite
  didn't (different import graph reaches `purge.js` first there). Fixed by
  side-effect-importing every already-converted table-owning file into
  `purge.js` (26 imports, none of their exports used) — since `purgeGuild`
  genuinely touches all of them, this guarantees the full `GUILD_TABLES`
  schema exists in whichever process loads `purge.js`, test or production,
  regardless of what else that process happened to import first.
- That fix's extra imports meant more processes racing to `CREATE TABLE IF
  NOT EXISTS` the *same* brand-new table against a freshly wiped database at
  once — reproduced locally (wipe the schema, rerun the suite) at roughly a
  50% failure rate, always a `pg_type_typname_nsp_index` 23505: the
  existence check and the creation aren't one atomic step, so two sessions
  can both see "doesn't exist yet" and collide inserting into Postgres's
  internal catalog. This was always possible, not something the extra
  imports introduced — they just made it likely enough to actually hit. Fixed
  in `driver.js`: the whole bootstrap loop now runs under a session-scoped
  `pg_advisory_lock`, serializing it across every concurrent connection.
  Also replaced the plain `bootstrapped` boolean with one shared promise every
  caller awaits, closing a same-process version of the same race (a second
  concurrent call could previously see the flag flip before the first call's
  DDL had actually finished). 12 fresh-schema-wipe reruns clean afterward,
  versus roughly 1-in-2 failing before.

28 of 30 files converted; same caveats as before still apply. Remaining:
`tempVoice.js` and `insights.js`.

### Phase 23 shipped — `src/db/tempVoice.js` and `src/db/insights.js`

The last two files — every `src/db/*.js` file now runs through the shared
driver. Both bootstrap blocks that `purge.js` was temporarily carrying for
these two tables (added in Phase 22, specifically flagged there as "drop once
converted") moved back to their real owning files, and `purge.js`'s
side-effect-import list picked up both files in their place — no functional
change to `purge.js`, just where the DDL text lives.

Neither file used `db.transaction()`, so no redesign needed there — but going
async surfaced a real concurrency gap in `src/modules/insights.js` (not
`src/db/insights.js` itself) worth detailing: `flushSlot()` reads a guild's
buffered counters, awaits `accrueDaily`/`accrueHourly`, then resets them —
and once that middle step is a real (if normally fast) network round trip
instead of a synchronous write, two flushes for the *same* guild can now
overlap in time. The periodic 10-minute `flushAll()` tick and a dashboard
"Refresh now" click (`flushGuild`) racing for the same guild would previously
have been impossible (JS never yielded between them), but now genuinely could
send that guild's buffered counters to the DB twice. Fixed with a small
per-guild in-flight `Set` — a second call for a guild already mid-flush is a
no-op, not a double-send; nothing is lost, it's just picked up by the next
flush. Also switched the post-flush reset from a hard `= 0` to subtracting
the exact amount just flushed (matching the existing `voiceMinutes -=` carry
pattern already in that function) so an event landing in the await window
isn't wiped by the reset that follows — done for the scalar counters
(messages/joins/leaves) where it's a one-line change; left as a hard clear
for the Map/Set breakdowns (per-channel counts, active-member sets), which
are cosmetic on an already-approximate rollup and self-correct next flush —
not worth a general Map/Set diff for that narrow a window.

**A genuinely new cross-dialect gotcha, not seen in 22 prior conversions**:
`guild_daily`/`guild_hourly`'s upserts used SQLite's multi-argument scalar
`MAX(a, b)` to track running peaks (`active_members`, `voice_peak`, …).
Postgres's `MAX()` is aggregate-only — no two-argument scalar form exists —
so this 42883'd immediately against real Postgres ("function max(integer,
integer) does not exist"). `GREATEST(a, b)` is Postgres's equivalent, but
isn't valid SQLite, and this codebase's driver shim translates placeholders
only, not function names — so both dialects run the exact same SQL text.
Fixed portably with `CASE WHEN a > b THEN a ELSE b END`, which both drivers
understand identically. Worth adding to the running per-file gotcha
checklist: **`MAX`/`MIN` with 2+ scalar arguments doesn't exist on Postgres —
use a portable `CASE WHEN` instead of reaching for `GREATEST`/`LEAST`.**

New `test/tempVoice.postgres.test.js` and `test/insights.postgres.test.js`
caught both the `MAX()` gotcha and a test-authoring bug of the usual kind
(a fixed, non-namespaced `HUB` id colliding with leftover rows across
manual reruns against the same un-wiped local Postgres — fixed by
namespacing it per test run, same lesson as Phase 19's leveling.js expected
values). 5 fresh-schema-wipe reruns clean after both fixes.

30 of 30 files converted — every `src/db/*.js` file now goes through
`driver.js`. **#1 (driver + async seam) is done.** `DATABASE_URL` can be
turned on for real hosted use as far as the file-conversion line is
concerned — #2 (a real `schema_migrations`-tracked bootstrap, replacing the
current "run every registered DDL block once, guarded by an advisory lock"
approach) and #3 (Postgres-native backup/restore) are still ahead before that
caveat from the top of this section can be dropped for good.

### 1 — Driver + async seam in `src/db/` — done (30 of 30 files)

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
- `lastInsertRowid` has no Postgres equivalent (`.run({...}).lastInsertRowid`
  is how better-sqlite3 hands back a newly-created row's id). Verified against
  every `CREATE TABLE` in `MIGRATIONS`: exactly 8 tables use a surrogate
  `id INTEGER PRIMARY KEY AUTOINCREMENT` key (`tickets`, `ticket_messages`,
  `composed_messages`, `scheduled_messages`, `config_audit`, `appeals`,
  `giveaways`, `channel_cleanup_schedules`); every other table uses a
  natural/composite key and never touches `.lastInsertRowid`. Usage is
  confined to 6 files (`channelCleanup.js`, `scheduledMessages.js`,
  `tickets.js`, `giveaways.js`, `appeals.js`, `composedMessages.js`). The shim
  can scope a Postgres-only `RETURNING id` append to statements that actually
  read `.lastInsertRowid`, not a blanket INSERT rewrite.

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
- Don't dialect-translate all 36 historical migrations (`AUTOINCREMENT` →
  `SERIAL`/`IDENTITY`, SQLite type affinity, etc.) — a brand-new hosted
  Postgres deployment has no legacy SQLite data to replay against, so there's
  no correctness reason to port them one by one. Write a single "Postgres
  bootstrap schema" reflecting the *current* cumulative shape, applied once
  when `DATABASE_URL` is set and `schema_migrations` is empty. Accepted
  ongoing tradeoff: migrations 38+ get written twice (SQLite `.exec()` DDL +
  a Postgres-dialect equivalent) once this ships — a fine price for not
  back-porting 36 historical ones.

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
