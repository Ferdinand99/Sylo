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
- **Extensible game adapters** — one file per game, registered in a central
  registry. Adding a game does not touch bot or web code.
- **Web dashboard** (Express + EJS, no frontend framework)
  - `GET /health` — JSON status (uptime, guild count, last error) for healthchecks
  - `/` — bot online/offline, server list, recently queried stats
  - `/commands` — list of the slash commands the bot currently has loaded
  - `/stats` — browse cached lookups
- **SQLite persistence** (`better-sqlite3`) — guild settings + a TTL stats cache,
  stored in a single file so it lives on a mounted volume.
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
    commands/           ping.js, stats.js
    events/             ready.js, interactionCreate.js
    embeds/             battlefieldStats.js
  adapters/games/
    gameAdapter.js      Shared interface + typed errors
    registry.js         id -> adapter map
    index.js            Registers all adapters
    battlefield.js      gametools.network implementation
  db/
    index.js            SQLite connection + migrations
    cache.js            TTL stats cache
  web/
    server.js           Express app
    routes/             health.js, dashboard.js, commands.js, stats.js
    middleware/auth.js  No-op requireAdmin (OAuth2-ready)
    views/ public/      EJS templates + styles.css
scripts/register-commands.js
test/battlefield.adapter.test.js
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
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`,
   bot permission **Send Messages** (and **Embed Links**). Open the generated
   URL to invite the bot.

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

A Community Applications template (`unraid/sylo.xml`) can be added later; it is
not required to run the container.

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
