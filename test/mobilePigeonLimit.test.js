// GET /api/mobile/push/events/:ref is limited to 30 requests a minute for one app token (a
// phone asks once per notification, and a notification is at most 6 an hour). Its own file so the
// other Pigeon route tests do not use up the per-address limit of 120 a minute meanwhile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity, signInIdentity } = await import('../src/db/accounts.js');
const { createApiToken } = await import('../src/db/apiTokens.js');
const { createPushEvent } = await import('../src/db/pushEvents.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);
const app = browser();

async function person() {
  setProfiles();
  const id = profiles.discord.id;
  await signInIdentity({ platform: 'discord', platformUserId: id, guildIds: [D_GUILD] });
  const { accountId } = await findIdentity('discord', id);
  const { id: tokenId, token } = await createApiToken(accountId, { deviceName: 'iPhone', ttlMs: 60_000 });
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => p === 'ManageGuild' },
    roles: { cache: { hasAny: () => false } },
  });
  return { token, tokenId };
}

const getEvent = (token, ref) =>
  app.get(`/api/mobile/push/events/${ref}`, { headers: { authorization: `Bearer ${token}` } });

test('30 requests a minute for one token, then 429 that is never cached; another token is not affected', async () => {
  const one = await person();
  const two = await person();
  const content = {
    title: 'D-main',
    body: 'ferdi: hello',
    threadId: `${D_GUILD}:5`,
    kind: 'ticket',
    data: { kind: 'ticket', guildId: D_GUILD, ticketId: 5 },
  };
  await createPushEvent({ ref: 'q'.repeat(22), tokenId: one.tokenId, payload: content });
  let last;
  for (let i = 0; i < 30; i += 1) last = await getEvent(one.token, 'z'.repeat(22));
  assert.equal(last.status, 404);
  for (const ref of ['z'.repeat(22), 'q'.repeat(22)]) {
    const limited = await getEvent(one.token, ref);
    assert.equal(limited.status, 429, 'also for a reference that exists');
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.ok(!(await limited.text()).includes('hello'));
  }
  assert.equal((await getEvent(two.token, 'z'.repeat(22))).status, 404, 'another token has its own count');
});
