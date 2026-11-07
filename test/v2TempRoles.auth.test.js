// Who may use the Temporary roles routes: a signed-out caller, someone who does not manage the server
// and the admin of another server are refused (the shared lists in helpers/v2Guarded.js also run in
// v2.permissions*.test.js), a state-changing call needs the CSRF header, and a role is only handed out
// (or taken back) by someone who may hand it out themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';
import { runtime } from '../src/runtime.js';

await startOAuthApp();

const { getTempRole, putTempRole, tempRoleCount } = await import('../src/db/tempRoles.js');
const { setGuildModule } = await import('../src/db/modules.js');
const { listAudit } = await import('../src/db/audit.js');

const ROLE_ID = '100000000000000700';
const USER_ID = '100000000000000011';

const ROUTES = (g) => [
  ['GET', `/guilds/${g}/modules/temp-roles/config`],
  ['GET', `/guilds/${g}/modules/temp-roles/list`],
  ['GET', `/guilds/${g}/modules/temp-roles/members?q=a`],
  ['POST', `/guilds/${g}/modules/temp-roles/config`],
  ['POST', `/guilds/${g}/modules/temp-roles/add`],
  ['POST', `/guilds/${g}/modules/temp-roles/remove`],
];

test('signed out: every Temporary roles route is refused', async () => {
  const nobody = anonymous();
  for (const [method, path] of ROUTES(D_GUILD)) {
    const res = method === 'GET' ? await nobody.get(path) : await nobody.post(path, {});
    assert.ok([401, 403].includes(res.status), `${method} ${path} -> ${res.status}`);
  }
});

test('a member without Manage Server, and the admin of another server, are refused', async () => {
  await putTempRole({ guildId: D_GUILD, userId: USER_ID, roleId: ROLE_ID, expiresAt: Date.now() + 60_000 });
  const body = { userId: USER_ID, roleId: ROLE_ID, duration: '1d' };
  const member = await session({
    guilds: [{ id: D_GUILD, owner: false, permissions: '0' }],
  });
  for (const [method, path] of ROUTES(D_GUILD)) {
    const res = method === 'GET' ? await member.get(path) : await member.post(path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const admin = await session(); // owner of D_GUILD only
  for (const [method, path] of ROUTES(OTHER_D_GUILD)) {
    const res = method === 'GET' ? await admin.get(path) : await admin.post(path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.ok(await getTempRole(D_GUILD, USER_ID, ROLE_ID), 'nothing was removed');
  assert.equal(await tempRoleCount(D_GUILD), 1);
  assert.deepEqual(await listAudit(D_GUILD, 20), []);
});

test('the admin of the server gets in, and a POST needs the CSRF token', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const url = `/api/v2/guilds/${D_GUILD}/modules/temp-roles/remove`;
  const post = (headers) =>
    b.get(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ userId: '100000000000000099', roleId: ROLE_ID }),
    });

  const read = await b.get(`/api/v2/guilds/${D_GUILD}/modules/temp-roles/config`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).list.total, 1);

  assert.equal((await post({})).status, 403, 'no token');
  assert.equal((await post({ 'x-csrf-token': 'not-the-token' })).status, 403, 'wrong token');
  const ok = await post({ 'x-csrf-token': token });
  assert.equal(ok.status, 404, 'with the token it reaches the route, which finds no such record');
  assert.match((await ok.json()).error, /does not have that role/);
  assert.equal(await tempRoleCount(D_GUILD), 1);
});

test('a role is checked against the person using the dashboard, for adding and for taking back', async () => {
  const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
  guild.roles.cache.set(ROLE_ID, { id: ROLE_ID, name: 'Perk', position: 3, managed: false });
  await setGuildModule(D_GUILD, 'temp-roles', { enabled: true, config: {} });

  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const post = (path, body) =>
    b.get(`/api/v2/guilds/${D_GUILD}/modules/temp-roles/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': token },
      body: JSON.stringify(body),
    });

  // The fake server has no member for the signed-in person, so they cannot be shown to outrank the role.
  const add = await post('add', { userId: USER_ID, roleId: ROLE_ID, duration: '1d' });
  assert.equal(add.status, 403);
  assert.match((await add.json()).error, /can't hand out Perk/);
  const remove = await post('remove', { userId: USER_ID, roleId: ROLE_ID });
  assert.equal(remove.status, 403);
  assert.ok(await getTempRole(D_GUILD, USER_ID, ROLE_ID), 'the record is still there');
  guild.roles.cache.delete(ROLE_ID);
});
