import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldRepost, cooldownMs, normaliseStickyConfig } from '../src/modules/sticky.js';

const human = { isOwnSticky: false, isApp: false };
const app = { isOwnSticky: false, isApp: true };
const ownSticky = { isOwnSticky: true, isApp: true };
const base = { content: 'stick around' };

test('cooldownMs: 0 / missing -> 4s default; otherwise clamped to [3, 3600] s', () => {
  assert.equal(cooldownMs({}), 4000);
  assert.equal(cooldownMs({ cooldownSeconds: 0 }), 4000);
  assert.equal(cooldownMs({ cooldownSeconds: 1 }), 3000); // clamped up
  assert.equal(cooldownMs({ cooldownSeconds: 60 }), 60_000);
  assert.equal(cooldownMs({ cooldownSeconds: 99_999 }), 3_600_000); // clamped down
});

test('shouldRepost: a human message past the cooldown reposts', () => {
  assert.equal(shouldRepost(base, human, 0, 10_000), true);
});

test('shouldRepost: never react to our own sticky message, even with repostOnBots', () => {
  assert.equal(shouldRepost({ ...base, repostOnBots: true }, ownSticky, 0, 10_000), false);
});

test('shouldRepost: app / webhook / Sylo messages are ignored unless repostOnBots', () => {
  assert.equal(shouldRepost({ ...base, repostOnBots: false }, app, 0, 10_000), false);
  assert.equal(shouldRepost({ ...base, repostOnBots: true }, app, 0, 10_000), true);
});

test('shouldRepost: within the cooldown window it holds off', () => {
  const now = 100_000;
  assert.equal(shouldRepost(base, human, now - 2000, now), false); // < 4s default
  assert.equal(shouldRepost(base, human, now - 5000, now), true); // > 4s
  const slow = { ...base, cooldownSeconds: 60 };
  assert.equal(shouldRepost(slow, human, now - 30_000, now), false); // < 60s
  assert.equal(shouldRepost(slow, human, now - 61_000, now), true);
});

test('shouldRepost: an empty sticky never reposts', () => {
  assert.equal(shouldRepost({ content: '' }, human, 0, 10_000), false);
});

test('shouldRepost: an embed-only sticky (no content) still reposts', () => {
  assert.equal(shouldRepost({ content: '', embed: { title: 'hi' } }, human, 0, 10_000), true);
});

test('normaliseStickyConfig: drops a row with neither content nor a usable embed', () => {
  const out = normaliseStickyConfig({
    stickies: [
      { channelId: '111111111111111111', content: '', embed: null },
      { channelId: '222222222222222222', content: '', embed: {} }, // empty embed spec
    ],
  });
  assert.deepEqual(out.stickies, []);
});

test('normaliseStickyConfig: keeps an embed-only row and sanitises the embed', () => {
  const out = normaliseStickyConfig({
    stickies: [
      {
        channelId: '111111111111111111',
        content: '',
        embed: { title: 'Rules', color: '5865f2', junk: 'nope' },
      },
    ],
  });
  assert.equal(out.stickies.length, 1);
  assert.equal(out.stickies[0].content, '');
  assert.equal(out.stickies[0].embed.title, 'Rules');
  assert.equal(out.stickies[0].embed.color, '#5865f2');
  assert.equal(out.stickies[0].embed.junk, undefined);
});

test('normaliseStickyConfig: carries the previous lastMessageId over by channelId', () => {
  const prev = {
    stickies: [{ channelId: '111111111111111111', content: 'old', lastMessageId: '999' }],
  };
  const out = normaliseStickyConfig(
    { stickies: [{ channelId: '111111111111111111', content: 'new' }] },
    prev
  );
  assert.equal(out.stickies[0].lastMessageId, '999');
});
