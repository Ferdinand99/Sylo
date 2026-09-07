// Regression coverage for the cookie-session size bug (issue #163): an
// account managing enough Discord guilds pushed the signed, base64 session
// cookie past the ~4093-byte limit browsers accept, silently dropping
// `session.user` on every subsequent request and looping the OAuth login
// forever. The fix stores only the ids of guilds the user actually manages
// (filtered at login, not read time), as plain strings instead of
// `{ id, owner, permissions }` objects, capped as a last resort.
process.env.DISCORD_CLIENT_SECRET = 'test-secret';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { adminGuildIds, adminGuildIdsFromOAuth, MAX_STORED_GUILDS } =
  await import('../src/web/middleware/auth.js');
const { runtime } = await import('../src/runtime.js');

// Mirrors keygrip's default signing (sha1, used by `cookies`/`cookie-session`
// under the hood) closely enough to get a realistic cookie-value byte count
// for a session object, without pulling in the real middleware/HTTP stack.
function cookieValueBytes(sessionObj, key = 'x') {
  const b64 = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
  const sig = createHmac('sha1', key).update(b64).digest('base64');
  return Buffer.byteLength(`${b64}.${sig}`, 'utf8');
}

const ADMINISTRATOR = (1n << 3n).toString();
const MANAGE_GUILD = (1n << 5n).toString();
const NONE = '0';

test('adminGuildIdsFromOAuth: keeps owned or admin/manage-guild guilds only', () => {
  const guilds = [
    { id: 'owned', owner: true, permissions: NONE },
    { id: 'admin', owner: false, permissions: ADMINISTRATOR },
    { id: 'manage', owner: false, permissions: MANAGE_GUILD },
    { id: 'member-only', owner: false, permissions: NONE },
    { id: 'garbage-perms', owner: false, permissions: 'not-a-number' },
  ];
  assert.deepEqual(adminGuildIdsFromOAuth(guilds), ['owned', 'admin', 'manage']);
});

test('adminGuildIdsFromOAuth: non-array input and empty list both return []', () => {
  assert.deepEqual(adminGuildIdsFromOAuth(undefined), []);
  assert.deepEqual(adminGuildIdsFromOAuth(null), []);
  assert.deepEqual(adminGuildIdsFromOAuth([]), []);
});

test('adminGuildIdsFromOAuth: stores plain ids, not { id, owner, permissions } objects', () => {
  const guilds = Array.from({ length: 200 }, (_, i) => ({
    id: String(100000000000000000n + BigInt(i)),
    owner: true,
    permissions: NONE,
  }));
  const ids = adminGuildIdsFromOAuth(guilds);
  assert.equal(ids.length, 200); // uncapped here — the cap is the callback's job, tested below
  assert.ok(ids.every((id) => typeof id === 'string'));
});

test('MAX_STORED_GUILDS worth of ids + a full session fits well under the 4093-byte cookie limit — issue #163', () => {
  // The actual bug: an account in 50+ guilds pushed the old
  // `{ id, owner, permissions }`-per-guild session past the browser's
  // ~4093-byte Set-Cookie ceiling, which silently dropped `session.user` on
  // every request after login and looped the OAuth flow forever. This
  // reconstructs cookie-session's real encoding (base64 JSON + HMAC-SHA1
  // signature) for a worst-case-realistic full session at the cap, to prove
  // the fix actually fits rather than just asserting the cap constant exists.
  const ids = Array.from({ length: MAX_STORED_GUILDS }, (_, i) => String(100000000000000000n + BigInt(i)));
  const session = {
    guilds: ids,
    user: {
      id: '111111111111111111',
      username: 'a'.repeat(32), // Discord's max username length
      global_name: 'a'.repeat(32),
      avatar: 'a'.repeat(32), // avatar hash
    },
    guildsFetchedAt: Date.now(),
    lastGuild: '111111111111111111',
  };
  const bytes = cookieValueBytes(session);
  assert.ok(bytes < 4093, `expected the full session at the cap to fit under 4093 bytes, got ${bytes}`);
});

test("adminGuildIds(req): intersects the stored (already-filtered) ids with the bot's current guilds", (t) => {
  const savedClient = runtime.client;
  runtime.client = {
    guilds: {
      cache: new Map([
        ['bot-guild-1', {}],
        ['bot-guild-2', {}],
      ]),
    },
  };
  t.after(() => {
    runtime.client = savedClient;
  });

  const req = { session: { guilds: ['bot-guild-1', 'guild-bot-left', 'bot-guild-2'] } };
  assert.deepEqual([...adminGuildIds(req)].sort(), ['bot-guild-1', 'bot-guild-2']);
});

test('adminGuildIds(req): no session / no guilds → empty set, never throws', (t) => {
  const savedClient = runtime.client;
  runtime.client = { guilds: { cache: new Map() } };
  t.after(() => {
    runtime.client = savedClient;
  });

  assert.deepEqual([...adminGuildIds({})], []);
  assert.deepEqual([...adminGuildIds({ session: {} })], []);
  assert.deepEqual([...adminGuildIds({ session: { guilds: [] } })], []);
});
