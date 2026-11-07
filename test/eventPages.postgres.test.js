// Public event pages on a real Postgres connection: the public token is written and found, the
// backfill that gives events from before the column a token works (and leaves tokens alone), the
// column and its unique index exist, the table has exactly the columns SQLite's has (the
// SQLite-to-Postgres copy script refuses a table that drifted), and a purge removes the token's event.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;
const TOKEN = /^[0-9a-f]{32}$/;

test(
  'event page tokens against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const db = await import('../src/db/events.js');
    const purge = await import('../src/db/purge.js');
    const { prepare } = await import('../src/db/driver.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-event-pages-${Date.now()}`;
    const NOW = Date.now();
    const make = (over = {}) =>
      db.createEvent({
        guildId: G,
        channelId: '1',
        title: 'Game night',
        startAt: NOW + 7_200_000,
        hostId: 'h',
        ...over,
      });

    await t.test('a new event gets its token, and the token finds it', async () => {
      const a = await make();
      const b = await make({ title: 'Quiz' });
      const rowA = await db.getEvent(a.id);
      const rowB = await db.getEvent(b.id);
      assert.match(rowA.public_token, TOKEN);
      assert.notEqual(rowA.public_token, rowB.public_token);
      assert.equal((await db.getEventByToken(rowA.public_token)).id, a.id);
      assert.equal((await db.getEventByToken(rowA.public_token.toUpperCase())) ?? null, null);
      assert.equal(await db.getEventByToken(String(a.id)), null, 'the event number is not an address');
      assert.equal(await db.getEventByToken("' OR 1=1 --"), null);
      assert.equal(await db.getEventByToken('%'), null);
    });

    await t.test(
      'the migration backfill gives an event without a token one, and keeps the others',
      async () => {
        const kept = await make();
        const keptToken = (await db.getEvent(kept.id)).public_token;
        const insertOld = prepare(
          `INSERT INTO guild_events (guild_id, channel_id, title, start_at, host_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
          { returningId: true }
        );
        const old1 = Number((await insertOld.run(G, '1', 'Old one', NOW + 1, 'h', NOW)).lastInsertRowid);
        const old2 = Number((await insertOld.run(G, '1', 'Old two', NOW + 2, null, NOW)).lastInsertRowid);
        assert.equal((await db.getEvent(old1)).public_token, null, 'a row from before the column');

        await prepare(db.EVENT_TOKEN_BACKFILL_SQL).run();

        const t1 = (await db.getEvent(old1)).public_token;
        const t2 = (await db.getEvent(old2)).public_token;
        assert.match(t1, TOKEN);
        assert.match(t2, TOKEN);
        assert.notEqual(t1, t2);
        assert.equal(
          (await db.getEvent(kept.id)).public_token,
          keptToken,
          'an existing token is not replaced'
        );
        assert.equal((await db.getEventByToken(t1)).id, old1);

        // running it again changes nothing
        await prepare(db.EVENT_TOKEN_BACKFILL_SQL).run();
        assert.equal((await db.getEvent(old1)).public_token, t1);
      }
    );

    await t.test('the token column is unique', async () => {
      const a = await make();
      const b = await make();
      const token = (await db.getEvent(a.id)).public_token;
      await assert.rejects(
        prepare('UPDATE guild_events SET public_token = ? WHERE id = ?').run(token, b.id),
        /unique|duplicate/i
      );
    });

    await t.test('the table has the same columns as the SQLite one', async () => {
      const { default: Database } = await import('better-sqlite3');
      const { MIGRATIONS } = await import('../src/db/index.js');
      const lite = new Database(':memory:');
      for (const migration of MIGRATIONS) migration(lite);
      const sqliteCols = lite
        .prepare('PRAGMA table_info(guild_events)')
        .all()
        .map((c) => c.name)
        .sort();
      lite.close();
      const pgCols = (
        await prepare(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'guild_events'"
        ).all()
      )
        .map((c) => c.column_name)
        .sort();
      assert.ok(sqliteCols.includes('public_token'));
      assert.deepEqual(pgCols, sqliteCols);
    });

    await t.test('a purge removes the events and with them the addresses', async () => {
      const a = await make();
      const token = (await db.getEvent(a.id)).public_token;
      await purge.purgeGuild(G);
      assert.equal(await db.getEventByToken(token), null);
    });
  }
);
