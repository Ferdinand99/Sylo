// /health and /metrics are public: a guild's custom command names must not become metric labels.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, byMetric, peek } from '../src/lib/metrics.js';
import { execute } from '../src/bot/events/interactionCreate.js';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { handleMessage } from '../src/bot/framework/router.js';

test.beforeEach(() => reset());

function slash(commandName, commands) {
  return {
    commandName,
    isMessageComponent: () => false,
    isAutocomplete: () => false,
    isMessageContextMenuCommand: () => false,
    isChatInputCommand: () => true,
    inGuild: () => false,
    guildId: null,
    client: { commands: new Map(commands), contextMenus: new Map() },
    reply: async () => {},
  };
}

test('a built-in slash command is counted by name, any other name under one fixed label', async () => {
  await execute(slash('ping', [['ping', { execute: async () => {} }]]));
  await execute(slash('secret-giveaway-promo', [['ping', { execute: async () => {} }]]));
  await execute(slash('other-secret-command', [['ping', { execute: async () => {} }]]));
  const names = byMetric('sylo_commands_total').map((s) => s.labels.command);
  assert.deepEqual(names.sort(), ['custom', 'ping']);
  assert.equal(peek('sylo_commands_total', { command: 'custom' }), 2);
  assert.equal(peek('sylo_commands_total', { command: 'ping' }), 1);
});

test('a custom command run with a prefix on Fluxer is counted under the fixed label too', async () => {
  const RAW = '900000000000000091';
  const UID = '111111111111111111';
  const client = { users: { cache: new Map() }, user: { id: '555555555555555555' } };
  runtime.clients.fluxer = client;
  await setGuildModule(`fluxer:${RAW}`, 'custom-commands', {
    enabled: true,
    config: {
      commands: [
        {
          name: 'hidden-name',
          actions: [{ type: 'reply', private: false, messages: [{ content: 'hi', embed: null }] }],
          allowedRoles: [],
          allowedChannels: [],
          cooldownSeconds: 0,
        },
      ],
    },
  });
  const message = {
    content: '!hidden-name',
    createdTimestamp: 1,
    author: { id: UID, username: 'ferdi', tag: 'ferdi', bot: false },
    member: { id: UID, permissions: { has: () => true }, roles: { cache: new Map() } },
    guild: {
      id: RAW,
      name: 'Fluxer Test',
      client,
      members: { cache: new Map(), fetch: async () => null },
      channels: { cache: new Map() },
    },
    channel: { id: '222222222222222222', send: async () => ({}), sendTyping: async () => {} },
    channelId: '222222222222222222',
    client,
    reply: async () => ({ delete: async () => {}, edit: async () => {} }),
    delete: async () => {},
  };
  await handleMessage(message, { commands: new Map(), prefix: '!' });
  assert.equal(peek('sylo_commands_total', { command: 'custom' }), 1);
  assert.equal(peek('sylo_commands_total', { command: 'hidden-name' }), 0);
  runtime.clients.fluxer = null;
});
