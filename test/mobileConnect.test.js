// Adding the other login (Discord or Fluxer) to an account from the Sylo app:
//   POST /api/mobile/connect/:platform (app token)  -> a 60-second single-use connect code
//   GET  /auth/mobile/connect?code=…                 (browser sheet) -> the confirmation page
//   GET  /auth/mobile/connect/continue?nonce=…       -> the other platform's login
//   GET  /auth/<platform>/callback                   -> links NOTHING; the sheet ends at
//                                                       sylo://connected?platform=…&result=… (or &error=…)
//   POST /api/mobile/connect/complete { result }     (the same app token) -> the login is linked
// The completion is what ties the link to the app: a link someone else minted ends at the victim's own
// app, whose token is not the minter's, so it attaches nothing. The codes are stored hashed, expire and
// work once, and the only place a browser is ever sent is the fixed app address. The rate limits are
// in mobileConnect.limit.test.js.
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
  createConnectResult,
  createMobileCode,
  pkceChallenge,
  redeemConnectCode,
  revokeApiTokenValue,
} = await import('../src/db/apiTokens.js');
const { prepare } = await import('../src/db/driver.js');

const DAY = 24 * 60 * 60 * 1000;
const APP_FLUXER = 'sylo://connected?platform=fluxer';
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
  const { id: tokenId, token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  return { b, accountId, tokenId, token, discord: { ...profiles.discord }, fluxer: { ...profiles.fluxer } };
}
/** A further app token of the same account (a second device). */
const anotherToken = async (p) => createApiToken(p.accountId, { deviceName: 'iPad', ttlMs: DAY });

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const issue = (token, platform = 'fluxer') =>
  app.get(`/api/mobile/connect/${platform}`, { method: 'POST', headers: bearer(token) });
const codeFor = async (token, platform) => (await (await issue(token, platform)).json()).code;
const complete = (token, result) =>
  app.get('/api/mobile/connect/complete', {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ result }),
  });

const page = (b, code, extra = '') => b.get(`/auth/mobile/connect?code=${encodeURIComponent(code)}${extra}`);
const nonceOf = async (res) => {
  const m = /connect\/continue\?nonce=([^"&]+)/.exec(await res.text());
  return m ? decodeURIComponent(m[1]) : null;
};
const identityKinds = async (accountId) => (await identitiesOf(accountId)).map((i) => i.platform).sort();
const resultOf = (res) => new URL(res.headers.get('location')).searchParams.get('result');

/**
 * The browser part, up to and including the platform callback. `as` is the profile the person logs in
 * with at the platform (of the callback's platform, default Fluxer).
 */
async function browserFlow(b, code, as, platform = 'fluxer') {
  const confirm = await page(b, code);
  assert.equal(confirm.status, 200, 'the confirmation page');
  const html = await confirm.text();
  const nonce = /continue\?nonce=([^"&]+)/.exec(html)?.[1];
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${nonce}`);
  assert.equal(cont.status, 302);
  profiles[platform] = as;
  const callback = await b.get(`/auth/${platform}/callback?code=abc&state=${stateOf(cont)}`);
  return { confirm, html, cont, callback };
}

/** Ask for a code, run the browser part in a fresh sheet; returns the result code from the callback. */
async function flowFor(p, as = p.fluxer, b = browser()) {
  const out = await browserFlow(b, await codeFor(p.token), as);
  assert.equal(out.callback.status, 302);
  return { ...out, result: resultOf(out.callback) };
}

test('the whole flow: a code, the sheet, a result code, and only the completion links the login', async () => {
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
  assert.match(html, /Add Fluxer to the Sylo account ferdi\?/, 'names the account, does not say "your"');
  assert.doesNotMatch(html, /your Sylo account/);
  assert.doesNotMatch(html, /signed in to Sylo as/, 'no warning for a browser nobody is signed in on');
  assert.match(html, /sylo:\/\/connected\?platform=fluxer&amp;error=access-denied/, 'a way to cancel');

  const nonce = await nonceOf(confirm);
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`);
  assert.equal(cont.status, 302);
  const to = new URL(cont.headers.get('location'));
  assert.equal(`${to.origin}${to.pathname}`, 'http://fluxer.test/oauth2/authorize');
  assert.equal(to.searchParams.get('prompt'), 'consent', 'the platform shows which account is used');

  profiles.fluxer = p.fluxer;
  const callback = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  assert.equal(callback.status, 302);
  const back = new URL(callback.headers.get('location'));
  assert.equal(`${back.protocol}//${back.host}`, 'sylo://connected');
  assert.equal(back.searchParams.get('platform'), 'fluxer');
  const result = back.searchParams.get('result');
  assert.match(result, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([...back.searchParams.keys()].sort(), ['platform', 'result']);

  // The callback linked nothing.
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  assert.ok(!(await findIdentity('fluxer', p.fluxer.id)));

  const done = await complete(p.token, result);
  assert.equal(done.status, 200);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await done.json(), { ok: true, platform: 'fluxer', platforms: ['discord', 'fluxer'] });
  assert.equal((await findIdentity('fluxer', p.fluxer.id)).accountId, p.accountId);

  // The sheet was never signed in, before or after: no session, so no dashboard.
  assert.equal((await sheet.get('/api/v2/guilds')).status, 401);
});

test('the other direction works too: a Fluxer account adds Discord', async () => {
  setProfiles();
  await signIn(browser(), 'fluxer');
  const { accountId } = await findIdentity('fluxer', profiles.fluxer.id);
  const { id: tokenId, token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  const discord = { ...profiles.discord };

  const sheet = browser();
  const out = await browserFlow(sheet, await codeFor(token, 'discord'), discord, 'discord');
  assert.equal(new URL(out.cont.headers.get('location')).searchParams.get('prompt'), 'consent');
  assert.match(out.callback.headers.get('location'), /^sylo:\/\/connected\?platform=discord&result=/);
  assert.equal((await complete(token, resultOf(out.callback))).status, 200);
  assert.deepEqual(await identityKinds(accountId), ['discord', 'fluxer']);
  assert.ok(tokenId);
});

test('the attacker scenario: a link made for A, followed by a victim, never attaches the victim to A', async () => {
  const a = await person(); // the attacker, with their own app token
  const victim = await person(); // signed in on the dashboard (browser b) with Discord, has no Fluxer account yet
  const victimFluxer = victim.fluxer;

  // The attacker mints a code and the victim's own browser (signed in as the victim) follows the link.
  const link = await codeFor(a.token);
  const confirm = await page(victim.b, link);
  const html = await confirm.clone().text();
  assert.match(html, /This browser is signed in to Sylo as/, 'a browser signed in as someone else is warned');
  const nonce = await nonceOf(confirm);
  const cont = await victim.b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`);
  profiles.fluxer = victimFluxer;
  const callback = await victim.b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  const result = resultOf(callback);
  assert.ok(result, 'the sheet ends at an app, which on the victim’s phone is the victim’s app');

  // The victim's identity is not linked to anyone yet.
  assert.ok(!(await findIdentity('fluxer', victimFluxer.id)));

  // The victim's app (signed in as the victim) hands the result in: refused, nothing linked.
  const refused = await complete(victim.token, result);
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: 'invalid_result' });
  assert.ok(!(await findIdentity('fluxer', victimFluxer.id)));
  assert.deepEqual(await identityKinds(a.accountId), ['discord']);
  assert.deepEqual(await identityKinds(victim.accountId), ['discord']);

  // The result was used up by that attempt: not even the attacker's token can use it now.
  assert.equal((await complete(a.token, result)).status, 400);
  assert.ok(!(await findIdentity('fluxer', victimFluxer.id)));

  // Same again, but now the attacker's own token completes (the attacker's own device, not a victim's):
  // that is the one case where the link is made, and it is the attacker's own login they add.
  const second = await person();
  const own = await browserFlow(browser(), await codeFor(second.token), second.fluxer);
  assert.equal((await complete(second.token, resultOf(own.callback))).status, 200);
  assert.equal((await findIdentity('fluxer', second.fluxer.id)).accountId, second.accountId);
});

test('a result code is bound to the token that began the flow, not just to its account', async () => {
  const p = await person();
  const other = await anotherToken(p); // another device of the same account
  const { result } = await flowFor(p);
  const refused = await complete(other.token, result);
  assert.equal(refused.status, 400, 'the account matches but the token does not');
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  assert.equal((await complete(p.token, result)).status, 400, 'and the attempt used it up');

  const again = await flowFor(p);
  assert.equal((await complete(p.token, again.result)).status, 200);
});

test('a result code works once, expires, and must look like one', async () => {
  const p = await person();
  const { result } = await flowFor(p);
  assert.equal((await complete(p.token, result)).status, 200);
  assert.equal((await complete(p.token, result)).status, 400, 'reuse');

  const identity = { platform: 'fluxer', platformUserId: uid('5555555555'), username: 'x', guildIds: [] };
  const q = await person();
  const stale = await createConnectResult(
    { accountId: q.accountId, tokenId: q.tokenId, identity },
    { ttlMs: -1 }
  );
  assert.equal((await complete(q.token, stale)).status, 400, 'expired');
  assert.deepEqual(await identityKinds(q.accountId), ['discord']);

  for (const bad of [undefined, null, '', 'x', 42, { a: 1 }, ['a'], 'A'.repeat(43)]) {
    assert.equal((await complete(q.token, bad)).status, 400, JSON.stringify(bad));
  }
  const noBody = await app.get('/api/mobile/connect/complete', {
    method: 'POST',
    headers: bearer(q.token),
  });
  assert.equal(noBody.status, 400);
});

test('two completions at the same moment: one login per platform, the loser gets a clean 409', async () => {
  const p = await person();
  const first = await flowFor(p, p.fluxer);
  const secondFluxer = { ...p.fluxer, id: uid('5555555555'), username: 'second' };
  const second = await flowFor(p, secondFluxer);
  const [x, y] = await Promise.all([complete(p.token, first.result), complete(p.token, second.result)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const lost = x.status === 409 ? x : y;
  assert.deepEqual(await lost.json(), { error: 'already_linked' });
  assert.deepEqual(await identityKinds(p.accountId), ['discord', 'fluxer'], 'one Fluxer login, not two');
});

test('the same login racing into two accounts: one wins, the other gets identity_linked, no 500', async () => {
  const a = await person();
  const b = await person();
  const shared = { ...a.fluxer };
  const fa = await flowFor(a, shared);
  const fb = await flowFor(b, shared);
  const [x, y] = await Promise.all([complete(a.token, fa.result), complete(b.token, fb.result)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const lost = x.status === 409 ? x : y;
  assert.deepEqual(await lost.json(), { error: 'identity_linked' });
  const owner = (await findIdentity('fluxer', shared.id)).accountId;
  assert.ok([a.accountId, b.accountId].includes(owner));
});

test('the database enforces one login per platform and account', async () => {
  const p = await person();
  await linkIdentity(p.accountId, {
    platform: 'fluxer',
    platformUserId: uid('5555555555'),
    username: 'one',
    avatar: null,
    guildIds: [],
  });
  await assert.rejects(async () =>
    prepare(
      `INSERT INTO account_identities (platform, platform_user_id, account_id, username, guild_ids, linked_at)
       VALUES ('fluxer', ?, ?, 'two', '[]', 1)`
    ).run(uid('5555555555'), p.accountId)
  );
});

test('the codes are stored as hashes, never as themselves', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  const rows = await prepare('SELECT * FROM mobile_connect_codes WHERE account_id = ?').all(p.accountId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, createHash('sha256').update(code).digest('hex'));
  assert.ok(!JSON.stringify(rows).includes(code));
  assert.equal(rows[0].platform, 'fluxer');
  assert.equal(rows[0].token_id, p.tokenId, 'bound to the token that asked');
  assert.ok(Number(rows[0].expires_at) > Date.now());

  const { result } = await flowFor(p);
  const kept = await prepare('SELECT * FROM mobile_connect_results WHERE account_id = ?').all(p.accountId);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].code_hash, createHash('sha256').update(result).digest('hex'));
  assert.ok(!JSON.stringify(kept).includes(result));
  assert.equal(kept[0].token_id, p.tokenId);
  assert.ok(Number(kept[0].expires_at) <= Date.now() + 120_000, 'a result code lives two minutes at most');
  await complete(p.token, result);
  assert.equal(
    (await prepare('SELECT * FROM mobile_connect_results WHERE account_id = ?').all(p.accountId)).length,
    0,
    'and is gone once used'
  );
});

test('a connect code expires after 60 seconds', async () => {
  const p = await person();
  const { code } = await createConnectCode(p.accountId, p.tokenId, 'fluxer', { ttlMs: -1 });
  const res = await page(browser(), code);
  assert.equal(res.status, 400);
  assert.match(await res.text(), /expired or was already used/);
  assert.equal(res.headers.get('location'), null);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('a connect code works once, even when several browsers try at the same moment', async () => {
  const p = await person();
  const code = await codeFor(p.token);
  const [a, b] = await Promise.all([page(browser(), code), page(browser(), code)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal((await page(browser(), code)).status, 400, 'and not again afterwards');

  const direct = await createConnectCode(p.accountId, p.tokenId, 'fluxer');
  const taken = await Promise.all(Array.from({ length: 6 }, () => redeemConnectCode(direct.code)));
  assert.equal(taken.filter(Boolean).length, 1);
});

test('asking for a new code replaces the earlier one, also when two asks arrive together', async () => {
  const p = await person();
  const first = await codeFor(p.token);
  const second = await codeFor(p.token);
  assert.equal((await page(browser(), first)).status, 400);
  assert.equal((await page(browser(), second)).status, 200);

  const q = await person();
  await Promise.all([issue(q.token), issue(q.token), issue(q.token)]);
  const rows = await prepare('SELECT * FROM mobile_connect_codes WHERE account_id = ?').all(q.accountId);
  assert.equal(rows.length, 1, 'exactly one live code per account');
});

test('a connect code belongs to the account and token that asked', async () => {
  const a = await person();
  const b = await person();
  const codeA = await codeFor(a.token);
  const codeB = await codeFor(b.token);
  assert.deepEqual(await redeemConnectCode(codeA), {
    accountId: a.accountId,
    tokenId: a.tokenId,
    platform: 'fluxer',
  });
  assert.deepEqual(await redeemConnectCode(codeB), {
    accountId: b.accountId,
    tokenId: b.tokenId,
    platform: 'fluxer',
  });

  // B's browser (signed in as B) opens A's link: the page says so, and the result is A's to complete.
  const link = await codeFor(a.token);
  const mid = await browserFlow(b.b, link, a.fluxer);
  assert.match(mid.html, /This browser is signed in to Sylo as ferdi/);
  const result = resultOf(mid.callback);
  assert.equal((await complete(b.token, result)).status, 400, "B's token cannot finish A's flow");
  assert.deepEqual(await identityKinds(b.accountId), ['discord'], "B's account is untouched");
  // B's own browser session was not replaced or signed out.
  assert.equal((await b.b.get('/api/v2/guilds')).status, 200);
});

test('the other kinds of code do not work here, and this one does not work as a sign-in', async () => {
  const p = await person();
  const signInCode = await createMobileCode(p.accountId, pkceChallenge('v'.repeat(43)));
  assert.equal((await page(browser(), signInCode)).status, 400);
  const code = await codeFor(p.token);
  const token = await app.get('/api/mobile/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier: 'v'.repeat(43) }),
  });
  assert.equal(token.status, 400);
  assert.equal((await token.json()).error, 'invalid_grant');
  assert.equal((await page(browser(), code)).status, 200, 'and the connect code was not used up by that');
  // A connect code is not a result code either.
  const c2 = await codeFor(p.token);
  assert.equal((await complete(p.token, c2)).status, 400);
});

test('only a real app token can ask for a code, for a platform the account lacks', async () => {
  const p = await person();
  const post = (path, init = {}) => app.get(path, { method: 'POST', ...init });
  // Without a token a POST is a browser request: the CSRF check answers before the route does.
  assert.equal((await post('/api/mobile/connect/fluxer')).status, 403, 'no token');
  assert.equal((await post('/api/mobile/connect/fluxer', { headers: bearer('sylo_nope') })).status, 401);
  // A browser session, even with its CSRF token, is not an app.
  const csrf = (await (await p.b.get('/api/v2/csrf')).json()).token;
  for (const path of ['/api/mobile/connect/fluxer', '/api/mobile/connect/complete']) {
    const cookie = await p.b.get(path, { method: 'POST', headers: { 'x-csrf-token': csrf } });
    assert.equal(cookie.status, 403, path);
    assert.deepEqual(await cookie.json(), { error: 'Adding a login is for the Sylo app only.' });
  }

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

test('a revoked token, and an expired one, can neither ask for a code nor complete', async () => {
  const p = await person();
  const { result } = await flowFor(p);
  await revokeApiTokenValue(p.token);
  assert.equal((await issue(p.token)).status, 401);
  assert.equal((await complete(p.token, result)).status, 401, 'a revoked token cannot complete a flow');
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);

  const q = await person();
  const old = await createApiToken(q.accountId, { deviceName: 'old', ttlMs: -1 });
  assert.equal((await issue(old.token)).status, 401, 'an expired token');
  assert.equal((await complete(old.token, 'A'.repeat(43))).status, 401);
});

test('signing the app out (revoking its token) ends a flow in flight, at every step', async () => {
  // before the sheet opens
  const a = await person();
  const code = await codeFor(a.token);
  await revokeApiTokenValue(a.token);
  const page1 = await page(browser(), code);
  assert.equal(page1.status, 302);
  assert.equal(page1.headers.get('location'), `${APP_FLUXER}&error=token-revoked`);

  // between the confirmation and the callback
  const b = await person();
  const sheet = browser();
  const nonce = await nonceOf(await page(sheet, await codeFor(b.token)));
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`);
  await revokeApiTokenValue(b.token);
  profiles.fluxer = b.fluxer;
  const callback = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  assert.equal(callback.headers.get('location'), `${APP_FLUXER}&error=token-revoked`);
  assert.equal(
    (await prepare('SELECT * FROM mobile_connect_results').all()).filter((r) => r.account_id === b.accountId)
      .length,
    0
  );
  assert.deepEqual(await identityKinds(b.accountId), ['discord']);
});

test('the confirmation is needed: no nonce, a wrong nonce, a repeat and no page at all are all refused', async () => {
  const p = await person();
  const cont = (b, nonce) =>
    b.get(`/auth/mobile/connect/continue${nonce === undefined ? '' : `?nonce=${nonce}`}`);

  assert.equal((await cont(browser(), 'x')).status, 403, 'nothing was asked');

  const b = browser();
  const confirm = await page(b, await codeFor(p.token));
  const nonce = await nonceOf(confirm);
  assert.equal((await cont(b)).status, 403, 'no nonce');
  // ...and that burned the confirmation: the right nonce no longer works either.
  assert.equal((await cont(b, encodeURIComponent(nonce))).status, 403);

  const b2 = browser();
  await nonceOf(await page(b2, await codeFor(p.token)));
  assert.equal((await cont(b2, 'not-the-nonce')).status, 403, 'wrong nonce');
  const b3 = browser();
  const nonce3 = await nonceOf(await page(b3, await codeFor(p.token)));
  // A link from another site (or another browser) does not know this browser's nonce.
  assert.equal((await cont(browser(), encodeURIComponent(nonce3))).status, 403, 'nonce in a foreign browser');
  assert.equal((await cont(b3, encodeURIComponent(nonce3))).status, 302, 'the right one, once');
  assert.equal((await cont(b3, encodeURIComponent(nonce3))).status, 403, 'a repeat');
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('the browser is only ever sent to the app address or the platform login, never anywhere else', async () => {
  const p = await person();
  // A hostile query: a platform, a return address and a redirect of its own.
  const evil =
    '&platform=evil&next=https://evil.test&returnTo=//evil.test&redirect=https://evil.test&result=x';
  const sheet = browser();
  const confirm = await page(sheet, await codeFor(p.token), evil);
  const html = await confirm.text();
  assert.ok(!html.includes('evil'), 'nothing of the query is shown or used');
  const nonce = /nonce=([^"&]+)/.exec(html)[1];
  const cont = await sheet.get(`/auth/mobile/connect/continue?nonce=${nonce}${evil}`);
  assert.match(cont.headers.get('location'), /^http:\/\/fluxer\.test\/oauth2\/authorize\?/);
  assert.ok(!cont.headers.get('location').includes('evil'));
  profiles.fluxer = p.fluxer;
  const callback = await sheet.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}${evil}`);
  const back = new URL(callback.headers.get('location'));
  assert.equal(`${back.protocol}//${back.host}${back.pathname}`, 'sylo://connected');
  assert.equal(back.searchParams.get('platform'), 'fluxer');
  assert.match(
    back.searchParams.get('result'),
    /^[A-Za-z0-9_-]{43}$/,
    'the result is Sylo’s, not the query’s'
  );
  assert.ok(!callback.headers.get('location').includes('evil'));

  // Every way the callback can end ends at the same fixed address, with a fixed error word.
  const cases = [
    ['the person cancelled', (st) => `error=access_denied&state=${st}`, 'access-denied'],
    [
      'another error word',
      (st) => `error=${encodeURIComponent('https://evil.test')}&state=${st}`,
      'invalid-response',
    ],
    ['a wrong state', () => 'code=abc&state=wrong', 'invalid-response'],
    ['no state', () => 'code=abc', 'invalid-response'],
    ['nothing at all', () => '', 'invalid-response'],
  ];
  for (const [name, query, error] of cases) {
    const q = await person();
    const b = browser();
    const cn = await nonceOf(await page(b, await codeFor(q.token)));
    const go = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(cn)}`);
    const end = await b.get(`/auth/fluxer/callback?${query(stateOf(go))}${evil}`);
    assert.equal(end.status, 302, name);
    assert.equal(end.headers.get('location'), `${APP_FLUXER}&error=${error}`, name);
    assert.deepEqual(await identityKinds(q.accountId), ['discord'], name);
  }
});

test('a code made for fluxer cannot finish on the discord callback', async () => {
  const p = await person();
  const b = browser();
  const nonce = await nonceOf(await page(b, await codeFor(p.token, 'fluxer')));
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`);
  profiles.discord = { ...profiles.discord, id: uid('3333333333') };
  const wrong = await b.get(`/auth/discord/callback?code=abc&state=${stateOf(cont)}`);
  assert.equal(wrong.status, 400, 'an ordinary failed login, not the app flow');
  assert.equal(wrong.headers.get('location'), null);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  const rows = await prepare('SELECT * FROM mobile_connect_results WHERE account_id = ?').all(p.accountId);
  assert.equal(rows.length, 0);
  // and the flow is spent: the right callback with the same state cannot be replayed
  profiles.fluxer = p.fluxer;
  const replay = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  assert.equal(replay.status, 400);
});

test('a login that already belongs to another account ends at the app with an error', async () => {
  setProfiles();
  await signIn(browser(), 'fluxer'); // someone else's account holds this Fluxer login
  const taken = { ...profiles.fluxer };
  const takenAccount = (await findIdentity('fluxer', taken.id)).accountId;

  const p = await person();
  const { callback } = await browserFlow(browser(), await codeFor(p.token), taken);
  assert.equal(callback.headers.get('location'), `${APP_FLUXER}&error=identity-linked`);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  assert.equal((await findIdentity('fluxer', taken.id)).accountId, takenAccount);
});

test('a login taken by another account between the callback and the completion is a 409', async () => {
  const p = await person();
  const { result } = await flowFor(p);
  const other = await person();
  await linkIdentity(other.accountId, {
    platform: 'fluxer',
    platformUserId: p.fluxer.id,
    username: 'quicker',
    avatar: null,
    guildIds: [],
  });
  const res = await complete(p.token, result);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'identity_linked' });
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('an account that got the platform in the meantime ends with an error, at the callback or the completion', async () => {
  const p = await person();
  const b = browser();
  const nonce = await nonceOf(await page(b, await codeFor(p.token)));
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`);
  await linkIdentity(p.accountId, {
    platform: 'fluxer',
    platformUserId: uid('5555555555'),
    username: 'first',
    avatar: null,
    guildIds: [],
  });
  profiles.fluxer = p.fluxer;
  const callback = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
  assert.equal(callback.headers.get('location'), `${APP_FLUXER}&error=already-linked`);
  assert.ok(!(await findIdentity('fluxer', p.fluxer.id)));

  // between the callback and the completion
  const q = await person();
  const { result } = await flowFor(q);
  await linkIdentity(q.accountId, {
    platform: 'fluxer',
    platformUserId: uid('5555555555'),
    username: 'sneaky',
    avatar: null,
    guildIds: [],
  });
  const res = await complete(q.token, result);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'already_linked' });
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
  assert.equal(res.headers.get('location'), `${APP_FLUXER}&error=already-linked`);
});

test('the round-trip must finish within ten minutes', async () => {
  const p = await person();
  const b = browser();
  const nonce = await nonceOf(await page(b, await codeFor(p.token)));
  const cont = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce)}`);
  profiles.fluxer = p.fluxer;
  const real = Date.now;
  Date.now = () => real() + 11 * 60 * 1000;
  try {
    const callback = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(cont)}`);
    assert.equal(callback.headers.get('location'), `${APP_FLUXER}&error=expired`);
  } finally {
    Date.now = real;
  }
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
});

test('the confirmation page warns when the browser is signed in as someone else, and names both accounts', async () => {
  const a = await person();
  const b = await person();
  profiles.discord = { ...b.discord };
  // A has a different display name from B, so the page can tell them apart.
  await prepare("UPDATE account_identities SET username = 'attacker-handle' WHERE account_id = ?").run(
    a.accountId
  );
  const res = await page(b.b, await codeFor(a.token));
  const html = await res.text();
  assert.match(html, /Add Fluxer to the Sylo account attacker-handle\?/);
  assert.match(html, /This browser is signed in to Sylo as ferdi, not as attacker-handle/);
  assert.match(html, /If attacker-handle is not you, someone else started this: cancel/);
  // The same person opening their own link gets no warning.
  const own = await page(a.b, await codeFor(a.token));
  assert.doesNotMatch(await own.text(), /signed in to Sylo as/);
});

test('no session fixation: the flow never makes or replaces a session, and a leftover login does not become one', async () => {
  const p = await person();
  const b = browser();
  // This browser has begun an ordinary Fluxer login first and holds its state.
  const begin = await b.get('/auth/fluxer/login');
  const oldState = stateOf(begin);

  const nonce = await nonceOf(await page(b, await codeFor(p.token)));
  assert.ok(nonce);
  // Finishing the old login now must not be mistaken for the app's flow (the page cleared its state).
  profiles.fluxer = p.fluxer;
  const old = await b.get(`/auth/fluxer/callback?code=abc&state=${oldState}`);
  assert.equal(old.status, 400);
  assert.equal(old.headers.get('location'), null);
  assert.deepEqual(await identityKinds(p.accountId), ['discord']);
  assert.ok(!(await findIdentity('fluxer', p.fluxer.id)), 'and it signed nobody in');
  assert.equal((await b.get('/api/v2/guilds')).status, 401);

  // The other way round: a plain login started after the confirmation is never an app flow.
  const nonce2 = await nonceOf(await page(b, await codeFor(p.token)));
  const go = await b.get(`/auth/mobile/connect/continue?nonce=${encodeURIComponent(nonce2)}`);
  assert.ok(go.headers.get('location'));
  const plain = await b.get('/auth/fluxer/login'); // a new, ordinary round-trip
  const done = await b.get(`/auth/fluxer/callback?code=abc&state=${stateOf(plain)}`);
  assert.ok(!done.headers.get('location').startsWith('sylo:'), 'an ordinary login ends in the dashboard');
  assert.deepEqual(await identityKinds(p.accountId), ['discord'], 'and does not touch the app’s account');
});

test('GET /api/mobile/info offers app-connect when both logins are set up', async () => {
  const info = await (await app.get('/api/mobile/info')).json();
  assert.ok(info.features.includes('app-connect'));
});
