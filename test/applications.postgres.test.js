// Proves the driver shim's Postgres branch for Applications: the tables are created by the bootstrap, BIGINT
// values come back as numbers, the partial unique index allows one pending submission per form and member
// (and the error is recognised), a decision can be claimed only once even from two callers at the same
// moment, the cooldown upserts, and the filters, retention helpers, /forget, the export and the guild
// purge run against the tables.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;

test(
  'applications against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const apps = await import('../src/db/applications.js');
    const purge = await import('../src/db/purge.js');
    t.after(async () => {
      await closePostgres();
    });

    const G = `pgtest-apps-${Date.now()}`;
    const H = `${G}-other`;
    const U = 'user-1';
    const V = 'user-2';
    const config = { name: 'Staff', questions: [] };
    const sub = (over = {}) =>
      apps.insertSubmission({
        guildId: G,
        formId: 1,
        formName: 'Staff',
        userId: U,
        source: 'web',
        questions: [{ id: 'q', label: 'Why?' }],
        answers: { q: 'because' },
        ...over,
      });
    let formId;

    await t.test(
      'a form round-trips, numbers are numbers, and every save moves the version forward',
      async () => {
        formId = await apps.insertForm({
          guildId: G,
          name: 'Staff',
          enabled: true,
          fillMode: 'both',
          config,
        });
        assert.equal(typeof formId, 'number');
        const form = await apps.getForm(G, formId);
        assert.deepEqual(
          [form.name, form.enabled, form.fillMode, form.sortOrder],
          ['Staff', true, 'both', 0]
        );
        assert.equal(typeof form.createdAt, 'number');
        assert.equal(typeof form.updatedAt, 'number');
        await apps.updateForm(G, formId, { name: 'Staff 2', enabled: false, fillMode: 'web', config });
        await apps.updateForm(G, formId, { name: 'Staff 3', enabled: false, fillMode: 'web', config });
        const after = await apps.getForm(G, formId);
        assert.ok(after.updatedAt >= form.updatedAt + 2, 'two saves in one millisecond still differ');
        assert.equal(after.fillMode, 'web');
        assert.equal(await apps.formCount(G), 1);
        assert.equal(typeof (await apps.formCount(G)), 'number');
        const second = await apps.insertForm({
          guildId: G,
          name: 'B',
          enabled: true,
          fillMode: 'both',
          config,
        });
        await apps.reorderForms(G, [second, formId]);
        assert.deepEqual(
          (await apps.listForms(G)).map((f) => f.id),
          [second, formId]
        );
      }
    );

    await t.test(
      'one pending submission per form and member: the second is refused and the error is recognised',
      async () => {
        const id = await sub();
        assert.equal(typeof id, 'number');
        await assert.rejects(sub(), (err) => apps.isUniqueViolation(err));
        assert.ok(await sub({ userId: V }), 'another member');
        assert.ok(await sub({ formId: 2 }), 'another form');
        const row = await apps.getSubmission(G, id);
        assert.deepEqual(
          [row.status, row.source, row.answers, row.questions.length, row.history[0].action],
          ['pending', 'web', { q: 'because' }, 1, 'submitted']
        );
        assert.equal(typeof row.createdAt, 'number');
        assert.equal((await apps.pendingSubmission(G, 1, U)).id, id);
        assert.equal((await apps.pendingOfUser(G, U)).length, 2);
        assert.equal(await apps.pendingCount(G), 3);
        assert.equal(typeof (await apps.pendingCount(G)), 'number');
      }
    );

    await t.test('a decision is claimed once, even by two callers at the same moment', async () => {
      const id = (await apps.pendingSubmission(G, 1, U)).id;
      const claims = await Promise.all(
        ['accepted', 'denied', 'accepted'].map((status, i) =>
          apps.claimDecision(G, id, {
            status,
            by: `staff-${i}`,
            reason: 'r',
            history: [{ at: 1, action: status }],
          })
        )
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const row = await apps.getSubmission(G, id);
      assert.ok(['accepted', 'denied'].includes(row.status));
      assert.equal(typeof row.decidedAt, 'number');
      // and the member may apply again now
      assert.ok(await sub());
    });

    await t.test('the post, the copy, the roles waiting and the notes are stored', async () => {
      const id = (await apps.pendingSubmission(G, 1, V)).id;
      await apps.setSubmissionPost(G, id, 'c1', 'm1');
      await apps.setSubmissionCopy(G, id, 'c2', 'm2');
      await apps.setSubmissionThread(G, id, 't1');
      await apps.setSubmissionRoles(
        G,
        id,
        [{ op: 'add', roleId: 'r1' }],
        [{ at: 1, action: 'roles_failed' }]
      );
      await apps.setSubmissionDmNote(G, id, 'completed');
      const row = await apps.getSubmission(G, id);
      assert.deepEqual(
        [row.channelId, row.messageId, row.copyChannelId, row.copyMessageId, row.threadId],
        ['c1', 'm1', 'c2', 'm2', 't1']
      );
      assert.deepEqual(row.rolesPending, [{ op: 'add', roleId: 'r1' }]);
      assert.equal(row.dmNote, 'completed');
      assert.equal((await apps.submissionByMessage(G, 'm2')).id, id, 'found by the copy too');
      assert.equal(await apps.submissionByMessage(H, 'm1'), null);
    });

    await t.test('the list filters by form, status and member, and counts are numbers', async () => {
      const all = await apps.listSubmissions({ guildId: G });
      assert.equal(typeof all.total, 'number');
      assert.ok(all.total >= 4);
      const forForm = await apps.listSubmissions({ guildId: G, formId: 2 });
      assert.ok(forForm.rows.every((r) => r.formId === 2));
      const byUser = await apps.listSubmissions({ guildId: G, userId: V });
      assert.ok(byUser.rows.every((r) => r.userId === V));
      const pending = await apps.listSubmissions({ guildId: G, status: 'pending' });
      assert.ok(pending.rows.every((r) => r.status === 'pending'));
      const page = await apps.listSubmissions({ guildId: G, limit: 2, offset: 1 });
      assert.equal(page.rows.length, 2);
      assert.equal(page.total, all.total);
      assert.ok((await apps.exportSubmissions({ guildId: G, formId: 1 })).length >= 3);
    });

    await t.test(
      'the cooldown upserts, and the sweep helpers find old decided submissions and expired cooldowns',
      async () => {
        await apps.setCooldownUntil(G, 1, U, 1000);
        await apps.setCooldownUntil(G, 1, U, 5000);
        assert.equal(await apps.getCooldownUntil(G, 1, U), 5000);
        assert.equal(typeof (await apps.getCooldownUntil(G, 1, U)), 'number');
        assert.equal(await apps.getCooldownUntil(G, 1, 'nobody'), 0);
        assert.equal(await apps.pruneCooldowns(6000), 1);
        assert.equal(await apps.getCooldownUntil(G, 1, U), 0);

        assert.ok((await apps.guildsWithDecidedBefore(Date.now() + 1000)).includes(G));
        assert.deepEqual(await apps.guildsWithDecidedBefore(1), []);
        const old = await apps.decidedBeforeInGuild(G, Date.now() + 1000, 10);
        assert.ok(old.length >= 1 && old.every((r) => r.status !== 'pending'));
        await apps.clearSubmissionAnswers(G, old[0].id);
        assert.deepEqual(
          (await apps.clearedSubmissions(500)).filter((r) => r.guildId === G).map((r) => r.id),
          [old[0].id]
        );
        assert.deepEqual((await apps.getSubmission(G, old[0].id)).answers, {});
        assert.equal(await apps.deleteSubmission(G, old[0].id), 1);
      }
    );

    await t.test('/forget, the export and the guild purge work on the tables', async () => {
      await sub({ guildId: H, userId: U });
      await apps.setCooldownUntil(G, 1, V, Date.now() + 100000);
      const exported = await purge.exportUserData(G, V);
      assert.ok(exported.data.applications.length >= 1);
      assert.equal(exported.data.applicationsCooldowns.length, 1);
      const summary = await purge.describeUserData(G, V);
      assert.ok(summary.items.find((i) => i.key === 'applications').count >= 1);
      const keep = (await apps.pendingOfUser(G, V))[0];
      const result = await purge.forgetUser(G, V, { keepApplicationIds: [keep.id] });
      assert.equal(typeof result.applications, 'number');
      const kept = await apps.getSubmission(G, keep.id);
      assert.deepEqual([kept.answers, kept.questions, kept.cleared], [{}, [], true]);
      assert.equal((await apps.getCooldownUntil(G, 1, V)) > 0, true, 'the cooldown stays');
      assert.equal((await purge.forgetUser(G, V)).applications, 1, 'the next time the kept row goes');
      await purge.purgeGuild(G);
      assert.deepEqual(await apps.listForms(G), []);
      assert.equal((await apps.listSubmissions({ guildId: G })).total, 0);
      assert.equal((await apps.listSubmissions({ guildId: H })).total, 1, 'another server is untouched');
      assert.equal(await apps.getCooldownUntil(G, 1, V), 0);
      await purge.purgeGuild(H);
    });
  }
);
