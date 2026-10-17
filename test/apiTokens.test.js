// API tokens for the Sylo app and the one-time codes that become them (internal/mobile-api-plan.md).
// Only hashes are stored; a code is single use, short-lived and bound to a PKCE challenge.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepare } from '../src/db/driver.js';
import {
  createApiToken,
  findApiToken,
  touchApiToken,
  listApiTokens,
  revokeApiToken,
  revokeApiTokenValue,
  revokeAccountTokens,
  purgeExpiredApiTokens,
  createMobileCode,
  redeemMobileCode,
  pkceChallenge,
} from '../src/db/apiTokens.js';

const DAY = 24 * 60 * 60 * 1000;
let n = 0;
const account = () => `acct-${++n}`;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test('createApiToken: a prefixed random token, only its hash in the database', async () => {
  const a = account();
  const { id, token, expiresAt } = await createApiToken(a, { deviceName: 'iPhone 18 Pro', ttlMs: 90 * DAY });
  assert.match(token, /^sylo_[A-Za-z0-9_-]{43}$/);
  assert.ok(expiresAt > Date.now() + 89 * DAY);
  const rows = await prepare('SELECT * FROM api_tokens WHERE id = ?').all(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, sha256(token));
  assert.ok(!JSON.stringify(rows[0]).includes(token), 'the token itself is never stored');
  const other = await createApiToken(a, { deviceName: 'iPad', ttlMs: DAY });
  assert.notEqual(other.token, token);
});

test('findApiToken: the right account for a live token, null for unknown, malformed or expired', async () => {
  const a = account();
  const { token, id } = await createApiToken(a, { deviceName: 'iPhone', ttlMs: DAY });
  const found = await findApiToken(token);
  assert.equal(found.id, id);
  assert.equal(found.accountId, a);
  assert.equal(found.deviceName, 'iPhone');
  assert.equal(await findApiToken('sylo_nope'), null);
  assert.equal(await findApiToken(''), null);
  assert.equal(await findApiToken(undefined), null);

  const old = await createApiToken(a, { deviceName: 'old', ttlMs: -1 });
  assert.equal(await findApiToken(old.token), null, 'expired');
});

test('touchApiToken: slides the expiry forward, at most once an hour', async () => {
  const a = account();
  const { token } = await createApiToken(a, { deviceName: 'x', ttlMs: DAY });
  const t0 = await findApiToken(token);
  const later = Date.now() + 2 * 60 * 60 * 1000;
  assert.equal(await touchApiToken(t0, { ttlMs: 90 * DAY, now: later }), true);
  const t1 = await findApiToken(token);
  assert.ok(t1.expiresAt >= later + 90 * DAY - 1000);
  assert.equal(t1.lastUsedAt, later);
  assert.equal(await touchApiToken(t1, { ttlMs: 90 * DAY, now: later + 60_000 }), false, 'within the hour');
});

test('listing and revoking: per device, by value, and every token of an account', async () => {
  const a = account();
  const b = account();
  const phone = await createApiToken(a, { deviceName: 'phone', ttlMs: DAY });
  const pad = await createApiToken(a, { deviceName: 'pad', ttlMs: DAY });
  const theirs = await createApiToken(b, { deviceName: 'theirs', ttlMs: DAY });

  const mine = await listApiTokens(a);
  assert.deepEqual(mine.map((t) => t.deviceName).sort(), ['pad', 'phone']);
  assert.ok(
    mine.every((t) => !('token' in t) && !('tokenHash' in t)),
    'a listing never exposes secrets'
  );

  assert.equal(await revokeApiToken(b, phone.id), false, "someone else's token is not theirs to revoke");
  assert.ok(await findApiToken(phone.token));
  assert.equal(await revokeApiToken(a, phone.id), true);
  assert.equal(await findApiToken(phone.token), null);

  assert.equal(await revokeApiTokenValue(pad.token), true);
  assert.equal(await findApiToken(pad.token), null);

  const again = await createApiToken(a, { deviceName: 'again', ttlMs: DAY });
  await revokeAccountTokens(a);
  assert.equal(await findApiToken(again.token), null);
  assert.ok(await findApiToken(theirs.token), 'other accounts keep theirs');
});

test('purgeExpiredApiTokens removes only expired rows', async () => {
  const a = account();
  const live = await createApiToken(a, { deviceName: 'live', ttlMs: DAY });
  await createApiToken(a, { deviceName: 'dead', ttlMs: -1 });
  assert.ok((await purgeExpiredApiTokens()) >= 1);
  assert.deepEqual(
    (await listApiTokens(a)).map((t) => t.deviceName),
    ['live']
  );
  assert.ok(await findApiToken(live.token));
});

test('pkceChallenge is base64url(sha256(verifier)) as in RFC 7636 (S256)', () => {
  // The RFC 7636 appendix B example.
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
});

test('mobile codes: redeemed once with the right verifier, before they expire', async () => {
  const a = account();
  const verifier = 'v'.repeat(64);
  const challenge = pkceChallenge(verifier);

  const code = await createMobileCode(a, challenge);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  const rows = await prepare('SELECT * FROM mobile_codes').all();
  assert.ok(
    rows.every((r) => r.code_hash !== code),
    'only the hash is stored'
  );

  assert.equal(await redeemMobileCode(code, verifier), a);
  assert.equal(await redeemMobileCode(code, verifier), null, 'single use');

  const wrong = await createMobileCode(a, challenge);
  assert.equal(await redeemMobileCode(wrong, 'not-the-verifier'), null);
  assert.equal(await redeemMobileCode(wrong, verifier), null, 'a failed attempt burns the code');

  const expired = await createMobileCode(a, challenge, { ttlMs: -1 });
  assert.equal(await redeemMobileCode(expired, verifier), null);

  assert.equal(await redeemMobileCode('', verifier), null);
  assert.equal(await redeemMobileCode(undefined, undefined), null);
});
