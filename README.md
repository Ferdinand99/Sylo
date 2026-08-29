# Sylo

Multi-function Discord bot with a web dashboard and an extensible game-stats
module. v1 ships **Battlefield-series** player stats (via the public
[gametools.network](https://gametools.network) API) and is packaged for
self-hosting on an **Unraid server via Docker**.

## Features

- **Discord bot** (discord.js v14, slash commands)
  - `/ping` — health check with gateway + round-trip latency
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
- **Web dashboard** (Express + EJS, no frontend framework)
  - `GET /health` — JSON status (uptime, guild count, last error) for healthchecks
  - `/` — bot online/offline, server list, recently queried stats
  - `/commands` — list of the slash commands the bot currently has loaded
  - `/stats` — browse cached lookups
  - `/guilds/<id>` — per-server page: set the **mod-log channel**, **add** and
    browse **warnings** (DMs the user + posts to the mod-log, attributed to
    "Dashboard"), and list **bans**
  - ⚠️ **No authentication yet.** The dashboard can change settings and shows
    ban lists — keep it on `localhost` / a trusted LAN until Discord OAuth2 is
    added (`src/web/middleware/auth.js`).
- **SQLite persistence** (`better-sqlite3`) — guild settings, warnings, and a TTL
  stats cache, stored in a single file so it lives on a mounted volume.
- **Lean Docker image** — multi-stage `node:20-alpine`, non-root, `HEALTHCHECK`.

## Project structure

```
src/
  index.js              Entrypoint — boots DB, bot, and web in one process
  config.js             Loads/validates env vars
  runtime.js            Shared in-memory state (uptime, last error, client)
  bot/
    index.js            Discord client bootstrap
    loadCommands.js     Command loader (shared with the register script)
    registerCommands.js Slash command registration via REST
    commands/           ping.js, stats.js, kick/ban/unban/timeout/untimeout/
                        purge/slowmode/warn/modlog.js
    events/             ready.js, interactionCreate.js
    embeds/             battlefieldStats.js
    lib/                duration.js, moderation.js, modlog.js
  adapters/games/
    gameAdapter.js      Shared interface + typed errors
    registry.js         id -> adapter map
    index.js            Registers all adapters
    battlefield.js      gametools.network implementation
  db/
    index.js            SQLite connection + migrations
    cache.js            TTL stats cache
    guildSettings.js    Per-guild settings (mod-log channel, …)
    warnings.js         Warning records
  web/
    server.js           Express app
    routes/             health.js, dashboard.js, commands.js, stats.js, guilds.js
    middleware/auth.js  No-op requireAdmin (OAuth2-ready)
    lib/                format.js, discord.js, asyncHandler.js
    views/ public/      EJS templates + styles.css
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
| `GAMETOOLS_API_BASE`      | no       | `https://api.gametools.network`| Stats API base URL |
| `STATS_CACHE_TTL_MINUTES` | no       | `5`                            | How long stats lookups are cached |
| `DATABASE_PATH`           | no       | `./data/sylo.db`               | SQLite file path |
| `NODE_ENV`                | no       | `development`                  | Set to `production` in deployment |

## Discord application setup

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy into `DISCORD_TOKEN`. No privileged
   intents are required.
3. **General Information** → copy **Application ID** into `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`. Bot
   permissions:
   - **Send Messages**, **Embed Links** — always
   - **Kick Members**, **Ban Members**, **Moderate Members**, **Manage Messages**,
     **Manage Channels** — for the moderation commands (skip any you don't want)

   Open the generated URL to invite the bot.
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

The container runs as a non-root user (uid 100). If it can't write the database,
make the host data directory writable once:
`chmod -R 0777 /mnt/user/appdata/sylo/data` (or `chown -R 100:101`).

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
4. **To list it in the public CA store**, submit the repo to
   [community-applications](https://github.com/Squidly271/community.applications)
   (the *Add to CA* thread / template-repo process).

Edit `Repository`, `Support`, `Project`, `TemplateURL`, and `Icon` in the XML if
your GitHub username or repo name differ.

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

## License

MIT © Ferdinand99
