// Proves the driver shim's Postgres branch for temporary roles: the composite-key upsert, BIGINT
// times that come back as numbers, the due query across servers, the conditional delete and the
// erasure statements.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'temporary roles against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const db = await import('../src/db/tempRoles.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-temproles-${Date.now()}`;
    const H = `${G}-other`;
    const put = (over = {}) =>
      db.putTempRole({ guildId: G, userId: 'u1', roleId: 'r1', expiresAt: 1_800_000_000_000, ...over });

    await t.test('a row round-trips with numbers; the same member and role is replaced', async () => {
      await put({ addedBy: 'staff', reason: 'first', createdAt: 1_700_000_000_000 });
      await put({ addedBy: 'other', reason: 'second', expiresAt: 1_900_000_000_000 });
      assert.equal(await db.tempRoleCount(G), 1);
      const row = await db.getTempRole(G, 'u1', 'r1');
      assert.equal(row.expires_at, 1_900_000_000_000);
      assert.equal(typeof row.expires_at, 'number');
      assert.equal(typeof row.created_at, 'number');
      assert.equal(row.added_by, 'other');
      assert.equal(row.reason, 'second');
      assert.equal(await db.getTempRole(H, 'u1', 'r1'), null);
    });

    await t.test('lists, the next expiry and the due rows across servers', async () => {
      await db.clearGuildTempRoles(G);
      await put({ userId: 'a', expiresAt: 300 });
      await put({ userId: 'b', expiresAt: 100 });
      await put({ userId: 'a', roleId: 'r2', expiresAt: 200 });
      await db.putTempRole({ guildId: H, userId: 'z', roleId: 'r1', expiresAt: 150 });
      assert.deepEqual(
        (await db.listTempRoles(G)).map((r) => `${r.user_id}/${r.role_id}`),
        ['b/r1', 'a/r2', 'a/r1']
      );
      assert.equal((await db.listTempRoles(G, { userId: 'a' })).length, 2);
      assert.equal(await db.nextTempRoleExpiry(G), 100);
      assert.equal(typeof (await db.nextTempRoleExpiry(G)), 'number');
      const due = (await db.dueTempRoles(250, 50)).filter((r) => [G, H].includes(r.guild_id));
      assert.deepEqual(
        due.map((r) => `${r.guild_id === G ? 'G' : 'H'}:${r.user_id}`),
        ['G:b', 'H:z', 'G:a']
      );
    });

    await t.test('conditional and per-member deletes report whether they removed a row', async () => {
      assert.equal(await db.deleteTempRoleAt(G, 'b', 'r1', 99), false);
      assert.equal(await db.deleteTempRoleAt(G, 'b', 'r1', 100), true);
      assert.equal(await db.deleteTempRole(G, 'b', 'r1'), false);
      assert.equal(await db.deleteTempRolesOfUser(G, 'a'), 2);
      assert.equal(await db.tempRoleCount(G), 0);
    });

    await t.test(
      'forgetUser, describeUserData and purgeGuild cover the member and the staff name',
      async () => {
        await db.clearGuildTempRoles(G);
        await db.clearGuildTempRoles(H);
        await put({ userId: 'victim', roleId: 'r1', addedBy: 'staff' });
        await put({ userId: 'victim', roleId: 'r2', addedBy: 'staff' });
        await put({ userId: 'other', roleId: 'r1', addedBy: 'victim', reason: 'by victim' });
        await db.putTempRole({ guildId: H, userId: 'victim', roleId: 'r1', expiresAt: 5, addedBy: 'victim' });

        const seen = await purge.describeUserData(G, 'victim');
        const n = (key) => seen.items.find((i) => i.key === key).count;
        assert.deepEqual([n('tempRoles'), n('tempRoleAdders')], [2, 1]);
        const exported = await purge.exportUserData(G, 'victim');
        assert.equal(exported.data.tempRoles.length, 2);
        assert.equal(exported.data.tempRoleAdders[0].reason, 'by victim');

        const r = await purge.forgetUser(G, 'victim');
        assert.deepEqual([r.tempRoles, r.tempRoleAdders], [2, 1]);
        assert.equal(await db.getTempRole(G, 'victim', 'r1'), null);
        assert.equal((await db.getTempRole(G, 'other', 'r1')).added_by, null);
        assert.equal((await db.getTempRole(H, 'victim', 'r1')).added_by, 'victim');

        await purge.purgeGuild(G);
        assert.equal(await db.tempRoleCount(G), 0);
        assert.equal(await db.tempRoleCount(H), 1);
        await purge.purgeGuild(H);
        assert.equal(await db.tempRoleCount(H), 0);
      }
    );
  }
);
