// A web session's admin rights come from the guild list saved at sign-in. The dashboard only
// refreshes that list on GET / and /guilds pages, so V2 requests and form posts must not trust
// it for long: once it is older than the refresh window, rights are checked live through the
// bot, like app tokens are. Someone who lost Manage Server is then refused within minutes,
// instead of keeping access for the whole 7-day session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { prepare } = await import('../src/db/driver.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const ageSnapshot = prepare('UPDATE account_identities SET guilds_fetched_at = 1 WHERE platform_user_id = ?');

/** A new person whose sign-in snapshot says they administer D_GUILD. */
async function person() {
  setProfiles();
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  return { id, b };
}

function member(id, perms = []) {
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { cache: { hasAny: () => false, some: () => false } },
  });
}

const overview = (b) => b.get(`/api/v2/guilds/${D_GUILD}/overview`);
const tickets = (b) => b.get(`/api/v2/guilds/${D_GUILD}/tickets`);

test.afterEach(() => {
  guild.members.cache.clear();
});

test('a fresh sign-in snapshot is trusted', async () => {
  const { b } = await person();
  assert.equal((await overview(b)).status, 200);
  assert.equal((await tickets(b)).status, 200);
});

test('a stale snapshot is checked live: no longer an admin means no access', async () => {
  const { id, b } = await person();
  await ageSnapshot.run(id);
  assert.equal((await overview(b)).status, 403);
  assert.equal((await tickets(b)).status, 403);
});

test('a stale snapshot still works for someone who still has Manage Server', async () => {
  const { id, b } = await person();
  await ageSnapshot.run(id);
  member(id, ['ManageGuild']);
  assert.equal((await overview(b)).status, 200);
  assert.equal((await tickets(b)).status, 200);
});

// The "Not an admin" page is rendered with the shared header. It used to build the sidebar
// from the server in the URL before the access check, so anyone signed in could read any
// server's name and which modules it runs.
test('the 403 page for a server you do not manage does not show that server', async () => {
  const { OTHER_D_GUILD } = await import('./helpers/oauthApp.js');
  const { b } = await person();
  const res = await b.get(`/guilds/${OTHER_D_GUILD}/overview`);
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /D-other/);
});
