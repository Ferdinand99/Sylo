import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLevelingConfig, resolveMultiplier } from '../src/modules/leveling.js';

const R1 = '100000000000000001';
const R2 = '100000000000000002';
const C1 = '200000000000000001';

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

test('normaliseLevelingConfig: voice XP defaults off, per-min clamped 1..60', () => {
  const d = normaliseLevelingConfig({});
  assert.equal(d.voiceXpEnabled, false);
  assert.equal(d.voiceXpPerMin, 10);
  assert.equal(d.voiceAfkExcluded, true);
  const c = normaliseLevelingConfig({ voiceXpEnabled: true, voiceXpPerMin: 999, voiceAfkExcluded: false });
  assert.equal(c.voiceXpEnabled, true);
  assert.equal(c.voiceXpPerMin, 60);
  assert.equal(c.voiceAfkExcluded, false);
});

test('normaliseLevelingConfig: multipliers — type coerced, factor clamped 0.1..5, bad id dropped, capped 25', () => {
  const c = normaliseLevelingConfig({
    multipliers: [
      { type: 'role', id: R1, factor: 2 },
      { type: 'channel', id: C1, factor: 99 }, // -> 5
      { type: 'bogus', id: R2, factor: 0.01 }, // type -> role, factor -> 0.1
      { type: 'role', id: 'nope', factor: 3 }, // dropped: bad id
    ],
  });
  assert.equal(c.multipliers.length, 3);
  assert.deepEqual(c.multipliers[0], { type: 'role', id: R1, factor: 2 });
  assert.equal(c.multipliers[1].factor, 5);
  assert.deepEqual(c.multipliers[2], { type: 'role', id: R2, factor: 0.1 });
  const many = Array.from({ length: 40 }, () => ({ type: 'role', id: R1, factor: 1 }));
  assert.equal(normaliseLevelingConfig({ multipliers: many }).multipliers.length, 25);
});

test('resolveMultiplier: max matching role factor × channel factor, capped at 10, defaults 1', () => {
  const cfg = normaliseLevelingConfig({
    multipliers: [
      { type: 'role', id: R1, factor: 2 },
      { type: 'role', id: R2, factor: 3 },
      { type: 'channel', id: C1, factor: 0.5 },
    ],
  });
  assert.equal(resolveMultiplier(cfg, {}), 1); // nothing matches
  assert.equal(resolveMultiplier(cfg, { roleIds: [R1, R2] }), 3); // highest role
  assert.equal(resolveMultiplier(cfg, { roleIds: [R2], channelId: C1 }), 1.5); // 3 * 0.5
  const huge = normaliseLevelingConfig({
    multipliers: [
      { type: 'role', id: R1, factor: 5 },
      { type: 'channel', id: C1, factor: 5 },
    ],
  });
  assert.equal(resolveMultiplier(huge, { roleIds: [R1], channelId: C1 }), 10); // 25 capped to 10
});
