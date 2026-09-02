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
  assert.deepEqual(
    c.rewards.map((r) => r.level),
    [5, 10]
  );
});

test('normaliseLevelingConfig: publicLeaderboard and stackRewards default true, off when false', () => {
  assert.equal(normaliseLevelingConfig({ publicLeaderboard: false }).publicLeaderboard, false);
  assert.equal(normaliseLevelingConfig({ stackRewards: false }).stackRewards, false);
});

test('normaliseLevelingConfig: xpRate snapped to a valid step, defaults 1', () => {
  assert.equal(normaliseLevelingConfig({}).xpRate, 1);
  assert.equal(normaliseLevelingConfig({ xpRate: '2.5' }).xpRate, 2.5);
  assert.equal(normaliseLevelingConfig({ xpRate: 7 }).xpRate, 1); // not a valid step
});

test('normaliseLevelingConfig: no-XP modes + removeRewardsOnXpLoss', () => {
  const c = normaliseLevelingConfig({
    noXpRolesMode: 'deny',
    noXpChannelsMode: 'nonsense',
    removeRewardsOnXpLoss: true,
  });
  assert.equal(c.noXpRolesMode, 'deny');
  assert.equal(c.noXpChannelsMode, 'allow'); // unknown -> default
  assert.equal(c.removeRewardsOnXpLoss, true);
  assert.equal(normaliseLevelingConfig({}).removeRewardsOnXpLoss, false);
});
