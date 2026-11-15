// "Change its permissions" in the setup wizard edits an existing channel with the bot's rights, so the
// person asking must hold Manage Channels and Manage Roles themselves (the owner and Administrators
// always do). A bot master or Manage Server holder without them is refused before anything is touched;
// creating a new channel with the wizard's permissions stays open to Edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const TARGET = '100000000000000701';
const ROLE = '700000000000000701';

async function signedIn(perms) {
  setProfiles();
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  guild.members.cache.set(id, {
    id,
    permissions: { has: (p) => perms.includes(p) },
    roles: { highest: { position: 10 }, cache: new Map() },
  });
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  return (fields, item = 'modlog') =>
    b.get(`/api/v2/guilds/${D_GUILD}/setup/apply`, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ id: item, fields }] }),
    });
}

const edits = [];
test.beforeEach(() => {
  edits.length = 0;
  guild.channels.cache.set(TARGET, {
    id: TARGET,
    name: 'admins',
    guild,
    isTextBased: () => true,
    permissionOverwrites: { edit: async (...args) => edits.push(args) },
  });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.channels.cache.clear();
});

const fixExisting = { channelId: { id: TARGET, fix: true }, viewRole: { id: ROLE } };

test('Manage Server alone cannot change the permissions of a channel that exists', async () => {
  const apply = await signedIn(['ManageGuild']);
  const res = await apply(fixExisting);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Manage Channels and Manage Roles/);
  assert.deepEqual(edits, []);
});

test('Manage Channels without Manage Roles is not enough either', async () => {
  const apply = await signedIn(['ManageGuild', 'ManageChannels']);
  assert.equal((await apply(fixExisting)).status, 403);
});

test('a person with Manage Channels and Manage Roles gets past the check', async () => {
  const apply = await signedIn(['ManageGuild', 'ManageChannels', 'ManageRoles']);
  const res = await apply(fixExisting);
  assert.equal(res.status, 200, 'the apply runs (and reports per item)');
});

test('Administrator gets past the check', async () => {
  const apply = await signedIn(['Administrator']);
  assert.equal((await apply(fixExisting)).status, 200);
});

test('creating a new channel with the wizard permissions is not stopped by the permission check', async () => {
  const apply = await signedIn(['ManageGuild']);
  const res = await apply({ channelId: { create: true, fix: true } });
  assert.equal(res.status, 200);
  const [result] = (await res.json()).results;
  assert.doesNotMatch(result.message, /Manage Channels and Manage Roles in this server/);
});

test('picking a channel without ticking the permission change stays open to Edit', async () => {
  const apply = await signedIn(['ManageGuild']);
  const res = await apply({ channelId: { id: TARGET } });
  assert.equal(res.status, 200);
});
