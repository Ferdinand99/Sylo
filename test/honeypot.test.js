// Covers the exact bug report from issue #211's feedback: "the Kicks counter
// on the trap message doesn't tick up upon trigger" — a reaction-honeypot
// (kind: 'messages') punishment should both persist the bumped triggerCount
// AND re-render the live bait message's embed with the new count. Minimal,
// self-built fakes (not test/helpers/fakeGuild.js — that helper's
// channel.messages.fetch always resolves null and its send()-returned
// message's edit() is a no-op, neither of which is enough to assert on here,
// and this module doesn't need the rest of that helper's surface).
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule, getGuildModule } from '../src/db/modules.js';
import '../src/modules/honeypot.js'; // registers the messageCreate/reactionAdd handlers

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
