// Import this in any test that specifically needs a real Postgres connection
// (the CI matrix's `postgres` leg sets DATABASE_URL to its service container).
// Unlike tmpDb.js, this does NOT provision anything — there is no SQLite-style
// throwaway file for Postgres; CI's service container is already reachable at
// a fixed connection string. This documents/asserts the convention so a
// future Postgres-aware test fails fast with a clear message locally, instead
// of a confusing connection-refused error.
export function requirePostgres() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. This test needs a real Postgres connection ' +
        '(the CI "postgres" matrix leg sets one automatically).'
    );
  }
  return process.env.DATABASE_URL;
}
