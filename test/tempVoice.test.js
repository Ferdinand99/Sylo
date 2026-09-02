import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseTempVoiceConfig,
  renderName,
  buildOverwrites,
  syncedOverwrites,
} from '../src/modules/tempVoice.js';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
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
  assert.equal(c.hubs[0].nameTemplate, "#{index} - {username}'s Channel"); // blank -> default
  assert.equal(c.hubs[0].userLimit, 99); // clamped
  assert.equal(c.hubs[0].roleMode, 'allow');
  assert.equal(c.hubs[0].keepAliveMinutes, 0);
  assert.equal(c.hubs[0].ownerPerms.manageChannels, true);
});

test('normaliseTempVoiceConfig: caps at 25 hubs', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ hubChannelId: String(1e17 + i) }));
  assert.equal(normaliseTempVoiceConfig({ hubs: many }).hubs.length, 25);
});

test('renderName: substitutes {index}/{username} (and legacy {user}/{count}), trims to 100', () => {
  const member = { displayName: 'Ferd', user: { username: 'ferd99' } };
  assert.equal(renderName("{user}'s room", { member, index: 3 }), "Ferd's room");
  assert.equal(renderName('{username} #{index}', { member, index: 3 }), 'ferd99 #3');
  assert.equal(renderName('#{count} - {username}', { member, index: 5 }), '#5 - ferd99');
  assert.equal(renderName('{username}', { member: null, index: 1 }), 'player');
  assert.ok(renderName('x'.repeat(200), { member, index: 1 }).length === 100);
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

// --- overwrites: no "server muted" in your own temp channel -----------------

const GUILD = { id: '999999999999999999', members: { me: { id: 'bot' } } };
const hub = (over = {}) =>
  normaliseTempVoiceConfig({ hubs: [{ hubChannelId: '111111111111111111', ...over }] }).hubs[0];
const forId = (rows, id) => rows.find((r) => r.id === id);

test('buildOverwrites: voice channel always lets @everyone Speak/Stream', () => {
  const rows = buildOverwrites(GUILD, hub(), 'owner-id');
  const everyone = forId(rows, GUILD.id);
  assert.ok(everyone, '@everyone entry present');
  assert.deepEqual(everyone.allow, [P.Speak, P.Stream]);
  assert.deepEqual(everyone.deny, []);
  assert.ok(forId(rows, 'owner-id').allow.includes(P.Speak), 'owner can speak');
  assert.ok(forId(rows, 'bot'), 'bot keeps control');
});

test('buildOverwrites: role deny-mode still gates Connect on @everyone', () => {
  const rows = buildOverwrites(GUILD, hub({ roleMode: 'deny', roleList: ['222222222222222222'] }), 'o');
  const everyone = forId(rows, GUILD.id);
  assert.deepEqual(everyone.allow, [P.Speak, P.Stream]);
  assert.deepEqual(everyone.deny, [P.Connect]);
  assert.deepEqual(forId(rows, '222222222222222222').allow, [P.Connect]);
});

test('buildOverwrites: text channel gets no Speak allow', () => {
  const rows = buildOverwrites(GUILD, hub(), 'o', { forText: true });
  assert.equal(forId(rows, GUILD.id), undefined); // nothing to say for @everyone
});

test('syncedOverwrites: drops the parent @everyone entry, keeps the rest', () => {
  const parent = [
    { id: GUILD.id, deny: new PermissionsBitField(P.Speak), allow: new PermissionsBitField(0n) },
    { id: 'role-x', deny: new PermissionsBitField(0n), allow: new PermissionsBitField(P.Connect) },
  ];
  const kept = syncedOverwrites(parent, GUILD);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, 'role-x');
});
