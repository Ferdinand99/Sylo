import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWinners, normaliseGiveawaysConfig, endGiveaway } from '../src/modules/giveaways.js';
import {
  createGiveaway,
  getGiveaway,
  setGiveawayMessage,
  addGiveawayEntry,
  removeGiveawayEntry,
  hasGiveawayEntry,
  giveawayEntryCount,
  giveawayEntrantIds,
  markGiveawayEnded,
  claimGiveawayEnd,
  activeGiveaways,
  endedGiveaways,
  dueGiveaways,
  clearGuildGiveaways,
} from '../src/db/giveaways.js';

const G = '900000000000000123';

test('pickWinners: distinct, capped, order-independent', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  const w = pickWinners(pool, 3);
  assert.equal(w.length, 3);
  assert.equal(new Set(w).size, 3);
  w.forEach((x) => assert.ok(pool.includes(x)));

  assert.deepEqual(pickWinners(['x', 'x', 'y'], 5).sort(), ['x', 'y']); // dedupes input
  assert.deepEqual(pickWinners([], 2), []);
  assert.equal(pickWinners(pool, 99).length, 5); // capped at pool size
});

test('normaliseGiveawaysConfig: defaults and validation', () => {
  assert.deepEqual(normaliseGiveawaysConfig(), { ping: 'none', dmWinners: false });
  assert.deepEqual(normaliseGiveawaysConfig({ ping: 'everyone', dmWinners: 1 }), {
    ping: 'everyone',
    dmWinners: true,
  });
  assert.equal(normaliseGiveawaysConfig({ ping: 'nonsense' }).ping, 'none');
});

test('giveaway lifecycle: create, enter, count, end', async () => {
  const { id } = await createGiveaway({
    guildId: G,
    channelId: '111',
    prize: 'Nitro',
    winners: 2,
    hostId: '222',
    endsAt: Date.now() + 60_000,
  });
  assert.ok(id > 0);
  await setGiveawayMessage(id, '333');
  assert.equal((await getGiveaway(id)).message_id, '333');
  assert.equal((await getGiveaway(id)).ended, false);

  await addGiveawayEntry(id, 'u1');
  await addGiveawayEntry(id, 'u2');
  await addGiveawayEntry(id, 'u2'); // dupe — ignored
  assert.equal(await giveawayEntryCount(id), 2);
  assert.ok(await hasGiveawayEntry(id, 'u1'));
  await removeGiveawayEntry(id, 'u1');
  assert.equal(await hasGiveawayEntry(id, 'u1'), false);
  assert.deepEqual((await giveawayEntrantIds(id)).sort(), ['u2']);

  assert.equal((await activeGiveaways(G)).length, 1);
  await markGiveawayEnded(id, ['u2']);
  const g = await getGiveaway(id);
  assert.equal(g.ended, true);
  assert.deepEqual(g.wonIds, ['u2']);
  assert.equal((await activeGiveaways(G)).length, 0);
  assert.equal((await endedGiveaways(G)).length, 1);
});

test('dueGiveaways returns only past, un-ended rows; clearGuild wipes everything', async () => {
  await clearGuildGiveaways(G);
  const past = await createGiveaway({
    guildId: G,
    channelId: '1',
    prize: 'p',
    winners: 1,
    hostId: 'h',
    endsAt: Date.now() - 1000,
  });
  const future = await createGiveaway({
    guildId: G,
    channelId: '1',
    prize: 'f',
    winners: 1,
    hostId: 'h',
    endsAt: Date.now() + 60_000,
  });
  const due = await dueGiveaways(Date.now());
  assert.ok(due.some((g) => g.id === past.id));
  assert.ok(!due.some((g) => g.id === future.id));

  await clearGuildGiveaways(G);
  assert.equal((await activeGiveaways(G)).length, 0);
  assert.equal(await getGiveaway(past.id), null);
});

test('buildGiveawayPayload copes with timestamps that arrive as strings (Postgres returns BIGINT as text)', async () => {
  const { buildGiveawayPayload } = await import('../src/modules/giveaways.js');
  const row = {
    id: 5,
    prize: 'Test',
    winners: 1,
    host_id: '111111111111111111',
    required_role_id: null,
    ends_at: String(Date.now() + 60_000),
    created_at: String(Date.now()),
    ended: false,
    wonIds: [],
  };
  const open = buildGiveawayPayload(row, { entryCount: 1 });
  assert.equal(open.embeds[0].toJSON().title, '🎉 Test');
  const ended = buildGiveawayPayload(
    { ...row, ended: true, wonIds: ['222222222222222222'] },
    { entryCount: 1 }
  );
  assert.match(ended.embeds[0].toJSON().description, /Winner: <@222222222222222222>/);
});

// The expiry tick does not wait for a draw, and the dashboard or /giveaway end can run at the
// same moment: only the first caller may draw, or there are two winner announcements.
test('claimGiveawayEnd: only the first claim wins', async () => {
  const { id } = await createGiveaway({
    guildId: G,
    channelId: '100000000000000001',
    hostId: '1',
    prize: 'p',
    winners: 1,
    endsAt: Date.now() - 1,
  });
  assert.equal(await claimGiveawayEnd(id), true);
  assert.equal(await claimGiveawayEnd(id), false);
  assert.equal((await getGiveaway(id)).ended, true);
});

test('endGiveaway: a second end of the same giveaway does not draw again', async () => {
  const { id } = await createGiveaway({
    guildId: G,
    channelId: '100000000000000001',
    hostId: '1',
    prize: 'p',
    winners: 1,
    endsAt: Date.now() - 1,
  });
  await claimGiveawayEnd(id);
  assert.deepEqual(await endGiveaway(id), { ok: false, reason: 'already-ended' });
});
