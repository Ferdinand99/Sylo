// Custom commands on a platform with no slash commands: no slash sync, and `!name` runs them.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { log } from '../src/lib/log.js';
import { setGuildModule } from '../src/db/modules.js';
import { handleMessage } from '../src/bot/framework/router.js';
import { syncGuildCustomCommands } from '../src/bot/lib/customCommandSync.js';

const RAW = '900000000000000090';
const KEY = `fluxer:${RAW}`;
const UID = '111111111111111111';
const CHANNEL = '222222222222222222';

const fluxerClient = { users: { cache: new Map() }, user: { id: '555555555555555555' } };

function fluxerMessage(content) {
  const replies = [];
  const message = {
    content,
    createdTimestamp: 1,
    author: { id: UID, username: 'ferdi', tag: 'ferdi', bot: false },
    member: { id: UID, permissions: { has: () => true }, roles: { cache: new Map() } },
    guild: {
      id: RAW,
      name: 'Fluxer Test',
      client: fluxerClient,
      members: { cache: new Map(), fetch: async () => null },
      channels: { cache: new Map() },
    },
    channel: { id: CHANNEL, send: async () => ({}), sendTyping: async () => {} },
    channelId: CHANNEL,
    client: fluxerClient,
    reply: async (p) => {
      replies.push(p);
      return { delete: async () => {}, edit: async (e) => replies.push(e) };
    },
    delete: async () => {},
  };
  return { message, replies };
}

const hello = {
  name: 'hello',
  actions: [{ type: 'reply', private: false, messages: [{ content: 'Hi {username}! {args}', embed: null }] }],
  allowedRoles: [],
  allowedChannels: [],
  cooldownSeconds: 0,
};

test('custom commands: no slash sync is attempted for a platform without slash commands', async () => {
  runtime.clients.fluxer = fluxerClient;
  const errors = [];
  const original = log.error;
  log.error = (...args) => errors.push(args);
  try {
    await setGuildModule(KEY, 'custom-commands', { enabled: true, config: { commands: [hello] } });
    // A Fluxer guild has no `commands` manager at all.
    await syncGuildCustomCommands({ id: RAW, client: fluxerClient });
    assert.deepEqual(errors, []);
  } finally {
    log.error = original;
  }
});

test('custom commands: "!hello there" runs the custom command, with the text as {args}', async () => {
  runtime.clients.fluxer = fluxerClient;
  await setGuildModule(KEY, 'custom-commands', { enabled: true, config: { commands: [hello] } });
  const { message, replies } = fluxerMessage('!hello there');
  await handleMessage(message, { commands: new Map(), prefix: '!' });
  assert.equal(replies.length > 0, true, 'the bot answered');
  const text = replies.map((r) => r.content ?? '').join(' ');
  assert.match(text, /Hi ferdi! there/);
});

test('custom commands: an unknown "!word" stays silent when no custom command matches', async () => {
  runtime.clients.fluxer = fluxerClient;
  await setGuildModule(KEY, 'custom-commands', { enabled: true, config: { commands: [hello] } });
  const { message, replies } = fluxerMessage('!nothing here');
  await handleMessage(message, { commands: new Map(), prefix: '!' });
  assert.deepEqual(replies, []);
});

test.after(() => {
  runtime.clients.fluxer = null;
});
