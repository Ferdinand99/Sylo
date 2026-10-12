import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import { db } from '../src/db/index.js';
import { getTempChannel, addTempChannel } from '../src/db/tempVoice.js';
import { sweepTempChannels } from '../src/modules/tempVoice.js';

// A Fluxer guild cannot move a member into a new channel (a bot move leaves them
// connected but invisible — see platform/capabilities.js), so temp voice creates the
// channel, DMs the member a link, and lets the channel expire if nobody joins.

const RAW = '900000000000000080';
const KEY = `fluxer:${RAW}`;
const HUB = '700000000000000080';
let seq = 0; // every test gets its own member and channel: the join debounce is per member
let NEW_CHANNEL = '700000000000000081';

function world({ moveRights = false } = {}) {
  seq += 1;
  NEW_CHANNEL = `70000000000000009${seq}`;
  const client = {};
  runtime.clients.fluxer = client;
  const log = { created: [], dms: [], moves: [], deleted: [] };
  const channelObjects = new Map([[HUB, { id: HUB, parentId: null }]]);
  const guild = {
    id: RAW,
    name: 'Test',
    client,
    roles: new Map(),
    members: {
      me: { permissions: { has: (p) => p === P.ManageChannels || (moveRights && p === P.MoveMembers) } },
    },
    channels: { cache: channelObjects },
    createChannelCompat: async (o) => {
      log.created.push(o);
      const ch = {
        id: NEW_CHANNEL,
        members: new Map(),
        delete: async (reason) => log.deleted.push(reason),
      };
      channelObjects.set(NEW_CHANNEL, ch);
      return ch;
    },
    maximumBitrate: 384_000,
  };
  client.guilds = { cache: new Map([[RAW, guild]]) };
  client.isReady = () => true;
  const member = {
    id: `u${seq}`,
    guild,
    user: { tag: 'ferdi#1', send: async (o) => log.dms.push(o) },
    voice: {
      channelId: HUB,
      setChannel: async (c) => {
        log.moves.push(c.id);
      },
    },
  };
  return { guild, member, log };
}

const joinHub = (guild, member) =>
  dispatch('voiceStateUpdate', KEY, {
    old: { channelId: null, guild },
    new: { channelId: HUB, guild, member },
  });

test.beforeEach(async () => {
  await setGuildModule(KEY, 'temp-voice', { enabled: true, config: { hubs: [{ hubChannelId: HUB }] } });
});
test.afterEach(() => {
  runtime.clients.fluxer = null;
});

test('joining a hub creates the channel, DMs a join link, and does not try to move the member', async () => {
  const { guild, member, log } = world({ moveRights: true });
  await joinHub(guild, member);
  assert.equal(log.created.length, 1, 'a channel was created');
  assert.deepEqual(log.moves, []);
  assert.equal(log.dms.length, 1);
  const dm = typeof log.dms[0] === 'string' ? log.dms[0] : log.dms[0].content;
  assert.ok(dm.includes(`<#${NEW_CHANNEL}>`), `the DM links the channel: ${dm}`);
  const row = await getTempChannel(NEW_CHANNEL);
  assert.equal(row.owner_id, member.id);
  assert.equal(row.guild_id, KEY);
});

test('it works without Move Members, which a Fluxer bot never needs', async () => {
  const { guild, member, log } = world({ moveRights: false });
  await joinHub(guild, member);
  assert.equal(log.created.length, 1);
});

test('a member who already has a channel is sent a link to it instead of being moved', async () => {
  const { guild, member, log } = world();
  await joinHub(guild, member);
  log.created.length = 0;
  log.dms.length = 0;
  await new Promise((r) => setTimeout(r, 3100)); // the join debounce is 3s
  await joinHub(guild, member);
  assert.equal(log.created.length, 0, 'no second channel');
  assert.deepEqual(log.moves, []);
  assert.equal(log.dms.length, 1);
});

test('a channel nobody joined survives the grace period and is then removed', async () => {
  db.prepare('DELETE FROM temp_voice_channels').run(); // rows left by the other tests belong to other fake guilds
  const { guild, log } = world();
  const channel = { id: NEW_CHANNEL, members: new Map(), delete: async (r) => log.deleted.push(r) };
  guild.channels.cache.set(NEW_CHANNEL, channel);
  await addTempChannel({
    channelId: NEW_CHANNEL,
    guildId: KEY,
    hubId: HUB,
    ownerId: 'u1',
    name: 'room',
    textChannelId: null,
  });

  await sweepTempChannels();
  assert.deepEqual(log.deleted, [], 'just created: the member is still on the way');
  assert.ok(await getTempChannel(NEW_CHANNEL));

  db.prepare('UPDATE temp_voice_channels SET created_at = ? WHERE channel_id = ?').run(
    Date.now() - 5 * 60_000,
    NEW_CHANNEL
  );
  await sweepTempChannels();
  assert.equal(log.deleted.length, 1);
  assert.equal(await getTempChannel(NEW_CHANNEL), null);
});
