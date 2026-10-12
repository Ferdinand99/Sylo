import test from 'node:test';
import assert from 'node:assert/strict';
import { setClientFor } from '../src/runtime.js';
import {
  postToChannel,
  sendToChannel,
  deleteChannelMessage,
  editChannelMessage,
} from '../src/modules/lib/send.js';

const CHANNEL_ID = '200000000000000001';
const DISCORD_GUILD = '900000000000000050';
const FLUXER_GUILD = '900000000000000060';

function mockGuild() {
  const channel = {
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => ({ id: 'msg1' }),
    messages: { delete: async () => {}, edit: async () => {} },
  };
  return {
    channels: { cache: new Map([[CHANNEL_ID, channel]]), fetch: async () => channel },
    members: { me: {} },
  };
}

test.afterEach(() => {
  setClientFor('discord', null);
  setClientFor('fluxer', null);
});

test('a bare (Discord) guildId resolves against the Discord client, exactly as before', async () => {
  setClientFor('discord', { guilds: { cache: new Map([[DISCORD_GUILD, mockGuild()]]) } });
  assert.equal(await sendToChannel(DISCORD_GUILD, CHANNEL_ID, { content: 'hi' }), true);
});

test('a "fluxer:" guildId resolves against the Fluxer client', async () => {
  setClientFor('fluxer', { guilds: { cache: new Map([[FLUXER_GUILD, mockGuild()]]) } });
  const result = await postToChannel(`fluxer:${FLUXER_GUILD}`, CHANNEL_ID, { content: 'hi' });
  assert.deepEqual(result, { channelId: CHANNEL_ID, messageId: 'msg1' });
});

test('each platform resolves independently of the other', async () => {
  setClientFor('discord', { guilds: { cache: new Map([[DISCORD_GUILD, mockGuild()]]) } });
  setClientFor('fluxer', { guilds: { cache: new Map([[FLUXER_GUILD, mockGuild()]]) } });
  assert.notEqual(await postToChannel(DISCORD_GUILD, CHANNEL_ID, { content: 'a' }), null);
  assert.notEqual(await postToChannel(`fluxer:${FLUXER_GUILD}`, CHANNEL_ID, { content: 'b' }), null);
  // A Fluxer guild id must not be found through the Discord client, or vice versa.
  assert.equal(await postToChannel(FLUXER_GUILD, CHANNEL_ID, { content: 'c' }), null);
  assert.equal(await postToChannel(`fluxer:${DISCORD_GUILD}`, CHANNEL_ID, { content: 'd' }), null);
});

test('a malformed guildId fails closed instead of throwing', async () => {
  setClientFor('discord', { guilds: { cache: new Map([[DISCORD_GUILD, mockGuild()]]) } });
  assert.equal(await postToChannel('discord:' + DISCORD_GUILD, CHANNEL_ID, { content: 'x' }), null);
  assert.equal(await postToChannel('garbage', CHANNEL_ID, { content: 'x' }), null);
  assert.equal(await postToChannel(undefined, CHANNEL_ID, { content: 'x' }), null);
});

test('a platform with no connected client returns null', async () => {
  assert.equal(await postToChannel(`fluxer:${FLUXER_GUILD}`, CHANNEL_ID, { content: 'x' }), null);
});

test('deleteChannelMessage and editChannelMessage route the same way', async () => {
  setClientFor('fluxer', { guilds: { cache: new Map([[FLUXER_GUILD, mockGuild()]]) } });
  assert.equal(await deleteChannelMessage(`fluxer:${FLUXER_GUILD}`, CHANNEL_ID, 'msg1'), true);
  assert.equal(
    await editChannelMessage(`fluxer:${FLUXER_GUILD}`, CHANNEL_ID, 'msg1', { content: 'x' }),
    true
  );
});
