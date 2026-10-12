import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandBuilder } from 'discord.js';
import { runtime } from '../src/runtime.js';
import { startFluxerBot, resolveInstance } from '../src/bot/fluxerBot.js';

function fakeSdk() {
  class Client {
    constructor(opts) {
      this.opts = opts;
      this.handlers = new Map();
      this.user = { id: '555555555555555555' };
    }
    on(event, fn) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(fn);
      return this;
    }
    once(event, fn) {
      return this.on(event, fn);
    }
    async emit(event, ...args) {
      for (const fn of this.handlers.get(event) ?? []) await fn(...args);
    }
    async login(token) {
      this.token = token;
    }
    isReady() {
      return true;
    }
  }
  class Base {
    async send(p) {
      return { id: 'sent', payload: p };
    }
  }
  class TextChannel extends Base {}
  class DMChannel extends Base {}
  class Message {
    async reply(p) {
      return { id: 'reply', payload: p };
    }
    async edit() {}
  }
  return { Client, TextChannel, DMChannel, Message };
}

const ping = new SlashCommandBuilder().setName('ping').setDescription('p');
const commandsWith = (calls) => new Map([['ping', { data: ping, execute: async (i) => calls.push(i) }]]);

test.afterEach(() => {
  runtime.clients.fluxer = null;
});

test('the client is built with the instance, logged in, and published as the fluxer client', async () => {
  const sdk = fakeSdk();
  const instance = { api_public: 'https://f.test/api' };
  const client = await startFluxerBot({
    sdk,
    token: 'id.secret',
    instance,
    commands: new Map(),
    prefix: '!',
    loadModules: async () => {},
    installCompat: () => {},
  });
  assert.equal(client.token, 'id.secret');
  assert.deepEqual(client.opts.instance, instance);
  assert.equal(client.opts.waitForGuilds, true);
  assert.equal(runtime.clients.fluxer, client);
});

test('the component bridge is installed on the SDK send path', async () => {
  const sdk = fakeSdk();
  await startFluxerBot({
    sdk,
    token: 't',
    commands: new Map(),
    prefix: '!',
    loadModules: async () => {},
    installCompat: () => {},
  });
  const sent = await new sdk.TextChannel().send({
    content: '',
    files: [{ attachment: Buffer.from('x'), name: 'a.txt' }],
  });
  assert.deepEqual(sent.payload.files, [{ name: 'a.txt', data: Buffer.from('x') }]);
});

test('commands are exposed on the client and run from a prefixed message', async () => {
  const sdk = fakeSdk();
  const calls = [];
  const commands = commandsWith(calls);
  const client = await startFluxerBot({
    sdk,
    token: 't',
    commands,
    prefix: '!',
    loadModules: async () => {},
    installCompat: () => {},
  });
  assert.equal(client.commands, commands);
  const message = {
    content: '!ping',
    author: { id: '111111111111111111', bot: false },
    member: { permissions: { has: () => true }, roles: { cache: new Map() } },
    guild: { id: '900000000000000050', members: { cache: new Map() } },
    channel: { id: 'c1', send: async () => ({}), sendTyping: async () => {} },
    channelId: 'c1',
    client,
    reply: async () => ({ delete: async () => {} }),
    delete: async () => {},
  };
  await client.emit('messageCreate', message);
  await new Promise((r) => setTimeout(r, 20)); // the listener runs the command without being awaited
  assert.equal(calls.length, 1);
  assert.equal(calls[0].guildId, 'fluxer:900000000000000050');
});

test('a reaction payload is adapted and handed to the component bridge without throwing', async () => {
  const sdk = fakeSdk();
  const client = await startFluxerBot({
    sdk,
    token: 't',
    commands: new Map(),
    prefix: '!',
    loadModules: async () => {},
    installCompat: () => {},
  });
  assert.ok(client.handlers.get('messageReactionAdd')?.length);
  // The bot's own reaction is ignored.
  await assert.doesNotReject(
    client.emit('messageReactionAdd', { userId: client.user.id, emoji: { name: '🎉' } })
  );
});

test('resolveInstance: hosted Fluxer needs none, a self-hosted one is read from its discovery document', async () => {
  assert.equal(await resolveInstance({}), undefined);

  const doc = { endpoints: { api_public: 'https://f.test/api', webapp: 'https://f.test' } };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => doc };
  };
  assert.equal(await resolveInstance({ webUrl: 'https://f.test' }, fetchImpl), doc);
  assert.deepEqual(seen, ['https://f.test/.well-known/fluxer']);
});

test('resolveInstance: without a loadable discovery document it falls back to the two origins', async () => {
  const failing = async () => ({ ok: false, status: 404 });
  assert.deepEqual(
    await resolveInstance({ webUrl: 'https://f.test', apiUrl: 'https://f.test/api' }, failing),
    {
      api_public: 'https://f.test/api',
      webapp: 'https://f.test',
    }
  );
});

test('the modules are loaded and their gateway events wired before login', async () => {
  const sdk = fakeSdk();
  let loaded = 0;
  const client = await startFluxerBot({
    sdk,
    token: 't',
    commands: new Map(),
    prefix: '!',
    loadModules: async () => {
      loaded += 1;
    },
    installCompat: () => {},
  });
  assert.equal(loaded, 1);
  for (const event of ['guildMemberAdd', 'messageCreate', 'guildDelete', 'messageReactionAdd']) {
    assert.ok(client.handlers.get(event)?.length, event);
  }
});

test('the discord.js compat aliases are installed on the SDK before login', async () => {
  const sdk = fakeSdk();
  let installedOn = null;
  await startFluxerBot({
    sdk,
    token: 't',
    commands: new Map(),
    prefix: '!',
    loadModules: async () => {},
    installCompat: (s, deps) => {
      installedOn = [s, typeof deps.Collection, typeof deps.voice?.track];
    },
  });
  assert.deepEqual(installedOn, [sdk, 'function', 'function']);
});

test('the Fluxer client logs when it is ready, so a run can be told from a silent failure', async () => {
  const { log } = await import('../src/lib/log.js');
  const sdk = fakeSdk();
  const client = await startFluxerBot({
    sdk,
    token: 't',
    commands: new Map(),
    prefix: '!',
    loadModules: async () => {},
    installCompat: () => {},
  });
  const lines = [];
  const original = log.info;
  log.info = (scope, ...rest) => lines.push([scope, ...rest].join(' '));
  try {
    client.user = { id: '555', username: 'Sylo_Test' };
    client.guilds = { cache: { size: 3 } };
    await client.emit('ready');
  } finally {
    log.info = original;
  }
  assert.ok(
    lines.some((l) => /fluxer.*Sylo_Test.*3 guild/.test(l)),
    lines.join(' | ')
  );
});
