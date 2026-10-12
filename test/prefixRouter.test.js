import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { handleMessage, splitCommand } from '../src/bot/framework/router.js';
import { setCommandOverride } from '../src/db/commandOverrides.js';

const RAW_GUILD = '900000000000000080';
const UID = '111111111111111111';
const BOT_ID = '555555555555555555';

function fakeMessage({ content, bot = false, inGuild = true, canDo = true } = {}) {
  const replies = [];
  const message = {
    content,
    createdTimestamp: 1,
    author: { id: UID, tag: 't#1', bot },
    member: inGuild ? { id: UID, permissions: { has: () => canDo }, roles: { cache: new Map() } } : null,
    guild: inGuild ? { id: RAW_GUILD, members: { cache: new Map(), fetch: async () => null } } : null,
    channel: { id: '222222222222222222', send: async () => ({}), sendTyping: async () => {} },
    channelId: '222222222222222222',
    client: { users: { cache: new Map([[UID, { id: UID }]]) }, user: { id: BOT_ID } },
    reply: async (p) => {
      replies.push(p);
      return { delete: async () => {}, edit: async () => {} };
    },
    delete: async () => {},
  };
  return { message, replies };
}

const ping = new SlashCommandBuilder().setName('ping').setDescription('p');
const say = new SlashCommandBuilder()
  .setName('say')
  .setDescription('s')
  .addUserOption((o) => o.setName('who').setDescription('w').setRequired(true))
  .addStringOption((o) => o.setName('text').setDescription('t'));
const guarded = new SlashCommandBuilder()
  .setName('guarded')
  .setDescription('g')
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers);
const guildOnly = new SlashCommandBuilder()
  .setName('guildonly')
  .setDescription('go')
  .setContexts(InteractionContextType.Guild);

function setup(overrides = {}) {
  const calls = [];
  const commands = new Map(
    [ping, say, guarded, guildOnly].map((data) => [
      data.name,
      {
        data,
        execute: async (interaction) => {
          calls.push(interaction);
          if (overrides.throws) throw new Error('boom');
        },
      },
    ])
  );
  return { commands, calls };
}

const run = (message, commands) => handleMessage(message, { commands, prefix: '!', botId: BOT_ID });

test('splitCommand reads the prefix or a leading bot mention, case-insensitively', () => {
  assert.deepEqual(splitCommand('!Ping hello', '!', BOT_ID), { name: 'ping', rest: 'hello' });
  assert.deepEqual(splitCommand(`<@${BOT_ID}> ping`, '!', BOT_ID), { name: 'ping', rest: '' });
  assert.deepEqual(splitCommand(`<@!${BOT_ID}>   ping x`, '!', BOT_ID), { name: 'ping', rest: 'x' });
  assert.equal(splitCommand('ping', '!', BOT_ID), null);
  assert.equal(splitCommand('!', '!', BOT_ID), null);
  assert.equal(splitCommand('! ping', '!', BOT_ID), null);
});

test('a prefixed message runs the command with a MessageInteraction', async () => {
  const { commands, calls } = setup();
  const { message } = fakeMessage({ content: '!ping' });
  await run(message, commands);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].commandName, 'ping');
  assert.equal(calls[0].guildId, `fluxer:${RAW_GUILD}`);
});

test('arguments are parsed and entity options resolved before execute()', async () => {
  const { commands, calls } = setup();
  const { message } = fakeMessage({ content: `!say <@${UID}> hello there` });
  await run(message, commands);
  assert.equal(calls[0].options.getUser('who').id, UID);
  assert.equal(calls[0].options.getString('text'), 'hello there');
});

test('a bot-mention prefix works too', async () => {
  const { commands, calls } = setup();
  const { message } = fakeMessage({ content: `<@${BOT_ID}> ping` });
  await run(message, commands);
  assert.equal(calls.length, 1);
});

test('non-commands, unknown commands and bot authors are ignored silently', async () => {
  for (const content of ['hello', '!nope', '!']) {
    const { commands, calls } = setup();
    const { message, replies } = fakeMessage({ content });
    await run(message, commands);
    assert.equal(calls.length + replies.length, 0, content);
  }
  const { commands, calls } = setup();
  const { message, replies } = fakeMessage({ content: '!ping', bot: true });
  await run(message, commands);
  assert.equal(calls.length + replies.length, 0);
});

test('a command needing a permission the member lacks is refused', async () => {
  const { commands, calls } = setup();
  const { message, replies } = fakeMessage({ content: '!guarded', canDo: false });
  await run(message, commands);
  assert.equal(calls.length, 0);
  assert.match(replies[0].content, /permission/i);

  const ok = fakeMessage({ content: '!guarded', canDo: true });
  await run(ok.message, commands);
  assert.equal(calls.length, 1);
});

test('a guild-only command refuses a DM, a context-free one allows it', async () => {
  const a = setup();
  const dm = fakeMessage({ content: '!guildonly', inGuild: false });
  await run(dm.message, a.commands);
  assert.equal(a.calls.length, 0);
  assert.match(dm.replies[0].content, /server/i);

  const b = fakeMessage({ content: '!ping', inGuild: false });
  await run(b.message, a.commands);
  assert.equal(a.calls.length, 1);
});

test('bad arguments get the problem and the usage line, and execute() is not called', async () => {
  const { commands, calls } = setup();
  const { message, replies } = fakeMessage({ content: '!say' });
  await run(message, commands);
  assert.equal(calls.length, 0);
  assert.match(replies[0].content, /who/);
  assert.match(replies[0].content, /!say <who> \[text\]/);
});

test('an unresolvable user is reported as an argument problem', async () => {
  const { commands, calls } = setup();
  const { message, replies } = fakeMessage({ content: '!say <@999999999999999999>' });
  await run(message, commands);
  assert.equal(calls.length, 0);
  assert.match(replies[0].content, /who/);
});

test('a per-guild command override disables the command, using the platform guild id', async () => {
  await setCommandOverride(`fluxer:${RAW_GUILD}`, 'ping', { enabled: false });
  const { commands, calls } = setup();
  const { message, replies } = fakeMessage({ content: '!ping' });
  await run(message, commands);
  assert.equal(calls.length, 0);
  assert.match(replies[0].content, /disabled/i);
  await setCommandOverride(`fluxer:${RAW_GUILD}`, 'ping', { enabled: true });
});

test('a command that throws is reported to the user and does not escape', async () => {
  const { commands } = setup({ throws: true });
  const { message, replies } = fakeMessage({ content: '!ping' });
  await assert.doesNotReject(run(message, commands));
  assert.match(replies[0].content, /went wrong/i);
});

test('isCommandMessage: true only for a known command from a human', async () => {
  const { isCommandMessage } = await import('../src/bot/framework/router.js');
  const { commands } = setup();
  const opts = { commands, prefix: '!', botId: BOT_ID };
  assert.equal(isCommandMessage(fakeMessage({ content: '!ping' }).message, opts), true);
  assert.equal(isCommandMessage(fakeMessage({ content: `<@${BOT_ID}> ping` }).message, opts), true);
  assert.equal(isCommandMessage(fakeMessage({ content: '!nope' }).message, opts), false);
  assert.equal(isCommandMessage(fakeMessage({ content: 'ping' }).message, opts), false);
  assert.equal(isCommandMessage(fakeMessage({ content: '!ping', bot: true }).message, opts), false);
});
