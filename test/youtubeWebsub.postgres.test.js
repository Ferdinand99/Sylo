// The youtube_websub table and its statements against a real Postgres connection: the upsert that
// keeps the secret, the nullable BIGINT lease, and the due query.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'youtubeWebsub against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const {
      getWebsub,
      allWebsub,
      wantWebsub,
      unwantWebsub,
      setWebsubLease,
      touchWebsubNotified,
      deleteWebsub,
      websubDueBefore,
    } = await import('../src/db/youtubeWebsub.js');
    const { listEnabledModuleConfigs, setGuildModule } = await import('../src/db/modules.js');

    t.after(async () => {
      await closePostgres();
    });

    // The database may be persistent: every assertion is about ids this run made.
    const stamp = String(Date.now()).padStart(22, 'p');
    const A = `UC${stamp}`;
    const B = `UD${stamp}`;
    const C = `UE${stamp}`;

    await t.test('want inserts a pending row; wanting again keeps secret and lease', async () => {
      await wantWebsub(A, 'secret-1');
      let row = await getWebsub(A);
      assert.equal(row.secret, 'secret-1');
      assert.equal(row.wanted, 1);
      assert.equal(row.lease_expires_at, null);
      assert.equal(row.last_notified_at, null);

      await setWebsubLease(A, 1_800_000_000_000);
      await wantWebsub(A, 'secret-2'); // a renewal never swaps the secret
      row = await getWebsub(A);
      assert.equal(row.secret, 'secret-1');
      assert.equal(row.lease_expires_at, 1_800_000_000_000); // BIGINT comes back as a number
      assert.equal(typeof row.lease_expires_at, 'number');
    });

    await t.test('touch, unwant and delete', async () => {
      await touchWebsubNotified(A, 1_800_000_000_123);
      assert.equal((await getWebsub(A)).last_notified_at, 1_800_000_000_123);
      await unwantWebsub(A);
      assert.equal((await getWebsub(A)).wanted, 0);
      assert.ok((await allWebsub()).some((r) => r.channel_id === A));
      await deleteWebsub(A);
      assert.equal(await getWebsub(A), null);
    });

    await t.test('websubDueBefore: wanted rows that are unverified or end before the cutoff', async () => {
      const cutoff = 2_000_000_000_000;
      await wantWebsub(A, 's'); // unverified
      await wantWebsub(B, 's');
      await setWebsubLease(B, cutoff - 1); // due
      await wantWebsub(C, 's');
      await setWebsubLease(C, cutoff + 1); // not yet
      const ids = (await websubDueBefore(cutoff)).map((r) => r.channel_id);
      assert.ok(ids.includes(A));
      assert.ok(ids.includes(B));
      assert.ok(!ids.includes(C));

      await unwantWebsub(B);
      assert.ok(!(await websubDueBefore(cutoff)).some((r) => r.channel_id === B));
      for (const id of [A, B, C]) await deleteWebsub(id);
    });

    await t.test('listEnabledModuleConfigs lists enabled guilds with their parsed config', async () => {
      const guild = `pgtest-websub-${Date.now()}`;
      await setGuildModule(guild, 'youtube-alerts', {
        enabled: true,
        config: { alerts: [{ ytChannelId: A }] },
      });
      const mine = (await listEnabledModuleConfigs('youtube-alerts')).find((r) => r.guildId === guild);
      assert.deepEqual(mine.config, { alerts: [{ ytChannelId: A }] });
      await setGuildModule(guild, 'youtube-alerts', { enabled: false });
      assert.ok(!(await listEnabledModuleConfigs('youtube-alerts')).some((r) => r.guildId === guild));
    });
  }
);
