// Proves the CI plumbing itself (connectivity to the Postgres service
// container), nothing about Sylo's own code — the driver shim doesn't exist
// yet (see docs/roadmap.md, "Postgres migration line").
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.DATABASE_URL;

test(
  'postgres smoke: SELECT 1 against DATABASE_URL',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async () => {
    const postgres = (await import('postgres')).default;
    const sql = postgres(url, { max: 1 });
    try {
      const rows = await sql`SELECT 1 AS ok`;
      assert.equal(rows[0].ok, 1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
);
