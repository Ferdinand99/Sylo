// A 4.10 server may have a custom command named like a command added in 5.0 (/suggest, /quote ...).
// The built-in wins, so such a custom command is skipped at sync (with one warning) and flagged.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { log } from '../src/lib/log.js';
import { setGuildModule } from '../src/db/modules.js';
import { loadCommands } from '../src/bot/loadCommands.js';
import {
  collidingCommands,
  reservedCommandNames,
  syncGuildCustomCommands,
} from '../src/bot/lib/customCommandSync.js';

const reply = (name) => ({
  name,
  actions: [{ type: 'reply', private: false, messages: [{ content: 'hi', embed: null }] }],
  allowedRoles: [],
  allowedChannels: [],
  cooldownSeconds: 0,
});

test('the reserved names come from the registered built-ins, including the five new in 5.0', async () => {
  const client = { commands: await loadCommands(), contextMenus: new Map() };
  const reserved = reservedCommandNames(client);
  for (const name of ['suggest', 'suggestion', 'quote', 'event', 'temprole', 'ping']) {
    assert.ok(reserved.has(name), `/${name} is reserved`);
  }
  assert.ok(!reserved.has('rules'));
  assert.deepEqual(reservedCommandNames(undefined), new Set());
  assert.deepEqual(
    collidingCommands(client, { commands: [reply('quote'), reply('rules')] }).map((c) => c.name),
    ['quote']
  );
});

test('sync skips a custom command that is a built-in name, in every guild, and warns once per guild and command', async () => {
  const client = { commands: new Map([['quote', {}]]), contextMenus: new Map() };
  const warnings = [];
  const original = log.warn;
  log.warn = (...args) => warnings.push(args.join(' '));
  try {
    for (const id of ['900000000000000701', '900000000000000702']) {
      await setGuildModule(id, 'custom-commands', {
        enabled: true,
        config: { commands: [reply('quote'), reply('rules')] },
      });
      const sets = [];
      const guild = { id, client, commands: { set: async (list) => sets.push(list) } };
      await syncGuildCustomCommands(guild);
      await syncGuildCustomCommands(guild); // a second sync does not repeat the warning
      assert.deepEqual(
        sets[0].map((c) => c.name),
        ['rules'],
        'the colliding command is not registered'
      );
    }
  } finally {
    log.warn = original;
  }
  const mine = warnings.filter((w) => w.includes('/quote'));
  assert.equal(mine.length, 2, 'one per guild');
  assert.match(mine[0], /900000000000000701/);
  assert.match(mine[1], /900000000000000702/);
});
