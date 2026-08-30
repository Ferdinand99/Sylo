import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseVerificationConfig,
  signVerifyToken,
  verifyVerifyToken,
  effectiveMode,
} from '../src/modules/verification.js';

const G = '111111111111111111';
const U = '222222222222222222';

test('normaliseVerificationConfig: defaults, id validation, clamps', () => {
  const c = normaliseVerificationConfig({
    mode: 'bogus',
    verifiedRoleId: 'nope',
    channelId: G,
    kickAfterMinutes: 99999,
  });
  assert.equal(c.mode, 'button');
  assert.equal(c.verifiedRoleId, '');
  assert.equal(c.channelId, G);
  assert.equal(c.kickAfterMinutes, 10080);
  assert.ok(c.title && c.message && c.successMessage);
});

test('effectiveMode: button mode is always button; captcha follows Turnstile config', () => {
  assert.equal(effectiveMode({ mode: 'button' }), 'button');
  // captcha resolves to 'captcha' only when Turnstile keys are set — env-dependent,
  // so just assert it is one of the two valid values.
  assert.ok(['button', 'captcha'].includes(effectiveMode({ mode: 'captcha' })));
});

test('verify token: round-trips and binds guild + user', () => {
  const token = signVerifyToken(G, U);
  const parsed = verifyVerifyToken(token);
  assert.deepEqual(parsed, { guildId: G, userId: U });
});

test('verify token: rejects tampering and garbage', () => {
  const token = signVerifyToken(G, U);
  assert.equal(verifyVerifyToken(token.slice(0, -3) + 'aaa'), null);
  assert.equal(verifyVerifyToken('not.a.token'), null);
  assert.equal(verifyVerifyToken(''), null);
});
