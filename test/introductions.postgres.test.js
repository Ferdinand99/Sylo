// Proves the driver shim's Postgres branch for Introductions: the table is created by the bootstrap,
// BIGINT times come back as numbers, the upsert keeps the creation time, the message index finds a
// card, and the purge, /forget and export statements run against it.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'introductions against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const intro = await import('../src/db/introductions.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-intro-${Date.now()}`;
    const H = `${G}-other`;
    const U = 'user-1';
    const V = 'user-2';
    const save = (over = {}) =>
      intro.saveIntroduction({
        guildId: G,
        userId: U,
        channelId: 'c1',
        messageId: 'm1',
        answers: { about: 'Hello' },
        ...over,
      });

    await t.test('the table is created by the bootstrap, and a row round-trips', async () => {
      assert.equal(await intro.getIntroduction(G, U), null);
      await save();
      const row = await intro.getIntroduction(G, U);
      assert.equal(row.channel_id, 'c1');
      assert.equal(row.message_id, 'm1');
      assert.deepEqual(intro.answersOf(row), { about: 'Hello' });
      assert.equal(typeof row.created_at, 'number');
      assert.equal(typeof row.updated_at, 'number');
    });

    await t.test('saving again replaces the row and keeps the creation time', async () => {
      const first = await intro.getIntroduction(G, U);
      await new Promise((r) => setTimeout(r, 5));
      await save({ messageId: 'm2', answers: { about: 'Changed' } });
      const second = await intro.getIntroduction(G, U);
      assert.equal(second.message_id, 'm2');
      assert.deepEqual(intro.answersOf(second), { about: 'Changed' });
      assert.equal(second.created_at, first.created_at);
      assert.ok(second.updated_at > first.updated_at);
      assert.equal(await intro.introductionCount(G), 1);
      assert.equal(typeof (await intro.introductionCount(G)), 'number');
    });

    await t.test('a card is found by its message, and the message can be forgotten', async () => {
      assert.equal((await intro.getIntroductionByMessage(G, 'm2')).user_id, U);
      assert.equal(await intro.getIntroductionByMessage(H, 'm2'), null);
      assert.equal(await intro.clearIntroductionMessage(G, U), 1);
      const row = await intro.getIntroduction(G, U);
      assert.equal(row.message_id, null);
      assert.deepEqual(intro.answersOf(row), { about: 'Changed' });
    });

    await t.test('/forget, the export and the guild purge work on the table', async () => {
      await save({ userId: V });
      await save({ guildId: H });
      const exported = await purge.exportUserData(G, V);
      assert.equal(exported.data.introductions.length, 1);
      const summary = await purge.describeUserData(G, V);
      assert.equal(summary.items.find((i) => i.key === 'introductions').count, 1);
      assert.equal((await purge.forgetUser(G, V)).introductions, 1);
      assert.equal(await intro.getIntroduction(G, V), null);
      await purge.purgeGuild(G);
      assert.equal(await intro.introductionCount(G), 0);
      assert.equal(await intro.introductionCount(H), 1, 'another server is untouched');
      await purge.purgeGuild(H);
      assert.equal(await intro.introductionCount(H), 0);
    });
  }
);
