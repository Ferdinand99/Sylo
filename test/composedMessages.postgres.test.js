// Proves the driver shim's Postgres branch for composed_messages — one of
// the 8 tables with a surrogate `id` key, so this also exercises the
// `returningId: true` / RETURNING id path for real. Real Postgres
// connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'composedMessages against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      listComposed,
      getComposed,
      getComposedByMessage,
      createComposed,
      updateComposed,
      deleteComposed,
    } = await import('../src/db/composedMessages.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const G = `pgtest-composed-${stamp}`;
    const CH = '700000000000000501';

    await t.test('createComposed returns a real id (RETURNING id); get/update round-trip', async () => {
      const rec = await createComposed(G, {
        name: 'Welcome',
        channelId: CH,
        messageId: null,
        spec: { content: 'hi', embeds: [] },
      });
      assert.ok(Number.isInteger(rec.id) && rec.id > 0);
      assert.deepEqual(rec.spec, { content: 'hi', embeds: [] });

      const fetched = await getComposed(G, rec.id);
      assert.deepEqual(fetched, rec);
      assert.equal(await getComposed(G, 999999999), null);

      const updated = await updateComposed(G, rec.id, {
        name: 'New',
        channelId: CH,
        messageId: 'posted-1',
        spec: { content: 'new', embeds: [] },
      });
      assert.equal(updated.id, rec.id);
      assert.equal(updated.name, 'New');
      assert.equal(updated.message_id, 'posted-1');

      const byMsg = await getComposedByMessage(G, 'posted-1');
      assert.equal(byMsg.id, rec.id);
    });

    await t.test('listComposed scopes to guild; deleteComposed removes a row', async () => {
      const other = `pgtest-composed-other-${stamp}`;
      await createComposed(other, { name: 'Other', channelId: CH, messageId: null, spec: {} });
      const a = await createComposed(G, { name: 'A', channelId: CH, messageId: null, spec: {} });

      const list = await listComposed(G, 50);
      assert.ok(list.some((r) => r.id === a.id));
      assert.equal((await listComposed(other, 50)).length, 1);

      assert.equal(await deleteComposed(G, a.id), true);
      assert.equal(await deleteComposed(G, a.id), false);
      assert.equal(await getComposed(G, a.id), null);
    });
  }
);
