// A server may keep up to 200 custom commands, but Discord registers at most 100 chat-input commands for one
// server and refuses a bulk overwrite with more. The list is stored whole; the sync registers the first 100 in
// list order, says so once, and the dashboard shows how many are registered and which are not.
import { startWebApp } from './helpers/webApp.js';
import { v2Open } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/lib/log.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { DISCORD_COMMAND_LIMIT, LIMITS, normaliseCustomCommands } from '../src/modules/customCommands.js';
import { syncGuildCustomCommands } from '../src/bot/lib/customCommandSync.js';

const reply = (name) => ({
  name,
  actions: [{ type: 'reply', private: false, messages: [{ content: 'hi', embed: null }] }],
  allowedRoles: [],
  allowedChannels: [],
  cooldownSeconds: 0,
});
const many = (n) => Array.from({ length: n }, (_, i) => reply(`cmd-${i + 1}`));

test('the limits: a server keeps up to 200, Discord registers 100', () => {
  assert.equal(LIMITS.commands.maxItems, 200);
  assert.equal(DISCORD_COMMAND_LIMIT, 100);
});

test('a save never drops commands below the stored maximum, and cuts only past it', () => {
  assert.equal(normaliseCustomCommands({ commands: many(120) }).commands.length, 120);
  assert.equal(normaliseCustomCommands({ commands: many(200) }).commands.length, 200);
  assert.equal(normaliseCustomCommands({ commands: many(230) }).commands.length, 200);
  // the order is kept: the first ones are the ones Discord registers
  assert.deepEqual(
    normaliseCustomCommands({ commands: many(120) })
      .commands.slice(98, 101)
      .map((c) => c.name),
    ['cmd-99', 'cmd-100', 'cmd-101']
  );
});

test('sync with 120 commands registers the first 100 in list order, does not throw, and warns once per guild', async () => {
  const id = '900000000000000801';
  await setGuildModule(id, 'custom-commands', { enabled: true, config: { commands: many(120) } });
  const sets = [];
  const guild = {
    id,
    client: { commands: new Map(), contextMenus: new Map() },
    commands: { set: async (list) => sets.push(list) },
  };
  const warnings = [];
  const original = log.warn;
  log.warn = (...args) => warnings.push(args.join(' '));
  try {
    await syncGuildCustomCommands(guild);
    await syncGuildCustomCommands(guild);
  } finally {
    log.warn = original;
  }
  assert.equal(sets.length, 2);
  assert.equal(sets[0].length, 100);
  assert.deepEqual(
    sets[0].map((c) => c.name),
    many(100).map((c) => c.name),
    'the first 100, in list order'
  );
  const over = warnings.filter((w) => w.includes('120 custom commands'));
  assert.equal(over.length, 1, 'one warning, not one per sync');
  assert.match(over[0], /Only the first 100 are registered/);
  // the stored list is untouched by the sync
  assert.equal(
    normaliseCustomCommands((await getGuildModule(id, 'custom-commands')).config).commands.length,
    120
  );
});

test('a list that fits is registered whole, and warns again after it grew past the limit once more', async () => {
  const id = '900000000000000802';
  const sets = [];
  const guild = {
    id,
    client: { commands: new Map(), contextMenus: new Map() },
    commands: { set: async (list) => sets.push(list) },
  };
  const warnings = [];
  const original = log.warn;
  log.warn = (...args) => warnings.push(args.join(' '));
  try {
    for (const n of [101, 100, 101]) {
      await setGuildModule(id, 'custom-commands', { enabled: true, config: { commands: many(n) } });
      await syncGuildCustomCommands(guild);
    }
  } finally {
    log.warn = original;
  }
  assert.deepEqual(
    sets.map((s) => s.length),
    [100, 100, 100]
  );
  assert.equal(warnings.filter((w) => w.includes('Only the first')).length, 2);
});

test('the list answer tells how many are registered and which commands are beyond the limit', async () => {
  const app = await startWebApp();
  try {
    const api = v2Open(app, GID);
    await setGuildModule(GID, 'custom-commands', { enabled: true, config: { commands: many(103) } });
    const data = await (await api.get('/modules/custom-commands/list')).json();
    assert.equal(data.registeredLimit, 100);
    assert.equal(data.overLimit, 3);
    assert.equal(data.commands.length, 103);
    assert.deepEqual(
      data.commands.filter((c) => c.beyondLimit).map((c) => c.name),
      ['cmd-101', 'cmd-102', 'cmd-103']
    );
    await setGuildModule(GID, 'custom-commands', { enabled: true, config: { commands: many(5) } });
    const small = await (await api.get('/modules/custom-commands/list')).json();
    assert.equal(small.overLimit, 0);
    assert.ok(small.commands.every((c) => c.beyondLimit === false));
  } finally {
    await app.close();
  }
});
