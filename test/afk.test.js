import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAfk, setAfk, clearAfk, clearGuildAfk } from '../src/db/afk.js';
import { normaliseServerStats } from '../src/modules/serverStats.js';

const G = '111111111111111111';
const U = '222222222222222222';

test('afk: set / get / clear round-trip', () => {
  assert.equal(getAfk(G, U), null);
  setAfk(G, U, { reason: 'lunch', oldNick: 'Bob' });
  const row = getAfk(G, U);
  assert.equal(row.reason, 'lunch');
  assert.equal(row.old_nick, 'Bob');
  assert.ok(row.since > 0);
  clearAfk(G, U);
  assert.equal(getAfk(G, U), null);
});

test('afk: oldNick null is stored as null (nickname untouched)', () => {
  setAfk(G, U, { reason: 'x', oldNick: null });
  assert.equal(getAfk(G, U).old_nick, null);
  clearGuildAfk(G);
  assert.equal(getAfk(G, U), null);
});

test('normaliseServerStats: drops rows without {count} or a channel, clamps to 10, defaults type', () => {
  const c = normaliseServerStats({
    channels: [
      { channelId: '123456789012345678', type: 'humans', template: 'Humans: {count}' },
      { channelId: '123456789012345678', type: 'bogus', template: 'no placeholder' }, // dropped
      { channelId: 'nope', type: 'members', template: '{count}' }, // dropped (bad id)
      { channelId: '223456789012345678', template: 'Roles {count}' }, // type defaults
    ],
  });
  assert.equal(c.channels.length, 2);
  assert.equal(c.channels[0].type, 'humans');
  assert.equal(c.channels[1].type, 'members');
});
