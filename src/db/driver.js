// Driver shim: lets a `src/db/*.js` file run against either better-sqlite3
// (today, always, unless DATABASE_URL is set) or Postgres (opt-in, hosted-only
// — see docs/roadmap.md, "Postgres migration line"). Only files that import
// `prepare`/`registerPostgresBootstrap` from here participate in the Postgres
// path; every other `src/db/*.js` file still imports `db` from `./index.js`
// directly and is completely unaffected by DATABASE_URL. `db`/`index.js`
// itself is never modified by this file — the SQLite path stays exactly what
// it was before this existed.
import { config } from '../config.js';
import { db } from './index.js';

const bootstrapStatements = [];
let sqlClient = null;
let bootstrapped = false;

/** Each converted db file calls this once with its own Postgres-dialect DDL. */
export function registerPostgresBootstrap(ddlText) {
  bootstrapStatements.push(ddlText);
}

// Dynamic import so a pure-SQLite process (every self-hosted deployment,
// today) never loads the `postgres` package at all — matches the "zero
// footprint when the flag is off" approach already used by
// test/postgresSmoke.test.js.
async function getSql() {
  if (!sqlClient) {
    const postgres = (await import('postgres')).default;
    sqlClient = postgres(config.databaseUrl);
  }
  if (!bootstrapped) {
    bootstrapped = true;
    for (const ddl of bootstrapStatements) {
      await sqlClient.unsafe(ddl);
    }
  }
  return sqlClient;
}

/** Closes the Postgres pool, if one was ever opened. For test teardown. */
export async function closePostgres() {
  if (sqlClient) {
    await sqlClient.end({ timeout: 1 });
    sqlClient = null;
    bootstrapped = false;
  }
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

function preparePg(sqlText) {
  const translated = translate(sqlText);
  const isInsert = /^\s*insert\s+into/i.test(sqlText);
  const hasReturning = /\breturning\b/i.test(sqlText);
  // Postgres has no lastInsertRowid; every surrogate-key table here uses `id`
  // as its sole PK column (verified against every CREATE TABLE in
  // src/db/index.js's MIGRATIONS), so a bare INSERT can safely get RETURNING
  // id appended to recover it.
  const runText = isInsert && !hasReturning ? `${translated.text} RETURNING id` : translated.text;

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
        lastInsertRowid: isInsert ? rows[0]?.id : undefined,
      };
    },
  };
}

/**
 * @param {string} sqlText
 * @returns {{ get: (...args: any[]) => Promise<any>, all: (...args: any[]) => Promise<any[]>, run: (...args: any[]) => Promise<{changes: number, lastInsertRowid: number | undefined}> }}
 */
export function prepare(sqlText) {
  if (!config.databaseUrl) {
    const stmt = db.prepare(sqlText);
    return {
      get: async (...args) => stmt.get(...args),
      all: async (...args) => stmt.all(...args),
      run: async (...args) => stmt.run(...args),
    };
  }
  return preparePg(sqlText);
}
