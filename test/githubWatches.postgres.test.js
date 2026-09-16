// Proves the driver shim's Postgres branch for github_watches (SERIAL id +
// a UNIQUE index on token + JSON-encoded events column) — same shape as
// githubWatches.test.js, real Postgres connection underneath.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'github_watches against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      createGithubWatch,
      getGithubWatch,
      getGithubWatchByToken,
      updateGithubWatch,
      deleteGithubWatch,
      listGithubWatches,
      clearGuildGithubWatches,
    } = await import('../src/db/githubWatches.js');

    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-gh-${Date.now()}`;
    const CH = '100000000000000001';

    await t.test('create, token lookup, update, list, delete', async () => {
      const id = await createGithubWatch(G, {
        repo: 'o/r',
        channelId: CH,
        roleId: '700000000000000099',
        changelogPath: 'CHANGELOG.md',
        events: ['push', 'release'],
      });
      const row = await getGithubWatch(G, id);
      assert.equal(row.repo, 'o/r');
      assert.deepEqual(row.events, ['push', 'release']);
      assert.equal(row.role_id, '700000000000000099');
      assert.equal(row.changelog_path, 'CHANGELOG.md');
      assert.match(row.token, /^[\w-]{20,}$/);

      const byToken = await getGithubWatchByToken(row.token);
      assert.equal(byToken.id, row.id);

      await updateGithubWatch(G, id, {
        channelId: '100000000000000002',
        roleId: '',
        changelogPath: '',
        events: ['star'],
      });
      const updated = await getGithubWatch(G, id);
      assert.deepEqual(updated.events, ['star']);
      assert.equal(updated.role_id, null); // cleared
      assert.equal(updated.changelog_path, null); // cleared

      assert.equal((await listGithubWatches(G)).length, 1);
      await deleteGithubWatch(G, id);
      assert.equal(await getGithubWatch(G, id), null);

      await clearGuildGithubWatches(G);
      assert.equal((await listGithubWatches(G)).length, 0);
    });
  }
);
