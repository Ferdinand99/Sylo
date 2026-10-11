import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGuildConfig, importGuildConfig } from '../src/db/exportConfig.js';
import { setGuildModule, getGuildModule } from '../src/db/modules.js';
import {
  setModlogChannel,
  setBotMasterRoles,
  setEmbedColor,
  getGuildSettings,
} from '../src/db/guildSettings.js';
import { createComposed, listComposed } from '../src/db/composedMessages.js';
import { createReminder, listScheduled } from '../src/db/scheduledMessages.js';
import { setCommandOverride, getCommandOverride } from '../src/db/commandOverrides.js';

const G = '830000000000000001',
  C = '830000000000000002',
  R = '830000000000000003';
test('export/import restores modules, access roles, colors, embeds and complete reminders without duplicates', async () => {
  await setModlogChannel(G, C);
  await setBotMasterRoles(G, [R]);
  await setEmbedColor(G, 0xff0000);
  await setGuildModule(G, 'tickets', { enabled: true, config: { dmCategory: C, staffRoles: [R] } });
  await setCommandOverride(G, 'warn', { enabled: true, allowedRoles: [R], allowedChannels: [C] });
  await createComposed(G, {
    name: 'Ogłoszenie',
    channelId: C,
    messageId: null,
    spec: { content: 'tekst', embeds: [] },
  });
  await createReminder(G, {
    name: 'Przypomnienie',
    channelId: C,
    spec: { content: 'termin', embeds: [{ title: 'Ważne' }] },
    mode: 'multiple',
    days: [1, 3],
    intervalMinutes: 1440,
  });
  const backup = await exportGuildConfig(G);
  assert.equal(backup.version, 2);
  assert.deepEqual(backup.scheduledMessages[0].days, [1, 3]);
  await setGuildModule(G, 'tickets', { enabled: false, config: {} });
  await setBotMasterRoles(G, []);
  await setEmbedColor(G, 0);
  await importGuildConfig(G, backup);
  await importGuildConfig(G, backup);
  assert.equal((await getGuildModule(G, 'tickets')).config.dmCategory, C);
  const settings = await getGuildSettings(G);
  assert.equal(settings.embed_color, 0xff0000);
  assert.deepEqual(JSON.parse(settings.bot_master_roles), [R]);
  assert.deepEqual((await getCommandOverride(G, 'warn')).allowedRoles, [R]);
  assert.equal((await listComposed(G)).length, 1);
  assert.equal((await listScheduled(G)).length, 1);
  assert.equal((await listScheduled(G))[0].spec.embeds[0].title, 'Ważne');
});
test('invalid files and foreign guild backups leave current configuration unchanged', async () => {
  const backup = await exportGuildConfig(G);
  for (const bad of [
    { ...backup, guildId: C },
    { ...backup, version: 100 },
    {
      ...backup,
      modules: [{ moduleId: 'tickets', enabled: true, config: { changed: true } }],
      composedMessages: [{ spec: null }],
    },
  ])
    await assert.rejects(importGuildConfig(G, bad));
  assert.equal((await getGuildModule(G, 'tickets')).config.dmCategory, C);
  assert.equal((await listComposed(G)).length, 1);
});
test('a database write failure rolls back settings and modules rather than applying a partial restore', async () => {
  const backup = await exportGuildConfig(G);
  const override = backup.commandOverrides[0];
  backup.commandOverrides.push(override);
  backup.modules[0].config = { changed: true };
  backup.settings.embed_color = 12;
  await assert.rejects(importGuildConfig(G, backup));
  assert.equal((await getGuildModule(G, 'tickets')).config.dmCategory, C);
  assert.equal((await getGuildSettings(G)).embed_color, 0xff0000);
});
test('legacy exports restore only available fields and preserve newer settings/templates', async () => {
  const legacy = {
    sylo: 'guild-config-export',
    version: 1,
    guildId: G,
    settings: { modlog_channel_id: C },
    modules: [],
    commandOverrides: [],
    scheduledMessages: [],
  };
  await importGuildConfig(G, legacy);
  assert.equal((await getGuildSettings(G)).embed_color, 0xff0000);
  assert.equal((await listComposed(G)).length, 1);
});
