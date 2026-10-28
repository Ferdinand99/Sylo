// Moderation side effects through the new dashboard's API: warnings and cases, channel locks,
// unban, automod immunity, ban-appeal decisions and command limits. Stored rows, audit rows and
// refusals are asserted (the classic dashboard's tests for these are being removed).
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, MEMBER_ID, CH } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getCase, listGuildCases, listWarnings } from '../src/db/modCases.js';
import { guildChannelLocks, isChannelLocked } from '../src/db/channelLocks.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getCommandOverride } from '../src/db/commandOverrides.js';
import { createAppeal, getAppeal } from '../src/db/appeals.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  app.guild.client = app.client; // the fake guild lacks the back-reference a real one has
  api = v2Open(app, GID);
});
test.after(() => app.close());

const OTHER_MEMBER = '900000000000008888';

// --- warnings and cases ---------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /warnings adds a case; POST /cases/:n/delete soft-deletes it"
test('a warning is stored as an active case, listed, and soft-deleted then restored with an audit row', async () => {
  const add = await api.post('/moderation/warn', { userId: `<@${MEMBER_ID}>`, reason: 'noise' });
  assert.equal(add.status, 200);
  const body = await add.json();
  assert.equal(body.ok, true);
  assert.equal(body.warnings, 1);

  const [{ id: n }] = await listWarnings(GID, MEMBER_ID);
  const warning = await getCase(GID, n);
  assert.equal(warning.action, 'warn');
  assert.equal(warning.reason, 'noise');
  assert.equal(warning.active, 1);
  assert.equal(warning.moderator_id, 'web');

  const listed = await (await api.get('/moderation')).json();
  const row = listed.cases.find((c) => c.caseNumber === n);
  assert.ok(row, 'the case is listed');
  assert.equal(row.userId, MEMBER_ID);
  assert.equal(row.active, true);
  assert.equal(row.moderator, 'Dashboard');

  const del = await api.post(`/moderation/cases/${n}/delete`);
  assert.equal(del.status, 200);
  assert.equal((await del.json()).active, false);
  assert.equal((await getCase(GID, n)).active, 0);
  const deleted = await auditRows(GID, 'moderation:case-delete');
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].detail, `#${n}`);
  assert.equal(deleted[0].actor, 'Dashboard');
  assert.equal(
    (await (await api.get('/moderation')).json()).cases.find((c) => c.caseNumber === n).active,
    false
  );

  const restore = await api.post(`/moderation/cases/${n}/restore`);
  assert.equal(restore.status, 200);
  assert.equal((await getCase(GID, n)).active, 1);
  assert.equal((await auditRows(GID, 'moderation:case-restore')).length, 1);
});

// replaces routes.guilds.test.js: "POST /warnings adds a case; POST /cases/:n/delete soft-deletes it" (refusals)
test('warning and case routes refuse bad input without storing anything', async () => {
  const before = (await listGuildCases(GID)).total;

  assert.equal((await api.post('/moderation/warn', { userId: 'not-an-id', reason: 'x' })).status, 400);
  assert.equal((await api.post('/moderation/warn', { userId: OTHER_MEMBER, reason: '   ' })).status, 400);

  // A person who is not in the server is not warned.
  const real = app.guild.members.fetch;
  app.guild.members.fetch = async () => {
    throw new Error('Unknown Member');
  };
  try {
    assert.equal((await api.post('/moderation/warn', { userId: OTHER_MEMBER, reason: 'x' })).status, 404);
    // ... and a bot cannot be warned.
    app.guild.members.fetch = async (id) => ({
      id,
      user: { id, bot: true, tag: 'b#0', send: async () => {} },
    });
    assert.equal((await api.post('/moderation/warn', { userId: OTHER_MEMBER, reason: 'x' })).status, 400);
  } finally {
    app.guild.members.fetch = real;
  }

  assert.equal((await api.post('/moderation/cases/99999/delete')).status, 404);
  assert.equal((await api.post('/moderation/cases/1/explode')).status, 404);
  assert.equal((await listGuildCases(GID)).total, before, 'nothing was stored');
});

// replaces routes.guilds.test.js: "POST /warnings adds a case; POST /cases/:n/delete soft-deletes it" (case reason, clear)
test('editing a case reason and clearing warnings write audit rows', async () => {
  await api.post('/moderation/warn', { userId: OTHER_MEMBER, reason: 'first' });
  await api.post('/moderation/warn', { userId: OTHER_MEMBER, reason: 'second' });
  const [newest] = await listWarnings(GID, OTHER_MEMBER);

  const edit = await api.post(`/moderation/cases/${newest.id}/reason`, { reason: 'reworded' });
  assert.equal(edit.status, 200);
  assert.equal((await getCase(GID, newest.id)).reason, 'reworded');
  assert.equal((await auditRows(GID, 'moderation:case-reason')).length, 1);
  assert.equal((await api.post(`/moderation/cases/${newest.id}/reason`, { reason: '' })).status, 404);

  const clear = await api.post('/moderation/warnings/clear', { userId: OTHER_MEMBER });
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).removed, 2);
  assert.deepEqual(await listWarnings(GID, OTHER_MEMBER), []);
  const audit = await auditRows(GID, 'moderation:warn-clear');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail, `2 for ${OTHER_MEMBER}`);

  assert.equal((await api.post('/moderation/warnings/clear', { userId: OTHER_MEMBER })).status, 404);
});

// --- channel locks ----------------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /moderation/lock-all locks the text channels via the fake overwrites"
test('lock-all locks the text and announcement channels, unlock-channel and unlock-all lift them', async () => {
  app.sink.channelEdits.length = 0;
  const lock = await api.post('/moderation/lock-all');
  assert.equal(lock.status, 200);
  assert.equal((await lock.json()).locked, 3);

  assert.deepEqual(
    (await guildChannelLocks(GID)).map((r) => r.channel_id).sort(),
    [CH.general, CH.bots, CH.announce].sort()
  );
  assert.ok(app.sink.channelEdits.length >= 3, 'every locked channel had its overwrite edited');
  assert.ok(!(await isChannelLocked(GID, CH.voice)), 'voice channels are left alone');
  const lockdown = await auditRows(GID, 'moderation:lockdown');
  assert.equal(lockdown.length, 1);
  assert.equal(lockdown[0].detail, 'locked 3 channel(s)');
  const hub = await (await api.get('/moderation')).json();
  assert.equal(hub.lockdownActive, true);
  assert.equal(hub.channelLocks.length, 3);

  // A second lock-all finds nothing new to lock.
  assert.equal((await (await api.post('/moderation/lock-all')).json()).locked, 0);

  const one = await api.post('/moderation/unlock-channel', { channelId: CH.bots });
  assert.equal(one.status, 200);
  assert.ok(!(await isChannelLocked(GID, CH.bots)));
  const unlocked = await auditRows(GID, 'moderation:unlock');
  assert.equal(unlocked.length, 1);
  assert.equal(unlocked[0].detail, '#bots');
  // That channel is not locked any more: unlocking it again, or a junk id, is refused.
  assert.equal((await api.post('/moderation/unlock-channel', { channelId: CH.bots })).status, 404);
  assert.equal((await api.post('/moderation/unlock-channel', { channelId: 'nope' })).status, 404);

  const all = await api.post('/moderation/unlock-all');
  assert.equal(all.status, 200);
  assert.equal((await all.json()).unlocked, 2);
  assert.deepEqual(await guildChannelLocks(GID), []);
  assert.deepEqual((await auditRows(GID, 'moderation:lockdown')).map((r) => r.detail).sort(), [
    'locked 0 channel(s)',
    'locked 3 channel(s)',
    'unlocked 2 channel(s)',
  ]);
});

// --- unban ------------------------------------------------------------------------------------

// replaces dashboardRoutes.test.js: "a POST without a body is handled, not a server error" (unban route)
test('unban lifts a ban, and refuses a bad id or a user who is not banned', async () => {
  const removed = [];
  const realFetch = app.guild.bans.fetch;
  const realRemove = app.guild.bans.remove;
  app.guild.bans.fetch = async (id) => {
    if (!id) return new Map();
    return id === MEMBER_ID ? { user: { id, tag: 'user#0001' }, reason: 'spam' } : null;
  };
  app.guild.bans.remove = async (id, reason) => removed.push({ id, reason });
  try {
    assert.equal((await api.post('/moderation/unban', { userId: 'garbage' })).status, 400);
    assert.equal((await api.post('/moderation/unban', { userId: OTHER_MEMBER })).status, 404);
    assert.deepEqual(removed, []);

    const res = await api.post('/moderation/unban', { userId: MEMBER_ID });
    assert.equal(res.status, 200);
    assert.deepEqual(removed, [{ id: MEMBER_ID, reason: 'Dashboard: unbanned via dashboard' }]);

    // An empty body is a refusal, not a server error.
    const empty = await fetch(`${app.base}/api/v2/guilds/${GID}/moderation/unban`, { method: 'POST' });
    assert.notEqual(empty.status, 500);
  } finally {
    app.guild.bans.fetch = realFetch;
    app.guild.bans.remove = realRemove;
  }
});

// --- automod immunity -------------------------------------------------------------------------

// There was no classic test for the immunity route; its stored effect and audit row are covered here.
test('automod immunity roles replace the stored list, keep the rest of the config, and are audited', async () => {
  await setGuildModule(GID, 'automod', { config: { timeoutMinutes: 7 } });
  const roles = ['100000000000000700', '100000000000000042'];
  const res = await api.post('/modules/automod/immunity', { exemptRoles: [...roles, 'junk', 12] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).exemptRoles, roles);

  const stored = (await getGuildModule(GID, 'automod')).config;
  assert.deepEqual(stored.exemptRoles, roles);
  assert.equal(stored.timeoutMinutes, 7, 'the other automod settings are kept');
  const audit = await auditRows(GID, 'module:automod');
  assert.equal(audit.at(0).detail, 'immunity roles (2)');

  // Sending none clears them.
  assert.deepEqual((await (await api.post('/modules/automod/immunity', {})).json()).exemptRoles, []);
  assert.deepEqual((await getGuildModule(GID, 'automod')).config.exemptRoles, []);
});

// --- ban appeals ------------------------------------------------------------------------------

// There was no classic test for deciding an appeal; stored decision, audit row and refusals are covered here.
test('deciding an appeal stores the decision, DMs the person, audits it and cannot be repeated', async () => {
  const accept = await createAppeal(GID, { userId: MEMBER_ID, userTag: 'user#0001', answers: [] });
  const deny = await createAppeal(GID, { userId: OTHER_MEMBER, userTag: 'other#0002', answers: [] });
  app.sink.dms.length = 0;

  const listed = await (await api.get('/appeals')).json();
  assert.equal(listed.open, 2);

  assert.equal((await api.post(`/appeals/${accept}/decide`, { decision: 'maybe' })).status, 400);
  assert.equal((await getAppeal(GID, accept)).status, 'open');

  const res = await api.post(`/appeals/${accept}/decide`, { decision: 'accept', reason: 'welcome back' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'accepted');
  const row = await getAppeal(GID, accept);
  assert.equal(row.status, 'accepted');
  assert.equal(row.decided_by, 'Dashboard');
  assert.equal(row.decision_reason, 'welcome back');
  assert.ok(
    app.sink.dms.some((d) => d.id === MEMBER_ID),
    'the person is told'
  );

  const denied = await api.post(`/appeals/${deny}/decide`, { decision: 'deny' });
  assert.equal(denied.status, 200);
  const deniedRow = await getAppeal(GID, deny);
  assert.equal(deniedRow.status, 'denied');
  assert.equal(deniedRow.decision_reason, 'No reason given');

  const audit = await auditRows(GID, 'appeal:accepted');
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, new RegExp(`^#${accept} user#0001`));
  assert.equal((await auditRows(GID, 'appeal:denied')).length, 1);

  // Deciding twice, or an appeal that is not there, is refused.
  assert.equal((await api.post(`/appeals/${accept}/decide`, { decision: 'deny' })).status, 409);
  assert.equal((await getAppeal(GID, accept)).status, 'accepted');
  assert.equal((await api.post('/appeals/99999/decide', { decision: 'deny' })).status, 409);
  assert.equal((await (await api.get('/appeals')).json()).open, 0);
});

// --- command limits ---------------------------------------------------------------------------

// There was no classic test for command overrides; stored override, audit rows and refusals are covered here.
test('command limits are stored per command with an audit row, and unknown commands are refused', async () => {
  const roleId = '100000000000000700';
  const res = await api.post('/commands/ping', {
    enabled: true,
    channels: [CH.general, 'junk'],
    roles: `${roleId}, nope`,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await getCommandOverride(GID, 'ping'), {
    command: 'ping',
    enabled: true,
    allowedChannels: [CH.general],
    allowedRoles: [roleId],
  });
  const updated = await auditRows(GID, 'command:/ping');
  assert.equal(updated[0].detail, 'updated limits');

  const off = await api.post('/commands/ban', { enabled: false });
  assert.equal(off.status, 200);
  assert.equal((await getCommandOverride(GID, 'ban')).enabled, false);
  assert.equal((await auditRows(GID, 'command:/ban'))[0].detail, 'disabled');

  const listed = await (await api.get('/commands')).json();
  assert.equal(listed.commands.find((c) => c.name === 'ban').enabled, false);
  assert.deepEqual(listed.commands.find((c) => c.name === 'ping').allowedChannels, [CH.general]);

  assert.equal((await api.post('/commands/not-a-command', { enabled: false })).status, 404);
  assert.equal(await getCommandOverride(GID, 'not-a-command'), null);
});
