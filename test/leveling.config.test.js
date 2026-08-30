import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLevelingConfig } from '../src/modules/leveling.js';

test('normaliseLevelingConfig: clamps cooldown, validates announce mode, keeps default message', () => {
  const a = normaliseLevelingConfig({ cooldownSeconds: 99999, announce: 'bogus' });
  assert.equal(a.cooldownSeconds, 3600);
  assert.equal(a.announce, 'channel');
  assert.ok(a.announceMessage.includes('{level}'));
  assert.equal(a.publicLeaderboard, true);
});

test('normaliseLevelingConfig: rewards need level>=1 and a snowflake role, sorted ascending', () => {
  const c = normaliseLevelingConfig({
    rewards: [
      { level: 10, roleId: '123456789012345678' },
      { level: 0, roleId: '123456789012345678' }, // dropped: level < 1
      { level: 3, roleId: 'nope' }, // dropped: bad id
      { level: 5, roleId: '223456789012345678' },
    ],
  });
  assert.deepEqual(c.rewards.map((r) => r.level), [5, 10]);
});

test('normaliseLevelingConfig: publicLeaderboard and stackRewards default true, off when false', () => {
  assert.equal(normaliseLevelingConfig({ publicLeaderboard: false }).publicLeaderboard, false);
  assert.equal(normaliseLevelingConfig({ stackRewards: false }).stackRewards, false);
});
