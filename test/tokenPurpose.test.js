// Verification links and appeal links are both HMAC tokens over "guild.user.expiry" with the
// same key. Without a purpose in the signature, one worked as the other. Old appeal links
// (sent before the purpose existed, valid for 60 days) still work as appeal links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { config } from '../src/config.js';
import { signVerifyToken, verifyVerifyToken } from '../src/modules/verification.js';
import { signAppealToken, verifyAppealToken } from '../src/modules/appeals.js';

const G = '900000000000000555';
const U = '900000000000000556';

test('a verification token is not an appeal token, and the other way round', () => {
  assert.ok(verifyVerifyToken(signVerifyToken(G, U)));
  assert.ok(verifyAppealToken(signAppealToken(G, U)));
  assert.equal(verifyAppealToken(signVerifyToken(G, U)), null);
  assert.equal(verifyVerifyToken(signAppealToken(G, U)), null);
});

test('an appeal link signed the old way still works', () => {
  const b64url = (buf) => Buffer.from(buf).toString('base64url');
  const body = `${G}.${U}.${Date.now() + 60_000}`;
  const legacy = `${b64url(body)}.${b64url(createHmac('sha256', config.sessionSecret).update(body).digest())}`;
  assert.deepEqual(verifyAppealToken(legacy), { guildId: G, userId: U });
  assert.equal(verifyVerifyToken(legacy), null, 'but not as a verification link');
});
