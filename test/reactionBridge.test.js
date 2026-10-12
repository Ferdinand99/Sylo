import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { registerComponent, _resetComponents } from '../src/bot/lib/components.js';
import { prepareOutgoing, attachActions } from '../src/platform/outgoing.js';
import { handleReactionAdd } from '../src/platform/reactionBridge.js';
import { saveComponentActions } from '../src/db/componentReactions.js';

const RAW_GUILD = '900000000000000095';
const GUILD = `fluxer:${RAW_GUILD}`;
const UID = '111111111111111111';

function fakeWorld({ messageId = 'msg1' } = {}) {
  const log = { sends: [], edits: [], deletes: [], removed: [], reacted: [] };
  const member = { id: UID, roles: { cache: new Map() }, permissions: { has: () => true } };
  const sentMessage = (payload) => ({
    payload,
    id: `sent${log.sends.length}`,
    delete: async () => {
      log.deletes.push(payload.content);
    },
    edit: async (p) => {
      log.edits.push(p);
    },
  });
  const message = {
    id: messageId,
    channelId: 'chan1',
    guild: { id: RAW_GUILD, members: { cache: new Map([[UID, member]]), fetch: async () => member } },
    client: { marker: 'client' },
    channel: {
      id: 'chan1',
      send: async (p) => {
        log.sends.push(p);
        return sentMessage(p);
      },
      sendTyping: async () => {},
    },
    edit: async (p) => {
      log.edits.push(p);
    },
    react: async (e) => {
      log.reacted.push(e);
    },
    reactions: { removeAll: async () => {} },
  };
  const reaction = (emoji) => ({
    emoji: { name: emoji, id: null },
    message,
    users: {
      remove: async (id) => {
        log.removed.push(id);
      },
    },
  });
  return { message, reaction, log, user: { id: UID, bot: false, tag: 't#1' } };
}

const save = (actions, extra = {}) =>
  saveComponentActions({ guildId: GUILD, channelId: 'chan1', messageId: 'msg1', actions, ...extra });

test('a reaction on a stored button runs the registered handler with a button interaction', async () => {
  _resetComponents();
  const seen = [];
  registerComponent('t', 'gaw:enter:', (i) => seen.push(i));
  await save([{ kind: 'button', customId: 'gaw:enter:7', emoji: '🎉', label: 'Enter' }]);
  const { reaction, user, message } = fakeWorld();
  await handleReactionAdd(reaction('🎉'), user);

  assert.equal(seen.length, 1);
  const i = seen[0];
  assert.equal(i.customId, 'gaw:enter:7');
  assert.equal(i.user, user);
  assert.equal(i.guildId, GUILD);
  assert.equal(i.guild.id, GUILD);
  assert.equal(i.member, message.guild.members.cache.get(UID));
  assert.equal(i.message, message);
  assert.equal(i.isButton(), true);
  assert.equal(i.isStringSelectMenu(), false);
  assert.equal(i.isMessageComponent(), true);
  assert.equal(i.isChatInputCommand(), false);
  assert.equal(i.isRepliable(), true);
});

test('a reaction on a select option runs the handler with that value', async () => {
  _resetComponents();
  const seen = [];
  registerComponent('t', 'help-', (i) => seen.push(i));
  await save([{ kind: 'select', customId: 'help-category', value: 'moderation', emoji: '2️⃣', label: 'Mod' }]);
  const { reaction, user } = fakeWorld();
  await handleReactionAdd(reaction('2️⃣'), user);
  assert.deepEqual(seen[0].values, ['moderation']);
  assert.equal(seen[0].isStringSelectMenu(), true);
  assert.equal(seen[0].isButton(), false);
});

test("the user's reaction is removed afterwards so it can be used again", async () => {
  _resetComponents();
  registerComponent('t', 'x', () => {});
  await save([{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }]);
  const { reaction, user, log } = fakeWorld();
  await handleReactionAdd(reaction('🎉'), user);
  assert.deepEqual(log.removed, [UID]);
});

test('bots, unknown emoji, unknown messages and expired actions are ignored', async () => {
  _resetComponents();
  let calls = 0;
  registerComponent('t', 'x', () => (calls += 1));
  await save([{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }]);
  const w = fakeWorld();
  await handleReactionAdd(w.reaction('🎉'), { ...w.user, bot: true });
  await handleReactionAdd(w.reaction('🙈'), w.user);
  const other = fakeWorld({ messageId: 'other' });
  await handleReactionAdd(other.reaction('🎉'), other.user);
  await saveComponentActions({
    guildId: GUILD,
    channelId: 'chan1',
    messageId: 'msg1',
    actions: [{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }],
    expiresAt: Date.now() - 1,
  });
  await handleReactionAdd(w.reaction('🎉'), w.user);
  assert.equal(calls, 0);
});

test('a message with a collector hands the interaction to it instead of the registry', async () => {
  _resetComponents();
  let routed = 0;
  registerComponent('t', 'x', () => (routed += 1));
  const w = fakeWorld();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('x').setLabel('X').setStyle(ButtonStyle.Primary)
  );
  await attachActions(w.message, prepareOutgoing({ components: [row] }), { guildId: GUILD });
  const collector = w.message.createMessageComponentCollector({});
  const got = [];
  collector.on('collect', (i) => got.push(i.customId));
  await handleReactionAdd(w.reaction('1️⃣'), w.user);
  collector.stop();
  assert.deepEqual(got, ['x']);
  assert.equal(routed, 0);
});

test('an ephemeral reply is sent as a mention in the channel and removed after the TTL', async () => {
  _resetComponents();
  registerComponent('t', 'x', (i) => i.reply({ content: 'Verified!', flags: MessageFlags.Ephemeral }));
  await save([{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }]);
  const { reaction, user, log } = fakeWorld();
  await handleReactionAdd(reaction('🎉'), user, { privateTtlMs: 5 });
  assert.equal(log.sends[0].content, `<@${UID}> Verified!`);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log.deletes, [`<@${UID}> Verified!`]); // the panel itself is not deleted
});

test('a public reply is sent as is and kept', async () => {
  _resetComponents();
  registerComponent('t', 'x', (i) => i.reply({ content: 'Hello all' }));
  await save([{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }]);
  const { reaction, user, log } = fakeWorld();
  await handleReactionAdd(reaction('🎉'), user, { privateTtlMs: 5 });
  assert.equal(log.sends[0].content, 'Hello all');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(log.deletes, []);
});

test('update() edits the source message and re-attaches the new components', async () => {
  _resetComponents();
  registerComponent('t', 'x', (i) =>
    i.update({
      embeds: [{ title: 'Page 2' }],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('x').setLabel('Back').setStyle(ButtonStyle.Primary)
        ),
      ],
    })
  );
  await save([{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }]);
  const { reaction, user, log } = fakeWorld();
  await handleReactionAdd(reaction('🎉'), user);
  assert.deepEqual(log.edits[0].embeds, [{ title: 'Page 2' }]);
  assert.match(log.edits[0].content, /1️⃣ Back/);
  assert.deepEqual(log.reacted, ['1️⃣']);
});

test('a handler that throws gets the generic failure reply, and nothing escapes', async () => {
  _resetComponents();
  registerComponent('t', 'x', () => {
    throw new Error('boom');
  });
  await save([{ kind: 'button', customId: 'x', emoji: '🎉', label: 'x' }]);
  const { reaction, user, log } = fakeWorld();
  await assert.doesNotReject(handleReactionAdd(reaction('🎉'), user));
  assert.match(log.sends[0].content, /Something went wrong/);
});
