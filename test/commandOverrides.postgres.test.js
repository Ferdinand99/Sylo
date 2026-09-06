// Proves the driver shim's Postgres branch for command_overrides (composite
// natural PK + ON CONFLICT upsert) — same assertions as
// commandOverrides.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'commandOverrides against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { getCommandOverrides, getCommandOverride, setCommandOverride } =
      await import('../src/db/commandOverrides.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-overrides-${Date.now()}`;

    await t.test('getCommandOverride null with no override; setCommandOverride creates one', async () => {
      assert.equal(await getCommandOverride(G, 'ping'), null);
      await setCommandOverride(G, 'ping', { enabled: false, allowedChannels: ['1'], allowedRoles: ['2'] });
      const ov = await getCommandOverride(G, 'ping');
      assert.equal(ov.enabled, false);
      assert.deepEqual(ov.allowedChannels, ['1']);
    });

    await t.test('upsert keeps unspecified fields; getCommandOverrides returns a scoped Map', async () => {
      await setCommandOverride(G, 'rank', { enabled: true, allowedChannels: ['1'], allowedRoles: [] });
      await setCommandOverride(G, 'rank', { allowedRoles: ['9'] });
      const ov = await getCommandOverride(G, 'rank');
      assert.equal(ov.enabled, true);
      assert.deepEqual(ov.allowedRoles, ['9']);

      const map = await getCommandOverrides(G);
      assert.equal(map.size, 2);
      assert.equal(map.get('ping').enabled, false);
    });
  }
);
