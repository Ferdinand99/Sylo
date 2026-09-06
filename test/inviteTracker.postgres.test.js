// Proves the driver shim's Postgres branch for the 3 invite-tracker tables —
// composite natural PKs, upsert-with-increment (`regular = invite_counts.regular
// + @delta`, table-qualified so Postgres doesn't treat it as ambiguous between
// the current row and `excluded` — SQLite accepts either form), and an
// aliased correlated-subquery rank query. Same assertions as
// inviteTracker.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'inviteTracker against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      getInviteCount,
      bumpRegular,
      bumpLeaves,
      setBonus,
      topInviters,
      inviterRank,
      inviterCount,
      recordJoin,
      getJoin,
      deleteJoin,
      setPersonalCode,
      personalCodeOwner,
      clearGuildInvites,
    } = await import('../src/db/inviteTracker.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-invites-${Date.now()}`;

    await t.test('net = regular - leaves + bonus; setBonus overwrites', async () => {
      const u = '111111111111111111';
      await bumpRegular(G, u, 5);
      await bumpLeaves(G, u, 2);
      await setBonus(G, u, 3);
      let c = await getInviteCount(G, u);
      assert.equal(c.net, 6);

      await setBonus(G, u, 4);
      c = await getInviteCount(G, u);
      assert.equal(c.bonus, 4);
    });

    await t.test('bumpRegular increments in place (table-qualified column ref in ON CONFLICT)', async () => {
      const u = '111111111111111111';
      const before = (await getInviteCount(G, u)).regular;
      await bumpRegular(G, u, 3);
      const after = (await getInviteCount(G, u)).regular;
      assert.equal(after, before + 3);
    });

    await t.test('topInviters excludes non-positive net; inviterRank/inviterCount', async () => {
      await bumpRegular(G, '222222222222222222', 3);
      await bumpRegular(G, '333333333333333333', 1);
      await bumpLeaves(G, '333333333333333333', 5); // net negative, excluded

      const top = await topInviters(G, 10);
      assert.ok(top.some((r) => r.user_id === '111111111111111111'));
      assert.ok(!top.some((r) => r.user_id === '333333333333333333'));
      assert.equal(await inviterCount(G), 2);
      assert.equal(await inviterRank(G, '111111111111111111'), 1);
    });

    await t.test(
      'join records + personal codes round-trip; clearGuildInvites wipes all three tables',
      async () => {
        const joiner = '444444444444444444';
        await recordJoin(G, joiner, { inviterId: '111111111111111111', code: 'abcd', joinedAt: 1000 });
        let j = await getJoin(G, joiner);
        assert.equal(j.inviter_id, '111111111111111111');

        await recordJoin(G, joiner, { source: 'vanity', joinedAt: 2000, counted: 0 });
        j = await getJoin(G, joiner);
        assert.equal(j.inviter_id, null);
        assert.equal(j.source, 'vanity');

        await setPersonalCode(G, '111111111111111111', 'xYz123');
        assert.equal(await personalCodeOwner(G, 'xYz123'), '111111111111111111');

        await deleteJoin(G, joiner);
        assert.equal(await getJoin(G, joiner), null);

        await clearGuildInvites(G);
        assert.equal((await getInviteCount(G, '111111111111111111')).net, 0);
        assert.equal(await personalCodeOwner(G, 'xYz123'), null);
      }
    );
  }
);
