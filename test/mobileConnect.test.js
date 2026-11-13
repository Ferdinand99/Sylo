// Adding the other login (Discord or Fluxer) to an account from the Sylo app:
//   POST /api/mobile/connect/:platform (app token) -> a 60-second single-use code
//   GET  /auth/mobile/connect?code=…        (browser sheet) -> the confirmation page
//   GET  /auth/mobile/connect/continue?nonce=… -> the other platform's login
//   GET  /auth/<platform>/callback          -> the login is added, and the sheet ends at
//                                              sylo://connected?platform=…[&error=…]
// The code is stored hashed, expires, works once, belongs to one account, and the only place a
// browser is ever sent is the fixed app address. The rate limits are in mobileConnect.limit.test.js.
import './helpers/trustLoopbackProxy.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  browser as plainBrowser,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
  stateOf,
  uid,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { findIdentity, identitiesOf, linkIdentity } = await import('../src/db/accounts.js');
const {
  createApiToken,
  createConnectCode,
  createMobileCode,
  pkceChallenge,
  redeemConnectCode,
  revokeApiTokenValue,
} = await import('../src/db/apiTokens.js');
const { prepare } = await import('../src/db/driver.js');

const DAY = 24 * 60 * 60 * 1000;
const APP_OK = 'sylo://connected?platform=fluxer';
let n = 0;
/** A client address of its own, so one test's requests never use up another's per-client limits. */
const from = () => ({ 'x-forwarded-for': `10.77.${Math.floor(++n / 250)}.${(n % 250) + 1}` });

/** A browser whose every request comes from a client address of its own, unless it says otherwise. */
function browser() {
  const b = plainBrowser();
  return {
    ...b,
    get: (path, init = {}) => b.get(path, { ...init, headers: { ...from(), ...(init.headers ?? {}) } }),
  };
}
const app = browser(); // the app itself: never any cookie

/** A person with a Discord-only account, an app token for it and the Fluxer identity they will add. */
async function person() {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { accountId } = await findIdentity('discord', profiles.discord.id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  return { b, accountId, token, discord: { ...profiles.discord }, fluxer: { ...profiles.fluxer } };
}

const issue = (token, platform = 'fluxer') =>
  app.get(`/api/mobile/connect/${platform}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...from() },
  });
const codeFor = async (token, platform) => (await (await issue(token, platform)).json()).code;

const page = (b, code, extra = '') =>
  b.get(`/auth/mobile/connect?code=${encodeURIComponent(code)}${extra}`, { headers: from() });
const nonceOf = async (res) => {
  const m = /connect\/continue\?nonce=([^"&]+)/.exec(await res.text());
  return m ? decodeURIComponent(m[1]) : null;
};
const identityKinds = async (accountId) => (await identitiesOf(accountId)).map((i) => i.platform).sort();

/** The whole browser part. `as` is the Fluxer profile the person logs in with at the platform. */
async function connectInBrowser(b, code, as) {
  const confirm = await page(b, code);
  assert.equal(confirm.status, 200, 'the confirmation page');
  const nonce = await nonceOf(confirm);
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`, {
    headers: from(),
  });
  assert.equal(cont.status, 302);
  profiles.fluxer = as;
  const callback = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`, { headers: from() });
  return { cont, callback };
}

test('POST /api/mobile/connect gives a code, and the whole flow adds the login to the account', async () => {
  const p = await person();
  const issued = await issue(p.token);
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { code, expiresAt } = await issued.json();
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 60_000, 'about 60 seconds');

  const sheet = browser(); // the browser sheet: no cookie, nobody signed in
  const confirm = await page(sheet, code);
  assert.equal(confirm.status, 200);
  assert.match(confirm.headers.get('x-frame-options'), /DENY/);
  assert.match(confirm.headers.get('cache-control'), /no-store/);
  const html = await confirm.clone().text();
  assert.match(html, /Add Fluxer to your Sylo account/);
  assert.match(html, new RegExp(`<strong>${p.discord.username}</strong>`));
  assert.match(html, /sylo:\/\/connected\?platform=fluxer&amp;error=access_denied/, 'a way to cancel');

  const nonce = await nonceOf(confirm);
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`, {
    headers: from(),
  });
  assert.equal(cont.status, 302);
  assert.match(cont.headers.get('location'), /^http:\/\/fluxer\.test\/oauth2\/authorize\?/);

  profiles.fluxer = p.fluxer;
  const callback = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`, {
    headers: from(),
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), APP_OK);

  assert.deepEqual(await identityKinds(p.accountId), ['discord', 'fluxer']);
  assert.equal((await findIdentity('fluxer', p.fluxer.id)).accountId, p.accountId);
  // The app's next sign-in state: the same token now sees both platforms.
  const me = await app.get('/api/v2/guilds', { headers: { authorization: `Bearer ${p.token}`, ...from() } });
  assert.equal(me.status, 200);

  // The sheet was never signed in, before or after: no session, so no dashboard.
  const after = await sheet.get('/api/v2/guilds', { headers: from() });
  assert.equal(after.status, 401);
});

test('the other direction works too: a Fluxer account adds Discord', async () => {
  setProfiles();
  const web = browser();
  await signIn(web, 'fluxer');
  const { accountId } = await findIdentity('fluxer', profiles.fluxer.id);
  const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  const discord = { ...profiles.discord };

  const code = await codeFor(token, 'discord');
  const sheet = browser();
  const nonce = await nonceOf(await page(sheet, code));
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`, {
    headers: from(),
  });
  profiles.discord = discord;
  const callback = await sheet.get(`/auth/discord/callback?code=abc&state=${stateOf(cont)}`, {
    headers: from(),
  });
  assert.equal(callback.headers.get('location'), 'sylo://connected?platform=discord');
  assert.deepEqual(await identityKinds(accountId), ['discord', 'fluxer']);
});

test('the code is stored as a hash, never as itself', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  const rows = await prepare('SELECT * FROM mobile_connect_codes WHERE account_id = ?').all(p.accountId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, createHash('sha256').update(code).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(code));
  assert.equal(rows[0].platform, 'fluxer');
  assert.ok(Number(rows[0].expires_at) > Date.now());
});

test('a code expires after 60 seconds', async () => {
  const p = await person();
  const { code } = await createConnectCode(p.accountId, 'fluxer', { ttlMs: -1 });
  const res = await page(browser(), code);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /expired or was already used/);
  assert.equal(res.headers.get('location'), null);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('a code works once, even when two browsers try at the same moment', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  const [a, b] = await Promise.all([page(browser(), code), page(browser(), code)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal((await page(browser(), code)).status, 400, 'and not again afterwards');

  const direct = await createConnectCode(p.accountId, 'fluxer');
  const taken = await Promise.all(Array.from({ length: 6 }, () => redeemConnectCode(direct.code)));
  assert.equal(taken.filter(Boolean).length, 1);
});

test('asking for a new code makes the earlier one useless', async () => {
  const p = await person();
  const first = await codeFor(p.token);
  const second = await codeFor(p.token);
  assert.equal((await page(browser(), first)).status, 400);
  assert.equal((await page(browser(), second)).status, 200);
});

test('a code belongs to the account of the token that asked, and to nobody else', async () => {
  const a = await person();
  const b = await person();
  const codeA = await codeFor(a.token);
  const codeB = await codeFor(b.token);
  assert.deepEqual(await redeemConnectCode(codeA), { accountId: a.accountId, platform: 'fluxer' });
  assert.deepEqual(await redeemConnectCode(codeB), { accountId: b.accountId, platform: 'fluxer' });

  // B's browser (signed in as B) opens A's link: the login still goes to A, B is left alone.
  const link = await codeFor(a.token);
  const mid = await connectInBrowser(b.b, link, a.fluxer);
  assert.equal(mid.callback.headers.get('location'), APP_OK);
  assert.deepEqual(await identityKinds(a.accountId), ['discord', 'fluxer']);
  assert.deepEqual(await identityKinds(b.accountId), ['discord'], "B's account is untouched");
  // B's own browser session was not replaced or signed out.
  const still = await b.b.get('/api/v2/guilds', { headers: from() });
  assert.equal(still.status, 200);
});

test('the other kinds of code do not work here, and this one does not work as a sign-in', async () => {
  const p = await person();
  // A sign-in code (PKCE) is not a connect code.
  const signInCode = await createMobileCode(p.accountId, pkceChallenge('v'.repeat(43)));
  assert.equal((await page(browser(), signInCode)).status, 400);
  // A connect code is not a sign-in code: the token endpoint refuses it.
  const code = await codeFor(p.token);
  const token = await app.get('/api/mobile/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...from() },
    body: JSON.stringify({ code, verifier: 'v'.repeat(43) }),
  });
  assert.equal(token.status, 400);
  assert.equal((await token.json()).error, 'invalid_grant');
  assert.equal((await page(browser(), code)).status, 200, 'and the connect code was not used up by that');
});

test('only a real app token can ask for a code, for a platform the account lacks', async () => {
  const p = await person();
  const post = (path, init = {}) =>
    app.get(path, { method: 'POST', ...init, headers: { ...from(), ...(init.headers ?? {}) } });
  // Without a token a POST is a browser request: the CSRF check answers before the route does.
  assert.equal((await post('/api/mobile/connect/fluxer')).status, 403, 'no token');
  assert.equal(
    (await post('/api/mobile/connect/fluxer', { headers: { authorization: 'Bearer sylo_nope' } })).status,
    401
  );
  // A browser session, even with its CSRF token, is not an app.
  const csrf = (await (await p.b.get('/api/v2/csrf')).json()).token;
  const cookie = await p.b.get('/api/mobile/connect/fluxer', {
    method: 'POST',
    headers: { 'x-csrf-token': csrf, ...from() },
  });
  assert.equal(cookie.status, 403);
  assert.deepEqual(await cookie.json(), { error: 'Adding a login is for the Sylo app only.' });

  for (const platform of ['telegram', '__proto__', 'constructor', 'toString']) {
    const res = await issue(p.token, platform);
    assert.equal(res.status, 400, platform);
    assert.deepEqual(await res.json(), { error: 'invalid_platform' });
  }
  const have = await issue(p.token, 'discord');
  assert.equal(have.status, 409);
  assert.deepEqual(await have.json(), { error: 'already_connected' });
  const rows = await prepare('SELECT * FROM mobile_connect_codes WHERE account_id = ?').all(p.accountId);
  assert.equal(rows.length, 0, 'none of that made a code');
});

test('a revoked or expired token cannot ask for a code', async () => {
  const p = await person();
  await revokeApiTokenValue(p.token);
  assert.equal((await issue(p.token)).status, 401);
});

test('the confirmation is needed: no nonce, a wrong nonce, a repeat and no page at all are all refused', async () => {
  const p = await person();
  const cont = (b, nonce) =>
    b.get(`/auth/mobile/connect/continue${nonce === undefined ? '' : `?nonce=${nonce}`}`, {
      headers: from(),
    });

  assert.equal((await cont(browser(), 'x')).status, 403, 'nothing was asked');

  const b = browser();
  const confirm = await page(b, await codeFor(p.token));
  const nonce = await nonceOf(confirm);
  assert.equal((await cont(b)).status, 403, 'no nonce');
  // ...and that burned the confirmation: the right nonce no longer works either.
  assert.equal((await cont(b, encodeURIComponent(nonce))).status, 403);

  const b2 = browser();
  const nonce2 = await nonceOf(await page(b2, await codeFor(p.token)));
  assert.equal((await cont(b2, 'not-the-nonce')).status, 403, 'wrong nonce');
  const b3 = browser();
  const nonce3 = await nonceOf(await page(b3, await codeFor(p.token)));
  // A link from another site (or another browser) does not know this browser's nonce.
  assert.equal((await cont(browser(), encodeURIComponent(nonce3))).status, 403, 'nonce in a foreign browser');
  assert.equal((await cont(b3, encodeURIComponent(nonce3))).status, 302, 'the right one, once');
  assert.equal((await cont(b3, encodeURIComponent(nonce3))).status, 403, 'a repeat');
  assert.notEqual(nonce2, nonce3);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('the browser is only ever sent to the app address or the platform login, never anywhere else', async () => {
  const p = await person();
  // A hostile query: a platform, a return address and a redirect of its own.
  const evil = '&platform=evil&next=https://evil.test&returnTo=//evil.test&redirect=https://evil.test';
  const sheet = browser();
  const confirm = await page(sheet, await codeFor(p.token), evil);
  const html = await confirm.text();
  assert.ok(!html.includes('evil'), 'nothing of the query is shown or used');
  const nonce = /nonce=([^"&]+)/.exec(html)[1];
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${nonce}${evil}`, { headers: from() });
  assert.match(cont.headers.get('location'), /^http:\/\/fluxer\.test\/oauth2\/authorize\?/);
  assert.ok(!cont.headers.get('location').includes('evil'));
  profiles.fluxer = p.fluxer;
  const callback = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}${evil}`, {
    headers: from(),
  });
  assert.equal(callback.headers.get('location'), APP_OK, 'exactly the fixed address');

  // Every way the callback can end ends at the same fixed address, with a fixed error word.
  const cases = [
    ['the person cancelled', (st) => `error=access_denied&state=${st}`, 'access_denied'],
    [
      'another error word',
      (st) => `error=${encodeURIComponent('https://evil.test')}&state=${st}`,
      'invalid_response',
    ],
    ['a wrong state', () => 'code=abc&state=wrong', 'invalid_response'],
    ['no state', () => 'code=abc', 'invalid_response'],
    ['nothing at all', () => '', 'invalid_response'],
  ];
  for (const [name, query, error] of cases) {
    const q = await person();
    const b = browser();
    const cn = await nonceOf(await page(b, await codeFor(q.token)));
    const go = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(cn)}`, {
      headers: from(),
    });
    const end = await b.get(`/auth/fluxer/callback?${query(stateOf(go))}${evil}`, { headers: from() });
    assert.equal(end.status, 302, name);
    assert.equal(end.headers.get('location'), `${APP_OK}&error=${error}`, name);
    assert.deepEqual(await identityKinds(q.accountId), ['discord'], name);
  }
});

test('a login that already belongs to another account ends at the app with an error, and changes nothing', async () => {
  setProfiles();
  const owner = browser();
  await signIn(owner, 'fluxer'); // someone else's account holds this Fluxer login
  const taken = { ...profiles.fluxer };
  const takenAccount = (await findIdentity('fluxer', taken.id)).accountId;

  const p = await person();
  const { callback } = await connectInBrowser(browser(), await codeFor(p.token), taken);
  assert.equal(callback.headers.get('location'), `${APP_OK}&error=identity_linked`);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  assert.equal((await findIdentity('fluxer', taken.id)).accountId, takenAccount);
});

test('an account that got the platform in the meantime ends at the app with an error', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  const b = browser();
  const nonce = await nonceOf(await page(b, code));
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`, {
    headers: from(),
  });
  // Someone linked another Fluxer login to the account while the sheet was open.
  await linkIdentity(p.accountId, {
    platform: 'fluxer',
    platformUserId: uid('5555555555'),
    username: 'first',
    avatar: null,
    guildIds: [],
  });
  profiles.fluxer = p.fluxer;
  const callback = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`, { headers: from() });
  assert.equal(callback.headers.get('location'), `${APP_OK}&error=platform_already_linked`);
  assert.ok(!(await findIdentity('fluxer', p.fluxer.id)));
});

test('opening the link when the account already has that platform ends at the app, not on a page', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  await linkIdentity(p.accountId, {
    platform: 'fluxer',
    platformUserId: uid('5555555555'),
    username: 'there',
    avatar: null,
    guildIds: [],
  });
  const res = await page(browser(), code);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${APP_OK}&error=platform_already_linked`);
});

test('the round-trip must finish within ten minutes', async () => {
  const p = await person();
  const b = browser();
  const nonce = await nonceOf(await page(b, await codeFor(p.token)));
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`, {
    headers: from(),
  });
  profiles.fluxer = p.fluxer;
  const real = Date.now;
  Date.now = () => real() + 11 * 60 * 1000;
  try {
    const callback = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`, {
      headers: from(),
    });
    assert.equal(callback.headers.get('location'), `${APP_OK}&error=expired`);
  } finally {
    Date.now = real;
  }
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('no session fixation: the flow never makes or replaces a session, and a leftover login does not become one', async () => {
  const p = await person();
  const b = browser();
  // This browser has begun an ordinary Fluxer login first and holds its state.
  const begin = await b.get('/auth/fluxer/login', { headers: from() });
  const oldState = stateOf(begin);

  const code = await codeFor(p.token);
  const nonce = await nonceOf(await page(b, code));
  assert.ok(nonce);
  // Finishing the old login now must not be mistaken for the app's flow (the page cleared its state).
  profiles.fluxer = p.fluxer;
  const old = await b.get(`/auth/fluxer/callback?code=abc&state=${oldState}`, { headers: from() });
  assert.equal(old.status, 400);
  assert.equal(old.headers.get('location'), null);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  assert.ok(!(await findIdentity('fluxer', p.fluxer.id)), 'and it signed nobody in');
  assert.equal((await b.get('/api/v2/guilds', { headers: from() })).status, 401);

  // The other way round: a plain login started after the confirmation is never an app flow.
  const code2 = await codeFor(p.token);
  const nonce2 = await nonceOf(await page(b, code2));
  const go = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce2)}`, {
    headers: from(),
  });
  assert.ok(go.headers.get('location'));
  const plain = await b.get('/auth/fluxer/login', { headers: from() }); // a new, ordinary round-trip
  const done = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(plain)}`, { headers: from() });
  assert.ok(!done.headers.get('location').startsWith('sylo:'), 'an ordinary login ends in the dashboard');
  assert.deepEqual(await identityKinds(p.accountId), ['discord'], 'and does not touch the app’s account');
});

test('an account that was deleted meanwhile ends at the app with an error', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  const b = browser();
  const nonce = await nonceOf(await page(b, code));
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`, {
    headers: from(),
  });
  await prepare('DELETE FROM account_identities WHERE account_id = ?').run(p.accountId);
  profiles.fluxer = p.fluxer;
  const callback = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`, { headers: from() });
  assert.equal(callback.headers.get('location'), `${APP_OK}&error=account_gone`);
  assert.ok(!(await findIdentity('fluxer', p.fluxer.id)));
});

test('GET /api/mobile/info offers app-connect when both logins are set up', async () => {
  const info = await (await app.get('/api/mobile/info', { headers: from() })).json();
  assert.ok(info.features.includes('app-connect'));
});
