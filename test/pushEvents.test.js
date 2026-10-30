// The content behind a Postal Pigeon notification (src/db/pushEvents.js): kept per recipient
// under a random reference, found only by that recipient's app token, gone after two hours and
// when the token goes.
import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiToken, revokeApiToken, revokeAccountTokens } from '../src/db/apiTokens.js';
import { db } from '../src/db/index.js';
import {
  PUSH_EVENT_TTL_MS,
  createPushEvent,
  deletePushEvent,
  deletePushEventsOf,
  findPushEvent,
  purgeExpiredPushEvents,
} from '../src/db/pushEvents.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
let n = 0;

async function token() {
  const accountId = `events-acct-${++n}`;
  const { id } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: DAY });
  return { id, accountId };
}

const ref = () => `ref${String(++n).padStart(19, 'x')}`;
const payload = (text = 'hello') => ({
  title: 'Server',
  body: `member: ${text}`,
  threadId: 'g:1',
  kind: 'ticket',
  data: { kind: 'ticket', guildId: 'g', ticketId: 1 },
});

test('a reference gives back its content to the token it was made for, and to nobody else', async () => {
  const mine = await token();
  const theirs = await token();
  const r = ref();
  await createPushEvent({ ref: r, tokenId: mine.id, payload: payload() });
  assert.deepEqual(await findPushEvent(r, mine.id), payload());
  assert.equal(await findPushEvent(r, theirs.id), null, "someone else's");
  assert.equal(await findPushEvent(ref(), mine.id), null, 'unknown');
});

test('it expires after two hours', async () => {
  assert.equal(PUSH_EVENT_TTL_MS, 2 * HOUR);
  const { id } = await token();
  const r = ref();
  const made = 1_000_000_000_000;
  await createPushEvent({ ref: r, tokenId: id, payload: payload(), now: made });
  assert.ok(await findPushEvent(r, id, made + 2 * HOUR - 1));
  assert.equal(await findPushEvent(r, id, made + 2 * HOUR), null);
  assert.equal(await findPushEvent(r, id, made + 3 * HOUR), null);
});

test('a reference is unique', async () => {
  const { id } = await token();
  const r = ref();
  await createPushEvent({ ref: r, tokenId: id, payload: payload('one') });
  await assert.rejects(() => createPushEvent({ ref: r, tokenId: id, payload: payload('two') }));
  assert.deepEqual(await findPushEvent(r, id), payload('one'));
});

test('a reference for a token that does not exist is refused', async () => {
  await assert.rejects(() => createPushEvent({ ref: ref(), tokenId: 'no-such-token', payload: payload() }));
});

test('deleting one, or all of a token, leaves the rest', async () => {
  const a = await token();
  const b = await token();
  const [a1, a2, b1] = [ref(), ref(), ref()];
  await createPushEvent({ ref: a1, tokenId: a.id, payload: payload() });
  await createPushEvent({ ref: a2, tokenId: a.id, payload: payload() });
  await createPushEvent({ ref: b1, tokenId: b.id, payload: payload() });
  await deletePushEvent(a1);
  assert.equal(await findPushEvent(a1, a.id), null);
  assert.ok(await findPushEvent(a2, a.id));
  await deletePushEventsOf(a.id);
  assert.equal(await findPushEvent(a2, a.id), null);
  assert.ok(await findPushEvent(b1, b.id));
});

test('purge deletes the expired and keeps the rest', async () => {
  const { id } = await token();
  const [old, fresh] = [ref(), ref()];
  const now = Date.now();
  await createPushEvent({ ref: old, tokenId: id, payload: payload(), now: now - 3 * HOUR });
  await createPushEvent({ ref: fresh, tokenId: id, payload: payload(), now });
  assert.ok((await purgeExpiredPushEvents(now)) >= 1);
  assert.equal(await findPushEvent(old, id, now - 3 * HOUR + 1), null, 'gone from the table');
  assert.ok(await findPushEvent(fresh, id, now));
  assert.equal(await purgeExpiredPushEvents(now), 0);
});

test('the content goes when its token is deleted, however that happens', async () => {
  const signedOut = await token();
  const wholeAccount = await token();
  const expired = await token();
  const kept = await token();
  const refs = new Map();
  for (const t of [signedOut, wholeAccount, expired, kept]) {
    const r = ref();
    refs.set(t.id, r);
    await createPushEvent({ ref: r, tokenId: t.id, payload: payload() });
  }
  await revokeApiToken(signedOut.accountId, signedOut.id);
  await revokeAccountTokens(wholeAccount.accountId);
  db.prepare('DELETE FROM api_tokens WHERE id = ?').run(expired.id);

  const left = (r) => db.prepare('SELECT 1 FROM push_events WHERE ref = ?').get(r);
  assert.equal(left(refs.get(signedOut.id)), undefined);
  assert.equal(left(refs.get(wholeAccount.id)), undefined);
  assert.equal(left(refs.get(expired.id)), undefined);
  assert.ok(left(refs.get(kept.id)));
});

test('a database from before this change gets the columns and the table, and keeps its tokens', async () => {
  // Migration 61 on top of a database at version 60 that has a signed-in token.
  const { default: Database } = await import('better-sqlite3');
  const { MIGRATIONS } = await import('../src/db/index.js');
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  for (const migration of MIGRATIONS.slice(0, -1)) migration(old);
  old
    .prepare(
      `INSERT INTO api_tokens (id, account_id, token_hash, device_name, created_at, last_used_at, expires_at, push_token, push_env, push_origin)
       VALUES ('t1', 'a1', 'h1', 'iPhone', 1, 1, 2, 'device', 'production', 'https://s.example')`
    )
    .run();
  assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'push_events'").get(), undefined);

  MIGRATIONS.at(-1)(old);

  const row = old.prepare('SELECT * FROM api_tokens WHERE id = ?').get('t1');
  assert.equal(row.push_token, 'device');
  assert.equal(row.push_pigeon_handle, null);
  assert.equal(row.push_pigeon_proven_at, null);
  old.prepare("INSERT INTO push_events VALUES ('r', 't1', '{}', 1, 2)").run();
  old.prepare('DELETE FROM api_tokens WHERE id = ?').run('t1');
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM push_events').get().n, 0, 'cascades');
  old.close();
});
