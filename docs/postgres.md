# Postgres support (optional)

Sylo's default and recommended setup is still **one SQLite file** — that
never changes, for anyone. Postgres is an opt-in alternative for large,
multi-server hosted deployments where a single SQLite connection starts to
be a real bottleneck. If that's not you, skip this page —
[docs/self-hosting.md](self-hosting.md) is all you need.

- [Should you use this?](#should-you-use-this)
- [Enabling Postgres for a new install](#enabling-postgres-for-a-new-install)
- [Moving an existing SQLite install over](#moving-an-existing-sqlite-install-over)
- [Backups and restore on Postgres](#backups-and-restore-on-postgres)
- [Rolling back](#rolling-back)
- [Troubleshooting](#troubleshooting)

---

## Should you use this?

Almost certainly not, and that's fine — SQLite handles one bot in any
realistic number of servers without breaking a sweat. Postgres is worth the
extra moving part only if you're running Sylo at hosted scale (many
thousands of servers, high write concurrency) where a single-writer SQLite
file genuinely becomes the bottleneck.

Turning it on doesn't change anything about how Sylo behaves — every module,
command and dashboard page works identically either way. It only changes
where the data lives and how backup/restore work under the hood.

## Enabling Postgres for a new install

Set `DATABASE_URL` before the first start:

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname
```

That's the whole setup. On first connect, Sylo creates every table it needs
automatically — no separate schema step, no migration to run by hand. Leave
`DATABASE_URL` unset (the default) and nothing changes: Sylo uses
`DATABASE_PATH` exactly as it always has.

## Moving an existing SQLite install over

If you already have a running instance with real data, don't just set
`DATABASE_URL` and restart — that gives you a brand-new, empty Postgres
database. Use `scripts/migrate-sqlite-to-postgres.js` to copy everything
over first.

> **The order matters — get this wrong and Sylo starts up on an empty
> database.** `DATABASE_URL` being set is the *only* thing that decides
> which database Sylo talks to; it doesn't know or care whether that
> database actually has your data in it yet. Do the copy **first**, with
> Sylo stopped and `DATABASE_URL` still unset for it, and only add
> `DATABASE_URL` to Sylo's own config **after** the migration reports every
> table matched. Adding the env var and restarting before that — even
> planning to "migrate right after" — means real requests hit empty tables
> in the gap. See the [troubleshooting entry](#troubleshooting) below for
> exactly what that looks like and how to recover if it happens anyway.

**1. Try it safely against a copy first.** Take a backup from the Health page
(or `docker cp <container>:/app/data/backups/<name>.db ./`), then dry-run the
migration against it — this touches nothing live:

```bash
DATABASE_PATH=./sylo-backup.db DATABASE_URL=postgres://user:pass@host/db \
  npm run migrate-to-postgres -- --dry-run
```

It reports every table it would copy and fails loudly on anything it isn't
sure about (a schema mismatch, an already-populated target) without writing
a single row.

**2. Run it for real** against the copy (drop `--dry-run`), and check the
per-table row-count report at the end — every line should show a ✔. This
proves the whole path works before it's anywhere near the live database.

**3. Stop Sylo.** Nothing should be writing to the SQLite file during the
real copy — a write mid-copy makes the snapshot inconsistent. `DATABASE_URL`
is **not** set anywhere yet at this point, on the stopped instance or in the
migration command below.

```bash
docker compose stop sylo          # docker-compose deployments
# or, for a container started directly (e.g. an Unraid template, no
# docker-compose.yml): docker stop sylo
```

**4. Get a snapshot of the now-quiet database and migrate it.** With Sylo
stopped, either take one last backup via `docker cp` (the file doesn't
change once the container isn't running) or point `DATABASE_PATH` straight
at the mounted volume's file, then run the real migration against your real
`DATABASE_URL`:

```bash
# docker-compose deployments — runs in a throwaway container sharing the
# same volume as the stopped service:
docker compose run --rm -e DATABASE_URL=postgres://user:pass@host/db \
  sylo node scripts/migrate-sqlite-to-postgres.js

# a container started directly (no compose file) — copy the file out first:
docker cp sylo:/app/data/sylo.db ./sylo-final.db
DATABASE_PATH=./sylo-final.db DATABASE_URL=postgres://user:pass@host/db \
  npm run migrate-to-postgres
```

Check the row-count report at the end — every line ✔ — **before** moving on.

**5. Only now add `DATABASE_URL`** to Sylo's own config — `.env` for
docker-compose, or as a Variable on the container's template if it was
started directly (e.g. Unraid: Docker tab → the container → **Edit** → add
a **Variable**, `DATABASE_URL` → **Apply**, which recreates and starts it
for you) — **then start Sylo**. It connects to a database that already has
every row it had before.

The script refuses to run onto a Postgres database that already has rows in
it (pass `--force` to override — see its own header comment for exactly what
that does and doesn't protect against). It preserves every row's id where
one exists, so cross-references between tables (a ticket's messages, a
giveaway's entries) stay intact — confirmed by inserting a new row through
Sylo's own code right after a migration and checking it didn't collide with
a copied one.

## Backups and restore on Postgres

The Health page's backup/restore works the same way on both drivers — same
buttons, same "Create backup now" / **Restore** flow — but the file format
underneath is different:

| | SQLite | Postgres |
|---|---|---|
| Snapshot format | `.db` (`VACUUM INTO`) | `.dump` (`pg_dump -Fc`) |
| Restore | file swap + restart | `pg_restore --clean` + restart |
| Live size shown | local file + WAL | `pg_database_size()` |

Both live in the same `data/backups/` directory and go through the same
off-site shipping (WebDAV / Discord webhook) if configured. A snapshot only
restores onto the driver it came from — trying to restore a `.dump` while
running on SQLite (or vice versa) fails with a clear error instead of doing
something destructive.

`pg_dump`/`pg_restore` are bundled in the Docker image, pinned to the newest
supported Postgres major version — that covers dumping from and restoring to
any older server version too (a newer client is safe against an older
server; the reverse isn't).

## Rolling back

Nothing about a Postgres cutover deletes your SQLite file — the migration
script only *reads* it. If something looks wrong after switching, just
remove `DATABASE_URL` from `.env` and restart; Sylo picks the SQLite file
back up exactly where it was left (any changes made *while* Postgres was
active won't be reflected there, since the two databases aren't kept in
sync — the migration is a one-time copy, not a live replication).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Migration refuses with "target already has N row(s)" | The Postgres database isn't empty. Use a fresh database, or pass `--force` if you're intentionally re-running onto it (Postgres's own primary-key constraints will still stop an actual duplicate insert). |
| Migration fails with "Postgres is missing column(s)" | The Postgres schema is out of date relative to this build — start Sylo once against `DATABASE_URL` first (it bootstraps the schema on connect), then re-run the migration. |
| Restore rejects a snapshot with "server is running in \[SQLite/Postgres\] mode" | The snapshot is from the other driver. Restore it only on a deployment running that same driver. |
| `pg_dump`/`pg_restore: command not found` | You're running Sylo from source outside the Docker image without the Postgres client tools installed locally. Install `postgresql-client` (matching or newer than your server's major version) or use the Docker image, which bundles it. |
| Sylo is already running against `DATABASE_URL`, but the database is empty (dashboard shows no servers, no settings) | `DATABASE_URL` got added and Sylo restarted *before* the migration ran — see the order in [step 3-5](#moving-an-existing-sqlite-install-over) above. To recover: **1)** stop Sylo again so nothing else gets written; **2)** check what, if anything, wrote to the empty database in the meantime (`SELECT * FROM app_settings;` is usually the only thing — background timers like the birthday sweep touch it even with zero real activity) and delete those few rows — they're not real data, and left in place they'll collide with the same rows in your SQLite backup; **3)** run the migration for real, now that the target is genuinely empty; **4)** start Sylo. Nothing about this touches or risks the original SQLite file — it was only ever read. |
