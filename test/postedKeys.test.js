import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  seen,
  seenValue,
  anySeenMatching,
  markSeen,
  forget,
  clearScope,
  clearGuildPostedKeys,
  pruneScopeOlderThan,
} from '../src/db/postedKeys.js';
import { db } from '../src/db/index.js';

const G = '900000000000000001';

test('markSeen / seen: a key is remembered per (guild, scope)', async () => {
  assert.equal(await seen(G, 'demo', 'a'), false);
  await markSeen(G, 'demo', 'a');
  assert.equal(await seen(G, 'demo', 'a'), true);
  assert.equal(await seen(G, 'demo', 'b'), false);
  assert.equal(await seen('900000000000000002', 'demo', 'a'), false);
});

test('markSeen default does not overwrite; upsert refreshes the value', async () => {
  await markSeen(G, 'val', 'k', 'first');
  await markSeen(G, 'val', 'k', 'second'); // no upsert -> ignored
  assert.equal(await seenValue(G, 'val', 'k'), 'first');
  await markSeen(G, 'val', 'k', 'third', { upsert: true });
  assert.equal(await seenValue(G, 'val', 'k'), 'third');
});

test('seenValue is null for a missing key and for a valueless row', async () => {
  assert.equal(await seenValue(G, 'nope', 'x'), null);
  await markSeen(G, 'novalue', 'x');
  assert.equal(await seenValue(G, 'novalue', 'x'), null);
  assert.equal(await seen(G, 'novalue', 'x'), true);
});

test('anySeenMatching matches on a key prefix glob', async () => {
  await markSeen(G, 'yt-video', 'UCabc:vid1');
  await markSeen(G, 'yt-video', 'UCabc:vid2');
  assert.equal(await anySeenMatching(G, 'yt-video', 'UCabc:*'), true);
  assert.equal(await anySeenMatching(G, 'yt-video', 'UCxyz:*'), false);
});

test('forget drops one key; clearScope drops the whole scope for a guild', async () => {
  await markSeen(G, 's1', 'a');
  await markSeen(G, 's1', 'b');
  await markSeen(G, 's2', 'a');
  await forget(G, 's1', 'a');
  assert.equal(await seen(G, 's1', 'a'), false);
  assert.equal(await seen(G, 's1', 'b'), true);
  await clearScope(G, 's1');
  assert.equal(await seen(G, 's1', 'b'), false);
  assert.equal(await seen(G, 's2', 'a'), true);
});

test('pruneScopeOlderThan only removes rows past the age in that scope', async () => {
  await markSeen(G, 'prune', 'old');
  db.prepare(
    "UPDATE posted_keys SET posted_at = ? WHERE guild_id = ? AND scope = 'prune' AND key = 'old'"
  ).run(Date.now() - 10_000, G);
  await markSeen(G, 'prune', 'fresh');
  await markSeen(G, 'keepme', 'old');
  db.prepare("UPDATE posted_keys SET posted_at = ? WHERE scope = 'keepme'").run(Date.now() - 10_000);

  await pruneScopeOlderThan('prune', 5_000);
  assert.equal(await seen(G, 'prune', 'old'), false);
  assert.equal(await seen(G, 'prune', 'fresh'), true);
  assert.equal(await seen(G, 'keepme', 'old'), true); // other scope untouched
});

test('clearGuildPostedKeys wipes every scope for one guild', async () => {
  await markSeen(G, 'x', '1');
  await markSeen(G, 'y', '2');
  await markSeen('900000000000000009', 'x', '1');
  await clearGuildPostedKeys(G);
  assert.equal(await seen(G, 'x', '1'), false);
  assert.equal(await seen(G, 'y', '2'), false);
  assert.equal(await seen('900000000000000009', 'x', '1'), true);
});
