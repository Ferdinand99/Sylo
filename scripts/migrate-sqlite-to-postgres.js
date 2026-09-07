// One-time data migration: copies every row from the local SQLite database
// into a Postgres database, so an *existing* deployment can cut over from
// SQLite to Postgres without losing anything. See docs/roadmap.md, "Postgres
// migration line" #4 — #1-#3 (the driver, the migration runner, backup/
// restore) only ever assumed a brand-new Postgres database; this is the
// piece that makes flipping DATABASE_URL on for an existing SQLite install
// safe.
//
// Usage:
//   DATABASE_URL=postgres://user:pass@host:5432/dbname npm run migrate-to-postgres
//
// DATABASE_PATH picks the source (defaults to ./data/sylo.db, same as the
// app) — point it at a downloaded Health-page backup to try this against a
// copy of a deployment's data without ever touching the live one:
//   DATABASE_PATH=./sylo-startup-2026-09-07.db DATABASE_URL=postgres://... \
//     npm run migrate-to-postgres
//
// Run this with Sylo NOT writing to that SQLite file — either the app is
// stopped, or (per above) you're migrating a downloaded snapshot instead of
// the live file. A snapshot mid-write would copy an inconsistent picture.
//
// Flags:
//   --force    proceed even though the target database already has rows in
//              it (normally refused — this tool is a one-shot copy onto an
//              empty database, not a merge)
//   --dry-run  do everything except the actual writes: bootstrap the target
//              schema, report what would be copied, skip INSERTs and the
//              sequence reset, skip the row-count verification
//
// Safety:
//  - The table list comes from sqlite_master, not a hand-maintained array,
//    so it can never silently drift from the real schema.
//  - Every table gets a cheap column-name check against Postgres's
//    information_schema before it's trusted for a blind INSERT.
//  - The handful of tables with a SQLite surrogate `id` (SERIAL on the
//    Postgres side) get that id copied explicitly, then their sequence
//    reset afterward, so cross-table references (e.g.
//    ticket_messages.ticket_id) stay valid — see resetSerialSequences().
//  - Verifies every table's row count matches, source vs. target, before
//    declaring success.
import { config } from '../src/config.js';
import { db, closeDb } from '../src/db/index.js';
import { prepare, closePostgres } from '../src/db/driver.js';

// Side-effect imports: registerPostgresBootstrap() only runs for a file
// that's actually been imported somewhere in this process — same reasoning
// as src/db/purge.js's own import list, just for literally every
// table-owning file this time (purge.js's list is guild-scoped tables only;
// this needs every table, e.g. cache.js's non-guild-scoped stats_cache too).
import '../src/db/guildSettings.js';
import '../src/db/modules.js';
import '../src/db/commandOverrides.js';
import '../src/db/modCases.js';
import '../src/db/tickets.js';
import '../src/db/composedMessages.js';
import '../src/db/counting.js';
import '../src/db/scheduledMessages.js';
import '../src/db/leveling.js';
import '../src/db/audit.js';
import '../src/db/afk.js';
import '../src/db/postedKeys.js';
import '../src/db/appeals.js';
import '../src/db/tempVoice.js';
import '../src/db/starboard.js';
import '../src/db/inviteTracker.js';
import '../src/db/polls.js';
import '../src/db/giveaways.js';
import '../src/db/leaderboardVanity.js';
import '../src/db/tempBans.js';
import '../src/db/channelLocks.js';
import '../src/db/birthdays.js';
import '../src/db/insights.js';
import '../src/db/channelCleanup.js';
import '../src/db/cache.js';
import '../src/db/appSettings.js';

const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const CHUNK = 1000;

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exitCode = 1;
  return false;
}

/** Every real table in the source database, alphabetical for stable output. */
function listSqliteTables() {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort();
}

/** SQLite's column order for a table, and whether it has a single-column integer `id` PK. */
function tableShape(table) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const pk = cols.filter((c) => c.pk > 0);
  const hasSerialId = pk.length === 1 && pk[0].name === 'id';
  return { columns: cols.map((c) => c.name), hasSerialId };
}

async function pgColumns(sql, table) {
  const rows = await sql`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
  `;
  return rows.map((r) => r.column_name);
}

/** Copy one table, paginated. Returns the number of rows copied. */
async function copyTable(sql, table, columns) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  if (total === 0) return 0;

  let copied = 0;
  for (let offset = 0; offset < total; offset += CHUNK) {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).all(CHUNK, offset);
    if (rows.length === 0) break;
    if (!DRY_RUN) {
      await sql`INSERT INTO ${sql(table)} ${sql(rows, ...columns)}`;
    }
    copied += rows.length;
    process.stdout.write(`\r  ${table}: ${copied}/${total}`);
  }
  process.stdout.write('\n');
  return copied;
}

/** Point every SERIAL-backed id sequence past the ids that were just copied in. */
async function resetSerialSequences(sql, tables) {
  for (const table of tables) {
    await sql.unsafe(`
      SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${table}), 1),
        (SELECT MAX(id) FROM ${table}) IS NOT NULL
      )
    `);
  }
}

async function main() {
  console.log('Sylo: SQLite -> Postgres data migration');
  console.log('========================================');
  console.log(`Source (SQLite):  ${db.name}`);
  console.log(
    `Target (Postgres): ${config.databaseUrl ? config.databaseUrl.replace(/:[^:@]*@/, ':****@') : '(not set)'}`
  );
  console.log(DRY_RUN ? 'Mode: DRY RUN — no writes will happen\n' : '\n');

  if (!config.databaseUrl) {
    return fail("DATABASE_URL is not set — nothing to migrate into. See this script's header comment.");
  }

  console.log('Before you continue:');
  console.log('  - Sylo must not be actively writing to the SQLite file this is reading —');
  console.log('    either stop it first, or point DATABASE_PATH at a downloaded backup instead.');
  console.log('  - This is a one-shot copy onto an empty Postgres database, not a merge.\n');

  // Force the Postgres schema to bootstrap now (driver.js's getSql() runs it
  // lazily on the first real query) — every side-effect import above has
  // already registered its table's DDL by the time this file's module body
  // finished loading.
  await prepare('SELECT 1 AS x').get();

  const { default: postgres } = await import('postgres');
  const sql = postgres(config.databaseUrl);

  try {
    const tables = listSqliteTables();
    console.log(`${tables.length} table(s) in the source database.\n`);

    if (!FORCE) {
      for (const table of tables) {
        const pgCount = await sql`SELECT COUNT(*) AS n FROM ${sql(table)}`.catch(() => null);
        if (pgCount && Number(pgCount[0].n) > 0) {
          return fail(
            `target already has ${pgCount[0].n} row(s) in "${table}" — refusing to continue without --force`
          );
        }
      }
    }

    const serialTables = [];
    const sourceCounts = {};

    for (const table of tables) {
      const { columns, hasSerialId } = tableShape(table);
      const pgCols = await pgColumns(sql, table);
      const missing = columns.filter((c) => !pgCols.includes(c));
      if (missing.length) {
        return fail(
          `"${table}": Postgres is missing column(s) ${missing.join(', ')} — schema drift, aborting`
        );
      }
      if (hasSerialId) serialTables.push(table);

      const copied = await copyTable(sql, table, columns);
      sourceCounts[table] = copied;
    }

    if (process.exitCode) return; // a table failed its column check above

    if (!DRY_RUN) {
      console.log('\nResetting id sequences for tables with a surrogate key...');
      await resetSerialSequences(sql, serialTables);
    }

    console.log(
      DRY_RUN ? '\nDry run — skipping verification (nothing was written).' : '\nVerifying row counts...'
    );
    if (!DRY_RUN) {
      let allGood = true;
      for (const table of tables) {
        const [{ n }] = await sql`SELECT COUNT(*) AS n FROM ${sql(table)}`;
        const ok = Number(n) === sourceCounts[table];
        if (!ok) allGood = false;
        console.log(`  ${ok ? '✔' : '✖'} ${table}: sqlite ${sourceCounts[table]} / postgres ${n}`);
      }
      if (!allGood) return fail('row counts do not match for one or more tables — see above.');
    }

    console.log(
      DRY_RUN
        ? '\n✔ Dry run complete — looks safe to run for real (drop --dry-run).'
        : '\n✔ Migration complete. Every table matched. Sylo can now start with DATABASE_URL set.'
    );
  } finally {
    await sql.end({ timeout: 1 });
  }
}

try {
  await main();
} catch (err) {
  fail(err.stack || err.message);
} finally {
  await closePostgres();
  closeDb();
}
