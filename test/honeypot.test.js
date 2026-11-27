// Covers the exact bug report from issue #211's feedback: "the Kicks counter
// on the trap message doesn't tick up upon trigger" — a reaction-honeypot
// (kind: 'messages') punishment should both persist the bumped triggerCount
// AND re-render the live bait message's embed with the new count. Minimal,
// self-built fakes (not test/helpers/fakeGuild.js — that helper's
// channel.messages.fetch always resolves null and its send()-returned
// message's edit() is a no-op, neither of which is enough to assert on here,
// and this module doesn't need the rest of that helper's surface).
import './helpers/tmpDb.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule, getGuildModule } from '../src/db/modules.js';
import { ensureHoneypotMessages, resetBaitPermWarnings } from '../src/modules/honeypot.js'; // also registers the messageCreate/reactionAdd handlers

const G = '900000000000000777';
const CHANNEL_ID = '100000000000000111';
const MESSAGE_ID = '200000000000000222';
const RAIDER_ID = '300000000000000333';

function fakeEnv() {
  const editCalls = [];
  const message = {
    id: MESSAGE_ID,
    guild: null, // set below, after guild exists
    edit: async (payload) => {
      editCalls.push(payload);
    },
  };
  const channel = {
    id: CHANNEL_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async (id) => (id === MESSAGE_ID ? message : null) },
  };
  const member = {
    id: RAIDER_ID,
    user: { id: RAIDER_ID, tag: 'raider#0001', displayAvatarURL: () => null, send: async () => {} },
    permissions: { has: () => false },
    roles: { cache: new Map() },
    moderatable: true,
    kickable: true,
    bannable: true,
    timeout: async () => {},
    kick: async () => {},
  };
  const guild = {
    id: G,
    name: 'Test Guild',
    channels: {
      cache: new Map([[CHANNEL_ID, channel]]),
      fetch: async (id) => (id === CHANNEL_ID ? channel : null),
    },
    members: {
      me: { permissions: { has: () => true } },
      fetch: async (id) => (id === RAIDER_ID ? member : null),
    },
    bans: { create: async () => {} },
  };
  message.guild = guild;
  channel.guild = guild;
  return { guild, channel, message, editCalls };
}

test('reactionAdd on a message honeypot bumps triggerCount AND re-renders the live embed', async () => {
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: {
      exemptRoles: [],
      channels: [],
      messages: [
        {
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          bait: 'do not react',
          action: 'kick',
          timeoutMinutes: 10,
          triggerCount: 0,
        },
      ],
    },
  });

  const { guild, message, editCalls } = fakeEnv();
  await dispatch('reactionAdd', G, { reaction: { message }, user: { id: RAIDER_ID, bot: false } });

  // The persisted config's triggerCount must be bumped...
  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(saved.messages[0].triggerCount, 1);

  // ...and the live message must have been re-edited to show it.
  assert.equal(editCalls.length, 1, 'the bait message should have been re-edited exactly once');
  const embed = editCalls[0].embeds[0];
  const catchesField = embed.data.fields.find((f) => f.name === 'Catches');
  assert.equal(catchesField.value, 'Kicks: 1');
  void guild;
});

test('reactionAdd: a second trigger reads the fresh count, not the stale dispatch-time copy', async () => {
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: {
      exemptRoles: [],
      channels: [],
      messages: [
        {
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          bait: 'do not react',
          action: 'kick',
          timeoutMinutes: 10,
          triggerCount: 0,
        },
      ],
    },
  });

  const { message, editCalls } = fakeEnv();
  await dispatch('reactionAdd', G, { reaction: { message }, user: { id: RAIDER_ID, bot: false } });
  await dispatch('reactionAdd', G, { reaction: { message }, user: { id: RAIDER_ID, bot: false } });

  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(saved.messages[0].triggerCount, 2);
  assert.equal(editCalls.length, 2);
  assert.equal(editCalls[1].embeds[0].data.fields[0].value, 'Kicks: 2');
});

test('reactionAdd: a bot reacting is ignored entirely (no punish, no bump)', async () => {
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: {
      exemptRoles: [],
      channels: [],
      messages: [
        {
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          bait: 'do not react',
          action: 'kick',
          timeoutMinutes: 10,
          triggerCount: 0,
        },
      ],
    },
  });

  const { message, editCalls } = fakeEnv();
  await dispatch('reactionAdd', G, { reaction: { message }, user: { id: RAIDER_ID, bot: true } });

  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(saved.messages[0].triggerCount, 0);
  assert.equal(editCalls.length, 0);
});

test('reactionAdd: missing Read Message History still bumps the count but skips the message edit without throwing', async () => {
  await setGuildModule(G, 'honeypot', {
    enabled: true,
    config: {
      exemptRoles: [],
      channels: [],
      messages: [
        {
          channelId: CHANNEL_ID,
          messageId: MESSAGE_ID,
          bait: 'do not react',
          action: 'kick',
          timeoutMinutes: 10,
          triggerCount: 0,
        },
      ],
    },
  });

  const { channel, message, editCalls } = fakeEnv();
  channel.permissionsFor = () => ({ has: () => false }); // ReadMessageHistory missing
  await dispatch('reactionAdd', G, { reaction: { message }, user: { id: RAIDER_ID, bot: false } });

  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(
    saved.messages[0].triggerCount,
    1,
    'the DB count is still real even if the live message could not be updated'
  );
  assert.equal(editCalls.length, 0, 'no edit attempted without Read Message History');
});

// --- issue #369: the bait embed counts every catch in its channel -------------------------------------

const row = (over) => ({
  channelId: CHANNEL_ID,
  action: 'kick',
  timeoutMinutes: 10,
  triggerCount: 0,
  ...over,
});
const bait = (over) => row({ messageId: MESSAGE_ID, bait: 'do not react', ...over });
const saveConfig = (config) =>
  setGuildModule(G, 'honeypot', {
    enabled: true,
    config: { exemptRoles: [], channels: [], messages: [], ...config },
  });
const trapMessage = (guild) => ({
  partial: false,
  guild,
  channelId: CHANNEL_ID,
  author: { id: RAIDER_ID },
  member: guild.members.fetch(RAIDER_ID),
  deletable: false,
});
const postTrapMessage = async (guild) => {
  const msg = trapMessage(guild);
  msg.member = await msg.member;
  await dispatch('messageCreate', G, msg);
};
const react = (message) =>
  dispatch('reactionAdd', G, { reaction: { message }, user: { id: RAIDER_ID, bot: false } });
const catches = (call) => call.embeds[0].data.fields.find((f) => f.name === 'Catches').value;

test('a catch in the trap channel updates the bait embed in the same channel', async () => {
  await saveConfig({ channels: [row({ triggerCount: 2 })], messages: [bait({ triggerCount: 1 })] });
  const { guild, editCalls } = fakeEnv();

  await postTrapMessage(guild);

  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(saved.channels[0].triggerCount, 3, 'the channel row keeps its own count');
  assert.equal(saved.messages[0].triggerCount, 1, 'the bait row count is not touched');
  assert.equal(editCalls.length, 1);
  assert.equal(catches(editCalls[0]), 'Kicks: 4');
});

test('a reaction catch still updates the bait embed, and adds the channel row count', async () => {
  await saveConfig({ channels: [row({ triggerCount: 2 })], messages: [bait({ triggerCount: 0 })] });
  const { message, editCalls } = fakeEnv();

  await react(message);

  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(saved.messages[0].triggerCount, 1);
  assert.equal(saved.channels[0].triggerCount, 2);
  assert.equal(catches(editCalls[0]), 'Kicks: 3');
});

test('different actions render one line per action', async () => {
  await saveConfig({
    channels: [row({ action: 'ban', triggerCount: 0 })],
    messages: [bait({ action: 'kick', triggerCount: 3 })],
  });
  const { guild, editCalls } = fakeEnv();

  await postTrapMessage(guild);

  assert.equal(catches(editCalls[0]), 'Kicks: 3\nBans: 1');
});

test('a trap channel without a bait message: the catch counts and nothing is edited or thrown', async () => {
  await saveConfig({ channels: [row()], messages: [] });
  const { guild, channel, editCalls } = fakeEnv();
  let fetches = 0;
  channel.messages.fetch = async () => {
    fetches++;
    return null;
  };

  await postTrapMessage(guild);

  assert.equal((await getGuildModule(G, 'honeypot')).config.channels[0].triggerCount, 1);
  assert.equal(editCalls.length, 0);
  assert.equal(fetches, 0);
});

test('a bait message in another channel is left alone by a channel-trap catch', async () => {
  await saveConfig({
    channels: [row()],
    messages: [bait({ channelId: '100000000000000999', triggerCount: 5 })],
  });
  const { guild, editCalls } = fakeEnv();

  await postTrapMessage(guild);

  assert.equal(editCalls.length, 0);
});

test('a channel-trap catch without Read Message History keeps the count and logs the existing warning', async () => {
  resetBaitPermWarnings();
  await saveConfig({ channels: [row()], messages: [bait()] });
  const { guild, channel, editCalls } = fakeEnv();
  channel.permissionsFor = () => ({ has: () => false });
  // Text logging writes through console.error, JSON logging through process.stderr.
  const lines = [];
  const textLog = mock.method(console, 'error', (line) => lines.push(String(line)));
  const jsonLog = mock.method(process.stderr, 'write', (chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await postTrapMessage(guild);
  } finally {
    textLog.mock.restore();
    jsonLog.mock.restore();
  }

  assert.equal((await getGuildModule(G, 'honeypot')).config.channels[0].triggerCount, 1);
  assert.equal(editCalls.length, 0);
  assert.ok(lines.some((l) => /missing permissions .* to update the live catch count/.test(l)));
});

test('concurrent channel and reaction catches in one channel lose no counts', async () => {
  await saveConfig({ channels: [row()], messages: [bait()] });
  const { guild, message, editCalls } = fakeEnv();

  await Promise.all([
    postTrapMessage(guild),
    react(message),
    postTrapMessage(guild),
    react(message),
    postTrapMessage(guild),
  ]);

  const saved = (await getGuildModule(G, 'honeypot')).config;
  assert.equal(saved.channels[0].triggerCount, 3);
  assert.equal(saved.messages[0].triggerCount, 2);
  // Refreshes of the same message are coalesced, so there are between 1 and 5 edits.
  assert.ok(editCalls.length >= 1 && editCalls.length <= 5);
  assert.equal(catches(editCalls.at(-1)), 'Kicks: 5', 'the last edit shows the full total');
});

test('ensureHoneypotMessages renders the combined count', async () => {
  const cfg = { channels: [row({ triggerCount: 4 })], messages: [bait({ triggerCount: 2 })] };
  await saveConfig(cfg);
  const { guild, editCalls } = fakeEnv();

  await ensureHoneypotMessages(guild, cfg);

  assert.equal(editCalls.length, 1);
  assert.equal(catches(editCalls[0]), 'Kicks: 6');
});

test('an action with no catches is left out of the embed', async () => {
  await saveConfig({
    channels: [row({ action: 'ban', triggerCount: 0 })],
    messages: [bait({ action: 'kick', triggerCount: 2 })],
  });
  const { message, editCalls } = fakeEnv();

  await react(message);

  assert.equal(catches(editCalls[0]), 'Kicks: 3');
});

test('a trap with no catches at all shows the bait row action with 0', async () => {
  const cfg = {
    channels: [row({ action: 'ban', triggerCount: 0 })],
    messages: [bait({ action: 'kick', triggerCount: 0 })],
  };
  await saveConfig(cfg);
  const { guild, editCalls } = fakeEnv();

  await ensureHoneypotMessages(guild, cfg);

  assert.equal(catches(editCalls[0]), 'Kicks: 0');
});

test('ensureHoneypotMessages posts a gone bait message again with the combined count', async () => {
  const cfg = { channels: [row({ triggerCount: 4 })], messages: [bait({ triggerCount: 2 })] };
  await saveConfig(cfg);
  const { guild, channel, editCalls } = fakeEnv();
  const sent = [];
  channel.messages.fetch = async () => {
    throw Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
  };
  channel.send = async (payload) => {
    sent.push(payload);
    return { id: '200000000000000999' };
  };

  await ensureHoneypotMessages(guild, cfg);

  assert.equal(editCalls.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(catches(sent[0]), 'Kicks: 6');
  assert.equal((await getGuildModule(G, 'honeypot')).config.messages[0].messageId, '200000000000000999');
});

test('a channel-trap catch where the bait row has no message yet counts and touches nothing', async () => {
  await saveConfig({ channels: [row()], messages: [row({ bait: 'not posted yet' })] });
  const { guild, channel, editCalls } = fakeEnv();
  let fetches = 0;
  channel.messages.fetch = async () => {
    fetches++;
    return null;
  };

  await postTrapMessage(guild);

  assert.equal((await getGuildModule(G, 'honeypot')).config.channels[0].triggerCount, 1);
  assert.equal(editCalls.length, 0);
  assert.equal(fetches, 0);
});

test('the missing-permission warning is logged once per channel, not on every catch', async () => {
  resetBaitPermWarnings();
  await saveConfig({ channels: [row()], messages: [bait()] });
  const { guild, channel, editCalls } = fakeEnv();
  channel.permissionsFor = () => ({ has: () => false });
  // Text logging writes through console.error, JSON logging through process.stderr.
  const lines = [];
  const textLog = mock.method(console, 'error', (line) => lines.push(String(line)));
  const jsonLog = mock.method(process.stderr, 'write', (chunk) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    await postTrapMessage(guild);
    await postTrapMessage(guild);
    await postTrapMessage(guild);
  } finally {
    textLog.mock.restore();
    jsonLog.mock.restore();
  }

  assert.equal((await getGuildModule(G, 'honeypot')).config.channels[0].triggerCount, 3);
  assert.equal(editCalls.length, 0);
  assert.equal(
    lines.filter((l) => /missing permissions .* to update the live catch count/.test(l)).length,
    1
  );
});
