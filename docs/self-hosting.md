# Self-hosting Sylo

Everything needed to run your own instance: install, configuration, a reverse
proxy, upgrades and rollback, and a troubleshooting table. For what each feature
does, see [`docs/modules/`](modules/README.md).

Sylo is a single Node 22 process — the Discord bot and the web dashboard in one.
No build step. All state is one SQLite file under a mounted data directory by
default — that's the right choice for nearly everyone; see
[docs/postgres.md](postgres.md) if you're running at hosted scale and want
the optional Postgres backend instead.

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Discord application setup](#discord-application-setup)
- [Running on Fluxer](fluxer.md) (separate page)
- [Dashboard authentication](#dashboard-authentication)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Docker](#docker)
- [Unraid](#unraid)
- [Backups](#backups)
- [Upgrades and rollback](#upgrades-and-rollback)
- [SQLite on a network mount](#sqlite-on-a-network-mount)
- [Troubleshooting](#troubleshooting)

---

## Quick start

```bash
git clone https://github.com/Ferdinand99/Sylo.git
cd Sylo
npm install
cp .env.example .env        # fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
npm start
```

Or with Docker:

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f sylo
```

The dashboard is then on `http://<host>:${WEB_PORT:-3000}` and the database
persists in `./data`.

For fast iteration set `DISCORD_DEV_GUILD_IDS` to a test server's id — commands
register to it instantly instead of taking up to ~1 hour globally. `npm run
register` re-syncs commands without a restart.

---

## Environment variables

Only `DISCORD_TOKEN` and `DISCORD_CLIENT_ID` are required, unless you run on
[Fluxer](fluxer.md) only: then `FLUXER_TOKEN` and `FLUXER_CLIENT_ID` replace them.
At least one platform must be configured.

| Variable                  | Default                         | Description |
|---------------------------|---------------------------------|-------------|
| `DISCORD_TOKEN`           | —                               | Bot token (**required**) |
| `DISCORD_CLIENT_ID`       | —                               | Application (client) id (**required**) |
| `DISCORD_DEV_GUILD_IDS`   | —                               | Register commands instantly to one or more servers (comma/space-separated) instead of globally. Old name `DISCORD_GUILD_ID` still works (warns). |
| `DISCORD_SHARD_COUNT`     | `auto`                          | Internal gateway shards for this one process. `auto` follows Discord's recommendation and stays at 1 below ~2,500 servers; pin an integer to override. Multi-process sharding is not supported. |
| `FLUXER_TOKEN`            | —                               | Optional: bot token for [Fluxer](fluxer.md). Setting it runs Sylo on Fluxer too (experimental) |
| `FLUXER_CLIENT_ID`        | —                               | Fluxer application id (**required** with `FLUXER_TOKEN`) |
| `FLUXER_WEB_URL`          | hosted Fluxer                   | Web app origin of a self-hosted Fluxer instance, e.g. `https://chat.example.com` |
| `COMMAND_PREFIX`          | `!`                             | Chat prefix for commands on Fluxer, which has no slash commands (1–5 characters) |
| `APPLE_KEY_ID`            | —                               | Optional: App Store Connect API key id for the owner-only [App Store Connect module](modules/apple-connect.md) |
| `APPLE_ISSUER_ID`         | —                               | Issuer id of a team API key (leave unset for an individual key) |
| `APPLE_PRIVATE_KEY`       | —                               | The key's `.p8` file: PEM text, PEM on one line with literal `\n`, or base64 |
| `APPLE_VENDOR_NUMBER`     | —                               | Optional vendor number for a planned daily downloads digest |
| `TRUST_PROXY`             | one private hop with `DASHBOARD_URL` | Which proxies may set `X-Forwarded-For`: `false`, a hop count, or addresses/subnets. See [Behind a reverse proxy](#behind-a-reverse-proxy) |
| `ALLOW_PRIVATE_URLS`      | `false`                         | Let server admins use feed and image URLs on private, loopback or link-local addresses (your own network). Off by default: those URLs are fetched by the server |
| `PUSH_RELAY_URL`          | `https://app.sylobot.com`       | Where this instance sends [Sylo app notifications](mobile-app.md#notifications); empty turns them off |
| `APNS_KEY_ID`             | —                               | Only for the instance that talks to Apple itself (the hosted Sylo): APNs auth key id |
| `APNS_TEAM_ID`            | —                               | The Apple developer team id that owns the key |
| `APNS_PRIVATE_KEY`        | —                               | The APNs key's `.p8` file: PEM text, PEM on one line with literal `\n`, or base64 |
| `APNS_TOPIC`              | `net.opland.sylo`               | The app's bundle id |
| `FLUXER_CLIENT_SECRET`    | —                               | Adds "Log in with Fluxer" to the dashboard |
| `FLUXER_OWNER_IDS`        | —                               | Your Fluxer user id(s); the Fluxer counterpart of `OWNER_IDS` |
| `WEB_PORT`                | `3000`                          | Dashboard HTTP port |
| `DISCORD_CLIENT_SECRET`   | —                               | Set to require "Log in with Discord" on the dashboard |
| `SESSION_SECRET`          | random                          | Signs the session cookie; pin it so logins survive restarts |
| `OWNER_IDS`               | —                               | Your Discord user id(s), comma/space-separated. Gates `/health` to just these accounts when `DISCORD_CLIENT_SECRET` is set — everyone else is blocked, not just non-admins |
| `DEV_LOG_CHANNEL_ID`      | —                               | A channel id Sylo posts its own errors to — a "dev-log", separate from any per-guild logging/modlog channel. Optional: errors and warnings are stored either way, and the [Sylo app](mobile-app.md#health-and-the-dev-log-operators) shows them and can notify operators |
| `DASHBOARD_URL`           | derived                         | Public dashboard URL; needed behind a reverse proxy and for verification-captcha / ban-appeal links |
| `TURNSTILE_SITE_KEY`      | —                               | Cloudflare Turnstile site key — enables the Verification captcha mode |
| `TURNSTILE_SECRET_KEY`    | —                               | Cloudflare Turnstile secret key (pair with the site key) |
| `ITAD_API_KEY`            | —                               | IsThereAnyDeal key — adds non-Epic stores to the Free games module |
| `INTENT_GUILD_MEMBERS`    | `true`                          | Request the Server Members privileged intent |
| `INTENT_MESSAGE_CONTENT`  | `true`                          | Request the Message Content privileged intent |
| `GAMETOOLS_API_BASE`      | `https://api.gametools.network` | Stats API base URL |
| `STATS_CACHE_TTL_MINUTES` | `5`                             | How long stats lookups are cached |
| `DATABASE_PATH`           | `./data/sylo.db`                | SQLite file path |
| `DATABASE_URL`            | —                               | Optional: a `postgres://` URL to use Postgres instead of SQLite. Hosted-scale deployments only — see [docs/postgres.md](postgres.md). Unset (default) means nothing about the setup below changes. |
| `BACKUP_INTERVAL_HOURS`   | `24`                            | Scheduled DB snapshot interval; `0` disables it (pre-migration + manual still run) |
| `BACKUP_RETENTION`        | `14`                            | How many DB snapshots to keep in `<data>/backups` |
| `BACKUP_DIR`              | `<db dir>/backups`              | Where DB snapshots are written |
| `LOG_LEVEL`               | `info`                          | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT`              | `text`                          | `text` or `json` (`LOG_JSON=1` = json) |
| `NODE_ENV`                | `development`                   | Set to `production` in deployment |

### Privileged intents

Both privileged intents default **on**. Several modules need them:

| Intent | Env var | Modules that need it |
|---|---|---|
| Server Members | `INTENT_GUILD_MEMBERS` | logging, roles, verification, welcome, leveling, server-stats, invite-tracker |
| Message Content | `INTENT_MESSAGE_CONTENT` | logging, autoresponder, counting, automod, starboard |

Enable them on the Discord Developer Portal (**Bot → Privileged Gateway
Intents**). If you don't want those modules, set the env var to `false` and Sylo
starts without requesting that intent. A verified bot (100+ servers) needs
Discord's approval for Message Content.

---

## Discord application setup

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy into `DISCORD_TOKEN`. Enable the
   privileged intents you need (see above).
3. **General Information** → copy **Application ID** into `DISCORD_CLIENT_ID`.
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`. Bot
   permissions:
   - **Send Messages**, **Embed Links** — always
   - **Attach Files** — welcome images, rank cards, leaderboard cards
   - **Kick Members**, **Ban Members**, **Moderate Members**, **Manage Messages** — moderation
   - **Manage Channels** — `/lock`, `/lockdown`, `/slowmode`, temporary voice
   - **Manage Roles** — reaction roles, autoroles, verification, leveling rewards, birthday role
   - **Move Members** — temporary voice channels
   - **Manage Server** — invite tracker (reads the invite list) and the automod
     push to native Discord AutoMod (creates/edits `Sylo:`-named rules)

   Open the generated URL to invite the bot. Tickets (modmail) need no extra
   permission — just leave the bot able to receive DMs.
5. Drag **Sylo's role above the roles it should manage** in *Server Settings →
   Roles*. The bot can never kick/ban/timeout someone whose highest role sits
   above its own, or edit a role above its own.

---

## Dashboard authentication

> Running on Fluxer too? The login steps for it (client secret, redirect URL,
> `FLUXER_OWNER_IDS`, linking both accounts) are in [fluxer.md](fluxer.md#dashboard-login).

By default the dashboard runs **open** (no login) — only safe on `localhost` or a
trusted LAN. Even in open mode a same-origin check blocks cross-site form posts.

To require a login:

1. Developer Portal → your app → **OAuth2** → copy the **Client Secret** into
   `DISCORD_CLIENT_SECRET`.
2. Same page → **Redirects** → add `<DASHBOARD_URL>/auth/discord/callback`
   (e.g. `http://192.168.1.10:3000/auth/discord/callback`, or the public HTTPS
   URL behind a proxy).
3. Set a long random `SESSION_SECRET`.
4. Set `OWNER_IDS` to your own Discord user id — without it, `/health` (status,
   error log, database backup/restore) is reachable by no one, not even you.

With `DISCORD_CLIENT_SECRET` set, every page except the `/health` JSON and the
`/metrics` scrape endpoint requires "Log in with Discord". Per-server pages
require **Manage Server** (or Administrator / owner) in that server, or one of the
**bot-master roles** set on that server's *Settings* page. Only the owner or
someone with Manage Server can change the bot-master roles; a bot master can save
the rest of that page.

`/health` (JSON) and `/metrics` stay unauthenticated so a monitor or Prometheus
can reach them — keep them on your LAN, or restrict them at the reverse proxy if
the dashboard is public.

Point Prometheus at `<host>:<WEB_PORT>/metrics` and import
`docs/grafana-dashboard.json` for a ready-made overview (gateway health, guild
count, HTTP and command rates, DB size, module adoption).

### Off-site backups

Every local snapshot can also be shipped, gzipped, to a remote target — set any
of `BACKUP_WEBDAV_URL` (+ `BACKUP_WEBDAV_USER` / `BACKUP_WEBDAV_PASS`, e.g. a
Nextcloud folder) or `BACKUP_WEBHOOK_URL` (a Discord webhook; attachments over
~8 MiB are skipped). Uploads are best-effort and logged; they never hold up the
local backup. The Health page shows which targets are active.

An off-site copy is the whole database (webhook secrets, ticket text, push
tokens). Set `BACKUP_ENCRYPTION_KEY` to a long passphrase and each copy leaves
encrypted (AES-256-GCM, `<name>.db.gz.enc`). Keep the passphrase somewhere other
than the server: without it the copies cannot be read. To restore one, decrypt it
first, then restore the `.db` file as usual:

```bash
BACKUP_ENCRYPTION_KEY='your passphrase' node scripts/decrypt-backup.js sylo-2026-10-17.db.gz.enc
```

With `BACKUP_WEBDAV_USER` set, `BACKUP_WEBDAV_URL` must be `https://` (or an
address on your own network, such as a container name or a `192.168.x.x`
address): Basic auth over plain http sends the password in clear text.

---

## Behind a reverse proxy

Set `DASHBOARD_URL` to the public URL and proxy to `127.0.0.1:${WEB_PORT}`. Sylo
then trusts one proxy hop (`X-Forwarded-*`), which it needs for correct client
IPs (rate limiting) and OAuth redirects. Make sure the OAuth **redirect** in the
Developer Portal matches `<DASHBOARD_URL>/auth/discord/callback`.

Exactly one hop: with two proxies in a row (for example Cloudflare in front of
nginx), every request looks like it comes from the inner proxy, so all clients
share one rate-limit bucket. Put only one HTTP proxy in front of Sylo.

The proxy must connect from this machine or the local network (a loopback or
private address, such as another container). `X-Forwarded-For` from any other
address is ignored, so a client that reaches Sylo's port directly cannot choose
its own IP. For another setup, set `TRUST_PROXY`: `false`, a hop count, or the
proxy's addresses or subnets (comma-separated, as Express takes them).

Without a login (open mode), the dashboard only answers on local names and
addresses (`localhost`, an IP address, a name without dots, `.local`, `.lan`,
`.home.arpa`, `.internal`) and on the host in `DASHBOARD_URL`. That blocks other
websites from reaching it through DNS rebinding.

**Caddy**

```caddy
sylo.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

**nginx**

```nginx
server {
    listen 443 ssl;
    server_name sylo.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```env
DASHBOARD_URL=https://sylo.example.com
```

---

## Docker

The bundled `docker-compose.yml` builds from source, mounts `./data`, and sets a
restart policy (needed so a dashboard **Restore** can restart the container).

```bash
cp .env.example .env
docker compose up -d --build
```

### Prebuilt images

CI publishes multi-arch (`linux/amd64` + `linux/arm64`) images to two registries:

| Tag | Registry | What it is |
| --- | --- | --- |
| `iwgamin/sylo:latest`, `:X.Y.Z`, `:X.Y` | [Docker Hub](https://hub.docker.com/r/iwgamin/sylo) · [GHCR](https://github.com/Ferdinand99/Sylo/pkgs/container/sylo) | Stable releases. What the Unraid template pulls. |
| `ghcr.io/ferdinand99/sylo:main`, `:sha-<short>` | GHCR only | Rolling build of `main` — every push. |

```bash
docker run -d --name sylo -p 3000:3000 --env-file .env \
  -v "$PWD/data:/app/data" --restart unless-stopped iwgamin/sylo:latest
```

If `better-sqlite3` ever fails to build on Alpine for your platform, change the
two `FROM node:22-alpine` lines in the `Dockerfile` to `node:22-slim`.

---

## Unraid

Sylo is in the Unraid **Community Applications** store — search "Sylo". The
template's source of truth is
[Ferdinand99/unraid-templates](https://github.com/Ferdinand99/unraid-templates)
(`templates/sylo.xml`) — edits there propagate to existing installs
automatically via `<TemplateURL>`, so no re-submission is needed for config
changes. If Community Applications hasn't picked up that repository yet, add
`https://github.com/Ferdinand99/unraid-templates` under Docker → Template
repositories to install the current template directly.

Manual container setup (Docker tab → Add Container):

| Field | Value |
|---|---|
| Repository | `docker.io/iwgamin/sylo:latest` |
| Network | `bridge` |
| Port | Container `3000` → Host `3000` |
| Path | Container `/app/data` → a real local path (see the caveat below) |
| Variable | `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `NODE_ENV=production` |

The image starts as root only long enough to fix ownership of the data
directory, then runs as an unprivileged user (`sylo`, uid 100). A fresh
root-owned folder works out of the box. If you still see `SQLITE_CANTOPEN`, run
once: `chown -R 100:101 <data path>`.

---

## SQLite on a network mount

**Put the data directory on a real local disk**, not a network share.
`better-sqlite3` uses WAL mode, which needs working file locks and `mmap`. SMB,
NFS, Unraid's `/mnt/user` (shfs / FUSE) and some Docker-Desktop bind mounts don't
provide them reliably, and you get `SQLITE_IOERR`, `database is locked`, or
silent corruption.

- **Unraid:** use a cache-pool path such as `/mnt/cache/appdata/sylo`, or a
  disk-share path like `/mnt/disk1/appdata/sylo` — not `/mnt/user/...`.
- **NAS / remote:** run Sylo on the box that owns the disk, or use a local
  volume.

---

## Backups

All state is one SQLite file (`data/sylo.db` + `-wal` / `-shm` sidecars) —
this section assumes that default setup. Running with `DATABASE_URL` set
instead? See [docs/postgres.md](postgres.md#backups-and-restore-on-postgres)
— the same buttons and flow, `pg_dump`/`pg_restore` under the hood.

**Automatic snapshots** are written to `data/backups/`: one before any schema
migration, one shortly after start, and one every `BACKUP_INTERVAL_HOURS`
(default 24), keeping the newest `BACKUP_RETENTION` (default 14). Set
`BACKUP_INTERVAL_HOURS=0` to keep only the pre-migration and manual ones.

**From the dashboard Health page** you can create a snapshot now, import a `.db`
from another machine (validated: SQLite header, `integrity_check`, schema no
newer than this build), download any snapshot, and **Restore** — which takes a
`prerestore` snapshot, swaps the file, and exits so the container restarts on the
restored data (needs a restart policy).

**Manual restore:** stop the container, copy a snapshot over `data/sylo.db`
(delete the `-wal` / `-shm` sidecars first), start again. Migrations only ever
move the schema forward; Sylo runs a `quick_check` on boot and logs corruption.

Per-server module config can also be exported as JSON from **General → Backup**.

---

## Upgrades and rollback

**Upgrade (prebuilt image):**

```bash
docker compose pull        # or: docker pull iwgamin/sylo:latest
docker compose up -d
```

**Upgrade (from source):**

```bash
git pull
npm install
# restart the process / container
```

On start, Sylo applies any new schema migrations inside a transaction, taking a
`sylo-premigrate-vN-*.db` snapshot first.

**Rollback:** pull the previous image tag (`iwgamin/sylo:3.4.1`), or `git
checkout` the previous tag, then restore the matching `sylo-premigrate-*` (or a
dated) snapshot from `data/backups/` over `data/sylo.db`. A newer database can't
be opened by an older build — the schema check refuses it — so always roll the
database back together with the code.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Used disallowed intents` on start | A privileged intent is requested but not enabled in the Developer Portal. Enable it, or set `INTENT_GUILD_MEMBERS=false` / `INTENT_MESSAGE_CONTENT=false`. |
| Slash commands don't appear | Global registration takes up to ~1 hour. Set `DISCORD_DEV_GUILD_IDS` for instant per-server registration, or wait. `npm run register` re-syncs. |
| "Log in with Discord" loops / `redirect_uri` mismatch | The Developer Portal **Redirect** must exactly equal `<DASHBOARD_URL>/auth/discord/callback`, scheme and port included. |
| `SQLITE_CANTOPEN` | The data directory isn't writable by uid 100. `chown -R 100:101 <data path>`. |
| `SQLITE_IOERR`, `database is locked`, corruption | The database is on a network share. Move it to a local disk — see [SQLite on a network mount](#sqlite-on-a-network-mount). |
| `better-sqlite3` fails to build | Switch the `Dockerfile` base images to `node:22-slim`, or install `python3 make g++` for a from-source build. |
| Moderation says it can't act on a member | Sylo's highest role must sit above the target's, and it needs the relevant permission (Ban/Kick/Moderate Members). |
| Welcome image / rank card missing | The bot lacks **Attach Files** in that channel, or `@napi-rs/canvas` didn't load on this platform (a warning is logged; the text message still sends). |
| Dashboard shows "open mode — no auth" | `DISCORD_CLIENT_SECRET` isn't set. That's expected for LAN use; set it to require a login. |
