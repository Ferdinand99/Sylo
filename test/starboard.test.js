import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseStarboard } from '../src/modules/starboard.js';

test('normaliseStarboard: defaults an empty config to no boards', () => {
  assert.deepEqual(normaliseStarboard(), { boards: [] });
  assert.deepEqual(normaliseStarboard({ boards: 'nope' }), { boards: [] });
});

test('normaliseStarboard: fills defaults, validates ids, clamps the threshold', () => {
  const c = normaliseStarboard({
    boards: [
      {
        channelId: 'not-an-id',
        threshold: 999,
        emojis: '⭐',
      },
    ],
  });
  assert.equal(c.boards.length, 1);
  const b = c.boards[0];
  assert.equal(b.id, '0'); // deterministic index fallback
  assert.equal(b.name, 'Starboard');
  assert.equal(b.channelId, ''); // bad id rejected
  assert.equal(b.threshold, 100); // clamped to max
  assert.deepEqual(b.emojis, ['⭐']);
  assert.equal(b.roleMode, 'allow');
  assert.equal(b.channelMode, 'allow');
  assert.equal(b.autoReact, true);
  assert.equal(b.removeOnUnstar, true);
  assert.equal(b.ignoreSelfStars, true);
  assert.equal(b.ignoreBotMessages, true);
  assert.equal(b.removeOnDelete, true);
});

test('normaliseStarboard: parses custom emojis, keeps a stable id, dedupes lists', () => {
  const c = normaliseStarboard({
    boards: [
      {
        id: 42,
        name: 'x'.repeat(200),
        channelId: '123456789012345678',
        emojis: '⭐ <:star:987654321098765432> <a:spin:111111111111111111> ⭐',
        threshold: '5',
        roleMode: 'deny',
        roleList: ['222222222222222222', '222222222222222222', 'bad'],
        channelMode: 'deny',
        channelList: ['333333333333333333'],
        multiPerUser: true,
      },
    ],
  });
  const b = c.boards[0];
  assert.equal(b.id, '42');
  assert.equal(b.name.length, 60); // sliced
  assert.equal(b.channelId, '123456789012345678');
  assert.deepEqual(b.emojis, ['⭐', '987654321098765432', '111111111111111111']);
  assert.equal(b.threshold, 5);
  assert.equal(b.roleMode, 'deny');
  assert.deepEqual(b.roleList, ['222222222222222222']);
  assert.equal(b.channelMode, 'deny');
  assert.deepEqual(b.channelList, ['333333333333333333']);
  assert.equal(b.multiPerUser, true);
});

test('normaliseStarboard: caps the number of boards at 10', () => {
  const c = normaliseStarboard({
    boards: Array.from({ length: 25 }, (_, i) => ({ id: String(i), channelId: '123456789012345678' })),
  });
  assert.equal(c.boards.length, 10);
});

test('normaliseStarboard: round-trips its own output', () => {
  const once = normaliseStarboard({
    boards: [{ id: '1', channelId: '123456789012345678', emojis: '⭐', threshold: 4 }],
  });
  const twice = normaliseStarboard(once);
  assert.deepEqual(twice, once);
});
