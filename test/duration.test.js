// Tests for the duration parser/formatter used by /timeout and /slowmode.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDuration, formatDuration } from '../src/bot/lib/duration.js';

test('parseDuration: single units', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('1w'), 604_800_000);
});

test('parseDuration: combined and messy input', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1d 2h'), 93_600_000);
  assert.equal(parseDuration(' 2H 15M '), 8_100_000);
});

test('parseDuration: bare number is minutes', () => {
  assert.equal(parseDuration('15'), 900_000);
});

test('parseDuration: invalid input returns null', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration('10x'), null);
});

test('formatDuration: compact output', () => {
  assert.equal(formatDuration(600_000), '10m');
  assert.equal(formatDuration(5_400_000), '1h 30m');
  assert.equal(formatDuration(93_600_000), '1d 2h');
  assert.equal(formatDuration(0), '0s');
});

test('parseDuration then formatDuration round-trips', () => {
  assert.equal(formatDuration(parseDuration('1h30m')), '1h 30m');
});
