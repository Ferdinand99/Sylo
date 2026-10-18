import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCount, initial } from '../web-v2/src/util.js';

test('initial: first letter, uppercased', () => {
  assert.equal(initial('sylo'), 'S');
  assert.equal(initial('  gaming hub'), 'G');
  assert.equal(initial('Æsir'), 'Æ');
});

test('initial: emoji-first names keep the whole emoji', () => {
  assert.equal(initial('🎮 Gaming Hub'), '🎮');
  // Flag (two regional indicators) and a skin-toned emoji are one grapheme each.
  assert.equal(initial('🇳🇴 Norge'), '🇳🇴');
  assert.equal(initial('👍🏽 Thumbs'), '👍🏽');
});

test('initial: empty or missing names fall back to ?', () => {
  assert.equal(initial(''), '?');
  assert.equal(initial('   '), '?');
  assert.equal(initial(null), '?');
  assert.equal(initial(undefined), '?');
});

test('formatCount: separators, passthrough and missing values', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1284), (1284).toLocaleString());
  assert.equal(formatCount('3 h'), '3 h');
  assert.equal(formatCount(null), '—');
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount(Number.NaN), '—');
});
