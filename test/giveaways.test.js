import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickWinners, normaliseGiveawaysConfig } from '../src/modules/giveaways.js';
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

test('giveaway lifecycle: create, enter, count, end', () => {
  const { id } = createGiveaway({
    guildId: G,
    channelId: '111',
    prize: 'Nitro',
    winners: 2,
    hostId: '222',
    endsAt: Date.now() + 60_000,
  });
  assert.ok(id > 0);
  setGiveawayMessage(id, '333');
  assert.equal(getGiveaway(id).message_id, '333');
  assert.equal(getGiveaway(id).ended, false);

  addGiveawayEntry(id, 'u1');
  addGiveawayEntry(id, 'u2');
  addGiveawayEntry(id, 'u2'); // dupe — ignored
  assert.equal(giveawayEntryCount(id), 2);
  assert.ok(hasGiveawayEntry(id, 'u1'));
  removeGiveawayEntry(id, 'u1');
  assert.equal(hasGiveawayEntry(id, 'u1'), false);
  assert.deepEqual(giveawayEntrantIds(id).sort(), ['u2']);

  assert.equal(activeGiveaways(G).length, 1);
  markGiveawayEnded(id, ['u2']);
  const g = getGiveaway(id);
  assert.equal(g.ended, true);
  assert.deepEqual(g.wonIds, ['u2']);
  assert.equal(activeGiveaways(G).length, 0);
  assert.equal(endedGiveaways(G).length, 1);
});

test('dueGiveaways returns only past, un-ended rows; clearGuild wipes everything', () => {
  clearGuildGiveaways(G);
  const past = createGiveaway({
    guildId: G,
    channelId: '1',
    prize: 'p',
    winners: 1,
    hostId: 'h',
    endsAt: Date.now() - 1000,
  });
  const future = createGiveaway({
    guildId: G,
    channelId: '1',
    prize: 'f',
    winners: 1,
    hostId: 'h',
    endsAt: Date.now() + 60_000,
  });
  const due = dueGiveaways(Date.now());
  assert.ok(due.some((g) => g.id === past.id));
  assert.ok(!due.some((g) => g.id === future.id));

  clearGuildGiveaways(G);
  assert.equal(activeGiveaways(G).length, 0);
  assert.equal(getGiveaway(past.id), null);
});
