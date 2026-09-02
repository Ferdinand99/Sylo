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

test('markSeen / seen: a key is remembered per (guild, scope)', () => {
  assert.equal(seen(G, 'demo', 'a'), false);
  markSeen(G, 'demo', 'a');
  assert.equal(seen(G, 'demo', 'a'), true);
  assert.equal(seen(G, 'demo', 'b'), false);
  assert.equal(seen('900000000000000002', 'demo', 'a'), false);
});

test('markSeen default does not overwrite; upsert refreshes the value', () => {
  markSeen(G, 'val', 'k', 'first');
  markSeen(G, 'val', 'k', 'second'); // no upsert -> ignored
  assert.equal(seenValue(G, 'val', 'k'), 'first');
  markSeen(G, 'val', 'k', 'third', { upsert: true });
  assert.equal(seenValue(G, 'val', 'k'), 'third');
});

test('seenValue is null for a missing key and for a valueless row', () => {
  assert.equal(seenValue(G, 'nope', 'x'), null);
  markSeen(G, 'novalue', 'x');
  assert.equal(seenValue(G, 'novalue', 'x'), null);
  assert.equal(seen(G, 'novalue', 'x'), true);
});

test('anySeenMatching matches on a key prefix glob', () => {
  markSeen(G, 'yt-video', 'UCabc:vid1');
  markSeen(G, 'yt-video', 'UCabc:vid2');
  assert.equal(anySeenMatching(G, 'yt-video', 'UCabc:*'), true);
  assert.equal(anySeenMatching(G, 'yt-video', 'UCxyz:*'), false);
});

test('forget drops one key; clearScope drops the whole scope for a guild', () => {
  markSeen(G, 's1', 'a');
  markSeen(G, 's1', 'b');
  markSeen(G, 's2', 'a');
  forget(G, 's1', 'a');
  assert.equal(seen(G, 's1', 'a'), false);
  assert.equal(seen(G, 's1', 'b'), true);
  clearScope(G, 's1');
  assert.equal(seen(G, 's1', 'b'), false);
  assert.equal(seen(G, 's2', 'a'), true);
});

test('pruneScopeOlderThan only removes rows past the age in that scope', () => {
  markSeen(G, 'prune', 'old');
  db.prepare(
    "UPDATE posted_keys SET posted_at = ? WHERE guild_id = ? AND scope = 'prune' AND key = 'old'"
  ).run(Date.now() - 10_000, G);
  markSeen(G, 'prune', 'fresh');
  markSeen(G, 'keepme', 'old');
  db.prepare("UPDATE posted_keys SET posted_at = ? WHERE scope = 'keepme'").run(Date.now() - 10_000);

  pruneScopeOlderThan('prune', 5_000);
  assert.equal(seen(G, 'prune', 'old'), false);
  assert.equal(seen(G, 'prune', 'fresh'), true);
  assert.equal(seen(G, 'keepme', 'old'), true); // other scope untouched
});

test('clearGuildPostedKeys wipes every scope for one guild', () => {
  markSeen(G, 'x', '1');
  markSeen(G, 'y', '2');
  markSeen('900000000000000009', 'x', '1');
  clearGuildPostedKeys(G);
  assert.equal(seen(G, 'x', '1'), false);
  assert.equal(seen(G, 'y', '2'), false);
  assert.equal(seen('900000000000000009', 'x', '1'), true);
});
