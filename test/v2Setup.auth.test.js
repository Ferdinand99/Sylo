// Who may use the setup wizard's routes: a signed-out caller, someone who does not manage the server and
// the admin of another server are refused, and applying needs the CSRF header. Nothing is stored or
// audited by a refused call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { listAudit } = await import('../src/db/audit.js');
const { getGuildModule } = await import('../src/db/modules.js');

const BODY = { items: [{ id: 'welcome', fields: { joinChannel: { create: true } } }] };
const run = (who, g) => async (method) =>
  method === 'GET' ? who.get(`/guilds/${g}/setup/suggest`) : who.post(`/guilds/${g}/setup/apply`, BODY);

async function assertUntouched(note) {
  for (const g of [D_GUILD, OTHER_D_GUILD]) {
    assert.deepEqual(await listAudit(g, 20), [], `${note}: no audit rows (${g})`);
    assert.equal((await getGuildModule(g, 'welcome')).enabled, false, `${note}: welcome stays off`);
  }
}

test('signed out: both routes are refused', async () => {
  const call = run(anonymous(), D_GUILD);
  for (const method of ['GET', 'POST']) {
    const { status } = await call(method);
    assert.ok([401, 403].includes(status), `${method} -> ${status}`);
  }
  await assertUntouched('signed out');
});

test('a member without Manage Server, and the admin of another server, are refused', async () => {
  const member = await session({ guilds: [{ id: D_GUILD, owner: false, permissions: '0' }] });
  for (const method of ['GET', 'POST']) {
    assert.equal((await run(member, D_GUILD)(method)).status, 403, `member ${method}`);
  }
  const admin = await session(); // owner of D_GUILD only
  for (const method of ['GET', 'POST']) {
    assert.equal((await run(admin, OTHER_D_GUILD)(method)).status, 403, `other server ${method}`);
  }
  await assertUntouched('refused');
});

test('the admin of the server reads the proposal, and applying needs the CSRF token', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;

  const read = await b.get(`/api/v2/guilds/${D_GUILD}/setup/suggest`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.equal(body.goals.length, 5);
  assert.equal(body.platform, 'discord');

  const post = (headers) =>
    b.get(`/api/v2/guilds/${D_GUILD}/setup/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ items: [] }),
    });
  assert.equal((await post({})).status, 403, 'no token');
  assert.equal((await post({ 'x-csrf-token': 'not-the-token' })).status, 403, 'wrong token');
  assert.equal((await post({ 'x-csrf-token': token })).status, 400, 'with the token it reaches the route');
  await assertUntouched('after the checks');
});
