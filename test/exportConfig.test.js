import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setGuildModule } from '../src/db/modules.js';
import { setModlogChannel } from '../src/db/guildSettings.js';
import { createReminder } from '../src/db/scheduledMessages.js';
import { exportGuildConfig } from '../src/db/exportConfig.js';

const G = '800000000000000001';

test('exportGuildConfig captures settings, modules and scheduled messages, excludes member data', () => {
  setModlogChannel(G, '123456789012345678');
  setGuildModule(G, 'counting', { enabled: true, config: { channelId: '5', resetOnFail: true } });
  createReminder(G, {
    name: 'daily',
    channelId: '999999999999999999',
    spec: { content: 'daily', embeds: [] },
    mode: 'multiple',
    intervalMinutes: 1440,
    days: [0, 1, 2, 3, 4, 5, 6],
  });

  const dump = exportGuildConfig(G);

  assert.equal(dump.sylo, 'guild-config-export');
  assert.equal(dump.guildId, G);
  assert.equal(dump.settings.modlog_channel_id, '123456789012345678');

  const counting = dump.modules.find((m) => m.moduleId === 'counting');
  assert.ok(counting?.enabled);
  assert.equal(counting.config.channelId, '5');

  assert.equal(dump.scheduledMessages.length, 1);
  assert.equal(dump.scheduledMessages[0].intervalMinutes, 1440);

  assert.ok(!('warnings' in dump) && !('leveling' in dump), 'no member data in the export');
});
