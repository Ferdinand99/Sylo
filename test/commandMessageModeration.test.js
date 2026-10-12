// A chat command is not chat for XP, AFK and counting, but it is still a message a member
// posted: automod and the honeypot must see it, or `!afk <invite link> @everyone` walks past them.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { dispatch } from '../src/modules/dispatch.js';
import { setGuildModule } from '../src/db/modules.js';
import '../src/modules/automod.js';
import '../src/modules/honeypot.js';
import { beginModeration, moderationOutcome } from '../src/modules/lib/messageModeration.js';

const GUILD = '900000000000000095';
const CHANNEL = '222222222222222222'; // the honeypot's trap channel
const CHAT = '333333333333333333'; // an ordinary channel

function fakeMessage(content, perms = [], channelId = CHAT) {
  const log = { deleted: false };
  const member = {
    id: 'u1',
    user: { id: 'u1', tag: 'u#1', displayAvatarURL: () => null },
    permissions: { has: (p) => perms.includes(p) },
    roles: { cache: new Map() },
    moderatable: false,
    bannable: false,
    kickable: false,
  };
  const message = {
    content,
    partial: false,
    author: { id: 'u1', bot: false },
    member,
    channelId,
    deletable: true,
    delete: async () => {
      log.deleted = true;
    },
    mentions: [],
    mentionRoles: [],
    mentionEveryone: false,
    guild: {
      id: GUILD,
      name: 'G',
      client: {},
      members: { me: null, fetch: async () => member },
      channels: { cache: new Map() },
    },
  };
  return { message, log };
}

test('automod filters a command message (an invite link behind a command prefix) without flood counting', async () => {
  await setGuildModule(GUILD, 'automod', {
    enabled: true,
    config: { deleteMessage: true, rules: { invites: { enabled: true, action: 'delete' } } },
  });
  const { message, log } = fakeMessage('!afk join discord.gg/abcdef');
  await dispatch('commandMessageCreate', GUILD, message);
  assert.equal(log.deleted, true);
});

test('automod leaves an ordinary command with clean text alone', async () => {
  const { message, log } = fakeMessage('!afk lunch');
  await dispatch('commandMessageCreate', GUILD, message);
  assert.equal(log.deleted, false);
});

test('the honeypot catches a command posted in a trap channel', async () => {
  await setGuildModule(GUILD, 'honeypot', {
    enabled: true,
    config: { channels: [{ channelId: CHANNEL, action: 'kick', deleteMessage: true }] },
  });
  const { message, log } = fakeMessage('!afk x', [], CHANNEL);
  await dispatch('commandMessageCreate', GUILD, message);
  assert.equal(log.deleted, true, 'the trap message is removed');
});

test('automod marks a message it acted on, so the command behind it is not run', async () => {
  const { message } = fakeMessage('!afk join discord.gg/abcdef');
  beginModeration(message, dispatch('commandMessageCreate', GUILD, message));
  assert.equal(await moderationOutcome(message), true);

  const clean = fakeMessage('!afk lunch');
  beginModeration(clean.message, dispatch('commandMessageCreate', GUILD, clean.message));
  assert.equal(await moderationOutcome(clean.message), false);
});

test('a staff member running a command is not scanned as if it were chat', async () => {
  // `!ban @a @b @c … see https://evidence` carries mentions and links by design.
  const { message, log } = fakeMessage('!afk join discord.gg/abcdef', [PermissionFlagsBits.ModerateMembers]);
  await dispatch('commandMessageCreate', GUILD, message);
  assert.equal(log.deleted, false);

  // The same member typing the invite as chat is still filtered.
  const chat = fakeMessage('join discord.gg/abcdef', [PermissionFlagsBits.ModerateMembers]);
  await dispatch('messageCreate', GUILD, chat.message);
  assert.equal(chat.log.deleted, true);
});
