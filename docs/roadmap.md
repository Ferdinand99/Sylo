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

### 1 — Legal basis + retention table in `privacy-policy.md` (`docs:` — no bump)

Documentation only; no code.

- Add a **legal basis** subsection to `docs/privacy-policy.md`: name the basis
  per processing purpose (moderation records & audit log → legitimate interest;
  leveling / birthdays / AFK / invite tracking → the member's use of the feature;
  modmail transcripts → legitimate interest in handling the request). Note that
  self-hosters must set their own (ties into §9).
- Add a **retention schedule** table: for each data category (config, infractions,
  leveling + periods, birthdays, AFK, invite graph, modmail transcripts, ban
  appeals, insights aggregates, game-stat cache, logs) state the retention rule
  and the deletion trigger (`/forget`, guild-leave purge, auto-prune once #3
  lands, TTL, or "kept until changed").
- Mention the **off-site backup** path (`BACKUP_WEBDAV_URL` / `BACKUP_WEBHOOK_URL`):
  when enabled, the operator owns that destination as a processor, and snapshots
  hold since-deleted rows until they rotate out (newest 7 kept).
- Bump the "Last updated" date and add a line to §10.

### 2 — `/mydata` self-service data export (`feat:` — minor)

Covers GDPR Art. 15 (access) and Art. 20 (portability) in one command, and gives
a member a way to see their data without going through an admin.

- **`/mydata`** — ephemeral reply, DMs the caller a `sylo-<guildId>-<userId>.json`
  attachment: every row Sylo keys to their Discord account **in that guild**,
  grouped by source (infractions, leveling + period rows, birthdays, AFK, invite
  counts + attribution, giveaway entries, modmail transcript text, ban appeals,
  poll/temp-VC ownership). Same scope as `/forget`, read side.
- **Reuse `purge.js`** — the per-user `userStmts` map already enumerates every
  per-user table + column. Add a parallel `describeUserData(guildId, userId)` /
  `exportUserData(...)` in the same file that `SELECT`s where those `DELETE`s
  target, so the export and the erasure can never drift (a test asserts the two
  key sets match, like `guildTables.test.js` does for `GUILD_TABLES`).
- **Rate-limit** per user (cooldown in `posted_keys` or an in-memory map) — the
  export is a DB read across ~12 tables plus a DM.
- Fall back to an ephemeral message with the JSON in a code block if the DM is
  closed (Discord attachment in an ephemeral interaction reply is fine up to
  the size cap; chunk or refuse politely past it).
- Docs: new `docs/` note + a line in the privacy policy §6 next to `/forget`.

### 3 — Configurable auto-prune for transcripts + old infractions (`feat:` — minor)

Turns "kept indefinitely" into a stated, enforced retention limit.

- **Modmail transcripts** — a Tickets-module setting `transcriptRetentionDays`
  (0 = keep forever, default 0 for back-compat; suggest 90). A daily sweep
  deletes `ticket_messages` (and closed `tickets` rows) older than the cutoff.
- **Infractions** — a moderation-module setting `infractionRetentionDays` for
  **inactive** (soft-deleted / expired) cases only; active warns and the live
  case history are never auto-pruned. 0 = keep forever.
- One shared daily job (extend the insights prune interval pattern, or a small
  `src/db/retention.js` invoked from the existing scheduler). Log a count per
  sweep; never touch a guild with the setting at 0.
- Surface both in the respective config views + `guilds.js` POST branches;
  document in `docs/modules/tickets.md` and the moderation module doc.
- Tests: sweep deletes only past-cutoff rows, respects 0, leaves active cases and
  other guilds alone.

### Suggested order

1. **#1 legal basis + retention table** — docs-only, unblocks the wording #2/#3
   reference, ships immediately.
2. **#3 auto-prune** — makes the retention table's limits real.
3. **#2 `/mydata` export** — largest surface; benefits from the `purge.js`
   refactor being settled first.
