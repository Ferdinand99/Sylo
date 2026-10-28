// The server settings of the new dashboard save a mod-log channel only if the bot can post embeds in it,
// like the classic settings page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { D_GUILD, startOAuthApp } from './helpers/oauthApp.js';
import { adminApi } from './helpers/v2Admin.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { getGuildSettings } = await import('../src/db/guildSettings.js');

// --- mod-log channel ----------------------------------------------------------

test('the mod-log channel must be one the bot can post embeds in', async () => {
  const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
  const channel = (id, allowed) => ({
    id,
    name: `chan-${id.slice(-2)}`,
    type: ChannelType.GuildText,
    rawPosition: 0,
    permissionsFor: () => ({ has: () => allowed }),
  });
  guild.channels.cache.set('400000000000000001', channel('400000000000000001', false));
  guild.channels.cache.set('400000000000000002', channel('400000000000000002', true));

  const { api } = await adminApi();
  let res = await api('/settings', { modlogChannelId: '400000000000000001' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /View Channel, Send Messages and Embed Links/);
  assert.notEqual((await getGuildSettings(D_GUILD))?.modlog_channel_id, '400000000000000001');

  res = await api('/settings', { modlogChannelId: '400000000000000002' });
  assert.equal(res.status, 200);
  assert.equal((await getGuildSettings(D_GUILD)).modlog_channel_id, '400000000000000002');
});
