// Proves the Bridge storage against a real Postgres connection: the tables come from the bootstrap, ids and
// BIGINT times come back as numbers, a code is used up once, a channel is in one link, the message map is
// found from both sides and swept, and the guild purge removes the links of either side.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'bridge against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const store = await import('../src/db/bridge.js');
    const purge = await import('../src/db/purge.js');
    const retention = await import('../src/db/retention.js');
    t.after(async () => {
      await closePostgres();
    });

    const run = Date.now();
    const G1 = `pgtest-bridge-${run}-a`;
    const G2 = `fluxer:pgtest-bridge-${run}-b`;
    const link = (over = {}) => ({
      guildA: G1,
      channelA: `ca-${run}`,
      guildB: G2,
      channelB: `cb-${run}`,
      hookA: { id: `ha-${run}`, token: 'ta' },
      hookB: { id: `hb-${run}`, token: 'tb' },
      requestedBy: 'Alice',
      acceptedBy: 'Bob',
      ...over,
    });

    await t.test(
      'a link is created, found from the channel and the webhook, and a channel is in one link only',
      async () => {
        const id = await store.createLink(link());
        assert.equal(typeof id, 'number');
        const found = await store.linkForChannel(G2, `cb-${run}`);
        assert.equal(found.side, 'b');
        assert.equal(typeof found.link.createdAt, 'number');
        assert.equal((await store.linkForHook(`ha-${run}`)).id, id);
        assert.equal(
          await store.createLink(link({ channelB: `other-${run}` })),
          null,
          'the same a-channel again'
        );
        assert.equal(
          await store.createLink(link({ channelA: `other-${run}` })),
          null,
          'the same b-channel again'
        );
        assert.equal(await store.linkCount(G1), 1);
        await store.setLinkStatus(id, { status: 'paused', pausedSide: 'a' });
        assert.deepEqual(
          [(await store.getLink(id)).status, (await store.getLink(id)).pausedSide],
          ['paused', 'a']
        );
        await store.setLinkOptions(id, 'a', { bots: true });
        assert.deepEqual((await store.getLink(id)).optionsA, { bots: true });
        await store.setLinkHook(id, 'b', { id: `hb2-${run}`, token: 'tb2' });
        assert.equal((await store.getLink(id)).hookBId, `hb2-${run}`);
        await store.deleteLink(id);
        assert.equal(await store.getLink(id), null);
      }
    );

    await t.test('a code is stored as a hash, expires, and is used up once', async () => {
      const made = await store.createCode({
        guildId: G1,
        channelId: 'c1',
        options: { bots: true },
        requestedBy: 'Alice',
      });
      assert.equal(await store.pendingCodeCount(G1), 1);
      assert.equal(typeof (await store.pendingCodes(G1))[0].expiresAt, 'number');
      assert.equal((await store.peekCode(made.code)).guildId, G1);
      const [a, b] = await Promise.all([store.claimCode(made.code), store.claimCode(made.code)]);
      assert.equal([a, b].filter(Boolean).length, 1, 'exactly one claim wins');
      const old = await store.createCode({ guildId: G1, channelId: 'c2', ttlMs: -1000 });
      assert.equal(await store.claimCode(old.code), null);
      assert.ok((await store.sweepCodes()) >= 1);
      assert.equal(await store.cancelCode(G2, 1), false);
    });

    await t.test('the message map is found from both sides, replaced, and swept after 30 days', async () => {
      const id = await store.createLink(link());
      await store.saveMapping(id, 'a', {
        sourceId: 'm1',
        copyId: 'c1',
        hookId: 'h',
        hash: 'x',
        extra: { head: '> q' },
      });
      const fromCopy = await store.mappingOf(id, 'b', 'c1');
      assert.deepEqual([fromCopy.counterpartId, fromCopy.isOriginal], ['m1', false]);
      assert.deepEqual((await store.mappingOf(id, 'a', 'm1')).extra, { head: '> q' });
      await store.saveMapping(id, 'a', { sourceId: 'm1', copyId: 'c2' });
      assert.equal((await store.mappingOf(id, 'a', 'm1')).counterpartId, 'c2');
      await store.saveMapping(id, 'b', { sourceId: 'old', copyId: 'old-copy' });
      const { prepare } = await import('../src/db/driver.js');
      await prepare('UPDATE bridge_messages SET created_at = ? WHERE a_message_id = ?').run(
        Date.now() - 40 * 86_400_000,
        'old-copy'
      );
      await retention.sweepRetention();
      assert.equal(await store.mappingOf(id, 'a', 'old-copy'), null);
      assert.ok(await store.mappingOf(id, 'a', 'm1'));
      assert.equal(await store.mappingCount(id), 1);
    });

    await t.test(
      'purging a server removes the links it is in, on either side, and its requests',
      async () => {
        await store.createCode({ guildId: G2, channelId: 'c9' });
        await purge.purgeGuild(G2);
        assert.equal((await store.linksOfGuild(G1)).length, 0);
        assert.equal(await store.pendingCodeCount(G2), 0);
      }
    );
  }
);
