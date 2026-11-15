import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { setGuildModule } from '../src/db/modules.js';
import { buildAttention, moduleProblems } from '../src/web/lib/overviewAttention.js';
import { missingOwnerKeys } from '../src/web/lib/overviewSummary.js';
import { config } from '../src/config.js';

const G = '700000000000000777';
const CH = '111111111111111111';
const ROLE = '222222222222222222';

function stubGuild(id = G, { perms = PermissionsBitField.All } = {}) {
  return {
    id,
    members: { me: { permissions: new PermissionsBitField(perms) } },
    channels: { cache: new Map([[CH, { id: CH, name: 'general' }]]) },
    roles: { cache: new Map([[ROLE, { id: ROLE, name: 'Verified', managed: false }]]) },
  };
}

test('moduleProblems: a channel that is not set, or was deleted, is a problem; a set one is not', () => {
  const guild = stubGuild();
  assert.deepEqual(moduleProblems('logging', {}, guild), ['The log channel is not set']);
  assert.deepEqual(moduleProblems('logging', { channel: '999999999999999999' }, guild), [
    'The log channel no longer exists',
  ]);
  assert.deepEqual(moduleProblems('logging', { channel: CH }, guild), []);
});

test('moduleProblems: roles, lists and modules with no requirements', () => {
  const guild = stubGuild();
  assert.deepEqual(moduleProblems('verification', { channelId: CH }, guild), [
    'The verified role is not set',
  ]);
  assert.deepEqual(
    moduleProblems('verification', { channelId: CH, verifiedRoleId: '333333333333333333' }, guild),
    ['The verified role no longer exists']
  );
  assert.deepEqual(moduleProblems('verification', { channelId: CH, verifiedRoleId: ROLE }, guild), []);
  assert.deepEqual(moduleProblems('twitch-alerts', { alerts: [] }, guild), ['Streamers: none added yet']);
  assert.deepEqual(moduleProblems('twitch-alerts', { alerts: [{ login: 'a' }] }, guild), []);
  assert.deepEqual(
    moduleProblems('leveling', {}, guild),
    [],
    'a module with no required setting is never a problem'
  );
  assert.deepEqual(
    moduleProblems('logging', null, guild),
    ['The log channel is not set'],
    'a missing config counts as empty'
  );
});

test('moduleProblems: Welcome needs a role in role mode, and a channel for each message that is on', () => {
  const guild = stubGuild();
  assert.deepEqual(moduleProblems('welcome', {}, guild), []);
  assert.deepEqual(moduleProblems('welcome', { trigger: 'role', triggerRoleIds: [] }, guild), [
    'No role is picked to start the welcome',
  ]);
  assert.deepEqual(
    moduleProblems(
      'welcome',
      { trigger: 'role', triggerRoleIds: [ROLE], joinEnabled: true, joinChannel: CH },
      guild
    ),
    []
  );
  assert.deepEqual(moduleProblems('welcome', { joinEnabled: true, leaveEnabled: true }, guild), [
    'The welcome message has no channel',
    'The leave message has no channel',
  ]);
});

test('buildAttention lists enabled modules with problems, missing permissions and the waiting work', async () => {
  const guild = stubGuild(G, { perms: PermissionsBitField.Flags.KickMembers });
  await setGuildModule(G, 'logging', { enabled: true, config: {} });
  await setGuildModule(G, 'counting', { enabled: false, config: {} });
  await setGuildModule(G, 'birthdays', { enabled: true, config: { channel: CH } });
  const out = await buildAttention(guild);
  const byId = Object.fromEntries(out.problems.map((p) => [p.id, p]));
  assert.deepEqual(byId.logging.issues, ['The log channel is not set']);
  assert.equal(byId.logging.href, `/v2/guilds/${G}/m/logging`);
  assert.equal(byId.logging.name, 'Server logging');
  assert.equal(byId.counting, undefined, 'a module that is switched off is not a problem');
  assert.equal(byId.birthdays, undefined, 'a configured module is not a problem');
  assert.ok(out.missingPermissions.includes('Ban Members'));
  assert.ok(!out.missingPermissions.includes('Kick Members'));
  assert.deepEqual(out.waiting, { tickets: 0, appeals: 0, applications: 0, suggestions: 0 });
  assert.equal(out.platform, 'discord');
});

test('Events is not a problem without a default channel: it is optional', async () => {
  const guild = stubGuild('700000000000000779');
  await setGuildModule('700000000000000779', 'events', { enabled: true, config: {} });
  assert.deepEqual(moduleProblems('events', {}, guild), []);
  const out = await buildAttention(guild);
  assert.equal(
    out.problems.find((p) => p.id === 'events'),
    undefined
  );
});

test('an owner-only module is only ever listed for the bot owner', async () => {
  const id = '700000000000000780';
  const guild = stubGuild(id);
  await setGuildModule(id, 'apple-connect', { enabled: true, config: {} });
  const forOwner = await buildAttention(guild, { owner: true });
  const forAdmin = await buildAttention(guild, { owner: false });
  assert.ok(forOwner.problems.some((p) => p.id === 'apple-connect'));
  assert.ok(!forAdmin.problems.some((p) => p.id === 'apple-connect'));
});

test('buildAttention counts waiting tickets, applications and suggestions', async () => {
  const guild = stubGuild('700000000000000778');
  for (const m of ['tickets', 'suggestions', 'applications']) {
    await setGuildModule('700000000000000778', m, { enabled: true, config: {} });
  }
  const { createTicket } = await import('../src/db/tickets.js');
  await createTicket('700000000000000778', '800000000000000001');
  const sg = await import('../src/db/suggestions.js');
  await sg.createSuggestion({
    guildId: '700000000000000778',
    channelId: CH,
    authorId: '800000000000000002',
    title: 'Idea',
    body: 'More fries',
    createdAt: Date.now(),
  });
  const out = await buildAttention(guild);
  assert.equal(out.waiting.tickets, 1);
  assert.equal(out.waiting.suggestions, 1);
  assert.equal(out.waiting.applications, 0);
});

test('waiting work of a module that is switched off is not counted', async () => {
  const id = '700000000000000781';
  const guild = stubGuild(id);
  const sg = await import('../src/db/suggestions.js');
  await sg.createSuggestion({
    guildId: id,
    channelId: CH,
    authorId: '800000000000000002',
    title: 'Idea',
    body: 'More fries',
    createdAt: Date.now(),
  });
  await setGuildModule(id, 'suggestions', { enabled: false, config: {} });
  assert.equal((await buildAttention(guild)).waiting.suggestions, 0);
  await setGuildModule(id, 'suggestions', { enabled: true, config: {} });
  assert.equal((await buildAttention(guild)).waiting.suggestions, 1);
});

test('counts and module rows the caller already has are used as given', async () => {
  const id = '700000000000000782';
  const guild = stubGuild(id);
  const modules = [{ id: 'tickets', enabled: true, config: {} }];
  const out = await buildAttention(guild, { modules, openTickets: 7, openAppeals: 3 });
  assert.equal(out.waiting.tickets, 7);
  assert.equal(out.waiting.appeals, 0, 'appeals is not enabled in the rows given');
});

test('a module on that waits for API keys the bot owner has not added is listed as information, not as a setup problem', async () => {
  const id = '700000000000000782';
  const guild = stubGuild(id);
  await setGuildModule(id, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'a', channelId: CH }] },
  });
  await setGuildModule(id, 'kick-alerts', { enabled: false, config: {} });
  // the test environment has no Twitch or Kick keys
  assert.equal(config.twitchEnabled, false);
  assert.equal(missingOwnerKeys('twitch-alerts'), 'Twitch API keys');
  assert.equal(missingOwnerKeys('kick-alerts'), 'Kick API keys');
  assert.equal(missingOwnerKeys('apple-connect'), 'App Store Connect API keys');
  assert.equal(missingOwnerKeys('logging'), null);
  const out = await buildAttention(guild);
  assert.deepEqual(out.waitingForOwner, [
    { id: 'twitch-alerts', name: 'Twitch alerts', keys: 'Twitch API keys' },
  ]);
  // it is information, not a setup problem with a fix link
  assert.ok(!out.problems.some((p) => p.id === 'twitch-alerts'));
});

test("the modules that wait for the operator's keys are shown to an operator only", async () => {
  const id = '700000000000000783';
  const guild = stubGuild(id);
  await setGuildModule(id, 'twitch-alerts', {
    enabled: true,
    config: { alerts: [{ login: 'a', channelId: CH }] },
  });
  const forOperator = await buildAttention(guild, { owner: true });
  const forAdmin = await buildAttention(guild, { owner: false });
  assert.equal(forOperator.waitingForOwner.length, 1);
  assert.deepEqual(forAdmin.waitingForOwner, [], 'an admin has nothing to do about it');
  assert.ok(Array.isArray(forAdmin.waitingForOwner), 'the field stays, for the apps');
});

test('buildAttention carries the permission health of the enabled modules, without the picker data', async () => {
  const id = '700000000000000784';
  const guild = stubGuild(id);
  guild.channels.cache.get(CH).permissionsFor = () => new PermissionsBitField(['ViewChannel']);
  guild.channels.cache.get(CH).isTextBased = () => true;
  await setGuildModule(id, 'logging', { enabled: true, config: { channel: CH } });
  const { health } = await buildAttention(guild);
  assert.equal(health.available, true);
  assert.equal(health.summary.errors, 1);
  assert.equal(health.checks[0].module, 'logging');
  assert.equal(health.checks[0].code, 'missing-channel-permission');
  assert.ok(!('targets' in health));
});
