// Proves the driver shim's Postgres branch for guild_settings — a table
// whose bootstrap DDL had to account for 3 separate ALTER TABLE migrations
// on top of the original CREATE TABLE. Real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'guildSettings against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      DEFAULT_EMBED_COLOR,
      getGuildSettings,
      setModlogChannel,
      getBotMasterRoles,
      setBotMasterRoles,
      setEmbedColor,
      guildEmbedColor,
      deleteGuildSettings,
    } = await import('../src/db/guildSettings.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-settings-${Date.now()}`;

    await t.test(
      'getGuildSettings undefined before any write; setModlogChannel creates the row',
      async () => {
        assert.equal(await getGuildSettings(G), undefined);
        await setModlogChannel(G, '111111111111111111');
        const s = await getGuildSettings(G);
        assert.equal(s.modlog_channel_id, '111111111111111111');
      }
    );

    await t.test('bot master roles: round-trips, dedupes, rejects bad ids', async () => {
      const clean = await setBotMasterRoles(G, [
        '222222222222222222',
        '222222222222222222',
        'not-an-id',
        '333333333333333333',
      ]);
      assert.deepEqual(clean, ['222222222222222222', '333333333333333333']);
      assert.deepEqual(await getBotMasterRoles(G), ['222222222222222222', '333333333333333333']);
    });

    await t.test('embed colour: defaults, round-trips, null clears it', async () => {
      await setEmbedColor(G, 0xff00ff);
      assert.equal(await guildEmbedColor(G), 0xff00ff);
      await setEmbedColor(G, null);
      assert.equal(await guildEmbedColor(G), DEFAULT_EMBED_COLOR);
    });

    await t.test('deleteGuildSettings removes the row', async () => {
      await deleteGuildSettings(G);
      assert.equal(await getGuildSettings(G), undefined);
    });
  }
);
