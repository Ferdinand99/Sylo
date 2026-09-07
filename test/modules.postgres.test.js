// Proves the driver shim's Postgres branch for modules.js — the file with by
// far the widest blast radius in this migration (44 files, ~130+ call sites,
// including dispatch.js, the core event-fan-out gate every module runs
// through). Nothing here is architecturally novel (a single table, plain
// upsert, no transaction), so this mainly proves the basics work end to end
// against a real connection.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'modules against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { getGuildModule, getGuildModules, isModuleEnabled, setGuildModule } =
      await import('../src/db/modules.js');
    const { MODULES } = await import('../src/modules/registry.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-modules-${Date.now()}`;

    await t.test('getGuildModule falls back to the registry default when nothing is stored', async () => {
      const known = MODULES[0];
      const { enabled, config } = await getGuildModule(G, known.id);
      assert.equal(enabled, known.defaultEnabled);
      assert.deepEqual(config, {});
    });

    await t.test('setGuildModule + getGuildModule round-trip; isModuleEnabled matches', async () => {
      await setGuildModule(G, 'afk', { enabled: true, config: { message: 'brb' } });
      const { enabled, config } = await getGuildModule(G, 'afk');
      assert.equal(enabled, true);
      assert.deepEqual(config, { message: 'brb' });
      assert.equal(await isModuleEnabled(G, 'afk'), true);

      await setGuildModule(G, 'afk', { enabled: false });
      assert.equal(await isModuleEnabled(G, 'afk'), false);
      assert.deepEqual((await getGuildModule(G, 'afk')).config, { message: 'brb' });
    });

    await t.test('getGuildModules merges stored rows with registry defaults', async () => {
      await setGuildModule(G, 'polls', { enabled: true, config: { x: 1 } });
      const list = await getGuildModules(G);
      assert.equal(list.length, MODULES.length);
      const polls = list.find((m) => m.id === 'polls');
      assert.equal(polls.enabled, true);
      assert.deepEqual(polls.config, { x: 1 });
    });

    await t.test('20 concurrent setGuildModule upserts for different modules never collide', async () => {
      const g = `${G}-concurrent`;
      const ids = MODULES.slice(0, 20).map((m) => m.id);
      await Promise.all(ids.map((id) => setGuildModule(g, id, { enabled: true, config: { id } })));
      const list = await getGuildModules(g);
      for (const id of ids) {
        const row = list.find((m) => m.id === id);
        assert.equal(row.enabled, true);
        assert.deepEqual(row.config, { id });
      }
    });
  }
);
