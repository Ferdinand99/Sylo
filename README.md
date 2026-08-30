# Sylo

Multi-function Discord bot with a web dashboard and an extensible game-stats
module. v1 ships **Battlefield-series** player stats (via the public
[gametools.network](https://gametools.network) API) and is packaged for
self-hosting on an **Unraid server via Docker**.

## Features

- **Discord bot** (discord.js v14, slash commands)
  - `/ping` — health check with gateway + round-trip latency
  - `/version` — the release this instance is running · `/about` — version,
    uptime and runtime info
  - `/rank` · `/leaderboard` — leveling progress (when the module is enabled)
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
- **Per-guild modules** — 11 feature groups, each toggled and configured from the
  dashboard:
  - **Moderation** — warning thresholds that auto-timeout/kick/ban, one-click unban
  - **Server logging** — member / message / role / channel events to a log channel
  - **Reaction roles & autoroles** — dashboard-built reaction-role embeds; roles on join
  - **Welcome & leave** — join/leave messages with placeholders, optional DM
  - **Sticky messages** — keep a message pinned to the bottom of a channel
  - **Tickets (modmail)** — members DM the bot; staff read and reply from the
    dashboard (replies arrive as an anonymous "Staff" DM)
  - **Auto-moderation** — invite / link / flood / mass-mention / caps / banned-word
    filters, each with a delete / warn / timeout action and channel/role exemptions
  - **Counting** — members count upward one number per message in a chosen channel;
    correct or reset the running number from the dashboard
  - **Custom commands** — text/embed replies triggered by a chat prefix and,
    optionally, as `/name` slash commands synced to Discord
  - **Scheduled messages** — recurring posts to a channel, every minute to every
    4 weeks, with pause/resume
  - **Leveling** — 15–25 XP per message on a MEE6-style curve, level-up
    announcements, per-level role rewards, `/rank` and `/leaderboard`
- **Command management** — disable a command per server or restrict it to
  channels / roles (admins bypass).
- **Web dashboard** (Express + EJS, no frontend framework)
  - `GET /health` — JSON status (uptime, guild count, last error) for healthchecks
  - `/` — bot status, activity stats and module adoption; topbar server switcher
  - `/commands` — slash-command reference · `/stats` — cached lookups
  - `/guilds/<id>` — per-server control panel: a combined overview, General
    settings, Commands, Moderation (warnings + bans), Tickets, Message Creator,
    and a settings panel per module
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
    commands/           ping, stats, kick/ban/unban/timeout/untimeout/
                        purge/slowmode/warn/modlog
    events/             ready, interactionCreate, moduleEvents (gateway → modules),
                        dmTickets (DM → ticket)
    embeds/ lib/        embed builders; duration, moderation, modlog helpers
  modules/
    registry.js         module catalogue (id, intents, defaults)
    dispatch.js         fans gateway events out to enabled modules
    index.js            loads module implementations
    moderation.js logging.js tickets.js roles.js welcome.js sticky.js
    counting.js automod.js customCommands.js scheduledMessages.js leveling.js
  adapters/games/       gameAdapter, registry, battlefield
  db/
    index.js            SQLite connection + migrations
    cache guildSettings modules commandOverrides warnings tickets
    composedMessages counting scheduledMessages leveling
  web/
    server.js           Express app
    routes/             health, dashboard, commands, stats, guilds, guildTickets
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
commands then register instantly instead of taking up to ~1 hour globally.
`npm run register` re-syncs commands without a restart.

### Environment variables

| Variable                  | Required | Default                        | Description |
|---------------------------|:--------:|--------------------------------|-------------|
| `DISCORD_TOKEN`           | yes      | —                              | Bot token |
| `DISCORD_CLIENT_ID`       | yes      | —                              | Application (client) ID |
| `DISCORD_GUILD_ID`        | no       | —                              | Register commands to one guild (dev) instead of globally |
| `WEB_PORT`                | no       | `3000`                         | Dashboard HTTP port |
| `DISCORD_CLIENT_SECRET`   | no       | —                              | Set to require "Log in with Discord" on the dashboard (see below) |
| `SESSION_SECRET`          | no       | random                         | Signs the session cookie; pin it so logins survive restarts |
| `DASHBOARD_URL`           | no       | derived                        | Public dashboard URL; only needed behind a reverse proxy |
| `INTENT_GUILD_MEMBERS`    | no       | `true`                         | Request the Server Members privileged intent |
| `INTENT_MESSAGE_CONTENT`  | no       | `true`                         | Request the Message Content privileged intent |
| `GAMETOOLS_API_BASE`      | no       | `https://api.gametools.network`| Stats API base URL |
| `STATS_CACHE_TTL_MINUTES` | no       | `5`                            | How long stats lookups are cached |
| `DATABASE_PATH`           | no       | `./data/sylo.db`               | SQLite file path |
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

With `DISCORD_CLIENT_SECRET` set, every page except `/health` requires "Log in
with Discord", and per-server pages require **Manage Server** (or Administrator /
owner) in that server. `/health` stays public for the container healthcheck.

## Discord application setup

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy into `DISCORD_TOKEN`. Under *Privileged
   Gateway Intents* enable **Server Members** and **Message Content** if you want
   the member/message-driven modules (logging, welcome, autoroles, leveling,
   auto-moderation, counting, custom commands); a verified bot may need Discord's
   approval for Message Content.
   Otherwise set `INTENT_GUILD_MEMBERS=false` / `INTENT_MESSAGE_CONTENT=false`.
3. **General Information** → copy **Application ID** into `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`. Bot
   permissions:
   - **Send Messages**, **Embed Links** — always
   - **Kick Members**, **Ban Members**, **Moderate Members**, **Manage Messages**,
     **Manage Channels** — moderation
   - **Manage Roles** — reaction roles / autoroles

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

## Unraid deployment

**Option A — docker compose** (via the *Compose Manager* plugin): copy the repo
to `/mnt/user/appdata/sylo`, add your `.env`, and `docker compose up -d`.

**Option B — Docker tab → Add Container** (manual):

| Field            | Value |
|------------------|-------|
| Name             | `Sylo` |
| Repository       | your built/pushed image, e.g. `ghcr.io/ferdinand99/sylo:latest` |
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

1. **Publish the image.** CI does this automatically (see
   [Releases & CI](#releases--ci) below) — push to `main` and, once the package
   exists, set its visibility to **Public** (GitHub → your profile → Packages →
   `sylo` → Package settings). To publish once by hand instead:
   ```bash
   echo $GITHUB_TOKEN | docker login ghcr.io -u Ferdinand99 --password-stdin
   docker build -t ghcr.io/ferdinand99/sylo:latest .
   docker push ghcr.io/ferdinand99/sylo:latest
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

Two GitHub Actions workflows drive the images on GHCR:

| Workflow | Trigger | Publishes |
|---|---|---|
| `.github/workflows/docker-publish.yml` | every push to `main` (PRs build only) | `:main`, `:sha-<short>` — rolling dev image |
| `.github/workflows/release-please.yml` | merging a **release PR** | `:latest`, `:X.Y.Z`, `:X.Y` — stable release |

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

No secrets to configure — both workflows use the built-in `GITHUB_TOKEN`.
Note that a tag/Release created by CI does **not** trigger other workflows, which
is why `release-please.yml` builds the image itself rather than relying on the
tag trigger.

For a clean starting point, tag the current commit once so release-please has a
baseline: `git tag v1.0.0 && git push origin v1.0.0`
(keep `.release-please-manifest.json` at `1.0.0`).

Unraid users who want the bleeding edge can point the container at
`ghcr.io/ferdinand99/sylo:main` instead of `:latest`; pin to `:X.Y.Z` to freeze a
version.

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
