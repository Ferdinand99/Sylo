<div align="center">

<img src="unraid/sylo-icon.png" alt="Sylo" width="96" />

# Sylo

**Multi-function Discord bot with a MEE6-style web dashboard — self-hosted on Unraid via Docker.**

[![Test](https://github.com/Ferdinand99/Sylo/actions/workflows/test.yml/badge.svg)](https://github.com/Ferdinand99/Sylo/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/Ferdinand99/Sylo?sort=semver&label=release)](https://github.com/Ferdinand99/Sylo/releases)
[![Docker Hub](https://img.shields.io/docker/v/iwgamin/sylo?sort=semver&logo=docker&logoColor=white&label=docker%20hub)](https://hub.docker.com/r/iwgamin/sylo)
[![Pulls](https://img.shields.io/docker/pulls/iwgamin/sylo?logo=docker&logoColor=white&label=pulls)](https://hub.docker.com/r/iwgamin/sylo)
[![GHCR](https://img.shields.io/badge/ghcr.io-Ferdinand99%2FSylo-2496ED?logo=github&logoColor=white)](https://github.com/Ferdinand99/Sylo/pkgs/container/sylo)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/github/license/Ferdinand99/Sylo)](LICENSE)

</div>

Twenty-seven per-guild **modules**, Discord **OAuth2 login**, a public leveling
**leaderboard**, and — via the optional Game stats module — **Battlefield-series**
player lookups through the public [gametools.network](https://gametools.network) API.
Everything runs in **one Node process, one container, no build step**.

<details>
<summary>The 28 modules</summary>

moderation · logging · tickets · reaction roles · verification · welcome ·
welcome channel · birthdays · sticky messages · auto-moderation · counting · custom commands ·
autoresponder · reminders · leveling · AFK · server statistics · free games ·
ban appeals · temporary voice channels · starboard · invite tracker · polls ·
giveaways · game stats · Twitch alerts · YouTube alerts · Kick alerts

</details>

## Documentation

- **[docs/modules/](docs/modules/README.md)** — a page per module: what it does,
  the permissions and intents it needs, its settings, and its commands.
- **[docs/self-hosting.md](docs/self-hosting.md)** — install, environment
  variables, reverse proxy, Docker, Unraid, backups, upgrades and rollback,
  troubleshooting.
- [Privacy policy](docs/privacy-policy.md) · [Terms of service](docs/terms-of-service.md)

## Contents

- [What's new](#whats-new-since-20) · [Features](#features) · [Screenshots](#screenshots)
- [Project structure](#project-structure) · [Local setup](#local-setup)
- [Self-hosting](#self-hosting) · [Releases & CI](#releases--ci) · [Tests](#tests)
- [Adding another game](#adding-another-game) · [Legal](#legal) · [License](#license)

## Screenshots

The dashboard is server-rendered EJS with a small htmx + Alpine layer (no build
step): a fixed sidebar with a server switcher, a MEE6-style plugin grid, and a
settings panel per module — saves swap in place with a toast.

<!-- Drop PNGs in docs/screenshots/ and uncomment:
![Overview](docs/screenshots/overview.png)
![Module page](docs/screenshots/module-page.png)
![Embed builder](docs/screenshots/embed-builder.png)
-->

## Breaking changes in 3.0

- **Node 22** is now required (Node 20 is end-of-life). The Docker image is
  `node:22-alpine`.
- **`DISCORD_GUILD_ID` → `DISCORD_DEV_GUILD_IDS`.** The old name still works but
  logs a deprecation warning on boot — rename it in your `.env`.
- **Battlefield stats is now the "Game stats" module**, off by default. Enable it
  per server on the dashboard before `/stats battlefield` will respond.
- **The "Reminders" module's id changed** from `scheduled-messages` to
  `reminders`. A migration updates existing servers automatically; only matters
  if you script against the module id or a config-export JSON.

## What's new since 2.0

- **Giveaways** — `/giveaway start prize:… duration:30m` posts an embed with a
  **🎉 Enter** button; members join with one click (click again to leave). Winners
  are drawn automatically at the end time — no reactions, no Message Content
  intent. Optional `winners:` count and `required_role:`. `/giveaway end`,
  `/giveaway reroll` (excludes previous winners) and `/giveaway list`, plus an
  End / Reroll list on the dashboard. Winner ping (@here / @everyone) and
  optional winner DMs are configurable.
- **Image rank & leaderboard cards** — `/rank` replies with a rendered card
  (avatar, level, server rank, XP bar, message count) and `/leaderboard` with a
  rendered top-10 (medal badges, avatars, level, XP), both drawn in-process with
  `@napi-rs/canvas`. Each falls back to the old embed automatically if the image
  renderer is unavailable on the host.
- **Button & dropdown self-assign roles** — a reaction-role message can now use
  clickable **buttons** or a **select menu** instead of emoji reactions (pick the
  style in the builder). Buttons/dropdowns need no Add Reactions permission and
  no Message Content intent, handle up to 25 roles, and still honour the
  *exclusive* / *reverse* options. Emoji reactions remain the default.
- **Structured logging + error history** — every log line is now
  `<ISO timestamp>  LEVEL  scope  message`; set `LOG_LEVEL` (`debug`/`info`/
  `warn`/`error`) and `LOG_FORMAT=json` (or `LOG_JSON=1`) for machine-readable
  output. `LOG_LEVEL=debug` also emits one line per HTTP request
  (`method path status durationMs`). The **Health** page shows the last ~25
  errors (time, scope, message) and a gateway-ping sparkline; `GET /health`
  reports `errorCount`, `errorsByScope`, `commands` and a ping history. Dashboard
  forms and JSON actions now carry a CSRF token (enforced when "Log in with
  Discord" is enabled).
- **Prometheus metrics** — `GET /metrics` serves the standard text format
  (unauthenticated, rate-limited, same trust level as the `/health` JSON):
  `sylo_up`, `sylo_uptime_seconds`, `sylo_guilds`, `sylo_gateway_ping_ms`,
  `sylo_db_bytes`, `sylo_module_enabled{module}`, plus counters
  `sylo_commands_total{command}`, `sylo_component_interactions_total{scope}`,
  `sylo_errors_total{scope}` and `sylo_http_requests_total{route,status}`.
- **Automatic database backups + restore** — Sylo writes compacted single-file
  snapshots of `sylo.db` to `<data>/backups`: just before every schema migration,
  shortly after boot, and on a schedule (`BACKUP_INTERVAL_HOURS`, default 24;
  keeps `BACKUP_RETENTION`, default 14). The dashboard's **Health** page lists
  them and can create, download, **import** (upload a `.db` from elsewhere, with
  validation), and **restore** one — restore snapshots the current database
  first, then swaps the file and restarts the bot on the restored data. A WAL
  checkpoint runs alongside each backup and on shutdown so the `-wal` sidecar
  stays small.
- **YouTube alerts** — announce a channel's new uploads and when it goes live.
  Add channels by URL or `@handle` (resolved on save); new videos come from
  YouTube's public feed and live status from a light page check — no API key
  needed. Per-channel Discord channel, ping role and custom messages.
- **Twitch alerts** — announce in a channel when a streamer goes live. Add
  streamers on the dashboard (channel + optional ping role + custom message with
  `{name}`/`{title}`/`{game}`/`{url}` placeholders); Sylo polls the Twitch API
  ~once a minute. Needs a free `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`.
- **Kick alerts** — the same "go live" notification for [Kick.com](https://kick.com)
  streamers (channel + optional ping role + `{name}`/`{title}`/`{game}`/`{url}`/`{viewers}`
  message). Sylo polls the official Kick API ~once a minute; needs a free
  `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` (kick.com/settings/developer).
- **Polls** — members run `/poll question:… choices:A | B | C` (optional
  `duration`, `multiple`, `max_votes`); people vote by reacting with the option
  letter. Auto-closes on its timer or vote cap, posts a results embed with a
  bar chart, and `/poll-end` closes one early. Optional allow/deny role list for
  who may vote — disallowed reactions are removed.
- **Invite tracker** — credits the member whose invite link each new joiner used,
  keeps a per-member tally (joined / left / bonus), and ranks everyone.
  `/invites` (your count + a personal link), `/inviter`, `/invites-leaderboard`;
  optional join/leave log channel; a fake-invite grace window so a quick leave
  removes the credit. Needs the **Manage Server** permission.
- **Custom commands, rebuilt MEE6-style** — each command is now a `/slash`
  command that runs an ordered list of actions: reply in the channel (text /
  embed, optionally private, or a random pick from several messages), post to
  another channel, or add / remove a role. Per-command role and channel
  restrictions and a cooldown. Existing text/embed commands migrate automatically
  (they become a single reply action); the chat-prefix trigger is retired.
- **Starboard** — react to a message enough times and Sylo re-posts it into a
  highlights channel. MEE6-style per-server boards: pick the emoji(s) and
  threshold, auto-react on the post, remove it if it drops back below the bar or
  the original is deleted, ignore self-stars and bot messages, and restrict which
  roles' reactions count and which channels a board watches.
- **MEE6-style dashboard redesign** — a fixed left sidebar with a server switcher
  and collapsible plugin categories; the dashboard is a plugin grid; a
  **Bot Personalizer** (username / avatar / banner / presence), a per-server
  **Settings** page (bot-master roles, mod-log channel, embed colour, backup), a
  **Leaderboard** page, and a tabbed **Moderator** page (automod, warning
  auto-actions, infractions, immunity roles, audit logging, command
  permissions). Welcome Channel and Reaction Roles get a WYSIWYG embed editor.
- **Eight more modules**: Verification (button or Cloudflare Turnstile captcha),
  Autoresponder, AFK, Server statistics (live count voice channels), Free games
  (Epic + IsThereAnyDeal), Ban appeals (DM'd appeal link → dashboard review →
  decision shown on the link, with a single-use rejoin invite on accept),
  Temporary voice channels (MEE6-style hubs + 13 /voice-* control commands),
  and Welcome Channel (a builder for one pinned message in a read-only channel)
  — all functional and configurable from the dashboard (26 in total)
- Editable Discord **presence / activity** from the dashboard (`/settings`)
- 2.0 groundwork still current: action-based custom `/slash` commands,
  scheduled messages, full leveling with a public leaderboard, auto-moderation,
  the Counting mini-game, a YAGPDB-style combined overview and a topbar server
  switcher; `/forget` + guild-leave data purge; per-server **audit log** and
  JSON **config export**; CI test gate before any image publish; rate-limited
  public/auth routes; a database integrity check on boot

## Features

- **Discord bot** (discord.js v14, slash commands)
  - `/help` — command overview + a link to the dashboard
  - `/ping` — health check with gateway + round-trip latency
  - `/version` — the release this instance is running · `/about` — version,
    uptime and runtime info
  - `/rank` · `/leaderboard` — leveling progress (when the module is enabled)
  - `/forget` — delete the data Sylo stores about you in the current server
  - `/stats battlefield <title> <username> <platform>` — player stats as an embed
    (K/D, win rate, time played, KPM/SPM, best class, …)
  - Friendly, non-crashing error handling (unknown player, API down, rate-limited)
- **Moderation** — `/kick`, `/ban`, `/unban`, `/timeout`, `/untimeout`, `/purge`,
  `/slowmode`, `/warn` (add/list/remove/clear), and `/modlog` to send every action
  to a log channel. Role-hierarchy and permission checks, optional DM to the
  target, and per-command default permissions so Discord hides them from
  non-moderators.
- **Extensible game adapters** — one file per game, registered in a central
  registry. Adding a game does not touch bot or web code.
- **Per-guild modules** — 26 feature groups, each toggled and configured from the
  dashboard:
  - **Moderation** — warning thresholds that auto-timeout/kick/ban, one-click unban
  - **Server logging** — member / message / role / channel events to a log channel
  - **Reaction roles & autoroles** — dashboard-built reaction-role embeds; roles on join
  - **Verification** — gate new members behind a Verify button, or a Cloudflare
    Turnstile captcha on the dashboard, before granting a role; optional
    auto-kick of unverified members
  - **Welcome & leave** — join/leave messages with placeholders, optional DM,
    plus a shared "give roles to new members" picker
  - **Welcome channel** — a MEE6-style builder for one rich, pinned message in a
    dedicated read-only channel (welcome / rules / links / banner elements, live
    preview); can create the `#welcome` channel for you and publish/update it
  - **Sticky messages** — keep a message pinned to the bottom of a channel
  - **Tickets (modmail)** — members DM the bot; staff read and reply from the
    dashboard (replies arrive as an anonymous "Staff" DM)
  - **Moderator** — a tabbed page consolidating **Auto-moderation** (bad words,
    repeated text, invites, links, caps, emojis, spoilers, mentions, zalgo,
    anti-spam — each Disabled / Delete / Delete + Warn / Delete + Timeout), with
    an optional **push to Discord's native AutoMod** for the mappable checks
    (bad words, mentions, anti-spam) plus Discord's profanity / sexual-content /
    slurs preset lists — reconciled as `Sylo:`-named rules, needs Manage Server,
    **auto-actions** (warning-count thresholds → timeout/kick/ban), **infractions**
    (warnings + ban manager), **immunity roles** (skip automod + auto-actions),
    **audit logging** (server events → a channel), and per-command permissions
  - **Counting** — members count upward one number per message in a chosen channel;
    correct or reset the running number from the dashboard
  - **Custom commands** — MEE6-style `/slash` commands built from an ordered list
    of actions: reply in the channel (text and/or embed, optionally private, or a
    random pick from several messages), post a message to another channel, or add
    / remove a role. Per-command role/channel restrictions and cooldown; synced
    to Discord on save
  - **Invite tracker** — attributes each new member to the invite link they used
    and ranks inviters. `/invites` gives a member a personal invite link plus
    their count, `/inviter` looks up who invited someone, `/invites-leaderboard`
    ranks the server. Optional join/leave log channel and a fake-invite grace
    window (a join that leaves inside it doesn't count). Needs Manage Server
  - **Polls** — `/poll question:… choices:A | B | C` with optional `duration`,
    `multiple` and `max_votes`; members vote by reacting with the option letter.
    Auto-closes on the timer or vote cap and posts a bar-chart results embed;
    `/poll-end` closes one early. Optional allow/deny role list for voters
  - **Twitch alerts** — post a "go live" notification to a channel when a Twitch
    streamer starts streaming. Per-streamer channel, optional ping role and a
    custom message (`{name}` `{title}` `{game}` `{url}` `{viewers}`). Polls the
    Twitch Helix API ~once a minute; needs `TWITCH_CLIENT_ID` /
    `TWITCH_CLIENT_SECRET` (free app at dev.twitch.tv)
  - **YouTube alerts** — announce a channel's new uploads and/or "went live" in a
    Discord channel. Add channels by URL or `@handle` (Sylo resolves them on
    save); new videos read from YouTube's public Atom feed, live status from a
    light `/live` page check — no API key. Per-channel ping role and custom
    messages (`{name}` `{title}` `{url}`); polled every ~3 minutes
  - **Kick alerts** — post a "go live" notification when a Kick.com streamer
    starts. Per-streamer channel, optional ping role and a custom message
    (`{name}` `{title}` `{game}` `{url}` `{viewers}`). Polls the official Kick API
    ~once a minute; needs `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` (free app at
    kick.com/settings/developer)
  - **Autoresponder** — auto-reply when a message matches a trigger (contains /
    exact / starts-with / whole-word), optionally deleting the trigger
  - **Scheduled messages** — recurring posts to a channel, every minute to every
    4 weeks, with pause/resume
  - **Leveling** — 15–25 XP per message on a MEE6-style curve, level-up
    announcements, per-level role rewards, `/rank` and `/leaderboard`
  - **AFK** — `/afk [reason]`; Sylo replies to anyone who mentions an away
    member and clears the status when they next speak
  - **Server statistics** — keep chosen voice channels named with a live
    member / role / boost count, on a configurable 5–60 minute refresh
  - **Free games** — announces games that become free to claim (hourly poll):
    the Epic Games Store, plus Steam / GOG / Fanatical / Humble and more with an
    `ITAD_API_KEY`. Optional ping role; `/freegames [dlc]` on demand
  - **Ban appeals** — banned members are DM'd a signed link to an appeal form
    (sent *before* the ban lands, since a bot can't DM a user it no longer shares
    a server with). Staff accept (auto-unban + single-use rejoin invite) or deny
    with a reason from the Appeals tab. The decision, reason and rejoin invite are
    always shown on the same link when the user reopens it, so notification never
    depends on the DM. Configurable questions, post-denial cooldown, and an
    optional "appeals server" invite so Sylo can DM the outcome too; needs
    `DASHBOARD_URL` set
  - **Temporary voice channels** — MEE6-style hubs: a member joins a "join to
    create" voice channel and Sylo spawns their own VC (name template with
    `{index}`/`{username}`, user limit, bitrate, keep-alive delay, ownership
    lock, permission sync, role allow/deny + moderator/ignored roles, owner
    permissions, an optional paired text channel). Owners and voice moderators
    control it with 13 `/voice-*` commands (lock/unlock, hide/reveal, limit,
    rename, kick, ban/unban, claim/transfer, owner, clean). Multiple hubs;
    survives a restart via a sweep
  - **Starboard** — when a message gets enough of a chosen reaction, Sylo re-posts
    it (as an embed with a jump link) into a highlights channel and keeps the
    count live. Per-server boards: custom emoji(s) and threshold, auto-react on
    the post, remove-below-threshold and remove-on-delete, self-star and bot
    filtering, message-age limits, and role / channel restrictions
- **Command management** — disable a command per server or restrict it to
  channels / roles (admins bypass).
- **Operations** — per-server config **audit log** and JSON **config export**,
  `/forget` self-service data deletion, automatic data purge on guild removal,
  a database integrity check at startup, and rate-limited public / auth routes.
- **Web dashboard** (Express + EJS, server-rendered) — **htmx 2** and
  **Alpine.js 3** are vendored as static files under `src/web/public/vendor/`
  (pinned, no CDN, no build step). Settings saves swap a page fragment in place
  with a toast; every route keeps a no-JS fallback (full render + redirect). The
  builders (embed editor, reaction roles, custom commands, welcome channel, …)
  are Alpine components. The public pages below stay framework-free.
  - `GET /health` — JSON status (uptime, guild count, gateway-ping history,
    per-scope error counts, command counts) for healthchecks
  - `GET /metrics` — Prometheus text exposition (uptime, guilds, gateway ping,
    per-command / per-scope counters, module adoption), unauthenticated like
    `/health`; scrape it from your LAN or your own proxy
  - `/` — bot status, activity stats and module adoption; sidebar server switcher
  - `/stats` — cached lookups · `/health` — status page (JSON for monitors)
  - `/settings` — **Bot Personalizer**: bot username / avatar / banner + presence
  - `/guilds/<id>` — per-server control panel: a MEE6-style plugin grid, a
    **Leaderboard** page, **Settings** (bot-master roles, mod-log channel, embed
    colour, backup), Commands, Moderator (auto-mod + warnings/bans), Tickets,
    Ban appeals, Embed messages, an audit log, and a settings panel per module
  - **public, zero-JS pages** — the shareable leaderboard (`/leaderboard/:id`,
    `/lb/:slug`), member verification (`/verify`) and ban-appeal forms (`/appeal`)
  - **Discord OAuth2 login** (optional) — gate the dashboard to server admins
    (and configurable staff roles for tickets); runs open on a trusted LAN when
    unconfigured. See *Dashboard authentication*.
- **SQLite persistence** (`better-sqlite3`) — guild settings, module config,
  warnings, tickets and a TTL stats cache, in a single volume-mounted file.
- **Lean Docker image** — multi-stage `node:22-alpine`, non-root, `HEALTHCHECK`.
  Ships prebuilt native modules (`better-sqlite3`, `@napi-rs/canvas` for the rank
  card) and the DejaVu fonts the card needs.

## Project structure

```
src/
  index.js              Entrypoint — boots DB, bot, and web in one process
  config.js             Loads/validates env vars
  runtime.js            Shared in-memory state (uptime, last error, client)
  bot/
    index.js            Discord client bootstrap (intents, partials)
    loadCommands.js / registerCommands.js
    commands/           help, ping, about, version, stats, rank, leaderboard, forget,
                        afk, freegames, kick/ban/unban/timeout/untimeout/purge/slowmode/warn/modlog
    events/             ready, interactionCreate, moduleEvents (gateway → modules),
                        dmTickets (DM → ticket), guildDelete (purge on leave)
    embeds/ lib/        embed builders; duration, moderation, modlog, custom-command sync
  modules/
    registry.js         module catalogue (id, intents, defaults)
    dispatch.js         fans gateway events out to enabled modules
    index.js            loads module implementations
    moderation automod logging tickets roles welcome welcomeChannel sticky
    counting customCommands autoresponder verification scheduledMessages
    leveling afk serverStats freeGames appeals tempVoice polls giveaways
    starboard inviteTracker twitchAlerts youtubeAlerts kickAlerts messageCreator
  adapters/games/       gameAdapter, registry, battlefield
  db/
    index.js            SQLite connection + migrations
    cache guildSettings modules commandOverrides warnings tickets audit
    composedMessages counting scheduledMessages leveling appeals tempVoice
    polls giveaways starboard inviteTracker twitchAlerts youtubeAlerts
    leaderboardVanity backup exportConfig purge
  web/
    server.js           Express app (createApp() is exported for tests)
    routes/             health, dashboard, commands, stats, settings, guilds,
                        guildTickets, guildMessages,
                        verify + appeal + leaderboard (public, framework-free)
    middleware/         auth (OAuth2), csrf, rateLimit, ticketAccess
    lib/                guildContext, sidebarNav, moduleIcons, overviewSummary, …
    views/              EJS templates; guild.ejs + guild/_*.ejs fragment partials
    public/             styles.css, app.js (CSRF + confirm), htmx-setup.js,
                        alpine-components.js, vendor/{htmx,alpine}.min.js
scripts/register-commands.js
test/                   node --test; unit tests + dashboardRoutes.test.js (HTTP)
data/                   SQLite file lives here (git-ignored, volume-mounted)
```

## Local setup

Requires **Node.js 22+** and a Discord application with a bot.

```bash
git clone <this repo>
cd Sylo
npm install
cp .env.example .env     # then edit .env (see docs/self-hosting.md)
npm test                 # optional: run the adapter test suite
npm start
```

For fast iteration, set `DISCORD_DEV_GUILD_IDS` in `.env` to a test server's ID —
commands then register instantly instead of taking up to ~1 hour globally. Pass
several ids comma-separated (`DISCORD_DEV_GUILD_IDS=id1,id2`) to cover more than one
test server. `npm run register` re-syncs commands without a restart.

## Self-hosting

The full guide — every environment variable, Discord application setup, running
behind a reverse proxy, Docker, Unraid, backups, upgrades and rollback, and a
troubleshooting table — is in **[docs/self-hosting.md](docs/self-hosting.md)**.

Only two variables are required:

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token (Developer Portal → Bot → Reset Token) |
| `DISCORD_CLIENT_ID` | Application ID (Developer Portal → General Information) |

The dashboard runs **open** (no login) until you set `DISCORD_CLIENT_SECRET` —
only expose it beyond `localhost` / a trusted LAN after you do. Both privileged
gateway intents default on; disable the ones you don't need with
`INTENT_GUILD_MEMBERS=false` / `INTENT_MESSAGE_CONTENT=false`.

### Docker

```bash
cp .env.example .env      # DISCORD_TOKEN + DISCORD_CLIENT_ID
docker compose up -d --build
```

Or a prebuilt multi-arch image (`linux/amd64` + `linux/arm64`):

| Tag | What it is |
| --- | --- |
| `iwgamin/sylo:latest`, `:X.Y.Z`, `:X.Y` ([Docker Hub](https://hub.docker.com/r/iwgamin/sylo) · [GHCR](https://github.com/Ferdinand99/Sylo/pkgs/container/sylo)) | Stable releases. What the Unraid template pulls. |
| `ghcr.io/ferdinand99/sylo:main`, `:sha-<short>` (GHCR) | Rolling build of `main`. |

### Unraid

Sylo is in **Community Applications** — search "Sylo". Put the data directory on
a real local disk (e.g. `/mnt/cache/appdata/sylo`), **not** `/mnt/user` — SQLite
in WAL mode needs working file locks. See
[docs/self-hosting.md](docs/self-hosting.md#unraid) for the container fields and
[the SQLite-on-a-network-mount note](docs/self-hosting.md#sqlite-on-a-network-mount).

## Releases & CI

Three GitHub Actions workflows drive the images. `test.yml` runs the suite
(`npm test` + syntax + template compile) and is a required dependency of every
image build — nothing publishes on a red suite.

| Workflow | Trigger | Publishes |
|---|---|---|
| `.github/workflows/test.yml` | called by the two below | — (gate only) |
| `.github/workflows/docker-publish.yml` | every push to `main` (PRs build only) | GHCR `:main`, `:sha-<short>` — rolling dev image |
| `.github/workflows/release-please.yml` | merging a **release PR** | Docker Hub **and** GHCR `:latest`, `:X.Y.Z`, `:X.Y` — stable release |

**Cutting a release** is automated with
[release-please](https://github.com/googleapis/release-please):

1. Land changes on `main` using [Conventional Commits](https://www.conventionalcommits.org)
   (`feat: …`, `fix: …`, `refactor: …`, `chore: …`, `feat!: …`/`BREAKING CHANGE:`
   for a major bump).
2. release-please keeps a PR titled *"chore(main): release X.Y.Z"* open,
   accumulating a changelog. When you're ready, **merge it**.
3. Merging tags the commit `vX.Y.Z`, creates the GitHub Release with notes,
   bumps `package.json` + `CHANGELOG.md`, then builds and pushes the versioned
   images — including `:latest`, which is what the Unraid template tracks.

`docker-publish.yml` needs no secrets (built-in `GITHUB_TOKEN`). `release-please.yml`
also pushes to Docker Hub, so it needs a repo **variable** `DOCKERHUB_USERNAME`
(e.g. `iwgamin`) and a repo **secret** `DOCKERHUB_TOKEN` (a Docker Hub personal
access token with Read & Write). Set both under Settings → Secrets and variables →
Actions. Note that a tag/Release created by CI does **not** trigger other
workflows, which is why `release-please.yml` builds the image itself rather than
relying on the tag trigger.

For a clean starting point, tag the current commit once so release-please has a
baseline: `git tag v1.0.0 && git push origin v1.0.0`
(keep `.release-please-manifest.json` at `1.0.0`).

Unraid users who want the bleeding edge can point the container at
`ghcr.io/ferdinand99/sylo:main` (dev images are GHCR-only) instead of `:latest`;
pin to `:X.Y.Z` on either registry to freeze a version.

## Adding another game

1. Create `src/adapters/games/<game>.js` exporting an adapter with
   `id`, `titles()`, `platformsFor(title)`, and
   `getPlayerStats(username, platform, { title })` — throw the typed errors from
   `gameAdapter.js` for failure cases.
2. Register it in `src/adapters/games/index.js` (one `import` + `register(...)`).
3. Add a subcommand to `src/bot/commands/stats.js`. The shared
   `runStatsLookup()` helper and the cache layer need no changes.

## Tests

```bash
npm test
```

Runs the `node:test` suite — module normalisers and helpers, the CSRF
middleware, and `dashboardRoutes.test.js`, which boots `createApp()` over HTTP to
assert the htmx fragment contract. No network: `fetch` is stubbed where adapters
need it, and DB tests write to a throwaway SQLite file.

## Legal

For the instances operated by Ferdinand99 (the public **Sylo** and **Sylo -
Test** Discord applications):

- [Terms of Service](docs/terms-of-service.md)
- [Privacy Policy](docs/privacy-policy.md)

Self-hosted instances are run by their own operators; adjust these documents if
you publish your own.

## License

MIT © Ferdinand99
