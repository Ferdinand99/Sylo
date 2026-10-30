// The Postal Pigeon storage against a real Postgres connection: the handle columns and the
// push_events table that go with an app token (src/db/apiTokens.js, src/db/pushEvents.js).
// Skipped without DATABASE_URL (a sqlite-only run); test/pushEvents.test.js and
// test/pushDb.test.js cover the same behaviour on SQLite.
import './helpers/isolateSqlite.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { closePostgres } from '../src/db/driver.js';

const url = process.env.DATABASE_URL;
const HOUR = 60 * 60 * 1000;

test(
  'push events and Pigeon handles against a real Postgres connection',
  { skip: !url && 'DATABASE_URL not set (sqlite-only run)' },
  async (t) => {
    const tokens = await import('../src/db/apiTokens.js');
    const events = await import('../src/db/pushEvents.js');
    t.after(async () => {
      await closePostgres();
    });

    const stamp = Date.now();
    const handle = (c) => `hrh_${c.repeat(40)}`;
    const make = async (name) => {
      const accountId = `pg-events-${stamp}-${name}`;
      const { id } = await tokens.createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 24 * HOUR });
      return { id, accountId };
    };
    const content = {
      title: 'T',
      body: 'b',
      threadId: 'g:1',
      kind: 'ticket',
      data: { kind: 'ticket', guildId: 'g' },
    };

    await t.test('a handle is stored, proven once, and moves to the newest token', async () => {
      const first = await make('first');
      const second = await make('second');
      const h = handle('p') + stamp;
      await tokens.setApiTokenPush(first.id, {
        pigeonHandle: h,
        environment: 'production',
        origin: 'https://s.example',
      });
      let push = await tokens.apiTokenPush(first.id);
      assert.equal(push.enabled, true);
      assert.equal(push.pigeonHandle, h);
      assert.equal(push.pigeonProvenAt, null);

      await tokens.markApiTokenPigeonProven(first.id, h, 5555);
      await tokens.markApiTokenPigeonProven(first.id, h, 9999);
      push = await tokens.apiTokenPush(first.id);
      assert.equal(push.pigeonProvenAt, 5555);
      assert.equal(typeof push.pigeonProvenAt, 'number', 'a BIGINT comes back as a number');

      // Registering it again keeps the mark; another token taking it clears the first.
      await tokens.setApiTokenPush(first.id, {
        pigeonHandle: h,
        environment: 'production',
        origin: 'https://s.example',
      });
      assert.equal((await tokens.apiTokenPush(first.id)).pigeonProvenAt, 5555);
      await tokens.setApiTokenPush(second.id, {
        pigeonHandle: h,
        environment: 'production',
        origin: 'https://s.example',
      });
      assert.equal((await tokens.apiTokenPush(first.id)).enabled, false);
      assert.equal((await tokens.apiTokenPush(second.id)).pigeonProvenAt, null);

      const listed = (await tokens.pushRecipientTokens()).find((r) => r.id === second.id);
      assert.equal(listed.pigeonHandle, h);

      await tokens.clearApiTokenPush(second.id, { pigeonHandle: 'hrh_other' });
      assert.equal((await tokens.apiTokenPush(second.id)).pigeonHandle, h);
      await tokens.clearApiTokenPush(second.id, { pigeonHandle: h });
      assert.equal((await tokens.apiTokenPush(second.id)).enabled, false);
    });

    await t.test('content is found by its own token, expires, and goes with the token', async () => {
      const mine = await make('mine');
      const theirs = await make('theirs');
      const ref = `pgref${stamp}`.padEnd(22, 'x');
      const made = Date.now();
      await events.createPushEvent({ ref, tokenId: mine.id, payload: content, now: made });
      assert.deepEqual(await events.findPushEvent(ref, mine.id, made), content);
      assert.equal(await events.findPushEvent(ref, theirs.id, made), null);
      assert.equal(await events.findPushEvent(ref, mine.id, made + 2 * HOUR), null, 'expired');
      await assert.rejects(() => events.createPushEvent({ ref, tokenId: mine.id, payload: content }));
      await assert.rejects(() =>
        events.createPushEvent({ ref: `${ref}z`, tokenId: 'no-such-token', payload: content })
      );

      await events.deletePushEvent(ref);
      assert.equal(await events.findPushEvent(ref, mine.id, made), null);

      const other = `pgref2${stamp}`.padEnd(22, 'x');
      await events.createPushEvent({ ref: other, tokenId: mine.id, payload: content, now: made });
      await tokens.revokeApiToken(mine.accountId, mine.id);
      assert.equal(await events.findPushEvent(other, mine.id, made), null, 'cascaded with the token');
    });

    await t.test('purge removes only the expired', async () => {
      const { id } = await make('purge');
      const [old, fresh] = [`pgold${stamp}`.padEnd(22, 'x'), `pgnew${stamp}`.padEnd(22, 'x')];
      const now = Date.now();
      await events.createPushEvent({ ref: old, tokenId: id, payload: content, now: now - 3 * HOUR });
      await events.createPushEvent({ ref: fresh, tokenId: id, payload: content, now });
      assert.ok((await events.purgeExpiredPushEvents(now)) >= 1);
      assert.deepEqual(await events.findPushEvent(fresh, id, now), content);
      assert.equal(await events.purgeExpiredPushEvents(now), 0);
    });
  }
);
