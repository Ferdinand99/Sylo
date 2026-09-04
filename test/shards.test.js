import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveShardOptions } from '../src/bot/lib/shards.js';

test("resolveShardOptions: 'auto' passes straight through to discord.js", () => {
  assert.deepEqual(resolveShardOptions('auto'), { shards: 'auto' });
});

test('resolveShardOptions: a count expands to an explicit 0-based shard list', () => {
  assert.deepEqual(resolveShardOptions(1), { shardCount: 1, shards: [0] });
  assert.deepEqual(resolveShardOptions(4), { shardCount: 4, shards: [0, 1, 2, 3] });
});

test('resolveShardOptions: rejects non-positive-integer counts', () => {
  assert.throws(() => resolveShardOptions(0), TypeError);
  assert.throws(() => resolveShardOptions(-3), TypeError);
  assert.throws(() => resolveShardOptions(2.5), TypeError);
  assert.throws(() => resolveShardOptions('five'), TypeError);
  assert.throws(() => resolveShardOptions(NaN), TypeError);
});
