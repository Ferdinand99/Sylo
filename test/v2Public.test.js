// The new dashboard's public pages (command list, roadmap): they work without a session and show
// only what the classic public pages show, while the rest of /v2 and /api/v2 stays behind the login.
import { browser, signIn, setProfiles, startOAuthApp, stateOf } from './helpers/oauthApp.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlashCommandBuilder } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { v2Build } from '../src/web/routes/v2Client.js';
import { internalNext } from '../src/web/middleware/auth.js';

await startOAuthApp();
const { createPost, setPostStatus, toggleVote, listPendingPosts } = await import('../src/db/roadmap.js');

// Pretend the SPA is built, whatever the checkout has in web-v2/dist.
const dir = mkdtempSync(join(tmpdir(), 'sylo-v2-'));
const stubIndex = join(dir, 'index.html');
writeFileSync(stubIndex, '<!doctype html><title>stub shell</title>');
v2Build.exists = () => true;
v2Build.indexHtml = stubIndex;

// A user id that must never appear in a public answer.
const AUTHOR = 'author-user-id-424242';
const planned = await createPost({ title: 'Public idea', description: 'Do **this**', userId: AUTHOR });
await setPostStatus(planned.id, 'planned');
await toggleVote(planned.id, 'someone-else');
const pending = await createPost({ title: 'Still hidden', description: 'awaiting review', userId: AUTHOR });

runtime.clients.discord.commands.set('ping', {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Pong')
    .addStringOption((o) => o.setName('word').setDescription('A word').setRequired(true)),
});

const json = { accept: 'application/json' };
const loginRedirect = (res) => res.status === 302 && /^\/auth\//.test(res.headers.get('location') ?? '');

test('the two public pages serve the app without a session', async () => {
  const b = browser();
  for (const path of ['/v2/commands', '/v2/roadmap', '/v2/roadmap/', '/v2/Commands']) {
    const res = await b.get(path, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /stub shell/);
  }
});

test('every other /v2 page still needs a login', async () => {
  const b = browser();
  for (const path of [
    '/v2',
    '/v2/',
    '/v2/index.html',
    '/v2/account',
    '/v2/settings',
    '/v2/health',
    '/v2/stats',
    '/v2/roadmap/admin',
    '/v2/changelog',
    '/v2/guilds/900000000000000201',
    '/v2/guilds/900000000000000201/commands',
  ]) {
    const res = await b.get(path, { headers: { accept: 'text/html' } });
    assert.ok(loginRedirect(res), `${path} -> ${res.status} ${res.headers.get('location')}`);
  }
});

test("the app's built files are served without a session", async (t) => {
  const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'web-v2', 'dist', 'assets');
  let files;
  try {
    files = readdirSync(assets);
  } catch {
    return t.skip('web-v2 is not built');
  }
  const res = await browser().get(`/v2/assets/${files[0]}`);
  assert.equal(res.status, 200);
});

test('a missing built file is not a public page', async () => {
  const res = await browser().get('/v2/assets/does-not-exist.js');
  assert.ok(loginRedirect(res));
});

test('index.html is never served without a login, however it is spelled', async () => {
  for (const path of [
    '/v2/index.html',
    '/v2/index%2Ehtml',
    '/v2/index%2ehtml',
    '/v2/%69ndex.html',
    '/v2/INDEX.HTML',
    '/v2//index.html',
    '/v2/./index.html',
    '/v2/assets/../index.html',
    '/v2/assets/%2e%2e/index.html',
    '/v2/index.html/',
    '/v2/index.html.',
  ]) {
    const res = await browser().get(path, { headers: { accept: 'text/html' } });
    assert.ok(loginRedirect(res), `${path} -> ${res.status}`);
  }
});

test('an anonymous visit to a public page remembers no return address', async () => {
  for (const path of ['/v2/commands', '/v2/roadmap']) {
    const res = await browser().get(path, { headers: { accept: 'text/html' } });
    assert.equal(res.status, 200, path);
    // The CSRF middleware still gives every visitor a session cookie holding the CSRF token; the
    // page itself adds nothing to it.
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('sylo.sid='));
    const stored = sid ? JSON.parse(Buffer.from(sid.split(';')[0].slice('sylo.sid='.length), 'base64')) : {};
    assert.deepEqual(Object.keys(stored), ['csrf'], path);
  }
});

test("a public page's log-in link carries the page, and the login returns to it", async () => {
  setProfiles();
  const b = browser();
  const start = await b.get('/auth/login?next=%2Fv2%2Froadmap');
  // Two logins are offered, so the chooser is shown; the choice is already remembered.
  assert.equal(start.status, 200);
  const done = await signIn(b, 'discord');
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/v2/roadmap');
});

test('next also works straight on a provider login', async () => {
  setProfiles();
  const b = browser();
  const start = await b.get('/auth/discord/login?next=/v2/commands');
  assert.equal(start.status, 302);
  const done = await b.get(`/auth/discord/callback?code=abc&state=${stateOf(start)}`);
  assert.equal(done.headers.get('location'), '/v2/commands');
});

test('only an internal path is accepted as next', () => {
  for (const ok of ['/v2/roadmap', '/v2/commands', '/guilds/1/overview?x=1'])
    assert.equal(internalNext(ok), ok);
  for (const bad of [
    'https://evil.example/x',
    '//evil.example/x',
    '/\\evil.example/x',
    'evil.example',
    'javascript:alert(1)',
    '',
    '/',
    `/${'a'.repeat(600)}`,
    undefined,
    ['/v2/roadmap'],
    { a: 1 },
  ]) {
    assert.equal(internalNext(bad), null, JSON.stringify(bad));
  }
});

test('an outside next is ignored: the login still ends at the usual place', async () => {
  for (const next of ['https://evil.example/x', '//evil.example/x']) {
    setProfiles();
    const b = browser();
    await b.get(`/auth/login?next=${encodeURIComponent(next)}`);
    const done = await signIn(b, 'discord');
    assert.equal(done.headers.get('location'), '/', next);
  }
});

test('next does not override where a protected page sent the visitor from', async () => {
  setProfiles();
  const b = browser();
  await b.get('/v2/account', { headers: { accept: 'text/html' } }); // bounced to the login, remembered
  const done = await signIn(b, 'discord');
  assert.equal(done.headers.get('location'), '/v2/account');
});

test('/api/v2/public/session tells a visitor from a signed-in person', async () => {
  const out = await browser().get('/api/v2/public/session', { headers: json });
  assert.deepEqual(await out.json(), { signedIn: false, open: false });
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  assert.deepEqual(await (await b.get('/api/v2/public/session', { headers: json })).json(), {
    signedIn: true,
    open: false,
  });
});

test('/api/v2/public/commands works without a cookie and lists only the public fields', async () => {
  const res = await browser().get('/api/v2/public/commands', { headers: json });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['commands']);
  const ping = body.commands.find((c) => c.signature === '/ping <word>');
  assert.ok(ping);
  assert.deepEqual(Object.keys(ping).sort(), ['description', 'options', 'permissions', 'signature']);
  assert.deepEqual(Object.keys(ping.options[0]).sort(), ['choices', 'description', 'name', 'required']);
  assert.equal(ping.description, 'Pong');
});

test('/api/v2/public/commands has the same rows as the classic /commands page data', async () => {
  const { describeCommands } = await import('../src/web/lib/commandReference.js');
  const res = await browser().get('/api/v2/public/commands', { headers: json });
  assert.deepEqual((await res.json()).commands, describeCommands(runtime.clients.discord.commands));
});

test('/api/v2/public/roadmap works without a cookie and returns only public fields', async () => {
  const res = await browser().get('/api/v2/public/roadmap', { headers: json });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(AUTHOR), 'no author id in a public answer');
  assert.ok(!text.includes('Still hidden'), 'a pending suggestion is not public');
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['groups', 'isOwner', 'mine', 'open', 'signedIn']);
  assert.equal(body.signedIn, false);
  assert.equal(body.isOwner, false);
  assert.deepEqual(body.mine, []);
  assert.equal(body.groups.planned.length, 1);
  const post = body.groups.planned[0];
  assert.deepEqual(Object.keys(post).sort(), [
    'createdAt',
    'description',
    'descriptionHtml',
    'id',
    'status',
    'title',
    'voted',
    'votes',
  ]);
  assert.equal(post.votes, 1);
  assert.equal(post.voted, false);
  assert.match(post.descriptionHtml, /<strong>this<\/strong>/);
});

test('the public roadmap lists the same posts as the classic /roadmap/posts.json', async () => {
  const b = browser();
  const classic = await (await b.get('/roadmap/posts.json')).json();
  const v2 = await (await b.get('/api/v2/public/roadmap', { headers: json })).json();
  const flat = Object.values(v2.groups)
    .flat()
    .map(({ id, title, description, status, votes, createdAt }) => ({
      id,
      title,
      description,
      status,
      votes,
      createdAt,
    }));
  assert.deepEqual(flat, classic);
});

test("a signed-in person's public roadmap also carries their own votes", async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { token } = await (await b.get('/api/v2/csrf')).json();
  const vote = await b.get(`/api/v2/roadmap/${planned.id}/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: '{}',
  });
  assert.equal(vote.status, 200);
  const body = await (await b.get('/api/v2/public/roadmap', { headers: json })).json();
  assert.equal(body.signedIn, true);
  assert.equal(body.groups.planned[0].voted, true);
  assert.equal(body.groups.planned[0].votes, 2);
  // Someone else sees their own state, not this person's.
  const other = await (await browser().get('/api/v2/public/roadmap', { headers: json })).json();
  assert.equal(other.groups.planned[0].voted, false);
  // Undo, so the later tests start from one vote.
  await b.get(`/api/v2/roadmap/${planned.id}/vote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': token },
    body: '{}',
  });
});

test('/roadmap moves to the new board and the roadmap feed stays public', async () => {
  const b = browser();
  const moved = await b.get('/roadmap');
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), '/v2/roadmap');
  assert.equal((await b.get('/roadmap/posts.json')).status, 200);
});

test('every other /api/v2 route answers 401 without a session', async () => {
  const b = browser();
  for (const path of [
    '/api/v2/guilds',
    '/api/v2/account',
    '/api/v2/csrf',
    '/api/v2/roadmap',
    '/api/v2/roadmap/admin',
    '/api/v2/stats',
    '/api/v2/announcement',
    '/api/v2/guilds/900000000000000201/overview',
    '/api/v2/publicity',
  ]) {
    const res = await b.get(path, { headers: json });
    assert.equal(res.status, 401, path);
  }
});

test('nothing but the listed routes is public under /api/v2/public', async () => {
  const res = await browser().get('/api/v2/public/account', { headers: json });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Not found' });
});

test('voting and suggesting still need a login', async () => {
  const before = await (await browser().get('/api/v2/public/roadmap', { headers: json })).json();
  const votes = before.groups.planned[0].votes;
  const post = (path, headers) =>
    browser().get(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ title: 'Sneaky idea', description: 'x' }),
    });
  for (const path of [`/api/v2/roadmap/${planned.id}/vote`, '/api/v2/roadmap/suggest']) {
    // A browser without a session is stopped by the CSRF check, an app request by the login check.
    const res = await post(path, {});
    assert.ok([401, 403].includes(res.status), `${path} -> ${res.status}`);
    const app = await post(path, { authorization: 'Bearer not-a-token' });
    assert.equal(app.status, 401, path);
  }
  const after = await (await browser().get('/api/v2/public/roadmap', { headers: json })).json();
  assert.equal(after.groups.planned[0].votes, votes, 'no vote was recorded');
  assert.deepEqual(
    (await listPendingPosts()).map((p) => p.id),
    [pending.id],
    'no suggestion was recorded'
  );
});

test('the public API is rate limited like the classic public pages', async () => {
  const res = await browser().get('/api/v2/public/commands', { headers: json });
  assert.equal(res.headers.get('x-ratelimit-limit'), '60');
});

test('the public roadmap is private and revalidated, the session answer is never stored', async () => {
  const roadmap = await browser().get('/api/v2/public/roadmap', { headers: json });
  assert.equal(roadmap.headers.get('cache-control'), 'private, no-cache');
  const session = await browser().get('/api/v2/public/session', { headers: json });
  assert.equal(session.headers.get('cache-control'), 'no-store');
});

test("a signed-in person's own pending suggestion is in `mine` for them, nobody else", async () => {
  const MINE = '333333333300000001';
  const mineTitle = 'My own pending idea';
  await createPost({ title: mineTitle, description: 'only for me', userId: MINE });

  setProfiles({ discordId: MINE });
  const owner = browser();
  await signIn(owner, 'discord');
  const own = await (await owner.get('/api/v2/public/roadmap', { headers: json })).json();
  assert.deepEqual(
    own.mine.map((p) => p.title),
    [mineTitle]
  );

  setProfiles({ discordId: '333333333300000002' });
  const second = browser();
  await signIn(second, 'discord');
  for (const [who, b] of [
    ['a second signed-in person', second],
    ['a visitor', browser()],
  ]) {
    const text = await (await b.get('/api/v2/public/roadmap', { headers: json })).text();
    assert.deepEqual(JSON.parse(text).mine, [], who);
    assert.ok(!text.includes(mineTitle), `${who} does not see a pending suggestion`);
  }
});
