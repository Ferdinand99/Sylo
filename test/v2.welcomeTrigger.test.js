// The "when to welcome" setting through the dashboard API: what the form is given, what a save keeps,
// and the warning for a role mode with no usable role.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule } from '../src/db/modules.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

const read = async () => (await (await api.get('/modules/welcome/config')).json()).config;
const stored = async () => (await getGuildModule(GID, 'welcome')).config;

test('a server that never set it is given "join" and no roles, and the {role} placeholder', async () => {
  const res = await (await api.get('/modules/welcome/config')).json();
  assert.equal(res.config.trigger, 'join');
  assert.deepEqual(res.config.triggerRoleIds, []);
  assert.ok(res.placeholders.includes('{role}'));
  assert.ok(
    res.roles.every((r) => r.id !== ROLE.bot && r.id !== ROLE.everyone),
    'the picker offers no managed role and no @everyone'
  );
});

test('saving "when a member gets a role" keeps the usable roles and drops the rest', async () => {
  const res = await api.post('/modules/welcome/config', {
    trigger: 'role',
    triggerRoleIds: [ROLE.member, ROLE.member, ROLE.everyone, ROLE.bot, '100000000000000999', 'junk'],
    joinEnabled: true,
    joinChannel: '100000000000000001',
    joinMessage: 'Welcome {user}, you got {role}',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.trigger, 'role');
  assert.deepEqual(body.config.triggerRoleIds, [ROLE.member]);
  assert.equal(body.warning, undefined);
  assert.equal((await stored()).trigger, 'role');
  assert.deepEqual((await stored()).triggerRoleIds, [ROLE.member]);
  assert.deepEqual(await read().then((c) => [c.trigger, c.triggerRoleIds]), ['role', [ROLE.member]]);
});

test('the server stamps the roles when they start counting, and keeps the stamps of roles that stay', async () => {
  await api.post('/modules/welcome/config', { trigger: 'join' });
  assert.deepEqual((await stored()).triggerSince, {}, 'nothing counts in join mode');
  const before = Date.now();
  await api.post('/modules/welcome/config', {
    trigger: 'role',
    triggerRoleIds: [ROLE.member],
    triggerSince: { [ROLE.member]: 1, [ROLE.admin]: 1 },
  });
  const first = (await stored()).triggerSince;
  assert.deepEqual(Object.keys(first), [ROLE.member], 'a time sent by the client is ignored');
  assert.ok(first[ROLE.member] >= before);
  await new Promise((r) => setTimeout(r, 5));
  await api.post('/modules/welcome/config', { trigger: 'role', triggerRoleIds: [ROLE.member, ROLE.admin] });
  const second = (await stored()).triggerSince;
  assert.equal(second[ROLE.member], first[ROLE.member], 'a role that stays keeps its time');
  assert.ok(second[ROLE.admin] > first[ROLE.member], 'an added role starts now');
  // a client that leaves the fields out keeps the times too (the Sylo app)
  await api.post('/modules/welcome/config', { joinEnabled: true });
  assert.deepEqual((await stored()).triggerSince, second);
  await api.post('/modules/welcome/config', { trigger: 'role', triggerRoleIds: [ROLE.admin] });
  assert.deepEqual(Object.keys((await stored()).triggerSince), [ROLE.admin], 'a removed role loses its time');
});

test('a bad trigger is saved as "join"', async () => {
  const res = await api.post('/modules/welcome/config', {
    trigger: 'whenever',
    triggerRoleIds: [ROLE.member],
  });
  assert.equal(res.status, 200);
  assert.equal((await stored()).trigger, 'join');
  assert.deepEqual(
    (await stored()).triggerRoleIds,
    [ROLE.member],
    'the roles stay for when it is switched back'
  );
});

test('role mode with no usable role saves, with a warning', async () => {
  const res = await api.post('/modules/welcome/config', {
    trigger: 'role',
    triggerRoleIds: [ROLE.bot, ROLE.everyone],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.trigger, 'role');
  assert.deepEqual(body.config.triggerRoleIds, []);
  assert.match(body.warning, /no welcome is sent/i);
  assert.equal((await stored()).trigger, 'role');

  const none = await (await api.post('/modules/welcome/config', { trigger: 'role' })).json();
  assert.match(none.warning, /no welcome is sent/i, 'no roles sent at all, and none kept before');
});

test('a client that leaves the fields out (the Sylo app) keeps what is saved', async () => {
  await api.post('/modules/welcome/config', { trigger: 'role', triggerRoleIds: [ROLE.member] });
  const res = await api.post('/modules/welcome/config', { joinEnabled: true, joinMessage: 'hi' });
  assert.equal(res.status, 200);
  assert.equal((await stored()).trigger, 'role');
  assert.deepEqual((await stored()).triggerRoleIds, [ROLE.member]);
  assert.equal((await stored()).joinEnabled, true);
});

test('a role that was deleted or became managed since is not shown in the form', async () => {
  await api.post('/modules/welcome/config', { trigger: 'role', triggerRoleIds: [ROLE.member] });
  const { setGuildModule } = await import('../src/db/modules.js');
  await setGuildModule(GID, 'welcome', {
    config: { ...(await stored()), triggerRoleIds: [ROLE.member, ROLE.bot, '100000000000000998'] },
  });
  assert.deepEqual((await read()).triggerRoleIds, [ROLE.member]);
});
