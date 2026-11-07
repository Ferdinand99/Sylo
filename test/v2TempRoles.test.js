// The Temporary roles page of the new dashboard: settings, the filterable list, the member search,
// add and remove through /api/v2, with the side effects (stored rows, role calls, mod log, DMs,
// audit rows) asserted. Who may call these routes, and the CSRF header, are in
// v2.permissions*.test.js and v2TempRoles.auth.test.js.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { setModlogChannel } from '../src/db/guildSettings.js';
import { getTempRole, putTempRole, tempRoleCount } from '../src/db/tempRoles.js';

const U = ['100000000000000011', '100000000000000012', '100000000000000013'];
const NAMES = { [U[0]]: 'Alice', [U[1]]: 'Bob', [U[2]]: 'Carol' };
const DAY = 86_400_000;

let app;
let api;
const calls = [];
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  const { guild } = app;
  const member = (id) => {
    const cache = new Map();
    return {
      id,
      displayName: NAMES[id],
      user: { id, username: NAMES[id].toLowerCase(), bot: false },
      roles: {
        cache,
        add: async (role, reason) => {
          cache.set(role.id, role);
          calls.push(['add', id, role.id, reason]);
        },
        remove: async (role, reason) => {
          cache.delete(role.id);
          calls.push(['remove', id, role.id, reason]);
        },
      },
    };
  };
  for (const id of U) guild.members.cache.set(id, member(id));
  guild.members.fetch = async (id) =>
    guild.members.cache.get(id) ?? Promise.reject(new Error('Unknown Member'));
  await setModlogChannel(GID, CH.general);
});
test.after(() => app.close());

const json = async (res) => res.json();
const enable = (config = {}) => setGuildModule(GID, 'temp-roles', { enabled: true, config });
const titles = () => app.sink.messages.map((m) => m.payload.embeds[0].toJSON().title);

test('GET config: the defaults, the assignable roles and an empty list', async () => {
  const res = await api.get('/modules/temp-roles/config');
  assert.equal(res.status, 200);
  const data = await json(res);
  assert.deepEqual(data.config, { staffRoles: [], dmMember: false, defaultDuration: '7d' });
  assert.ok(data.roles.some((r) => r.id === ROLE.member));
  assert.ok(!data.roles.some((r) => r.id === ROLE.bot), 'a managed role cannot be offered');
  assert.ok(!data.roles.some((r) => r.id === ROLE.everyone));
  assert.deepEqual(data.list, { total: 0, matching: 0, rows: [] });
});

test('POST config stores the normalised settings and writes an audit row', async () => {
  const res = await api.post('/modules/temp-roles/config', {
    staffRoles: [ROLE.admin, 'junk'],
    dmMember: true,
    defaultDuration: ' 3D ',
  });
  assert.equal(res.status, 200);
  const stored = (await getGuildModule(GID, 'temp-roles')).config;
  assert.deepEqual(stored, { staffRoles: [ROLE.admin], dmMember: true, defaultDuration: '3d' });
  assert.deepEqual((await json(await api.get('/modules/temp-roles/config'))).config, stored);
  const audit = (await auditRows(GID, 'module:temp-roles'))[0];
  assert.equal(audit.detail, 'settings saved');
  assert.equal(audit.actor, 'Dashboard');
  const bad = await json(await api.post('/modules/temp-roles/config', { defaultDuration: '9999d' }));
  assert.equal(bad.config.defaultDuration, '7d');
  await api.post('/modules/temp-roles/config', {});
});

test('add: needs the module on, a member, a listed role and a good time', async () => {
  const body = { userId: U[0], roleId: ROLE.member, duration: '1d' };
  const off = await json(await api.post('/modules/temp-roles/add', body));
  assert.match(off.error, /Turn the Temporary roles module on/);
  await enable();
  const refuse = async (over, pattern) => {
    const res = await api.post('/modules/temp-roles/add', { ...body, ...over });
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.match((await json(res)).error, pattern, JSON.stringify(over));
  };
  await refuse({ userId: 'nope' }, /Pick a member/);
  await refuse({ roleId: ROLE.bot }, /Pick a role from the list/);
  await refuse({ roleId: ROLE.everyone }, /Pick a role from the list/);
  await refuse({ roleId: '100000000000009999' }, /Pick a role from the list/);
  await refuse({ duration: '' }, /Give a duration/);
  await refuse({ duration: '2 days' }, /not a duration/);
  await refuse({ duration: '366d' }, /365 days/);
  await refuse({ userId: '100000000000000099' }, /not in this server/);
  assert.equal(await tempRoleCount(GID), 0);
  assert.deepEqual(calls, []);
});

test('add gives the role, stores the row, writes the mod log and the audit row; the DM follows the setting', async () => {
  await enable();
  const res = await api.post('/modules/temp-roles/add', {
    userId: U[0],
    roleId: ROLE.member,
    duration: '2h',
    reason: 'Trial',
  });
  assert.equal(res.status, 200);
  const out = await json(res);
  assert.equal(out.replaced, false);
  assert.equal(out.dm, false);
  assert.ok(Math.abs(out.expiresAt - (Date.now() + 2 * 3_600_000)) < 60_000);
  assert.equal(out.list.total, 1);
  const row = out.list.rows[0];
  assert.equal(row.userId, U[0]);
  assert.equal(row.member, 'Alice');
  assert.equal(row.roleId, ROLE.member);
  assert.equal(row.role, 'Member');
  assert.equal(row.reason, 'Trial');
  assert.equal(row.addedBy, null, 'open mode has no person behind the call');
  assert.deepEqual(calls[0].slice(0, 3), ['add', U[0], ROLE.member]);
  assert.equal((await getTempRole(GID, U[0], ROLE.member)).reason, 'Trial');
  assert.ok(titles().includes('Temporary role added'));
  assert.match((await auditRows(GID, 'module:temp-roles'))[0].detail, /added Alice \/ Member/);
  assert.equal(app.sink.dms.length, 0);

  await enable({ dmMember: true });
  const dm = await json(
    await api.post('/modules/temp-roles/add', { userId: U[1], roleId: ROLE.member, duration: '1d' })
  );
  assert.equal(dm.dm, true);
  assert.equal(app.sink.dms.length, 1);
  assert.equal(app.sink.dms[0].id, U[1]);
});

test('adding again replaces the time and says so; the role is not given twice', async () => {
  await enable();
  const before = calls.filter((c) => c[0] === 'add' && c[1] === U[0]).length;
  const res = await json(
    await api.post('/modules/temp-roles/add', { userId: U[0], roleId: ROLE.member, duration: '30d' })
  );
  assert.equal(res.replaced, true);
  assert.equal(calls.filter((c) => c[0] === 'add' && c[1] === U[0]).length, before);
  const row = await getTempRole(GID, U[0], ROLE.member);
  assert.ok(row.expires_at > Date.now() + 29 * DAY);
  assert.ok(titles().includes('Temporary role replaced'));
});

test('the list is filtered by text (name, id, role, reason) and by role; the total is always counted', async () => {
  await putTempRole({
    guildId: GID,
    userId: U[2],
    roleId: ROLE.admin,
    expiresAt: Date.now() + 1000,
    reason: 'Moderator trial',
    addedBy: U[0],
  });
  const list = async (query) => (await json(await api.get(`/modules/temp-roles/list${query}`))).list;
  const all = await list('');
  assert.equal(all.total, 3);
  assert.equal(all.rows[0].member, 'Carol', 'soonest first');
  assert.equal(all.rows[0].addedByName, 'Alice');
  assert.equal((await list('?q=bob')).rows.length, 1);
  assert.equal((await list(`?q=${U[2]}`)).rows.length, 1);
  assert.equal((await list('?q=moderator')).rows[0].member, 'Carol');
  assert.equal((await list('?q=admins')).rows.length, 1, 'by role name');
  assert.equal((await list(`?roleId=${ROLE.member}`)).matching, 2);
  const none = await list('?q=nobody');
  assert.deepEqual([none.total, none.matching, none.rows.length], [3, 0, 0]);
  assert.equal((await list('?roleId=junk')).matching, 3, 'an invalid role filter is ignored');
});

test('member search: by name in the cache, by a pasted id, never a bot, at most ten', async () => {
  const search = async (q) =>
    (await json(await api.get(`/modules/temp-roles/members?q=${encodeURIComponent(q)}`))).members;
  assert.deepEqual(await search(''), []);
  assert.deepEqual(await search('ali'), [{ id: U[0], name: 'Alice', username: 'alice' }]);
  assert.equal((await search('CAROL')).length, 1, 'case does not matter');
  assert.deepEqual(await search('zzz'), []);
  assert.equal((await search(U[1]))[0].name, 'Bob');
  assert.deepEqual(await search('100000000000000098'), [], 'an id of nobody finds nobody');

  const { guild } = app;
  const bot = '100000000000000500';
  guild.members.cache.set(bot, {
    id: bot,
    displayName: 'Robot Bob',
    user: { id: bot, username: 'robotbob', bot: true },
  });
  assert.equal((await search('bob')).length, 1, 'the bot is left out');
  const many = Array.from({ length: 15 }, (_, i) => String(100000000000000600n + BigInt(i)));
  for (const [i, id] of many.entries()) {
    guild.members.cache.set(id, {
      id,
      displayName: `Many ${i}`,
      user: { id, username: `many${i}`, bot: false },
    });
  }
  assert.equal((await search('many')).length, 10);
  for (const id of [bot, ...many]) guild.members.cache.delete(id);
});

test('remove takes the role back, deletes the row, logs it and answers with the list', async () => {
  const res = await api.post('/modules/temp-roles/remove', {
    userId: U[0],
    roleId: ROLE.member,
    reason: 'Done',
  });
  assert.equal(res.status, 200);
  const out = await json(res);
  assert.equal(out.roleRemoved, true);
  assert.equal(out.warning, null);
  assert.equal(out.list.total, 2);
  assert.equal(await getTempRole(GID, U[0], ROLE.member), null);
  assert.deepEqual(calls.at(-1).slice(0, 3), ['remove', U[0], ROLE.member]);
  assert.ok(titles().includes('Temporary role removed early'));
  assert.match((await auditRows(GID, 'module:temp-roles'))[0].detail, /removed Alice \/ Member/);

  const gone = await api.post('/modules/temp-roles/remove', { userId: U[0], roleId: ROLE.member });
  assert.equal(gone.status, 404);
  assert.match((await json(gone)).error, /does not have that role/);
  const bad = await api.post('/modules/temp-roles/remove', { userId: 'x', roleId: ROLE.member });
  assert.equal(bad.status, 400);
});

test('remove still works for a deleted role, and warns when Sylo can no longer take the role', async () => {
  const { guild } = app;
  const lostRole = '100000000000000777';
  await putTempRole({ guildId: GID, userId: U[1], roleId: lostRole, expiresAt: Date.now() + 5000 });
  const a = await api.post('/modules/temp-roles/remove', { userId: U[1], roleId: lostRole });
  assert.equal(a.status, 200);
  assert.equal(await getTempRole(GID, U[1], lostRole), null);

  const highest = guild.members.me.roles.highest;
  const compare = highest.comparePositionTo;
  highest.comparePositionTo = () => -1; // Sylo lost its rank
  const out = await json(await api.post('/modules/temp-roles/remove', { userId: U[1], roleId: ROLE.member }));
  highest.comparePositionTo = compare;
  assert.equal(out.roleRemoved, false);
  assert.match(out.warning, /still on the member/);
  assert.equal(await getTempRole(GID, U[1], ROLE.member), null, 'the record is gone anyway');
});
