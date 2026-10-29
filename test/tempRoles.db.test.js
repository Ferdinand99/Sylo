// Temporary roles storage on SQLite, and the per-member and per-server erasure that covers it.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearGuildTempRoles,
  deleteTempRole,
  deleteTempRoleAt,
  deleteTempRolesOfUser,
  dueTempRoles,
  getTempRole,
  listTempRoles,
  nextTempRoleExpiry,
  putTempRole,
  tempRoleCount,
} from '../src/db/tempRoles.js';
import { GUILD_TABLES, describeUserData, exportUserData, forgetUser, purgeGuild } from '../src/db/purge.js';

const G = '900000000000000521';
const H = '900000000000000522';
const put = (over = {}) =>
  putTempRole({ guildId: G, userId: 'u1', roleId: 'r1', expiresAt: 10_000, addedBy: 'staff', ...over });

test('a row round-trips with numbers, and one row exists per member and role', async () => {
  await put({ reason: 'trial', createdAt: 5000 });
  const row = await getTempRole(G, 'u1', 'r1');
  assert.deepEqual(
    { ...row },
    {
      guild_id: G,
      user_id: 'u1',
      role_id: 'r1',
      expires_at: 10_000,
      added_by: 'staff',
      reason: 'trial',
      created_at: 5000,
    }
  );
  assert.equal(typeof row.expires_at, 'number');
  assert.equal(await getTempRole(G, 'u1', 'other'), null);
  assert.equal(await getTempRole(H, 'u1', 'r1'), null, 'another server does not see it');
  assert.equal(await tempRoleCount(G), 1);
});

test('putting the same member and role again replaces the row', async () => {
  const g = '900000000000000523';
  await put({ guildId: g, expiresAt: 1000, reason: 'first', addedBy: 'a' });
  await put({ guildId: g, expiresAt: 9000, reason: 'second', addedBy: 'b', createdAt: 77 });
  assert.equal(await tempRoleCount(g), 1);
  const row = await getTempRole(g, 'u1', 'r1');
  assert.equal(row.expires_at, 9000);
  assert.equal(row.reason, 'second');
  assert.equal(row.added_by, 'b');
  assert.equal(row.created_at, 77);
  await put({ guildId: g, roleId: 'r2' });
  await put({ guildId: g, userId: 'u2' });
  assert.equal(await tempRoleCount(g), 3, 'another role or member is another row');
});

test('lists are per server, soonest first, optionally for one member', async () => {
  const g = '900000000000000524';
  await put({ guildId: g, userId: 'a', roleId: 'r1', expiresAt: 300 });
  await put({ guildId: g, userId: 'b', roleId: 'r1', expiresAt: 100 });
  await put({ guildId: g, userId: 'a', roleId: 'r2', expiresAt: 200 });
  await put({ guildId: H, userId: 'a', roleId: 'r1', expiresAt: 50 });
  const pairs = (rows) => rows.map((r) => `${r.user_id}/${r.role_id}`);
  assert.deepEqual(pairs(await listTempRoles(g)), ['b/r1', 'a/r2', 'a/r1']);
  assert.deepEqual(pairs(await listTempRoles(g, { userId: 'a' })), ['a/r2', 'a/r1']);
  assert.equal((await listTempRoles(g, { limit: 2 })).length, 2);
  assert.equal(await nextTempRoleExpiry(g), 100);
  assert.equal(await nextTempRoleExpiry('900000000000000999'), null);
});

test('due rows span every server, are oldest first, and include the exact moment', async () => {
  const g = '900000000000000525';
  const h = '900000000000000526';
  await put({ guildId: g, userId: 'late', expiresAt: 5_000_000 });
  await put({ guildId: g, userId: 'exact', expiresAt: 4_000_000 });
  await put({ guildId: h, userId: 'early', expiresAt: 3_000_000 });
  const due = (await dueTempRoles(4_000_000)).filter((r) => [g, h].includes(r.guild_id));
  assert.deepEqual(
    due.map((r) => r.user_id),
    ['early', 'exact']
  );
  assert.equal((await dueTempRoles(4_000_000, 1)).length, 1, 'the batch size is honoured');
});

test('delete: by member and role, only if the time is unchanged, and all of a member', async () => {
  const g = '900000000000000527';
  await put({ guildId: g, userId: 'a', roleId: 'r1', expiresAt: 100 });
  await put({ guildId: g, userId: 'a', roleId: 'r2', expiresAt: 100 });
  await put({ guildId: g, userId: 'b', roleId: 'r1', expiresAt: 100 });
  assert.equal(await deleteTempRoleAt(g, 'a', 'r1', 99), false, 'an extended row survives');
  assert.ok(await getTempRole(g, 'a', 'r1'));
  assert.equal(await deleteTempRoleAt(g, 'a', 'r1', 100), true);
  assert.equal(await deleteTempRole(g, 'a', 'r1'), false, 'already gone');
  assert.equal(await deleteTempRolesOfUser(g, 'a'), 1);
  assert.equal(await tempRoleCount(g), 1);
  await clearGuildTempRoles(g);
  assert.equal(await tempRoleCount(g), 0);
});

test('/forget drops the member rows and the staff name; the role itself is not touched', async () => {
  const g = '900000000000000528';
  await put({ guildId: g, userId: 'victim', roleId: 'r1', addedBy: 'staff' });
  await put({ guildId: g, userId: 'victim', roleId: 'r2', addedBy: 'staff' });
  await put({ guildId: g, userId: 'bystander', roleId: 'r1', addedBy: 'victim', reason: 'by victim' });
  await put({ guildId: H, userId: 'victim', roleId: 'r1', addedBy: 'victim' });

  const seen = await describeUserData(g, 'victim');
  const count = (key) => seen.items.find((i) => i.key === key);
  assert.equal(count('tempRoles').count, 2);
  assert.equal(count('tempRoleAdders').count, 1);
  assert.equal(count('tempRoles').kept, false);
  assert.ok(seen.erasable >= 3);

  const exported = await exportUserData(g, 'victim');
  assert.equal(exported.data.tempRoles.length, 2);
  assert.equal(exported.data.tempRoleAdders[0].reason, 'by victim');
  assert.equal(exported.data.tempRoleAdders[0].added_by, undefined, 'the list does not repeat the name');

  const result = await forgetUser(g, 'victim');
  assert.equal(result.tempRoles, 2);
  assert.equal(result.tempRoleAdders, 1);
  assert.equal(await getTempRole(g, 'victim', 'r1'), null);
  assert.equal(await getTempRole(g, 'victim', 'r2'), null);
  const kept = await getTempRole(g, 'bystander', 'r1');
  assert.ok(kept, 'the other member keeps theirs');
  assert.equal(kept.added_by, null);
  assert.equal(kept.reason, 'by victim');
  assert.equal((await getTempRole(H, 'victim', 'r1')).added_by, 'victim', 'another server is untouched');
  assert.equal((await describeUserData(g, 'victim')).items.find((i) => i.key === 'tempRoles').count, 0);
});

test('purgeGuild removes the rows; the table is on the guild list', async () => {
  assert.ok(GUILD_TABLES.includes('guild_temp_roles'));
  const a = '900000000000000529';
  const b = '900000000000000530';
  await put({ guildId: a });
  await put({ guildId: b });
  await purgeGuild(a);
  assert.equal(await tempRoleCount(a), 0);
  assert.equal(await tempRoleCount(b), 1);
});
