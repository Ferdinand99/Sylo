// Who may use the Events routes: a signed-out caller, someone who does not manage the server and
// the admin of another server are refused (the shared lists in helpers/v2Guarded.js also run in
// v2.permissions*.test.js), and a state-changing call needs the CSRF header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { upcomingEvents } = await import('../src/db/events.js');
const { listAudit } = await import('../src/db/audit.js');

const ROUTES = (g) => [
  ['GET', `/guilds/${g}/modules/events/config`],
  ['POST', `/guilds/${g}/modules/events/config`],
  ['POST', `/guilds/${g}/modules/events/events`],
  ['POST', `/guilds/${g}/modules/events/events/1`],
  ['POST', `/guilds/${g}/modules/events/events/1/cancel`],
];

test('signed out: every Events route is refused', async () => {
  const nobody = anonymous();
  for (const [method, path] of ROUTES(D_GUILD)) {
    const res = method === 'GET' ? await nobody.get(path) : await nobody.post(path, {});
    assert.ok([401, 403].includes(res.status), `${method} ${path} -> ${res.status}`);
  }
});

test('a member without Manage Server, and the admin of another server, are refused', async () => {
  const member = await session({
    guilds: [{ id: D_GUILD, owner: false, permissions: '0' }],
  });
  for (const [method, path] of ROUTES(D_GUILD)) {
    const res = method === 'GET' ? await member.get(path) : await member.post(path, {});
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const admin = await session(); // owner of D_GUILD only
  for (const [method, path] of ROUTES(OTHER_D_GUILD)) {
    const res = method === 'GET' ? await admin.get(path) : await admin.post(path, {});
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.deepEqual(await upcomingEvents(D_GUILD), []);
  assert.deepEqual(await listAudit(D_GUILD, 20), []);
});

test('the admin of the server gets in, and a POST needs the CSRF token', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const url = `/api/v2/guilds/${D_GUILD}/modules/events/events/1/cancel`;
  const post = (headers) =>
    b.get(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: '{}',
    });

  const read = await b.get(`/api/v2/guilds/${D_GUILD}/modules/events/config`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).events, []);

  assert.equal((await post({})).status, 403, 'no token');
  assert.equal((await post({ 'x-csrf-token': 'not-the-token' })).status, 403, 'wrong token');
  const ok = await post({ 'x-csrf-token': token });
  assert.equal(ok.status, 404, 'with the token it reaches the route, which finds no such event');
  assert.match((await ok.json()).error, /No such event/);
});
