// A server the bot joins after someone signed in shows up in their server list without signing in
// again: the join marks the lists on that platform as due, and the next request looks once. The
// "Refresh server list" action does the same on demand, for the caller's own identities only, at
// most once per 30 seconds per account. See helpers/oauthApp.js for the harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  D_GUILD,
  F_GUILD,
  memberFetches,
  browser,
  guildIds,
  profiles,
  setProfiles,
  signIn,
  startOAuthApp,
  uid,
} from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { noteGuildJoin, lastGuildJoin, guildJoinedAt, resetGuildJoins } =
  await import('../src/bot/lib/guildJoins.js');
const { register: registerDiscordSnapshot } = await import('../src/bot/events/adminSnapshot.js');
const { registerFluxerModuleEvents } = await import('../src/bot/fluxerModuleEvents.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A server the bot is in, on one platform's fake client. `ownerId` is who owns it; others are not members. */
function addGuild(platform, rawId, ownerId) {
  const client = runtime.clients[platform];
  const guild = {
    id: rawId,
    name: `new-${rawId}`,
    client,
    iconURL: () => null,
    members: {
      cache: new Map(),
      fetch: async (arg) => {
        memberFetches.push(arg);
        throw new Error('Unknown Member');
      },
    },
    ownerId,
    channels: { cache: new Map() },
    roles: { cache: new Map() },
    emojis: { cache: new Map() },
  };
  client.guilds.cache.set(rawId, guild);
  return { guild, key: platform === 'discord' ? rawId : `fluxer:${rawId}` };
}

const csrf = async (b) => (await (await b.get('/api/v2/csrf')).json()).token;
const refresh = async (b) => {
  const res = await b.get('/api/v2/account/refresh-guilds', {
    method: 'POST',
    headers: { 'x-csrf-token': await csrf(b) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test.beforeEach(() => resetGuildJoins());

// --- the join event ------------------------------------------------------------------

test('the join registry ignores startup replays and joins the platform dates long ago', () => {
  noteGuildJoin('discord', 'g-startup', { joinedTimestamp: Date.now() }, { ready: false });
  assert.equal(lastGuildJoin('discord'), 0, 'before the client is ready: not a join');
  noteGuildJoin('discord', 'g-old', { joinedTimestamp: Date.now() - 3_600_000 });
  assert.equal(lastGuildJoin('discord'), 0, 'dated an hour ago: not a join');
  noteGuildJoin('discord', 'g-new', { joinedTimestamp: Date.now() - 1000 });
  assert.ok(lastGuildJoin('discord') > 0);
  assert.equal(lastGuildJoin('fluxer'), 0, 'the other platform is not touched');
  assert.ok(guildJoinedAt('g-new', null) > 0);
  assert.equal(guildJoinedAt('g-other', null), 0);
});

test('Discord guildCreate marks the platform, but not before the client is ready', () => {
  const client = new EventEmitter();
  client.isReady = () => false;
  registerDiscordSnapshot(client);
  client.emit('guildCreate', { id: '900000000000000801', client });
  assert.equal(lastGuildJoin('discord'), 0);
  client.isReady = () => true;
  client.emit('guildCreate', { id: '900000000000000802', client });
  assert.ok(lastGuildJoin('discord') > 0);
  assert.equal(lastGuildJoin('fluxer'), 0);
});

test('Fluxer guildCreate marks the Fluxer lists, keyed with the platform', async () => {
  const client = new EventEmitter();
  const dispatched = [];
  registerFluxerModuleEvents(client, { dispatch: (...args) => dispatched.push(args) });
  client.emit('guildCreate', { id: '900000000000000803' });
  await tick();
  assert.ok(lastGuildJoin('fluxer') > 0);
  assert.ok(guildJoinedAt('fluxer:900000000000000803', null) > 0);
  assert.equal(lastGuildJoin('discord'), 0);
  assert.equal(dispatched[0][0], 'guildCreate', 'the modules still get the event');
});

// --- the next request ----------------------------------------------------------------

test('a server the bot joins after sign-in appears on the next request, once, without signing in again', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const before = await guildIds(b);

  const { guild, key } = addGuild('discord', uid('9000000000'), profiles.discord.id);
  assert.deepEqual(await guildIds(b), before, 'nothing marks the list yet, so the server is not offered');

  await tick();
  noteGuildJoin('discord', key, guild);
  assert.deepEqual(await guildIds(b), [...before, key].sort());
  assert.ok((await findIdentity('discord', profiles.discord.id)).guildIds.includes(key), 'stored for later');
});

test('after a join each list is looked at once: later requests make no member lookups', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { guild, key } = addGuild('discord', uid('9000000000'), 'somebody-else');
  await tick();
  noteGuildJoin('discord', key, guild);

  const lookups = memberFetches.length;
  const ids = await guildIds(b);
  assert.ok(!ids.includes(key), 'they do not run it');
  assert.equal(memberFetches.length, lookups + 1, 'one lookup for the new server');
  await guildIds(b);
  await guildIds(b);
  assert.equal(memberFetches.length, lookups + 1, 'not looked at again until the next join');

  const second = addGuild('discord', uid('9000000000'), 'somebody-else');
  await tick();
  noteGuildJoin('discord', second.key, second.guild);
  await guildIds(b);
  assert.equal(memberFetches.length, lookups + 2, 'a later join is looked at once more');
});

test('a join on one platform leaves the other platform’s lists alone', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  await signIn(b, 'fluxer', { connect: true });
  const fluxerGuild = addGuild('fluxer', uid('91000000000'), profiles.fluxer.id);
  await tick();
  noteGuildJoin('discord', 'unrelated-discord-guild', null);
  assert.ok(!(await guildIds(b)).includes(fluxerGuild.key), 'a Discord join says nothing about Fluxer');
  noteGuildJoin('fluxer', fluxerGuild.key, fluxerGuild.guild);
  assert.ok((await guildIds(b)).includes(fluxerGuild.key));
  assert.ok((await guildIds(b)).includes(`fluxer:${F_GUILD}`));
  assert.ok((await guildIds(b)).includes(D_GUILD));
});

// --- the Refresh server list action -----------------------------------------------------

test('POST /account/refresh-guilds adds what the bot joined and is limited to once per 30 seconds', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const { key } = addGuild('discord', uid('9000000000'), profiles.discord.id); // no join was noted (a restart)

  assert.ok(!(await guildIds(b)).includes(key));
  const first = await refresh(b);
  assert.equal(first.status, 200);
  assert.equal(first.body.added, 1);
  assert.ok((await guildIds(b)).includes(key));

  const again = await refresh(b);
  assert.equal(again.status, 429);
  assert.match(again.body.error, /refreshed/);
});

test('the refresh only touches the caller’s own identities', async () => {
  setProfiles();
  const a = browser();
  await signIn(a, 'discord');
  const idA = profiles.discord.id;
  setProfiles();
  const c = browser();
  await signIn(c, 'discord');
  const idC = profiles.discord.id;
  assert.notEqual(idA, idC);

  const { key } = addGuild('discord', uid('9000000000'), idA);
  const other = await refresh(c);
  assert.equal(other.status, 200, "C's own limit is not used up by A");
  assert.equal(other.body.added, 0);
  assert.ok(!(await findIdentity('discord', idA)).guildIds.includes(key), "A's list is not changed by C");
  assert.ok(!(await findIdentity('discord', idC)).guildIds.includes(key));

  assert.equal((await refresh(a)).body.added, 1);
  assert.ok((await findIdentity('discord', idA)).guildIds.includes(key));
  assert.ok(!(await findIdentity('discord', idC)).guildIds.includes(key));
});

test('the refresh needs a sign-in and the CSRF token', async () => {
  const anonymous = await browser().get('/api/v2/account/refresh-guilds', { method: 'POST' });
  assert.ok([401, 403].includes(anonymous.status), 'refused before anything is looked at');
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const noToken = await b.get('/api/v2/account/refresh-guilds', { method: 'POST' });
  assert.equal(noToken.status, 403);
});
