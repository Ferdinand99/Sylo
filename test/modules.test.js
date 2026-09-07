import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, getGuildModules, isModuleEnabled, setGuildModule } from '../src/db/modules.js';
import { MODULES } from '../src/modules/registry.js';

const G = '900000000000000200';

test('getGuildModule: falls back to the registry default when nothing is stored', async () => {
  const known = MODULES[0];
  const { enabled, config } = await getGuildModule(G, known.id);
  assert.equal(enabled, known.defaultEnabled);
  assert.deepEqual(config, {});
});

test('getGuildModule: an unknown module id falls back to disabled, empty config', async () => {
  const { enabled, config } = await getGuildModule(G, 'not-a-real-module');
  assert.equal(enabled, false);
  assert.deepEqual(config, {});
});

test('setGuildModule + getGuildModule round-trip; isModuleEnabled matches', async () => {
  await setGuildModule(G, 'afk', { enabled: true, config: { message: 'brb' } });
  const { enabled, config } = await getGuildModule(G, 'afk');
  assert.equal(enabled, true);
  assert.deepEqual(config, { message: 'brb' });
  assert.equal(await isModuleEnabled(G, 'afk'), true);

  await setGuildModule(G, 'afk', { enabled: false });
  assert.equal(await isModuleEnabled(G, 'afk'), false);
  // Config is preserved when a patch only touches `enabled`.
  assert.deepEqual((await getGuildModule(G, 'afk')).config, { message: 'brb' });
});

test('setGuildModule: a config-only patch keeps the current enabled state', async () => {
  const g = '900000000000000201';
  await setGuildModule(g, 'birthdays', { enabled: true, config: { channel: 'a' } });
  await setGuildModule(g, 'birthdays', { config: { channel: 'b' } });
  const { enabled, config } = await getGuildModule(g, 'birthdays');
  assert.equal(enabled, true);
  assert.deepEqual(config, { channel: 'b' });
});

test('getGuildModules: merges stored rows with registry defaults for every module', async () => {
  const g = '900000000000000202';
  await setGuildModule(g, 'polls', { enabled: true, config: { x: 1 } });
  const list = await getGuildModules(g);
  assert.equal(list.length, MODULES.length);
  const polls = list.find((m) => m.id === 'polls');
  assert.equal(polls.enabled, true);
  assert.deepEqual(polls.config, { x: 1 });
  // A module never touched for this guild still shows up with its default.
  const untouched = list.find((m) => m.id !== 'polls');
  const def = MODULES.find((m) => m.id === untouched.id);
  assert.equal(untouched.enabled, def.defaultEnabled);
});

test('getGuildModule: malformed stored config JSON degrades to {} instead of throwing', async () => {
  const { db } = await import('../src/db/index.js');
  const g = '900000000000000203';
  db.prepare(
    'INSERT INTO guild_modules (guild_id, module_id, enabled, config, updated_at) VALUES (?,?,?,?,?)'
  ).run(g, 'rss', 1, 'not json', Date.now());
  const { enabled, config } = await getGuildModule(g, 'rss');
  assert.equal(enabled, true);
  assert.deepEqual(config, {});
});
