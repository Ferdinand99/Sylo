// Proves exportConfig.js against a real Postgres connection. The file owns no
// table of its own — it only reads tables bootstrapped by their owning files
// (guild_settings, guild_modules, command_overrides, scheduled_messages,
// counting), so this mainly proves the cross-file read composition works.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'exportGuildConfig against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { exportGuildConfig } = await import('../src/db/exportConfig.js');
    const { setGuildModule } = await import('../src/db/modules.js');
    const { setModlogChannel } = await import('../src/db/guildSettings.js');
    const { createReminder } = await import('../src/db/scheduledMessages.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-exportconfig-${Date.now()}`;

    await t.test('captures settings, modules and scheduled messages, excludes member data', async () => {
      await setModlogChannel(G, '123456789012345678');
      await setGuildModule(G, 'counting', { enabled: true, config: { channelId: '5', resetOnFail: true } });
      await createReminder(G, {
        name: 'daily',
        channelId: '999999999999999999',
        spec: { content: 'daily', embeds: [] },
        mode: 'multiple',
        intervalMinutes: 1440,
        days: [0, 1, 2, 3, 4, 5, 6],
      });

      const dump = await exportGuildConfig(G);

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

    await t.test('an untouched guild returns null settings/counting and empty lists', async () => {
      const dump = await exportGuildConfig(`${G}-empty`);
      assert.equal(dump.settings, null);
      assert.equal(dump.counting, null);
      assert.deepEqual(dump.modules, []);
      assert.deepEqual(dump.commandOverrides, []);
      assert.deepEqual(dump.scheduledMessages, []);
    });
  }
);
