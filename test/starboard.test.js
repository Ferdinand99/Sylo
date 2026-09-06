import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseStarboard } from '../src/modules/starboard.js';
import {
  getStarboardEntry,
  getStarboardEntryByPost,
  upsertStarboardEntry,
  setStarboardPost,
  setStarboardCount,
  deleteStarboardEntry,
  deleteBoardEntries,
  clearGuildStarboard,
} from '../src/db/starboard.js';

const G = '900000000000000020';
const B1 = 'b1';
const B2 = 'b2';
const M1 = '700000000000000101';
const M2 = '700000000000000102';

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

test('starboard_posts: upsert + get round-trips, scoped by (guild, board, source)', async () => {
  await clearGuildStarboard(G);
  assert.equal(await getStarboardEntry(G, B1, M1), null);

  await upsertStarboardEntry({ guildId: G, boardId: B1, sourceMsgId: M1, sourceChanId: 'c1', starCount: 3 });
  const row = await getStarboardEntry(G, B1, M1);
  assert.equal(row.source_chan_id, 'c1');
  assert.equal(row.star_count, 3);
  assert.equal(row.post_msg_id, null);
  assert.equal(row.posted_at, null);

  assert.equal(await getStarboardEntry(G, B2, M1), null); // different board, no entry
});

test('setStarboardPost/setStarboardCount update fields in place without touching the rest', async () => {
  await clearGuildStarboard(G);
  await upsertStarboardEntry({ guildId: G, boardId: B1, sourceMsgId: M1, sourceChanId: 'c1', starCount: 1 });

  await setStarboardPost(G, B1, M1, 'post-1', 12345);
  let row = await getStarboardEntry(G, B1, M1);
  assert.equal(row.post_msg_id, 'post-1');
  assert.equal(Number(row.posted_at), 12345);

  // setStarboardCount is what production code calls to bump the count on an
  // already-posted entry — it must not touch post_msg_id/posted_at.
  await setStarboardCount(G, B1, M1, 9);
  row = await getStarboardEntry(G, B1, M1);
  assert.equal(row.star_count, 9);
  assert.equal(row.post_msg_id, 'post-1');
  assert.equal(Number(row.posted_at), 12345);

  assert.deepEqual(await getStarboardEntryByPost('post-1'), row);
});

test('deleteStarboardEntry, deleteBoardEntries, clearGuildStarboard scope correctly', async () => {
  await clearGuildStarboard(G);
  await upsertStarboardEntry({ guildId: G, boardId: B1, sourceMsgId: M1, sourceChanId: 'c1', starCount: 1 });
  await upsertStarboardEntry({ guildId: G, boardId: B1, sourceMsgId: M2, sourceChanId: 'c1', starCount: 1 });
  await upsertStarboardEntry({ guildId: G, boardId: B2, sourceMsgId: M1, sourceChanId: 'c1', starCount: 1 });

  await deleteStarboardEntry(G, B1, M1);
  assert.equal(await getStarboardEntry(G, B1, M1), null);
  assert.ok(await getStarboardEntry(G, B1, M2));

  await deleteBoardEntries(G, B1);
  assert.equal(await getStarboardEntry(G, B1, M2), null);
  assert.ok(await getStarboardEntry(G, B2, M1)); // other board untouched

  await clearGuildStarboard(G);
  assert.equal(await getStarboardEntry(G, B2, M1), null);
});
