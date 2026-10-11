import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORMS,
  makePlatformGuildId,
  splitPlatformGuildId,
  isPlatformGuildId,
} from '../src/lib/platformId.js';

const DISCORD_ID = '123456789012345678';
const FLUXER_ID = '987654321098765432';

test('PLATFORMS lists exactly discord and fluxer', () => {
  assert.deepEqual(PLATFORMS, ['discord', 'fluxer']);
});

test('makePlatformGuildId leaves a Discord id bare and prefixes a Fluxer id', () => {
  assert.equal(makePlatformGuildId('discord', DISCORD_ID), DISCORD_ID);
  assert.equal(makePlatformGuildId('fluxer', FLUXER_ID), `fluxer:${FLUXER_ID}`);
});

test('makePlatformGuildId throws on an unknown platform', () => {
  assert.throws(() => makePlatformGuildId('telegram', DISCORD_ID), /Unknown platform/);
});

test('splitPlatformGuildId reads a bare snowflake as Discord', () => {
  assert.deepEqual(splitPlatformGuildId(DISCORD_ID), { platform: 'discord', rawId: DISCORD_ID });
});

test('splitPlatformGuildId reads "fluxer:<snowflake>" as Fluxer', () => {
  assert.deepEqual(splitPlatformGuildId(`fluxer:${FLUXER_ID}`), { platform: 'fluxer', rawId: FLUXER_ID });
});

test('splitPlatformGuildId round-trips whatever makePlatformGuildId produced', () => {
  for (const [platform, rawId] of [
    ['discord', DISCORD_ID],
    ['fluxer', FLUXER_ID],
  ]) {
    assert.deepEqual(splitPlatformGuildId(makePlatformGuildId(platform, rawId)), { platform, rawId });
  }
});

test('splitPlatformGuildId rejects malformed input', () => {
  assert.equal(splitPlatformGuildId('123'), null); // too short for a snowflake
  assert.equal(splitPlatformGuildId('abc'), null);
  assert.equal(splitPlatformGuildId(`discord:${DISCORD_ID}`), null); // Discord is never prefixed
  assert.equal(splitPlatformGuildId(`telegram:${DISCORD_ID}`), null); // unknown platform
  assert.equal(splitPlatformGuildId('fluxer:'), null); // empty raw id
  assert.equal(splitPlatformGuildId('fluxer:abc'), null); // raw id not a snowflake
  assert.equal(splitPlatformGuildId(''), null);
  assert.equal(splitPlatformGuildId(null), null);
  assert.equal(splitPlatformGuildId(undefined), null);
  assert.equal(splitPlatformGuildId(12345), null);
});

test('isPlatformGuildId mirrors splitPlatformGuildId', () => {
  assert.equal(isPlatformGuildId(DISCORD_ID), true);
  assert.equal(isPlatformGuildId(`fluxer:${FLUXER_ID}`), true);
  assert.equal(isPlatformGuildId('123'), false);
  assert.equal(isPlatformGuildId(`discord:${DISCORD_ID}`), false);
  assert.equal(isPlatformGuildId('fluxer:'), false);
});
