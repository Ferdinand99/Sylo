// Dashboard saves may only bring in roles the person could hand out on the platform itself:
// below their highest role, and Manage Roles for a role with elevated permissions. Otherwise
// Manage Server (or a bot-master role) would be enough to give yourself an Administrator role
// through autoroles, reaction roles or role buttons.
import test from 'node:test';
import assert from 'node:assert/strict';
import { D_GUILD, browser, profiles, setProfiles, signIn, startOAuthApp } from './helpers/oauthApp.js';

await startOAuthApp();

const { runtime } = await import('../src/runtime.js');
const { grantRefusal, moduleGrants } = await import('../src/web/middleware/roleGrants.js');
const { getGuildModule, setGuildModule } = await import('../src/db/modules.js');

const guild = runtime.clients.discord.guilds.cache.get(D_GUILD);

const fakeRole = (id, name, position, perms = []) => ({
  id,
  name,
  position,
  permissions: { has: (p) => perms.includes(p) },
});
const LOW = fakeRole('700000000000000101', 'Member', 1);
const MID = fakeRole('700000000000000102', 'Helper', 5);
const ADMIN = fakeRole('700000000000000103', 'Admin', 3, ['Administrator']);
const HIGH = fakeRole('700000000000000104', 'Boss', 20);

const fakeMember = (id, top, perms = []) => ({
  id,
  permissions: { has: (p) => perms.includes(p) },
  roles: { highest: { position: top }, cache: { hasAny: () => false } },
});

test('grantRefusal mirrors the platform rules', () => {
  const g = { ownerId: 'owner' };
  const manager = fakeMember('m', 10, ['ManageGuild']);
  assert.equal(grantRefusal(g, manager, LOW), null, 'a plain role below you');
  assert.match(grantRefusal(g, manager, HIGH), /above or equal/);
  assert.match(grantRefusal(g, manager, ADMIN), /need Manage Roles/);
  assert.equal(grantRefusal(g, fakeMember('m', 10, ['ManageRoles']), ADMIN), null);
  assert.equal(grantRefusal(g, fakeMember('owner', 0), HIGH), null, 'the owner may use any role');
  assert.equal(grantRefusal(g, fakeMember('a', 0, ['Administrator']), HIGH), null);
  assert.match(grantRefusal(g, null, LOW), /not a member/);
});

test('moduleGrants lists only roles the bot hands out', () => {
  assert.deepEqual(
    moduleGrants('roles', { autoroles: ['1'], reactionMessages: [{ pairs: [{ roleId: '2' }] }] }),
    ['1', '2']
  );
  assert.deepEqual(moduleGrants('tickets', { staffRoles: ['3'] }), [], 'staff access is not a grant');
  assert.deepEqual(moduleGrants('automod', { exemptRoles: ['4'] }), []);
  assert.deepEqual(
    moduleGrants('auto-react', {
      rules: [
        { roleId: '5', roleAction: 'add' },
        { roleId: '6', roleAction: 'remove' },
      ],
    }),
    ['5']
  );
});

async function signedIn(top, perms) {
  setProfiles();
  const id = profiles.discord.id;
  const b = browser();
  await signIn(b, 'discord');
  guild.members.cache.set(id, fakeMember(id, top, perms));
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const post = (path, body) =>
    b.get(path, {
      method: 'POST',
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return post;
}

const autoroles = (post, roles) =>
  post(`/api/v2/guilds/${D_GUILD}/modules/roles/autoroles`, { autoroles: roles });

test.beforeEach(async () => {
  for (const r of [LOW, MID, ADMIN, HIGH]) guild.roles.cache.set(r.id, r);
  await setGuildModule(D_GUILD, 'roles', { config: {} });
});
test.afterEach(() => {
  guild.members.cache.clear();
  guild.roles.cache.clear();
});

test('a Manage Server admin cannot set up a role above their own', async () => {
  const post = await signedIn(10, ['ManageGuild']);
  const res = await autoroles(post, [HIGH.id]);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /Boss is above/);
  assert.deepEqual((await getGuildModule(D_GUILD, 'roles')).config.autoroles ?? [], []);
});

test('a Manage Server admin without Manage Roles cannot hand out an admin role', async () => {
  const post = await signedIn(10, ['ManageGuild']);
  assert.equal((await autoroles(post, [ADMIN.id])).status, 403);
});

test('a plain role below them is fine', async () => {
  const post = await signedIn(10, ['ManageGuild']);
  assert.equal((await autoroles(post, [LOW.id, MID.id])).status, 200);
  assert.deepEqual((await getGuildModule(D_GUILD, 'roles')).config.autoroles, [LOW.id, MID.id]);
});

test('a role already in the saved setup can be kept by anyone who may use the dashboard', async () => {
  await setGuildModule(D_GUILD, 'roles', { config: { autoroles: [HIGH.id] } });
  const post = await signedIn(10, ['ManageGuild']);
  assert.equal((await autoroles(post, [HIGH.id, LOW.id])).status, 200);
});

// A role being somewhere in the saved setup (automod immunity, ticket staff, a ping) must not
// make it free to hand out.
test('a role saved in another module is still checked when it becomes a grant', async () => {
  await setGuildModule(D_GUILD, 'automod', { config: { exemptRoles: [ADMIN.id, HIGH.id] } });
  const post = await signedIn(10, ['ManageGuild']);
  assert.equal((await autoroles(post, [ADMIN.id])).status, 403);
  assert.equal((await autoroles(post, [HIGH.id])).status, 403);
});

test('roles that are not handed out are not checked (ticket staff above you)', async () => {
  const post = await signedIn(10, ['ManageGuild']);
  const res = await post(`/api/v2/guilds/${D_GUILD}/modules/tickets/config`, {
    staffRoles: [HIGH.id, ADMIN.id],
  });
  assert.equal(res.status, 200);
});
