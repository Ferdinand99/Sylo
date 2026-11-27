// Without the Server Members intent a cached member can keep a right that was taken away, so a refresh
// looks the member up fresh before it lets a cached Manage Server add a server.
import './helpers/noMembersIntent.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, guildIds, profiles, setProfiles, signIn, startOAuthApp, uid } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { findIdentity } = await import('../src/db/accounts.js');
const { noteGuildJoin } = await import('../src/bot/lib/guildJoins.js');

test('a cached member who lost Manage Server unseen does not add the server', async () => {
  setProfiles();
  const b = browser();
  await signIn(b, 'discord');
  const me = profiles.discord.id;
  const rawId = uid('9300000000');
  const fetches = [];
  const client = runtime.clients.discord;
  const stale = { id: me, permissions: { has: () => true }, roles: { cache: new Map() } };
  const guild = {
    id: rawId,
    name: 'stale',
    client,
    iconURL: () => null,
    ownerId: 'somebody-else',
    members: {
      cache: new Map([[me, stale]]), // the bot never heard that the right was removed
      fetch: async (arg) => {
        fetches.push(arg);
        const fresh = { ...stale, permissions: { has: () => false } };
        guild.members.cache.set(me, fresh);
        return fresh;
      },
    },
    channels: { cache: new Map() },
    roles: { cache: new Map() },
    emojis: { cache: new Map() },
  };
  client.guilds.cache.set(rawId, guild);
  await new Promise((resolve) => setTimeout(resolve, 5));
  noteGuildJoin('discord', rawId, guild);

  assert.ok(!(await guildIds(b)).includes(rawId));
  assert.deepEqual(fetches[0], { user: me, force: true }, 'the member was fetched fresh first');
  assert.ok(!(await findIdentity('discord', me)).guildIds.includes(rawId));
  client.guilds.cache.delete(rawId);
});
