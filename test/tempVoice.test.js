import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseTempVoiceConfig, renderName } from '../src/modules/tempVoice.js';
import {
  addTempChannel,
  removeTempChannel,
  isTempChannel,
  findUserHubChannel,
  countHubChannels,
  listAllTempChannels,
  clearGuildTempVoice,
} from '../src/db/tempVoice.js';

const G = '111111111111111111';
const HUB = '222222222222222222';
const U = '333333333333333333';

test('normaliseTempVoiceConfig: validates ids, clamps limit, defaults name, drops hub-less rows', () => {
  const c = normaliseTempVoiceConfig({
    hubs: [
      { hubChannelId: HUB, categoryId: 'nope', nameTemplate: '  ', userLimit: 999 },
      { hubChannelId: 'bad', nameTemplate: 'x' }, // dropped: no valid hub id
      { categoryId: G }, // dropped: no hub
    ],
  });
  assert.equal(c.hubs.length, 1);
  assert.equal(c.hubs[0].hubChannelId, HUB);
  assert.equal(c.hubs[0].categoryId, ''); // invalid id cleared
  assert.equal(c.hubs[0].nameTemplate, "{user}'s channel"); // blank -> default
  assert.equal(c.hubs[0].userLimit, 99); // clamped
});

test('normaliseTempVoiceConfig: caps at 10 hubs', () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ hubChannelId: String(1e17 + i) }));
  assert.equal(normaliseTempVoiceConfig({ hubs: many }).hubs.length, 10);
});

test('renderName: substitutes tokens and trims to 100 chars', () => {
  const member = { displayName: 'Ferd', user: { username: 'ferd99' } };
  assert.equal(renderName('{user}’s room', { member, count: 3 }), 'Ferd’s room');
  assert.equal(renderName('{username} #{count}', { member, count: 3 }), 'ferd99 #3');
  assert.equal(renderName('{user}', { member: null, count: 1 }), 'Player');
  assert.ok(renderName('x'.repeat(200), { member, count: 1 }).length === 100);
});

test('db: track a temp channel, find it by owner+hub, count, and remove', () => {
  clearGuildTempVoice(G);
  assert.equal(isTempChannel('900000000000000001'), false);

  addTempChannel({ channelId: '900000000000000001', guildId: G, hubId: HUB, ownerId: U });
  addTempChannel({ channelId: '900000000000000002', guildId: G, hubId: HUB, ownerId: '444444444444444444' });

  assert.equal(isTempChannel('900000000000000001'), true);
  assert.equal(countHubChannels(HUB), 2);
  assert.equal(findUserHubChannel(G, HUB, U).channel_id, '900000000000000001');
  assert.equal(listAllTempChannels().filter((r) => r.guild_id === G).length, 2);

  removeTempChannel('900000000000000001');
  assert.equal(isTempChannel('900000000000000001'), false);
  assert.equal(findUserHubChannel(G, HUB, U), null);
  assert.equal(countHubChannels(HUB), 1);

  clearGuildTempVoice(G);
  assert.equal(countHubChannels(HUB), 0);
});
