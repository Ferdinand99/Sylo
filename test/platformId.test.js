import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORMS,
  makePlatformGuildId,
  splitPlatformGuildId,
  isPlatformGuildId,
} from '../src/lib/platformId.js';

test('PLATFORMS lists exactly discord and fluxer', () => {
  assert.deepEqual(PLATFORMS, ['discord', 'fluxer']);
});

test('makePlatformGuildId builds the composite string', () => {
  assert.equal(makePlatformGuildId('discord', '123456789012345678'), 'discord:123456789012345678');
  assert.equal(makePlatformGuildId('fluxer', '987654321098765432'), 'fluxer:987654321098765432');
});

test('makePlatformGuildId throws on an unknown platform', () => {
  assert.throws(() => makePlatformGuildId('telegram', '123'), /Unknown platform/);
});

test('splitPlatformGuildId round-trips a value makePlatformGuildId produced', () => {
  const id = makePlatformGuildId('discord', '123456789012345678');
  assert.deepEqual(splitPlatformGuildId(id), { platform: 'discord', rawId: '123456789012345678' });
});

test('splitPlatformGuildId rejects malformed input', () => {
  assert.equal(splitPlatformGuildId('123456789012345678'), null); // bare snowflake, no prefix
  assert.equal(splitPlatformGuildId('telegram:123'), null); // unknown platform
  assert.equal(splitPlatformGuildId('discord:'), null); // empty raw id
  assert.equal(splitPlatformGuildId(''), null);
  assert.equal(splitPlatformGuildId(null), null);
  assert.equal(splitPlatformGuildId(undefined), null);
  assert.equal(splitPlatformGuildId(12345), null);
});

test('isPlatformGuildId mirrors splitPlatformGuildId', () => {
  assert.equal(isPlatformGuildId('discord:123'), true);
  assert.equal(isPlatformGuildId('fluxer:456'), true);
  assert.equal(isPlatformGuildId('123'), false);
  assert.equal(isPlatformGuildId('discord:'), false);
});
