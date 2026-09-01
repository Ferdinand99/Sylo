# Sylo

Multi-function Discord bot with a server-management **web dashboard**, packaged
for self-hosting on an **Unraid server via Docker**. Twenty-four per-guild modules
(moderation, logging, tickets, reaction roles, verification, welcome, welcome
channel, sticky messages, auto-moderation, counting, custom commands,
autoresponder, scheduled messages, leveling, AFK, server statistics, free games,
ban appeals, temporary voice channels, starboard, invite tracker, polls, Twitch
alerts, YouTube alerts), Discord OAuth2 login, a public leveling leaderboard, and
**Battlefield-series** player stats via the public
[gametools.network](https://gametools.network) API.

## What's new since 2.0

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
  — all functional and configurable from the dashboard (24 in total)
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
- **Per-guild modules** — 24 feature groups, each toggled and configured from the
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
    anti-spam — each Disabled / Delete / Delete + Warn / Delete + Timeout),
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
- **Web dashboard** (Express + EJS, no frontend framework)
  - `GET /health` — JSON status (uptime, guild count, last error) for healthchecks
  - `/` — bot status, activity stats and module adoption; topbar server switcher
  - `/stats` — cached lookups · `/health` — status page (JSON for monitors)
  - `/settings` — **Bot Personalizer**: bot username / avatar / banner + presence
  - `/guilds/<id>` — per-server control panel: a MEE6-style plugin grid, a
    **Leaderboard** page, **Settings** (bot-master roles, mod-log channel, embed
    colour, backup), Commands, Moderation (warnings + bans), Tickets, Ban appeals,
    Message Creator, an audit log, and a settings panel per module
  - **Discord OAuth2 login** (optional) — gate the dashboard to server admins
    (and configurable staff roles for tickets); runs open on a trusted LAN when
    unconfigured. See *Dashboard authentication*.
- **SQLite persistence** (`better-sqlite3`) — guild settings, module config,
  warnings, tickets and a TTL stats cache, in a single volume-mounted file.
- **Lean Docker image** — multi-stage `node:20-alpine`, non-root, `HEALTHCHECK`.

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
    moderation.js logging.js tickets.js roles.js welcome.js sticky.js
    counting.js automod.js customCommands.js autoresponder.js verification.js
    scheduledMessages.js leveling.js afk.js serverStats.js freeGames.js appeals.js
    tempVoice.js
  adapters/games/       gameAdapter, registry, battlefield
  db/
    index.js            SQLite connection + migrations
    cache guildSettings modules commandOverrides warnings tickets
    composedMessages counting scheduledMessages leveling appeals tempVoice
  web/
    server.js           Express app
    routes/             health, dashboard, commands, stats, guilds, guildTickets,
                        verify + appeal (public), leaderboard (public)
    middleware/         auth (OAuth2), ticketAccess
    lib/ views/ public/ helpers; EJS templates; styles.css, app.js
scripts/register-commands.js
test/                   battlefield.adapter.test.js, duration.test.js
data/                   SQLite file lives here (git-ignored, volume-mounted)
```

## Local setup

Requires **Node.js 20+** and a Discord application with a bot.

```bash
git clone <this repo>
cd Sylo
npm install
cp .env.example .env     # then edit .env (see below)
npm test                 # optional: run the adapter test suite
npm start
```

For fast iteration, set `DISCORD_GUILD_ID` in `.env` to a test server's ID —
commands then register instantly instead of taking up to ~1 hour globally. Pass
several ids comma-separated (`DISCORD_GUILD_ID=id1,id2`) to cover more than one
test server. `npm run register` re-syncs commands without a restart.

### Environment variables

| Variable                  | Required | Default                        | Description |
|---------------------------|:--------:|--------------------------------|-------------|
| `DISCORD_TOKEN`           | yes      | —                              | Bot token |
| `DISCORD_CLIENT_ID`       | yes      | —                              | Application (client) ID |
| `DISCORD_GUILD_ID`        | no       | —                              | Register commands instantly to one guild, or several (comma-separated), instead of globally |
| `WEB_PORT`                | no       | `3000`                         | Dashboard HTTP port |
| `DISCORD_CLIENT_SECRET`   | no       | —                              | Set to require "Log in with Discord" on the dashboard (see below) |
| `SESSION_SECRET`          | no       | random                         | Signs the session cookie; pin it so logins survive restarts |
| `DASHBOARD_URL`           | no       | derived                        | Public dashboard URL; needed behind a reverse proxy and for verification-captcha / ban-appeal links |
| `TURNSTILE_SITE_KEY`      | no       | —                              | Cloudflare Turnstile site key — enables the Verification captcha mode |
| `TURNSTILE_SECRET_KEY`    | no       | —                              | Cloudflare Turnstile secret key (pair with the site key) |
| `ITAD_API_KEY`            | no       | —                              | IsThereAnyDeal key — adds non-Epic stores to the Free games module |
| `INTENT_GUILD_MEMBERS`    | no       | `true`                         | Request the Server Members privileged intent |
| `INTENT_MESSAGE_CONTENT`  | no       | `true`                         | Request the Message Content privileged intent |
| `GAMETOOLS_API_BASE`      | no       | `https://api.gametools.network`| Stats API base URL |
| `STATS_CACHE_TTL_MINUTES` | no       | `5`                            | How long stats lookups are cached |
| `DATABASE_PATH`           | no       | `./data/sylo.db`               | SQLite file path |
| `BACKUP_INTERVAL_HOURS`   | no       | `24`                           | Scheduled DB snapshot interval; `0` disables it (pre-migration + manual still run) |
| `BACKUP_RETENTION`        | no       | `14`                           | How many DB snapshots to keep in `<data>/backups` |
| `BACKUP_DIR`              | no       | `<db dir>/backups`             | Where DB snapshots are written |
| `NODE_ENV`                | no       | `development`                  | Set to `production` in deployment |

### Dashboard authentication

By default the dashboard runs **open** (no login) — only safe on `localhost` or a
trusted LAN. To lock it down:

1. Discord Developer Portal → your app → **OAuth2** → copy the **Client Secret**
   into `DISCORD_CLIENT_SECRET`.
2. Same page → **Redirects** → add `http://<host>:<WEB_PORT>/auth/discord/callback`
   (e.g. `http://192.168.1.10:3000/auth/discord/callback`). Behind a reverse proxy, use
   the public URL and set `DASHBOARD_URL` to match.
3. Set a long random `SESSION_SECRET` so sessions survive restarts.

With `DISCORD_CLIENT_SECRET` set, every page except the `/health` JSON requires
"Log in with Discord", and per-server pages require **Manage Server** (or
Administrator / owner) in that server — or one of the **bot-master roles** set on
that server's *Settings* page. `/health` returns JSON publicly for the container
healthcheck (browsers get the status page, gated by login).

## Discord application setup

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy into `DISCORD_TOKEN`. Under *Privileged
   Gateway Intents* enable **Server Members** and **Message Content** if you want
   the member/message-driven modules (logging, welcome, autoroles, leveling,
   auto-moderation, counting); a verified bot may need Discord's
   approval for Message Content.
   Otherwise set `INTENT_GUILD_MEMBERS=false` / `INTENT_MESSAGE_CONTENT=false`.
3. **General Information** → copy **Application ID** into `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`. Bot
   permissions:
   - **Send Messages**, **Embed Links** — always
   - **Kick Members**, **Ban Members**, **Moderate Members**, **Manage Messages**,
     **Manage Channels** — moderation
   - **Manage Roles** — reaction roles / autoroles
   - **Manage Channels** + **Move Members** — temporary voice channels

   Open the generated URL to invite the bot. Tickets (modmail) need no extra
   permission — just leave the bot able to receive DMs.
5. For moderation to work, drag **Sylo's role above the roles of the members it
   should manage** in *Server Settings → Roles*. The bot can never kick/ban/timeout
   someone whose highest role sits above its own.

## Docker

```bash
cp .env.example .env     # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
docker compose up -d --build
docker compose logs -f sylo
```

The dashboard is then on `http://<host>:${WEB_PORT:-3000}`. The SQLite database
persists in `./data` on the host.

> If `better-sqlite3` ever fails to build on Alpine for your platform, change the
> two `FROM node:20-alpine` lines in the `Dockerfile` to `node:20-slim`.

### Backups

All state is in the single SQLite file under the mounted data directory
(`./data/sylo.db`, plus `-wal` / `-shm` sidecars).

**Automatic snapshots.** Sylo writes compacted copies of the database to
`data/backups/` — one right before any schema migration, one shortly after
start, and one every `BACKUP_INTERVAL_HOURS` (default 24), keeping the newest
`BACKUP_RETENTION` (default 14). Set `BACKUP_INTERVAL_HOURS=0` to keep only the
pre-migration and manual snapshots.

**From the Health page** you can:

- see every snapshot with its size and age;
- **Create backup now**, or **Import .db file…** to upload one from another
  machine (it is validated — SQLite header, `integrity_check`, and a schema no
  newer than this build — then stored as a snapshot);
- **download** any snapshot;
- **Restore** from any snapshot: Sylo takes a `prerestore` snapshot of the
  current database, swaps the file, and exits so the container restarts on the
  restored data (needs a restart policy — `unless-stopped` in the bundled
  compose file / Unraid template). The page waits for the bot and returns.

Manual restore still works too: stop the container, copy a snapshot over
`data/sylo.db` (delete the `-wal` / `-shm` sidecars first), and start again.
Migrations only ever move the schema forward, and Sylo runs a `quick_check` on
boot and logs if the file is corrupt.

Each server's module configuration can also be exported as JSON from
**General → Backup** in the dashboard.

## Unraid deployment

**Option A — docker compose** (via the *Compose Manager* plugin): copy the repo
to `/mnt/user/appdata/sylo`, add your `.env`, and `docker compose up -d`.

**Option B — Docker tab → Add Container** (manual):

| Field            | Value |
|------------------|-------|
| Name             | `Sylo` |
| Repository       | `docker.io/iwgamin/sylo:latest` (or `ghcr.io/ferdinand99/sylo:latest`) |
| Network Type     | `bridge` |
| Port             | Container `3000` → Host `3000` (`WEB_PORT`) |
| Path             | Container `/app/data` → Host `/mnt/user/appdata/sylo/data` (read/write) |
| Variable         | `DISCORD_TOKEN` = *your token* |
| Variable         | `DISCORD_CLIENT_ID` = *your client id* |
| Variable         | `NODE_ENV` = `production` |
| Variable (opt.)  | `STATS_CACHE_TTL_MINUTES` = `5` |

The image's `HEALTHCHECK` hits `/health`, so Unraid shows the container health
once it is up. To build the image on the Unraid box itself:
`docker build -t sylo:latest /mnt/user/appdata/sylo`.

The image starts as root only long enough for its entrypoint to fix ownership of
the mounted data directory, then runs the Node process as an unprivileged user
(`sylo`, uid 100). So a fresh, root-owned `appdata` folder works out of the box —
no manual `chmod`/`chown` needed. If you still see `SQLITE_CANTOPEN`, run once:
`chown -R 100:101 /mnt/user/appdata/sylo/data`.

### Option C — Unraid Community Applications template

`unraid/sylo.xml` is a ready-made CA template with all ports, paths, and
environment variables pre-defined. It needs a **published image** first:

1. **Publish the image.** CI does this automatically on every release (see
   [Releases & CI](#releases--ci) below), pushing to both
   `docker.io/iwgamin/sylo` and `ghcr.io/ferdinand99/sylo`. The Docker Hub repo
   is public; the GHCR package's visibility is set once under GitHub → your
   profile → Packages → `sylo` → Package settings. To publish once by hand:
   ```bash
   docker login -u iwgamin                 # Docker Hub personal access token
   docker build -t iwgamin/sylo:latest .
   docker push iwgamin/sylo:latest
   ```
2. **Add a 256×256 icon** at `unraid/sylo-icon.png` (the template references it).
3. **Use the template** on Unraid — either:
   - *Docker tab → Add Container → Template:* paste the raw URL
     `https://raw.githubusercontent.com/Ferdinand99/Sylo/main/unraid/sylo.xml`, or
   - drop the file in `/boot/config/plugins/dockerMan/templates-user/` and pick
     `Sylo` from the **User templates** dropdown.
4. **To list it in the public CA store**, use the submission portal at
   [ca.unraid.net/submit](https://ca.unraid.net/submit): sign in with GitHub,
   point it at this repo, then run **Validate** → **Scan** → **Submit** for
   moderator review. Requirements: a public repo with an OSI license (MIT, at
   the root ✓), a root `ca_profile.xml` with a filled `<Profile>` (✓), and a
   template XML with `<Repository>`, `<Registry>`, `<Overview>`, `<Support>`,
   `<Project>`, `<Icon>` and `<TemplateURL>` (all in `unraid/sylo.xml`). Once
   accepted, template edits pushed to `main` propagate automatically via
   `<TemplateURL>`.

Edit `Repository`, `Support`, `Project`, `TemplateURL`, and `Icon` in the XML
(and the URLs in `ca_profile.xml`) if your GitHub username or repo name differ.

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

Runs the `node:test` suite for the Battlefield adapter (parsing + error
handling, `fetch` stubbed — no network).

## Legal

For the instances operated by Ferdinand99 (the public **Sylo** and **Sylo -
Test** Discord applications):

- [Terms of Service](docs/terms-of-service.md)
- [Privacy Policy](docs/privacy-policy.md)

Self-hosted instances are run by their own operators; adjust these documents if
you publish your own.

## License

MIT © Ferdinand99
