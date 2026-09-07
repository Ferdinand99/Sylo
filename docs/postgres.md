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
per-table row-count report at the end — every line should show a ✔.

**3. Cut the live instance over.** Stop Sylo so nothing is still writing to
the SQLite file (a live write mid-copy would make the snapshot inconsistent),
then run the same command against the *live* `DATABASE_PATH`
(`./data/sylo.db` by default) and your real `DATABASE_URL`. In Docker:

```bash
docker compose stop sylo
docker compose run --rm -e DATABASE_URL=postgres://user:pass@host/db \
  sylo node scripts/migrate-sqlite-to-postgres.js
```

**4. Add `DATABASE_URL` to your `.env`** and start Sylo again. It's now
running on Postgres with all of its previous data.

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
