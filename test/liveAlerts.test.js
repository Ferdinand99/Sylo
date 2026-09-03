import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEndedPayload } from '../src/modules/lib/liveAlerts.js';

test('buildEndedPayload: greyed embed with a "was live for" line', () => {
  const p = buildEndedPayload({
    name: 'ninja',
    url: 'https://twitch.tv/ninja',
    since: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
  });
  assert.equal(p.embeds.length, 1);
  const e = p.embeds[0].data;
  assert.match(e.title, /^⏹ ninja — stream ended · was live for /);
  assert.equal(e.url, 'https://twitch.tv/ninja');
  assert.equal(e.color, 0x4b5563);
  assert.deepEqual(p.allowedMentions, { parse: [] }); // never re-pings on edit
});

test('buildEndedPayload: plain-text mode carries the link, no embed', () => {
  const p = buildEndedPayload({ name: 'xqc', url: 'https://kick.com/xqc', plainText: true });
  assert.deepEqual(p.embeds, []);
  assert.match(p.content, /^⏹ xqc — stream ended\nhttps:\/\/kick\.com\/xqc$/);
});

test('buildEndedPayload: no duration line when the start time is unknown', () => {
  const p = buildEndedPayload({ name: 'someone' });
  assert.equal(p.embeds[0].data.title, '⏹ someone — stream ended');
});
