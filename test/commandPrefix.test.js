import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_PREFIX_MAX, commandPrefixError } from '../src/lib/commandPrefix.js';
import {
  getCommandPrefix,
  setCommandPrefix,
  getGuildSettings,
  clearCommandPrefixCache,
  deleteGuildSettings,
} from '../src/db/guildSettings.js';
import { db } from '../src/db/index.js';
import { runtime } from '../src/runtime.js';
import { config } from '../src/config.js';
import {
  effectiveCommandPrefix,
  guildCommandPrefix,
  interactionCommandPrefix,
} from '../src/platform/commandPrefix.js';
import { modulePlatformNote, platformInfo } from '../src/platform/modulePlatformNotes.js';

const RAW = '900000000000000090';
const KEY = `fluxer:${RAW}`;

test('a command prefix is 1 to 5 characters with no whitespace or control characters', () => {
  for (const ok of ['!', '?', '.', '>>', 'sy!', 'abcde', '@', '/', '<', '$$$$$', 'ä']) {
    assert.equal(commandPrefixError(ok), null, ok);
  }
  assert.equal(COMMAND_PREFIX_MAX, 5);
  for (const bad of [
    '',
    'abcdef',
    '! ',
    ' !',
    'a b',
    '\t',
    '!\n',
    '\u00a0',
    '\u2003x',
    '!\u0000',
    null,
    undefined,
    5,
  ]) {
    assert.ok(commandPrefixError(bad), JSON.stringify(bad));
  }
});

test('the prefix is stored with the other server settings, and read back empty when unset', async () => {
  assert.equal(await getCommandPrefix(KEY), null);
  await setCommandPrefix(KEY, '?');
  assert.equal((await getGuildSettings(KEY)).command_prefix, '?');
  assert.equal(await getCommandPrefix(KEY), '?');
  await setCommandPrefix(KEY, null);
  assert.equal((await getGuildSettings(KEY)).command_prefix, null);
  assert.equal(await getCommandPrefix(KEY), null);
  await setCommandPrefix(KEY, '');
  assert.equal((await getGuildSettings(KEY)).command_prefix, null, 'an empty string clears it');
});

test('the lookup is cached per guild: no query after the first, and a save replaces the entry', async () => {
  await setCommandPrefix(KEY, '+');
  clearCommandPrefixCache();
  assert.equal(await getCommandPrefix(KEY), '+'); // loads from the database
  // Change the row behind the cache's back: the cached value still answers.
  db.prepare('UPDATE guild_settings SET command_prefix = ? WHERE guild_id = ?').run('~', KEY);
  assert.equal(await getCommandPrefix(KEY), '+', 'served from the cache');
  // Saving through the API of the module updates the cache at once.
  await setCommandPrefix(KEY, '%');
  assert.equal(await getCommandPrefix(KEY), '%');
  // Invalidation reads the database again.
  clearCommandPrefixCache(KEY);
  assert.equal(await getCommandPrefix(KEY), '%');
  db.prepare('UPDATE guild_settings SET command_prefix = ? WHERE guild_id = ?').run('~', KEY);
  clearCommandPrefixCache(KEY);
  assert.equal(await getCommandPrefix(KEY), '~');
  await deleteGuildSettings(KEY);
  assert.equal(await getCommandPrefix(KEY), null, 'deleting the settings forgets the prefix');
});

test('effectiveCommandPrefix: the server prefix, else the default; a DM always the default', async () => {
  await setCommandPrefix(KEY, '?');
  try {
    assert.equal(await effectiveCommandPrefix(KEY), '?');
    assert.equal(await effectiveCommandPrefix(KEY, '#'), '?');
    assert.equal(await effectiveCommandPrefix('fluxer:900000000000000091'), config.commandPrefix);
    assert.equal(await effectiveCommandPrefix('fluxer:900000000000000091', '#'), '#');
    assert.equal(await effectiveCommandPrefix(null), config.commandPrefix, 'a DM has no server');
  } finally {
    await setCommandPrefix(KEY, null);
  }
});

test("guildCommandPrefix and platformInfo show a Fluxer server's prefix, and Discord stays `/`", async () => {
  const fluxerClient = {};
  runtime.clients.fluxer = fluxerClient;
  const fluxerGuild = { id: RAW, client: fluxerClient };
  const discordGuild = { id: RAW, client: {} };
  try {
    assert.equal(await guildCommandPrefix(fluxerGuild), config.commandPrefix);
    await setCommandPrefix(KEY, '?');
    assert.equal(await guildCommandPrefix(fluxerGuild), '?');
    assert.equal(await guildCommandPrefix(discordGuild), '/');

    // The key may already be the guild key (the dashboard's keyed guild): same answer.
    assert.equal(await guildCommandPrefix({ id: KEY, client: fluxerClient }), '?');

    assert.equal(platformInfo(fluxerGuild, await guildCommandPrefix(fluxerGuild)).commandPrefix, '?');
    assert.equal(platformInfo(discordGuild, '?').commandPrefix, '/');
    assert.equal(platformInfo(fluxerGuild).commandPrefix, config.commandPrefix, 'default without a prefix');
    assert.match(modulePlatformNote('fluxer', 'temp-roles', '?'), /\?temprole add/);
    assert.match(modulePlatformNote('fluxer', 'custom-commands', '?'), /as \?name/);

    // A command run from a message (Fluxer) or a slash command (Discord).
    const messageInteraction = { client: fluxerClient, guild: { id: KEY, client: fluxerClient } };
    assert.equal(await interactionCommandPrefix(messageInteraction), '?');
    assert.equal(await interactionCommandPrefix({ client: fluxerClient, guild: null }), config.commandPrefix);
    assert.equal(await interactionCommandPrefix({ client: {}, guild: discordGuild }), '/');
  } finally {
    await setCommandPrefix(KEY, null);
    runtime.clients.fluxer = null;
  }
});
