// Internal sharding: turn the configured shard count into discord.js Client
// options. Every listed shard runs in this one process — one Client, one cache,
// one DB connection — so nothing else in Sylo has to change. See
// docs/roadmap.md ("Internal sharding") for why and when this matters.

/**
 * @param {'auto' | number} shardCount
 * @returns {{ shards: 'auto' } | { shardCount: number, shards: number[] }}
 */
export function resolveShardOptions(shardCount) {
  if (shardCount === 'auto') return { shards: 'auto' };
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError(`shardCount must be 'auto' or a positive integer, got ${shardCount}`);
  }
  return { shardCount, shards: Array.from({ length: shardCount }, (_, i) => i) };
}
