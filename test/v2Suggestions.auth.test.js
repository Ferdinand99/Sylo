// Who may use the Suggestions routes: a signed-out caller, someone who does not manage the server and
// the admin of another server are refused (the shared lists in helpers/v2Guarded.js also run in
// v2.permissions*.test.js), and a state-changing call needs the CSRF header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, OTHER_D_GUILD, browser, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';
import { anonymous, session } from './helpers/v2Guarded.js';

await startOAuthApp();

const { createSuggestion, getSuggestionByNumber, suggestionCount } = await import('../src/db/suggestions.js');
const { listAudit } = await import('../src/db/audit.js');

const ROUTES = (g) => [
  ['GET', `/guilds/${g}/modules/suggestions/config`],
  ['GET', `/guilds/${g}/modules/suggestions/list`],
  ['POST', `/guilds/${g}/modules/suggestions/config`],
  ['POST', `/guilds/${g}/modules/suggestions/1/decision`],
  ['POST', `/guilds/${g}/modules/suggestions/1/delete`],
];

test('signed out: every Suggestions route is refused', async () => {
  const nobody = anonymous();
  for (const [method, path] of ROUTES(D_GUILD)) {
    const res = method === 'GET' ? await nobody.get(path) : await nobody.post(path, {});
    assert.ok([401, 403].includes(res.status), `${method} ${path} -> ${res.status}`);
  }
});

test('a member without Manage Server, and the admin of another server, are refused', async () => {
  const kept = await createSuggestion({ guildId: D_GUILD, channelId: '1', authorId: 'a', body: 'Keep me' });
  const member = await session({
    guilds: [{ id: D_GUILD, owner: false, permissions: '0' }],
  });
  for (const [method, path] of ROUTES(D_GUILD)) {
    const res = method === 'GET' ? await member.get(path) : await member.post(path, { action: 'approve' });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const admin = await session(); // owner of D_GUILD only
  for (const [method, path] of ROUTES(OTHER_D_GUILD)) {
    const res = method === 'GET' ? await admin.get(path) : await admin.post(path, { action: 'approve' });
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  const row = await getSuggestionByNumber(D_GUILD, kept.number);
  assert.equal(row.status, 'open', 'nothing was decided');
  assert.equal(await suggestionCount(D_GUILD), 1, 'and nothing was deleted');
  assert.deepEqual(await listAudit(D_GUILD, 20), []);
});

test('the admin of the server gets in, and a POST needs the CSRF token', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const url = `/api/v2/guilds/${D_GUILD}/modules/suggestions/999/delete`;
  const post = (headers) =>
    b.get(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: '{}',
    });

  const read = await b.get(`/api/v2/guilds/${D_GUILD}/modules/suggestions/config`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).suggestions.length, 1);

  assert.equal((await post({})).status, 403, 'no token');
  assert.equal((await post({ 'x-csrf-token': 'not-the-token' })).status, 403, 'wrong token');
  const ok = await post({ 'x-csrf-token': token });
  assert.equal(ok.status, 404, 'with the token it reaches the route, which finds no such suggestion');
  assert.match((await ok.json()).error, /No such suggestion/);
  assert.equal(await suggestionCount(D_GUILD), 1);
});
