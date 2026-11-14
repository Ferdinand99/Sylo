// The change history against a real Postgres connection: the two new columns (change_json, reverts_id), the
// has_change flag in a list, the LIKE on the saved copy that /forget and /mydata use (a parameter inside a
// concatenation), a module save kept as the change of the entry written for it, and the 500-entry cap.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres, prepare } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'change history against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const { recordAudit, getAuditEntry, listAuditPage, scrubMemberFromHistory } =
      await import('../src/db/audit.js');
    const { runWithCapture } = await import('../src/db/auditCapture.js');
    const { setGuildModule } = await import('../src/db/modules.js');
    const { describeUserData, exportUserData, forgetUser, purgeGuild } = await import('../src/db/purge.js');

    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const G = `pgtest-history-${stamp}`;
    const MEMBER = '810000000000000123';
    const count = async (sql, ...args) => Number((await prepare(sql).get(...args)).n);

    await t.test('an entry keeps what changed; a list shows only that it did', async () => {
      await recordAudit(G, {
        actor: 'Ann',
        action: 'settings:server',
        detail: 'saved',
        change: { before: { modlogChannelId: '1', x: 1 }, after: { modlogChannelId: '2', x: 1 } },
      });
      await recordAudit(G, { actor: 'Ann', action: 'module:polls', detail: 'enabled', revertsId: 3 });
      const { rows } = await listAuditPage(G, { limit: 10 });
      const [plain, saved] = rows;
      assert.equal(Number(plain.has_change), 0);
      assert.equal(Number(plain.reverts_id), 3);
      assert.equal(Number(saved.has_change), 1);
      assert.ok(!('change_json' in saved));
      assert.deepEqual((await getAuditEntry(G, saved.id)).change, {
        before: { modlogChannelId: '1' },
        after: { modlogChannelId: '2' },
      });
      assert.equal(await getAuditEntry(`${G}-other`, saved.id), null, 'never another server');
    });

    await t.test(
      'a module save inside a request is kept as the entry written for it, secrets masked',
      async () => {
        await setGuildModule(G, 'rss', {
          config: { feeds: [{ id: 'a', url: 'https://e.com/f?token=old' }] },
        });
        await runWithCapture(async () => {
          await setGuildModule(G, 'rss', {
            config: { feeds: [{ id: 'a', url: 'https://e.com/f?token=new' }, { id: 'b' }] },
          });
          await recordAudit(G, { actor: 'Ann', action: 'module:rss', detail: 'settings saved' });
        });
        const row = (await listAuditPage(G, { limit: 1 })).rows[0];
        const entry = await getAuditEntry(G, row.id);
        assert.doesNotMatch(JSON.stringify(entry.change), /token=old|token=new/);
        assert.equal(entry.change.after.feeds.length, 2);
      }
    );

    await t.test('forget and export find a member in the saved copies and take the id out', async () => {
      await recordAudit(G, {
        actor: 'Ann',
        action: 'module:auto-react',
        detail: 'settings saved',
        change: {
          before: { rules: [{ targetUsers: [MEMBER, '810000000000000999'] }] },
          after: { rules: [{ targetUsers: ['810000000000000999'] }] },
        },
      });
      assert.equal((await describeUserData(G, MEMBER)).items.find((i) => i.key === 'configHistory').count, 1);
      assert.equal((await exportUserData(G, MEMBER)).data.configHistory.length, 1);
      assert.equal((await forgetUser(G, MEMBER)).configHistory, 1);
      assert.equal((await describeUserData(G, MEMBER)).items.find((i) => i.key === 'configHistory').count, 0);
      assert.equal(await scrubMemberFromHistory(G, MEMBER), 0);
    });

    await t.test('the history is capped at 500 entries a server, and a purge removes it', async () => {
      const P = `pgtest-history-cap-${stamp}`;
      for (let i = 0; i < 520; i += 1) {
        await recordAudit(P, {
          actor: 'x',
          action: 'module:afk',
          detail: String(i),
          change: { before: { n: i }, after: { n: i + 1 } },
        });
      }
      assert.equal(await count('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?', P), 500);
      assert.equal(
        await count(
          'SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ? AND change_json IS NOT NULL',
          P
        ),
        500
      );
      await purgeGuild(P);
      assert.equal(await count('SELECT COUNT(*) AS n FROM config_audit WHERE guild_id = ?', P), 0);
    });
  }
);
