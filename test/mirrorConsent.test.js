// Consent for a mirror (src/mirror/consent.js): nothing may go ahead until someone with Edit on each side
// has agreed; the code that carries the Fluxer side's agreement is one-time, expires, is stored hashed, and
// cannot be used for another server.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/db/mirror.js';
import {
  CODE_TTL_MS,
  ConsentError,
  MAX_CODE_ATTEMPTS,
  acceptMirror,
  newCode,
  requestMirror,
  requirePairConsent,
  setConsentProvider,
} from '../src/mirror/consent.js';

const D1 = '920000000000000001';
const D2 = '920000000000000002';
const F1 = 'fluxer:820000000000000001';
const F2 = 'fluxer:820000000000000002';
const T0 = 1_800_000_000_000;

const ask = (over = {}) =>
  requestMirror({
    sourceGuild: D1,
    targetGuild: F1,
    actor: 'Anna',
    sourceUser: 'dc-owner',
    targetOwner: false,
    now: T0,
    ...over,
  });
const rejects = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof ConsentError && err.code === code, `expected ${code}`);

test('a code is eight characters without lookalikes, and a new one each time', () => {
  const a = newCode();
  assert.match(a, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.notEqual(a, newCode());
});

test('asking creates a pending pair: the Discord side has agreed, the Fluxer side has not', async () => {
  const { pair, code } = await ask();
  assert.ok(code);
  assert.equal(pair.status, 'pending');
  assert.equal(pair.sourceConsentBy, 'Anna');
  assert.equal(pair.targetConsentBy, '');
  assert.equal(pair.codeExpiresAt, T0 + CODE_TTL_MS);
  assert.ok(!JSON.stringify(pair).includes(code), 'the code is stored only as a hash');
  await assert.rejects(requirePairConsent(pair.id), /Fluxer server/);
});

test('someone with Edit on the other server agrees with the code; the code works once', async () => {
  const { code } = await ask();
  const pair = await acceptMirror({
    targetGuild: F1,
    code: code.toLowerCase().replace('-', ' '),
    actor: 'Bo',
    userId: 'fx-owner',
    now: T0 + 1000,
  });
  assert.equal(pair.status, 'ready');
  assert.equal(pair.targetConsentBy, 'Bo');
  assert.deepEqual(
    [pair.sourceConsentUser, pair.targetConsentUser],
    ['dc-owner', 'fx-owner'],
    'the owners are recorded'
  );
  assert.equal(pair.codeHash, '');
  assert.equal((await requirePairConsent(pair.id)).id, pair.id);
  await rejects(acceptMirror({ targetGuild: F1, code, actor: 'Cy', now: T0 + 2000 }), 'no-request');
});

test('the same person with Edit on both servers agrees on both sides at once, with no code', async () => {
  await db.deletePair((await db.getPairBySource(D1)).id);
  const { pair, code } = await ask({ targetOwner: true, targetUser: 'fx-owner' });
  assert.deepEqual([pair.sourceConsentUser, pair.targetConsentUser], ['dc-owner', 'fx-owner']);
  assert.equal(code, null);
  assert.equal(pair.status, 'ready');
  assert.deepEqual([pair.sourceConsentBy, pair.targetConsentBy], ['Anna', 'Anna']);
});

test('a code is for one server: another Fluxer server cannot use it', async () => {
  await db.deletePair((await db.getPairBySource(D1)).id);
  const { code } = await ask();
  await rejects(acceptMirror({ targetGuild: F2, code, actor: 'Mallory', now: T0 + 1 }), 'no-request');
  assert.equal((await db.getPairBySource(D1)).status, 'pending', 'the request is untouched');
  assert.equal((await db.getPairBySource(D1)).codeAttempts, 0);
});

test('a wrong code is refused; five wrong tries cancel the request', async () => {
  await db.deletePair((await db.getPairBySource(D1)).id);
  const { code } = await ask();
  for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
    await rejects(acceptMirror({ targetGuild: F1, code: 'AAAA-AAAA', actor: 'x', now: T0 }), 'wrong-code');
    assert.equal((await db.getPairBySource(D1)).codeAttempts, i);
  }
  await rejects(acceptMirror({ targetGuild: F1, code: 'AAAA-AAAA', actor: 'x', now: T0 }), 'cancelled');
  assert.equal(await db.getPairBySource(D1), null);
  await rejects(acceptMirror({ targetGuild: F1, code, actor: 'x', now: T0 }), 'no-request');
});

test('an expired code is refused and the request goes away', async () => {
  const { code } = await ask();
  await rejects(acceptMirror({ targetGuild: F1, code, actor: 'Bo', now: T0 + CODE_TTL_MS + 1 }), 'expired');
  assert.equal(await db.getPairBySource(D1), null);
});

test('a server cannot be mirrored onto itself, and a target belongs to one source', async () => {
  await rejects(ask({ targetGuild: D1 }), 'same-server');
  await ask();
  await rejects(ask({ sourceGuild: D2 }), 'target-busy');
  // A stale request (its code has expired) does not keep the target.
  const later = await ask({ sourceGuild: D2, now: T0 + CODE_TTL_MS + 5 });
  assert.equal(later.pair.sourceGuild, D2);
  assert.equal(await db.getPairBySource(D1), null);
  await db.deletePair(later.pair.id);
});

test('a source that already copies cannot ask again; a pair that has not copied can be replaced', async () => {
  const first = await ask({ targetOwner: true });
  const replaced = await ask({ targetGuild: F2, targetOwner: true });
  assert.equal(replaced.pair.targetGuild, F2, 'a request that has not copied is replaced');
  assert.equal(await db.getPair(first.pair.id), null);
  await db.updatePair(replaced.pair.id, { status: 'live' });
  await rejects(ask({ targetGuild: F1 }), 'already-mirrored');
  await rejects(ask({ targetGuild: F2 }), 'already-mirrored');
  await db.updatePair(replaced.pair.id, { status: 'stopped' });
  const again = await ask({ targetGuild: F2, targetOwner: true });
  assert.equal(
    again.pair.id,
    replaced.pair.id,
    'asking again after a stop reuses the pair, and so its id map'
  );
  assert.equal(again.pair.status, 'ready');
});

test('the code works for 15 minutes', () => {
  assert.equal(CODE_TTL_MS, 15 * 60_000);
});

test('a stopped mirror that made something keeps its target: another server cannot take it over', async () => {
  const first = await ask({ targetOwner: true });
  await db.putMapping({ pairId: first.pair.id, kind: 'channel', sourceId: '1', targetId: 't1', owned: true });
  await db.updatePair(first.pair.id, { status: 'stopped' });
  await rejects(ask({ sourceGuild: D2, targetOwner: true }), 'target-busy');
  assert.ok(await db.getPair(first.pair.id), 'the pair and its id map are kept');
  await db.deleteMapping(first.pair.id, 'channel', '1');
  const later = await ask({ sourceGuild: D2, targetOwner: true });
  assert.equal(later.pair.sourceGuild, D2, 'a stopped mirror that made nothing can be replaced');
  await db.deletePair(later.pair.id);
});

test('the consent check can be replaced (the bridge can plug its link codes in)', async () => {
  await ask({ targetOwner: true });
  const pair = await db.getPairBySource(D1);
  assert.equal((await requirePairConsent(pair.id)).id, pair.id);
  const previous = setConsentProvider({
    name: 'strict',
    check: () => ({ ok: false, reason: 'the bridge says no' }),
  });
  await assert.rejects(requirePairConsent(pair.id), /the bridge says no/);
  setConsentProvider(previous);
  assert.equal((await requirePairConsent(pair.id)).id, pair.id);
  await rejects(requirePairConsent(999_999), 'no-consent');
});
