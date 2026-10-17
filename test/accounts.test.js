import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccount,
  findIdentity,
  identitiesOf,
  signInIdentity,
  linkIdentity,
  unlinkIdentity,
  setIdentityGuilds,
  createSession,
  getSession,
  deleteSession,
  purgeExpiredSessions,
  IdentityLinkedError,
  PlatformAlreadyLinkedError,
} from '../src/db/accounts.js';

// Every test gets its own identities: the database is shared across the file.
let n = 0;
const fresh = (platform, prefix, username) => ({
  platform,
  platformUserId: prefix + String(++n).padStart(4, '0'),
  username,
  avatar: null,
});
let discordMe;
let fluxerMe;
test.beforeEach(() => {
  discordMe = fresh('discord', '15163059564917', 'ferdi');
  fluxerMe = fresh('fluxer', '15549475055636', 'Ferdinand99');
});

test('signing in with an identity nobody has used creates an account and the identity', async () => {
  const { accountId, created } = await signInIdentity({ ...discordMe, guildIds: ['100000000000000001'] });
  assert.equal(created, true);
  assert.match(accountId, /^[0-9a-f-]{36}$/);
  const identity = await findIdentity('discord', discordMe.platformUserId);
  assert.equal(identity.accountId, accountId);
  assert.equal(identity.username, 'ferdi');
  assert.deepEqual(identity.guildIds, ['100000000000000001']);
});

test('signing in again with the same identity reuses the account and refreshes the profile and guilds', async () => {
  const first = await signInIdentity({ ...discordMe, guildIds: ['100000000000000001'] });
  const second = await signInIdentity({ ...discordMe, username: 'ferdi2', guildIds: ['100000000000000002'] });
  assert.equal(second.created, false);
  assert.equal(second.accountId, first.accountId);
  const identity = await findIdentity('discord', discordMe.platformUserId);
  assert.equal(identity.username, 'ferdi2');
  assert.deepEqual(identity.guildIds, ['100000000000000002']);
  assert.ok(identity.guildsFetchedAt > 0);
});

test('an account can hold one identity per platform', async () => {
  const { accountId } = await signInIdentity({ ...discordMe, guildIds: [] });
  await linkIdentity(accountId, { ...fluxerMe, guildIds: ['fluxer:900000000000000001'] });
  const identities = await identitiesOf(accountId);
  assert.deepEqual(identities.map((i) => i.platform).sort(), ['discord', 'fluxer']);
});

test('signing in with a linked identity lands on the account it is linked to', async () => {
  const { accountId } = await signInIdentity({ ...discordMe, guildIds: [] });
  await linkIdentity(accountId, { ...fluxerMe, guildIds: [] });
  const viaFluxer = await signInIdentity({ ...fluxerMe, guildIds: [] });
  assert.equal(viaFluxer.accountId, accountId);
  assert.equal(viaFluxer.created, false);
});

test('an identity already linked to another account cannot be linked again', async () => {
  const a = await signInIdentity({ ...discordMe, guildIds: [] });
  await signInIdentity({ ...fluxerMe, guildIds: [] }); // its own account
  await assert.rejects(linkIdentity(a.accountId, { ...fluxerMe, guildIds: [] }), IdentityLinkedError);
});

test('linking an identity to the account it is already on is a refresh, not an error', async () => {
  const a = await signInIdentity({ ...discordMe, guildIds: [] });
  await assert.doesNotReject(linkIdentity(a.accountId, { ...discordMe, username: 'again', guildIds: [] }));
  assert.equal((await findIdentity('discord', discordMe.platformUserId)).username, 'again');
});

test('an identity can be unlinked, but never the last one on an account', async () => {
  const { accountId } = await signInIdentity({ ...discordMe, guildIds: [] });
  await linkIdentity(accountId, { ...fluxerMe, guildIds: [] });
  assert.equal(await unlinkIdentity(accountId, 'fluxer'), true);
  assert.equal(await findIdentity('fluxer', fluxerMe.platformUserId), null);
  assert.equal(await unlinkIdentity(accountId, 'discord'), false); // the last one stays
  assert.ok(await findIdentity('discord', discordMe.platformUserId));
});

test('setIdentityGuilds replaces the stored guild list and stamps the time', async () => {
  const { accountId } = await signInIdentity({ ...discordMe, guildIds: ['100000000000000001'] });
  const before = Date.now();
  await setIdentityGuilds('discord', discordMe.platformUserId, ['100000000000000009']);
  const identity = (await identitiesOf(accountId))[0];
  assert.deepEqual(identity.guildIds, ['100000000000000009']);
  assert.ok(identity.guildsFetchedAt >= before);
});

test('createAccount makes an empty account with a unique id', async () => {
  const a = await createAccount();
  const b = await createAccount();
  assert.notEqual(a, b);
  assert.deepEqual(await identitiesOf(a), []);
});

// --- sessions ------------------------------------------------------------------

test('a session resolves to its account until it expires', async () => {
  const accountId = await createAccount();
  const sid = await createSession(accountId, 60_000);
  assert.ok(sid.length >= 40, 'an unguessable id');
  assert.deepEqual(await getSession(sid), { accountId, expiresAt: (await getSession(sid)).expiresAt });
  assert.equal(await getSession('not-a-session'), null);
  assert.equal(await getSession(''), null);
  assert.equal(await getSession(undefined), null);
});

test('an expired session is not returned', async () => {
  const accountId = await createAccount();
  const sid = await createSession(accountId, -1);
  assert.equal(await getSession(sid), null);
});

test('deleteSession ends it, and purgeExpiredSessions drops only the expired ones', async () => {
  const accountId = await createAccount();
  await purgeExpiredSessions(); // other tests leave expired sessions behind
  const live = await createSession(accountId, 60_000);
  const old = await createSession(accountId, -1);
  const gone = await createSession(accountId, 60_000);
  await deleteSession(gone);
  assert.equal(await getSession(gone), null);
  assert.equal(await purgeExpiredSessions(), 1);
  assert.ok(await getSession(live));
  assert.equal(await getSession(old), null);
});

test('removing the last identity is blocked, but deleting sessions with an account that has none works', async () => {
  const accountId = await createAccount();
  const sid = await createSession(accountId, 60_000);
  await deleteSession(sid);
  assert.equal(await getSession(sid), null);
});

test('an account cannot link a second identity on a platform it already has one on', async () => {
  const { accountId } = await signInIdentity({ ...discordMe, guildIds: [] });
  const otherDiscord = fresh('discord', '15163059564917', 'someone-else');
  await assert.rejects(
    linkIdentity(accountId, { ...otherDiscord, guildIds: [] }),
    PlatformAlreadyLinkedError
  );
  assert.equal(await findIdentity('discord', otherDiscord.platformUserId), null);
});

// --- security review fixes -------------------------------------------------------------------

const { createApiToken, listApiTokens } = await import('../src/db/apiTokens.js');
const { deleteAccount } = await import('../src/db/accounts.js');
const { prepare } = await import('../src/db/driver.js');

async function twoLogins() {
  const { accountId } = await signInIdentity({ ...discordMe, guildIds: [] });
  await linkIdentity(accountId, { ...fluxerMe, guildIds: [] });
  return accountId;
}

test('disconnecting a platform that is not linked changes nothing', async () => {
  const accountId = await twoLogins();
  await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  assert.equal(await unlinkIdentity(accountId, 'xyz'), false);
  assert.equal((await identitiesOf(accountId)).length, 2);
  assert.equal((await listApiTokens(accountId)).length, 1, 'the app stays signed in');
});

test('two disconnects at once never leave an account without a sign-in', async () => {
  const accountId = await twoLogins();
  await Promise.all([unlinkIdentity(accountId, 'discord'), unlinkIdentity(accountId, 'fluxer')]);
  assert.equal((await identitiesOf(accountId)).length, 1);
});

test('disconnecting a sign-in ends the account’s other web sessions', async () => {
  const accountId = await twoLogins();
  const here = await createSession(accountId, 60_000);
  const elsewhere = await createSession(accountId, 60_000);
  assert.equal(await unlinkIdentity(accountId, 'fluxer', { keepSession: here }), true);
  assert.ok(await getSession(here), 'the session that did it stays');
  assert.equal(await getSession(elsewhere), null);
});

test('deleteAccount removes the account, its sign-ins, sessions, app tokens and preferences', async () => {
  const accountId = await twoLogins();
  const sid = await createSession(accountId, 60_000);
  await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  const userId = discordMe.platformUserId;
  await prepare("INSERT INTO user_prefs (user_id, dashboard_version, updated_at) VALUES (?, 'v2', 1)").run(
    userId
  );
  await prepare('INSERT INTO roadmap_votes (post_id, user_id, created_at) VALUES (1, ?, 1)').run(userId);
  const post = await prepare(
    "INSERT INTO roadmap_posts (title, description, status, created_by, created_at, updated_at) VALUES ('t', 'd', 'pending', ?, 1, 1)"
  ).run(userId);

  await deleteAccount(accountId);

  assert.deepEqual(await identitiesOf(accountId), []);
  assert.equal(await findIdentity('discord', userId), null);
  assert.equal(await getSession(sid), null);
  assert.deepEqual(await listApiTokens(accountId), []);
  assert.equal(await prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(userId), undefined);
  assert.equal(await prepare('SELECT * FROM roadmap_votes WHERE user_id = ?').get(userId), undefined);
  const kept = await prepare('SELECT created_by FROM roadmap_posts WHERE id = ?').get(post.lastInsertRowid);
  assert.notEqual(kept.created_by, userId, 'a suggestion stays, without who made it');
  assert.equal(await prepare('SELECT * FROM accounts WHERE id = ?').get(accountId), undefined);
});
