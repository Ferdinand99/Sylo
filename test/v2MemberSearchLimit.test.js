// The member search is rate limited per person and server. Its own file: the app-wide limit of 120
// requests a minute per client would otherwise be spent by the other tests' calls first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');

setProfiles();
await signIn(browser(), 'discord');
const { accountId } = await findIdentity('discord', profiles.discord.id);
const { token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
runtime.clients.discord.guilds.cache.get(D_GUILD).members.cache.set(profiles.discord.id, {
  id: profiles.discord.id,
  permissions: { has: (p) => p === 'ManageGuild' },
  roles: { cache: { hasAny: () => false } },
});

test('the 101st search in a minute is a JSON 429', async () => {
  const app = browser();
  const search = (bearer) =>
    app.get(`/api/v2/guilds/${D_GUILD}/members?q=alice`, { headers: { authorization: `Bearer ${bearer}` } });
  for (let i = 0; i < 100; i++) assert.equal((await search(token)).status, 200, `call ${i + 1}`);
  const limited = await search(token);
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('content-type'), /json/);
  assert.equal(limited.headers.get('x-ratelimit-limit'), '100');
});
