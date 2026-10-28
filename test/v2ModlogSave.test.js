// Saving the server settings in the new dashboard: a mod-log channel that is unchanged is not
// checked again, so the other settings still save when the bot lost access to it.
import { startWebApp } from './helpers/webApp.js';
import { CH, GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { getGuildSettings, setModlogChannel } from '../src/db/guildSettings.js';

let app;
test.before(async () => {
  app = await startWebApp();
});
test.after(() => app.close());

const json = { accept: 'application/json', 'content-type': 'application/json' };

test('server settings: an unchanged mod-log channel is not checked again', async () => {
  const url = `${app.base}/api/v2/guilds/${GID}/settings`;
  const post = (body) => fetch(url, { method: 'POST', headers: json, body: JSON.stringify(body) });
  await setModlogChannel(GID, CH.bots);

  // The bot loses its permissions in the saved channel.
  const channel = app.guild.channels.cache.get(CH.bots);
  const real = channel.permissionsFor;
  channel.permissionsFor = () => new PermissionsBitField(0n);
  try {
    const same = await post({ modlogChannelId: CH.bots, embedColor: '#112233' });
    assert.equal(same.status, 200, 'other settings still save');
    assert.equal((await getGuildSettings(GID)).modlog_channel_id, CH.bots, 'the channel stays');

    // Picking a different channel the bot cannot post in is still refused.
    app.guild.channels.cache.get(CH.general).permissionsFor = () => new PermissionsBitField(0n);
    const other = await post({ modlogChannelId: CH.general, embedColor: '#112233' });
    assert.equal(other.status, 400);
    assert.equal((await getGuildSettings(GID)).modlog_channel_id, CH.bots);
  } finally {
    channel.permissionsFor = real;
    app.guild.channels.cache.get(CH.general).permissionsFor = real;
  }
});
