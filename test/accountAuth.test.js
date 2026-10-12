process.env.OWNER_IDS = '151630595649175552';
process.env.FLUXER_OWNER_IDS = '1554947505563631616';

import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const { primaryUserId, identityFor, isOperator, adminKeysOf, staleIdentities, sessionUserLabel } =
  await import('../src/web/lib/accountAuth.js');

const discord = (over = {}) => ({
  platform: 'discord',
  platformUserId: '151630595649175552',
  username: 'ferdi',
  avatar: 'https://cdn.example/a.png',
  guildIds: ['100000000000000001', '100000000000000002'],
  guildsFetchedAt: 1000,
  ...over,
});
const fluxer = (over = {}) => ({
  platform: 'fluxer',
  platformUserId: '1554947505563631616',
  username: 'Ferdinand99',
  avatar: null,
  guildIds: ['fluxer:900000000000000001'],
  guildsFetchedAt: 1000,
  ...over,
});
const account = (...identities) => ({ id: 'acc-1', identities });

test('primaryUserId: the Discord id when the account has one (existing data keeps its key), else fluxer:<id>', () => {
  assert.equal(primaryUserId(account(discord())), '151630595649175552');
  assert.equal(primaryUserId(account(fluxer(), discord())), '151630595649175552');
  assert.equal(primaryUserId(account(fluxer())), 'fluxer:1554947505563631616');
  assert.equal(primaryUserId(null), null);
  assert.equal(primaryUserId(account()), null);
});

test('identityFor finds the identity on a platform', () => {
  const acc = account(discord(), fluxer());
  assert.equal(identityFor(acc, 'fluxer').username, 'Ferdinand99');
  assert.equal(identityFor(acc, 'discord').username, 'ferdi');
  assert.equal(identityFor(account(discord()), 'fluxer'), null);
  assert.equal(identityFor(null, 'discord'), null);
});

test('isOperator: any identity on its own platform owner list makes the account an operator', () => {
  assert.equal(isOperator(account(discord())), true);
  assert.equal(isOperator(account(fluxer())), true);
  assert.equal(isOperator(account(discord({ platformUserId: '222222222222222222' }))), false);
  assert.equal(isOperator(account(fluxer({ platformUserId: '151630595649175552' }))), false); // a Discord id on the Fluxer side is not an owner
  assert.equal(isOperator(null), false);
});

test('adminKeysOf: the guilds of every identity, limited to the guilds the bot is in', () => {
  const acc = account(discord(), fluxer());
  const bot = ['100000000000000001', 'fluxer:900000000000000001', '100000000000000099'];
  assert.deepEqual([...adminKeysOf(acc, bot)].sort(), ['100000000000000001', 'fluxer:900000000000000001']);
  assert.deepEqual([...adminKeysOf(acc, [])], []);
  assert.deepEqual([...adminKeysOf(null, bot)], []);
});

test('staleIdentities: those whose guild list is older than the TTL', () => {
  const acc = account(discord({ guildsFetchedAt: 1000 }), fluxer({ guildsFetchedAt: 9000 }));
  assert.deepEqual(
    staleIdentities(acc, 5000, 10_000).map((i) => i.platform),
    ['discord']
  );
  assert.deepEqual(staleIdentities(acc, 5000, 5500), []);
  assert.deepEqual(staleIdentities(null, 5000, 10_000), []);
});

test('sessionUserLabel: the name shown in the UI comes from the primary identity', () => {
  assert.equal(sessionUserLabel(account(fluxer(), discord())), 'ferdi');
  assert.equal(sessionUserLabel(account(fluxer())), 'Ferdinand99');
  assert.equal(sessionUserLabel(null), null);
});
