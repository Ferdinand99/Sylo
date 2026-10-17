import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepMap } from '../src/lib/sweepMap.js';

test('sweepMap drops only the stale entries', () => {
  const m = new Map([
    ['old', Date.now() - 60_000],
    ['new', Date.now()],
  ]);
  const sweep = sweepMap(m, (at, now) => now - at > 30_000);
  sweep();
  assert.deepEqual([...m.keys()], ['new']);
});
