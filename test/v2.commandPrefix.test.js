// The per-server command prefix through the dashboard's settings API: Fluxer servers only, the
// same rules as COMMAND_PREFIX (checked on the server), empty = the instance default, an audit row
// for a change, and the saved prefix reaching the dashboard's platform info.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, fakeGuild } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { config } from '../src/config.js';
import { getCommandPrefix, getGuildSettings } from '../src/db/guildSettings.js';

const FKEY = `fluxer:${GID}`;
let app;
let discord;
let fluxer;
test.before(async () => {
  app = await startWebApp(); // a Discord server with the id GID
  const f = fakeGuild(); // the same id, on a Fluxer client
  f.guild.client = f.client;
  runtime.clients.fluxer = f.client;
  discord = v2Open(app, GID);
  fluxer = v2Open(app, FKEY);
});
test.after(() => {
  runtime.clients.fluxer = null;
  app.close();
});

test('a Fluxer server reads its prefix, the default and the one in use; Discord reports no Fluxer', async () => {
  const f = await (await fluxer.get('/settings')).json();
  assert.equal(f.platform, 'fluxer');
  assert.equal(f.commandPrefix, '');
  assert.equal(f.defaultCommandPrefix, config.commandPrefix);
  assert.equal(f.effectiveCommandPrefix, config.commandPrefix);
  assert.equal(f.commandPrefixMaxLength, 5);
  const d = await (await discord.get('/settings')).json();
  assert.equal(d.platform, 'discord');
  assert.equal(d.effectiveCommandPrefix, '/');
});

test('saving a prefix stores it, shows it, audits it and reaches the platform info', async () => {
  const res = await fluxer.post('/settings', { modlogChannelId: CH.bots, commandPrefix: ' ?? ' });
  assert.equal(res.status, 200);
  assert.equal(await getCommandPrefix(FKEY), '??', 'trimmed');
  assert.equal((await getGuildSettings(FKEY)).command_prefix, '??');
  const read = await (await fluxer.get('/settings')).json();
  assert.equal(read.commandPrefix, '??');
  assert.equal(read.effectiveCommandPrefix, '??');
  assert.equal((await (await fluxer.get('/platform')).json()).commandPrefix, '??');
  const audit = (await auditRows(FKEY, 'settings:server'))[0];
  assert.match(audit.detail, /command prefix set to \?\?/);

  // The same value again is not a change: a plain "saved".
  await fluxer.post('/settings', { modlogChannelId: CH.bots, commandPrefix: '??' });
  assert.equal((await auditRows(FKEY, 'settings:server'))[0].detail, 'saved');

  // Left out of the request = unchanged (an older client that does not send it).
  await fluxer.post('/settings', { modlogChannelId: CH.bots });
  assert.equal(await getCommandPrefix(FKEY), '??');

  // Empty = back to the instance default.
  await fluxer.post('/settings', { modlogChannelId: CH.bots, commandPrefix: '' });
  assert.equal(await getCommandPrefix(FKEY), null);
  assert.equal(
    (await auditRows(FKEY, 'settings:server'))[0].detail,
    `saved; command prefix reset to the default (${config.commandPrefix})`
  );
  assert.equal((await (await fluxer.get('/platform')).json()).commandPrefix, config.commandPrefix);
});

test('the server refuses a prefix that breaks the rules and changes nothing', async () => {
  await fluxer.post('/settings', { modlogChannelId: CH.bots, commandPrefix: '+' });
  for (const bad of ['abcdef', 'a b', '! ?', '\u00a0x\u00a0y', '!\u0000']) {
    const res = await fluxer.post('/settings', { modlogChannelId: CH.general, commandPrefix: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await res.json()).error, /prefix/i);
  }
  assert.equal(await getCommandPrefix(FKEY), '+');
  assert.equal((await getGuildSettings(FKEY)).modlog_channel_id, CH.bots, 'nothing else was saved either');
  await fluxer.post('/settings', { modlogChannelId: CH.bots, commandPrefix: '' });
});

test('a Discord server can not set a prefix, but saves its other settings', async () => {
  const res = await discord.post('/settings', { modlogChannelId: CH.bots, commandPrefix: '?' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Fluxer/);
  assert.equal(await getCommandPrefix(GID), null);
  assert.equal(
    (await discord.post('/settings', { modlogChannelId: CH.bots, commandPrefix: '' })).status,
    200
  );
  assert.equal(await getCommandPrefix(GID), null);
});
