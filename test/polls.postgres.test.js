// Proves the driver shim's Postgres branch for polls (TEXT primary key, no
// surrogate id) — a subset of polls.test.js's DB assertions, real Postgres
// connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'polls against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      createPoll,
      getPoll,
      pollsInChannel,
      latestPollInChannel,
      duePolls,
      guildPollCount,
      deletePoll,
      clearGuildPolls,
    } = await import('../src/db/polls.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const G = `pgtest-polls-${stamp}`;
    const CH = '700000000000000401';

    await t.test('create + get round-trips, hydrates options', async () => {
      await createPoll({
        messageId: `m1-${stamp}`,
        guildId: G,
        channelId: CH,
        question: 'Best?',
        options: ['A', 'B'],
        multiple: false,
        maxVotes: 0,
        endsAt: null,
        createdBy: 'u1',
        createdAt: 1000,
      });
      const p = await getPoll(`m1-${stamp}`);
      assert.equal(p.question, 'Best?');
      assert.deepEqual(p.options, ['A', 'B']);
      assert.equal(Number(p.created_at), 1000);
      assert.equal(p.ends_at, null);
      assert.equal(await getPoll('nope'), null);
    });

    await t.test('pollsInChannel order, guildPollCount, duePolls, delete/clear', async () => {
      await createPoll({
        messageId: `m2-${stamp}`,
        guildId: G,
        channelId: CH,
        question: 'Q2',
        options: ['A'],
        multiple: false,
        maxVotes: 0,
        createdBy: 'u1',
        createdAt: 2000,
      });

      const inCh = await pollsInChannel(G, CH);
      assert.deepEqual(
        inCh.map((p) => p.message_id),
        [`m2-${stamp}`, `m1-${stamp}`]
      );
      const latest = await latestPollInChannel(G, CH);
      assert.equal(latest.message_id, `m2-${stamp}`);
      assert.equal(await guildPollCount(G), 2);

      const now = Date.now();
      await createPoll({
        messageId: `m3-${stamp}`,
        guildId: G,
        channelId: CH,
        question: 'Q3',
        options: ['A'],
        multiple: false,
        maxVotes: 0,
        endsAt: now - 1000,
        createdBy: 'u1',
        createdAt: now,
      });
      const due = await duePolls(now);
      assert.ok(due.some((p) => p.message_id === `m3-${stamp}`));
      assert.ok(!due.some((p) => p.message_id === `m1-${stamp}`));

      await deletePoll(`m3-${stamp}`);
      assert.equal(await getPoll(`m3-${stamp}`), null);

      await clearGuildPolls(G);
      assert.equal(await getPoll(`m1-${stamp}`), null);
      assert.equal(await guildPollCount(G), 0);
    });
  }
);
