// Driver shim: lets a `src/db/*.js` file run against either better-sqlite3
// (today, always, unless DATABASE_URL is set) or Postgres (opt-in, hosted-only
// — see docs/roadmap.md, "Postgres migration line"). Only files that import
// `prepare`/`registerPostgresBootstrap` from here participate in the Postgres
// path; every other `src/db/*.js` file still imports `db` from `./index.js`
// directly and is completely unaffected by DATABASE_URL. `db`/`index.js`
// itself is never modified by this file — the SQLite path stays exactly what
// it was before this existed, including its own `PRAGMA user_version`-based
// migration runner (`migrate()`), untouched by the `schema_migrations` table
// below — that one tracks Postgres only, deliberately: unifying the two
// would mean changing how every self-hosted SQLite deployment's migration
// state is tracked for no benefit to them, which is the opposite of this
// migration's guiding rule ("Sylo's self-hosting pitch is one container, one
// SQLite file... that promise stays true," per the roadmap's own #0
// decision) — see `registerPostgresMigration` below for the Postgres-only
// incremental-migration mechanism this enables.
import { config } from '../config.js';
import { db, SCHEMA_VERSION } from './index.js';
import { idempotentTarget, splitStatements } from './splitSql.js';

const bootstrapStatements = [];
const postgresMigrations = [];
let sqlClient = null;
let readyPromise = null;

// An arbitrary, otherwise-unused key for the advisory lock below — see its
// comment. Any bigint works; this one just isn't 0 or a small round number
// something else might pick by coincidence.
const BOOTSTRAP_LOCK_KEY = 72739018;

/**
 * Each converted db file calls this once with its own Postgres-dialect DDL,
 * reflecting that table's *current* cumulative shape — the same convention
 * SQLite's `MIGRATIONS` array would produce if replayed from scratch, just
 * collapsed into one block instead of kept as history (see docs/roadmap.md,
 * "Postgres migration line" #2, for why: a brand-new Postgres database has no
 * legacy data to replay 30-odd historical migrations against). This always
 * runs, on every boot, for every driver — safe because every statement here
 * is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
 *
 * A schema change *after* this file's bootstrap DDL was last written needs
 * both: update the DDL text here too (so a brand-new install still gets it
 * for free) *and* register it via {@link registerPostgresMigration} (so an
 * *existing* Postgres database — one that already ran an older version of
 * this bootstrap — catches up). Exactly the "migrations 38+ get written
 * twice" tradeoff the roadmap note describes.
 */
export function registerPostgresBootstrap(ddlText) {
  bootstrapStatements.push(ddlText);
}

/**
 * Register a schema change that isn't safely re-runnable as an `IF NOT
 * EXISTS` bootstrap statement — a column rename, a data backfill, a type
 * change, anything `registerPostgresBootstrap` can't express idempotently.
 * `version` should match the SQLite migration number this mirrors (i.e. the
 * new `MIGRATIONS.length` after adding it) — purely for humans matching the
 * two up when reading the code side by side; nothing here reads the SQLite
 * migration array's *content*, only `SCHEMA_VERSION` (its length) once, to
 * know where a brand-new database's baseline already stands. See `getSql()`
 * for how a fresh vs. an existing Postgres database each decide what to run.
 * @param {number} version
 * @param {string} ddlText
 */
export function registerPostgresMigration(version, ddlText) {
  postgresMigrations.push({ version, ddl: ddlText });
}

// Dynamic import so a pure-SQLite process (every self-hosted deployment,
// today) never loads the `postgres` package at all — matches the "zero
// footprint when the flag is off" approach already used by
// test/postgresSmoke.test.js.
//
// `node --test` runs every test file as its own process, and each process
// only knows about the bootstrap DDL its own import graph registered — so
// several processes can reach here at (roughly) the same real-world moment,
// each running `CREATE TABLE IF NOT EXISTS` for tables the others are also
// creating for the first time. That's not safe to leave unserialized: the
// existence check and the creation aren't one atomic step, so two sessions
// can both see "doesn't exist yet" and collide inserting the new type into
// Postgres's internal catalog (a `pg_type_typname_nsp_index` 23505, not the
// friendlier "already exists" you'd expect) — reproduced locally by wiping
// the schema and re-running the suite against fresh Postgres a few times.
// A session-scoped advisory lock around the whole bootstrap loop makes every
// process's DDL run one at a time; whichever runs after the first just finds
// every `IF NOT EXISTS` already satisfied and moves on.
//
// `readyPromise` also fixes a narrower same-process version of the same
// bug: memoizing with a plain `if (!bootstrapped)` boolean lets a second
// concurrent call (e.g. from a `Promise.all(...)` stress test) see
// `bootstrapped = true` — set synchronously before the first `await` — and
// return `sqlClient` before that first call's DDL has actually finished
// running. Awaiting one shared promise makes every caller wait for the same
// completed (or failed) initialization instead.
async function getSql() {
  if (!readyPromise) {
    readyPromise = (async () => {
      const postgres = (await import('postgres')).default;
      // BIGINT (oid 20) comes back as a string by default. Every BIGINT here is an epoch-ms
      // timestamp or a counter, well inside Number's exact range, and the code treats them
      // as numbers — so convert, and Postgres returns what SQLite does.
      const client = postgres(config.databaseUrl, {
        types: { bigint: { to: 20, from: [20], parse: Number, serialize: String } },
      });
      await client`SELECT pg_advisory_lock(${BOOTSTRAP_LOCK_KEY})`;
      try {
        // One statement per query: a text with several statements is one implicit transaction that
        // keeps every lock until its last statement, which deadlocked against other processes that
        // were already writing to the same tables (see splitSql.js).
        for (const ddl of bootstrapStatements) {
          for (const statement of splitStatements(ddl)) {
            if (await alreadyThere(client, statement)) continue;
            await client.unsafe(statement);
          }
        }
        await runPostgresMigrations(client);
      } finally {
        await client`SELECT pg_advisory_unlock(${BOOTSTRAP_LOCK_KEY})`;
      }
      return client;
    })().catch((err) => {
      readyPromise = null; // let a later call retry instead of failing forever
      throw err;
    });
  }
  sqlClient = await readyPromise;
  return sqlClient;
}

/**
 * True when a bootstrap statement would change nothing because its column or index exists. A read of the
 * catalog takes no table lock; the statement itself would (ACCESS EXCLUSIVE for the ALTER, SHARE for
 * the index, even when it then does nothing), and lining up for those locks while other processes write
 * is how the bootstrap used to deadlock with them. The statement stays in the text for a database that
 * lacks the column or index.
 */
async function alreadyThere(client, statement) {
  const target = idempotentTarget(statement);
  if (!target) return false;
  const rows =
    target.kind === 'column'
      ? await client.unsafe(
          'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
          [target.table, target.column]
        )
      : await client.unsafe(
          'SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1',
          [target.name]
        );
  return rows.length > 0;
}

// Runs after the `IF NOT EXISTS` bootstrap above, inside the same advisory
// lock — so this never races another process's copy of the same check.
async function runPostgresMigrations(client) {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const [{ max }] = await client`SELECT COALESCE(MAX(version), 0) AS max FROM schema_migrations`;
  let current = Number(max);

  if (current === 0) {
    // No baseline recorded — either a brand-new database (the bootstrap DDL
    // above just created its full current shape, through SCHEMA_VERSION) or
    // a database from before this migration runner existed (same thing in
    // practice: every table already matches the current bootstrap DDL,
    // since nothing calls DATABASE_URL "ready for real use" before this
    // shipped — see the roadmap note). Either way, stamp SCHEMA_VERSION as
    // already covered instead of replaying registered migrations that the
    // bootstrap DDL was written to make unnecessary from scratch.
    await client`INSERT INTO schema_migrations (version) VALUES (${SCHEMA_VERSION})`;
    current = SCHEMA_VERSION;
  }

  for (const { version, ddl } of [...postgresMigrations].sort((a, b) => a.version - b.version)) {
    if (version <= current) continue; // already covered by the baseline or an earlier boot
    await client.unsafe(ddl);
    await client`INSERT INTO schema_migrations (version) VALUES (${version})`;
    current = version;
  }
}

/** Closes the Postgres pool, if one was ever opened. For test teardown. */
export async function closePostgres() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 1 });
    sqlClient = null;
  }
  readyPromise = null;
}

// `channelCleanup.js`'s statements are each consistently either all `?`
// (positional) or all `@name` (named) — never mixed within one statement.
// postgres.js only understands positional `$1, $2, …` (no native named-param
// binding), so both styles get rewritten to that at prepare() time.
function translate(sqlText) {
  if (sqlText.includes('@')) {
    const names = [];
    const text = sqlText.replace(/@(\w+)/g, (_, name) => {
      names.push(name);
      return `$${names.length}`;
    });
    return { text, named: names };
  }
  let n = 0;
  const text = sqlText.replace(/\?/g, () => `$${++n}`);
  return { text, named: null };
}

function toParams(translated, args) {
  if (translated.named) {
    const obj = args[0] ?? {};
    return translated.named.map((name) => obj[name]);
  }
  return args;
}

function preparePg(sqlText, { returningId } = {}) {
  const translated = translate(sqlText);
  // Postgres has no lastInsertRowid. Only append RETURNING id when the caller
  // explicitly says this statement's table has a surrogate `id` PK and its
  // result is actually used — NOT inferred from "starts with INSERT INTO",
  // since most tables here use a natural/composite key with no `id` column at
  // all (e.g. `afk`'s `(guild_id, user_id)`) and would error on a blind
  // RETURNING id append.
  const runText = returningId ? `${translated.text} RETURNING id` : translated.text;

  async function exec(text, args) {
    const sql = await getSql();
    return sql.unsafe(text, toParams(translated, args));
  }

  return {
    get: async (...args) => (await exec(translated.text, args))[0],
    all: async (...args) => Array.from(await exec(translated.text, args)),
    run: async (...args) => {
      const rows = await exec(runText, args);
      return {
        changes: rows.count,
        lastInsertRowid: returningId ? rows[0]?.id : undefined,
      };
    },
  };
}

/**
 * @param {string} sqlText
 * @param {{ returningId?: boolean }} [opts] - Set `returningId: true` for an
 *   INSERT whose table has a surrogate `id` PK and whose `.run().lastInsertRowid`
 *   is actually read (Postgres has no native equivalent, so this appends
 *   `RETURNING id` only on that driver).
 * @returns {{ get: (...args: any[]) => Promise<any>, all: (...args: any[]) => Promise<any[]>, run: (...args: any[]) => Promise<{changes: number, lastInsertRowid: number | undefined}> }}
 */
export function prepare(sqlText, opts) {
  if (!config.databaseUrl) {
    const stmt = db.prepare(sqlText);
    // The statement still runs at the moment of the call (an async arrow runs synchronously up to its
    // first await), and a failing statement still rejects the promise, as before. The guard throws
    // at once: see assertOutsideTransaction.
    const call = async (fn) => fn();
    return {
      get: (...args) => {
        assertOutsideTransaction();
        return call(() => stmt.get(...args));
      },
      all: (...args) => {
        assertOutsideTransaction();
        return call(() => stmt.all(...args));
      },
      run: (...args) => {
        assertOutsideTransaction();
        return call(() => stmt.run(...args));
      },
    };
  }
  return preparePg(sqlText, opts);
}

// --- transactions -------------------------------------------------------------------------------
//
// Most of Sylo needs no transaction (see the notes in purge.js and leveling.js: single upserts and
// idempotent sequences are enough). Money is the exception: a balance change and its ledger row
// must land together or not at all, and several accounts can change in one step (a payment). So
// `transaction(body)` runs `body` inside BEGIN/COMMIT on either driver. `body` is a GENERATOR
// function, and every statement is `yield`ed:
//
//   const out = await transaction(function* (tx) {
//     const row = yield tx.get('SELECT cash FROM accounts WHERE id = ?', id);
//     yield tx.run('UPDATE accounts SET cash = ? WHERE id = ?', row.cash - 5, id);
//     return row;
//   });
//
// `tx.get/all/run(sql, ...args)` work like the prepared statements above (positional `?` only);
// `tx.insertId(sql, ...args)` runs an INSERT into a table with a surrogate `id` and returns it.
// A throw inside `body` rolls everything back and is rethrown. Use `yield*` to call another
// generator (a helper, a hook). `body` must be a plain `function*` and must not await anything of
// its own: an async function, an async generator or any other function throws a TypeError at once, a
// yielded promise throws on SQLite, and a prepare() statement made while the body runs throws on SQLite.
//
// Why a generator: the same code has to be atomic on both drivers.
//
// SQLite: better-sqlite3 is synchronous and the process has one connection, so the whole body runs
// to its end inside `db.transaction(...).immediate()` without ever returning to the event loop:
// `yield tx.get(...)` just hands back the row, and nothing else (another module's write, a timer)
// can run in the middle. A transaction that is refused or rolled back therefore can never undo
// someone else's statement. (An `async` body would yield to the microtask queue at each `await`
// and let unrelated code run its statements inside the open transaction.)
//
// Postgres: `sql.begin` reserves a pooled connection for the body; each yielded query is awaited.
// Concurrent transactions that touch the same row wait for each other at the row lock (a plain
// UPDATE takes it).

// While a transaction() body runs on SQLite, the process has one open transaction on its one
// connection and nothing else can run, so a statement made through prepare() at that moment can only
// come from inside the body: from a hook that forgot to `yield` through `tx`. On Postgres the same
// call would run on another connection, outside the transaction and not rolled back with it. SQLite
// refuses it the same way, so the mistake shows up in tests on either driver.
function assertOutsideTransaction() {
  if (db.inTransaction) {
    throw new Error(
      'a prepare() statement was run inside a transaction() body: use the tx passed to the body (yield tx.run(...))'
    );
  }
}

const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;

/** True for a plain `function*` (not an async generator, an async function or a normal function). */
export const isGeneratorFunction = (fn) => fn instanceof GeneratorFunction;

function assertSyncGeneratorBody(body) {
  if (!isGeneratorFunction(body)) {
    throw new TypeError(
      'transaction() needs a generator function (function* (tx) { ... yield tx.run(...) }), not an async function or a plain function'
    );
  }
}

const sqliteStatements = new Map();

function sqliteStatement(sqlText) {
  let stmt = sqliteStatements.get(sqlText);
  if (!stmt) {
    stmt = db.prepare(sqlText);
    sqliteStatements.set(sqlText, stmt);
  }
  return stmt;
}

// Synchronous: the values come back as they are, and `yield` passes them straight through.
const sqliteTx = {
  get: (sqlText, ...args) => sqliteStatement(sqlText).get(...args),
  all: (sqlText, ...args) => sqliteStatement(sqlText).all(...args),
  run: (sqlText, ...args) => ({ changes: sqliteStatement(sqlText).run(...args).changes }),
  insertId: (sqlText, ...args) => Number(sqliteStatement(sqlText).run(...args).lastInsertRowid),
};

function runSqliteTransaction(body) {
  return db
    .transaction(() => {
      const it = body(sqliteTx);
      let step = it.next();
      while (!step.done) {
        // A promise here would be handed back as a promise on SQLite but awaited on Postgres.
        if (typeof step.value?.then === 'function') {
          throw new TypeError(
            'a transaction() body yielded a promise: yield only tx.get/all/run/insertId results'
          );
        }
        step = it.next(step.value);
      }
      return step.value;
    })
    .immediate();
}

function pgTx(tx) {
  const translated = new Map();
  const exec = (sqlText, args, suffix = '') => {
    let t = translated.get(sqlText);
    if (!t) {
      t = translate(sqlText);
      translated.set(sqlText, t);
    }
    return tx.unsafe(t.text + suffix, toParams(t, args));
  };
  return {
    get: (sqlText, ...args) => exec(sqlText, args).then((rows) => rows[0]),
    all: (sqlText, ...args) => exec(sqlText, args).then((rows) => Array.from(rows)),
    run: (sqlText, ...args) => exec(sqlText, args).then((rows) => ({ changes: rows.count })),
    insertId: (sqlText, ...args) => exec(sqlText, args, ' RETURNING id').then((rows) => rows[0].id),
  };
}

async function runPgTransaction(body) {
  const sql = await getSql();
  return sql.begin(async (tx) => {
    const it = body(pgTx(tx));
    let step = it.next();
    while (!step.done) {
      let value;
      try {
        value = await step.value;
      } catch (err) {
        step = it.throw(err);
        continue;
      }
      step = it.next(value);
    }
    return step.value;
  });
}

/**
 * Run `body` in one database transaction. See the notes above for what `tx` offers.
 * @template T
 * @param {(tx: { get: (sql: string, ...args: any[]) => any, all: (sql: string, ...args: any[]) => any, run: (sql: string, ...args: any[]) => any, insertId: (sql: string, ...args: any[]) => any }) => Generator<any, T, any>} body
 * @returns {Promise<T>}
 */
export async function transaction(body) {
  assertSyncGeneratorBody(body);
  return config.databaseUrl ? runPgTransaction(body) : runSqliteTransaction(body);
}
