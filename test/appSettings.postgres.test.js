// Proves the driver shim's Postgres branch for app_settings (single-column
// TEXT primary key, no surrogate id) — same assertions as presence.test.js's
// db-facing tests, real Postgres connection underneath.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'appSettings against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { getAppSetting, setAppSetting, getPresenceConfig, setPresenceConfig } =
      await import('../src/db/appSettings.js');

    t.after(async () => {
      await closePostgres();
    });

    const key = `pgtest-key-${Date.now()}`;

    await t.test('getAppSetting/setAppSetting round-trip; unset key is null', async () => {
      assert.equal(await getAppSetting(key), null);
      await setAppSetting(key, 'first');
      assert.equal(await getAppSetting(key), 'first');
      // upsert — same key, new value
      await setAppSetting(key, 'second');
      assert.equal(await getAppSetting(key), 'second');
    });

    await t.test('presence config round-trips and sanitises', async () => {
      await setPresenceConfig({ status: 'dnd', type: 'Watching', text: 'over {servers} servers' });
      const p = await getPresenceConfig();
      assert.equal(p.status, 'dnd');
      assert.equal(p.type, 'Watching');
      assert.equal(p.text, 'over {servers} servers');

      const bad = await setPresenceConfig({ status: 'nonsense', type: 'nope', text: 'x'.repeat(300) });
      assert.equal(bad.status, 'online');
      assert.equal(bad.type, 'Custom');
      assert.equal(bad.text.length, 128);
    });
  }
);
