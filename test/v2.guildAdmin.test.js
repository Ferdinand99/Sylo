// Server and bot-wide admin pages through the new dashboard's API: leaderboard settings, server
// insights, the bot personalizer and the database snapshots. Stored effects and audit rows are
// asserted; who may call them (non-admins, other servers, non-operators) is in
// v2.permissions.test.js. The classic dashboard's tests for these are being removed.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGuildModule } from '../src/db/modules.js';
import { getComposed } from '../src/db/composedMessages.js';
import { getBotMasterRoles, getGuildSettings, guildEmbedColor } from '../src/db/guildSettings.js';
import { accrueDaily, accrueHourly, utcDay, utcHour } from '../src/db/insights.js';
import { _internals as insights } from '../src/modules/insights.js';
import { setVanitySlug, getVanitySlug } from '../src/db/leaderboardVanity.js';
import { getPresenceConfig, getAnnouncement } from '../src/db/appSettings.js';
import { listBotAudit } from '../src/db/botAudit.js';
import { backupDir } from '../src/db/backup.js';
import { getAfk, setAfk } from '../src/db/afk.js';
import { addWarning, listWarnings } from '../src/db/modCases.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

// --- server settings -------------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /settings saves and redirects"
test('server settings store the bot masters, mod-log channel and embed colour, and write an audit row', async () => {
  const res = await api.post('/settings', {
    botMasterRoleIds: [ROLE.admin],
    modlogChannelId: CH.bots,
    embedColor: '#112233',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await getBotMasterRoles(GID), [ROLE.admin]);
  assert.equal((await getGuildSettings(GID)).modlog_channel_id, CH.bots);
  assert.equal(await guildEmbedColor(GID), 0x112233);
  const audit = (await auditRows(GID, 'settings:server'))[0];
  assert.equal(audit.detail, 'saved');
  assert.equal(audit.actor, 'Dashboard');

  const read = await (await api.get('/settings')).json();
  assert.deepEqual(read.botMasterRoleIds, [ROLE.admin]);
  assert.equal(read.modlogChannelId, CH.bots);
  assert.equal(read.embedColorHex, '#112233');

  // An unknown channel or a malformed colour is refused and changes nothing.
  assert.equal((await api.post('/settings', { modlogChannelId: '100000000000009999' })).status, 400);
  assert.equal((await api.post('/settings', { modlogChannelId: CH.bots, embedColor: 'zzz' })).status, 400);
  assert.equal(await guildEmbedColor(GID), 0x112233);
});

// --- leaderboard settings ---------------------------------------------------------------------

// There was no classic test for the leaderboard settings; the stored switch, the vanity address and
// their audit rows are covered here.
test('the public-leaderboard switch is stored with the rest of the leveling config and audited', async () => {
  await api.post('/modules/leveling/config', { announceMode: 'off' });
  const on = await api.post('/leaderboard/public', { publicLeaderboard: true });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { publicLeaderboard: true });
  assert.equal((await getGuildModule(GID, 'leveling')).config.publicLeaderboard, true);
  assert.equal((await auditRows(GID, 'leveling:leaderboard'))[0].detail, 'made public');
  assert.equal((await (await api.get('/leaderboard')).json()).publicLeaderboard, true);

  await api.post('/leaderboard/public', {});
  assert.equal((await getGuildModule(GID, 'leveling')).config.publicLeaderboard, false);
  assert.equal((await auditRows(GID, 'leveling:leaderboard'))[0].detail, 'made private');
});

test('a vanity address is cleaned, claimed once, cleared with a blank slug, and audited', async () => {
  await setVanitySlug('900000000000000999', 'taken-by-another');

  const set = await api.post('/leaderboard/vanity', { slug: '  My Server!! ' });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { vanitySlug: 'my-server' });
  assert.equal(await getVanitySlug(GID), 'my-server');
  assert.equal((await auditRows(GID, 'leveling:vanity'))[0].detail, '/lb/my-server');

  const taken = await api.post('/leaderboard/vanity', { slug: 'taken-by-another' });
  assert.equal(taken.status, 400);
  assert.equal((await taken.json()).error, 'taken');
  assert.equal((await api.post('/leaderboard/vanity', { slug: '!' })).status, 400);
  assert.equal(await getVanitySlug(GID), 'my-server', 'a refused slug changes nothing');

  const cleared = await api.post('/leaderboard/vanity', { slug: '' });
  assert.deepEqual(await cleared.json(), { vanitySlug: null });
  assert.equal(await getVanitySlug(GID), null);
  assert.equal((await auditRows(GID, 'leveling:vanity'))[0].detail, 'cleared');
});

// --- insights ---------------------------------------------------------------------------------

// replaces routes.guilds.test.js: "GET /insights renders the activity charts panel"
test('insights read back the daily and hourly activity with channel names', async () => {
  await accrueDaily(GID, utcDay(), {
    messages: 42,
    activeCount: 5,
    voiceMinutes: 180,
    voicePeak: 4,
    channels: { [CH.general]: 30, [CH.bots]: 12 },
    voiceChannels: { [CH.voice]: 180 },
  });
  await accrueHourly(GID, utcHour(), { messages: 7, voiceMinutes: 25 });

  const daily = await (await api.get('/insights?range=7')).json();
  assert.equal(daily.range, 7);
  assert.equal(daily.granularity, 'day');
  assert.equal(daily.series.length, 7);
  assert.equal(daily.totals.messages, 42);
  assert.equal(daily.totals.voiceMinutes, 180);
  assert.equal(daily.totals.peakActive, 5);
  assert.deepEqual(daily.topChannels, [
    { name: 'general', messages: 30 },
    { name: 'bots', messages: 12 },
  ]);
  assert.deepEqual(daily.topVoice, [{ name: 'Voice', minutes: 180 }]);

  const hourly = await api.get('/insights?range=24');
  assert.equal(hourly.status, 200);
  const body = await hourly.json();
  assert.equal(body.granularity, 'hour');
  assert.equal(body.series.length, 24);
  assert.equal(body.totals.messages, 7);

  assert.equal(
    (await (await api.get('/insights?range=bogus')).json()).range,
    30,
    'an unknown range falls back to 30 days'
  );
});

// replaces routes.guilds.test.js: "POST /insights/refresh flushes the buffer and redirects back"
test('insights refresh flushes the in-memory counters into the stored day', async () => {
  insights.buf.clear();
  const slot = await insights.slot(GID);
  slot.messages = 11;
  const before = (await (await api.get('/insights?range=7')).json()).totals.messages;

  const res = await api.post('/insights/refresh');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const after = (await (await api.get('/insights?range=7')).json()).totals.messages;
  assert.equal(after - before, 11);
});

// --- bot personalizer -------------------------------------------------------------------------

// replaces routes.misc.test.js: "POST /settings/presence saves"
test('the personalizer presence is stored and audited bot-wide', async () => {
  const res = await api.postRoot('/personalizer/presence', {
    status: 'idle',
    type: 'Watching',
    text: 'the server',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await getPresenceConfig(), { status: 'idle', type: 'Watching', text: 'the server' });
  const [row] = await listBotAudit(5);
  assert.equal(row.action, 'personalizer:presence');
  assert.equal(row.detail, 'idle / Watching / the server');
  assert.equal(row.actor, 'Dashboard');
  assert.equal((await (await api.getRoot('/personalizer/presence')).json()).presence.text, 'the server');
});

// replaces routes.misc.test.js: "POST /settings/identity with no changes says "nothing to change"" and "POST /settings/identity rejects a 1-character username"
test('the personalizer identity reports nothing to change, and refuses a 1-character username', async () => {
  const before = (await listBotAudit(50)).length;

  const none = await api.postRoot('/personalizer/identity', {});
  assert.equal(none.status, 200);
  assert.deepEqual(await none.json(), { done: [], failed: [] });

  const short = await api.postRoot('/personalizer/identity', { username: 'x' });
  assert.equal(short.status, 200);
  const body = await short.json();
  assert.deepEqual(body.done, []);
  assert.match(body.failed[0], /^username \(2–32 characters\)/);

  const insecure = await api.postRoot('/personalizer/identity', {
    avatarUrl: 'http://insecure.example/a.png',
  });
  assert.match((await insecure.json()).failed[0], /^avatar \(must be an https image URL\)/);

  assert.equal((await listBotAudit(50)).length, before, 'a change that did not happen is not audited');
});

test('the personalizer announcement is published, shown to everyone, and cleared, with audit rows', async () => {
  const res = await api.postRoot('/personalizer/announcement', {
    title: 'Maintenance',
    body: 'Tonight',
    severity: 'warning',
  });
  assert.equal(res.status, 200);
  assert.equal((await getAnnouncement()).title, 'Maintenance');
  assert.equal((await getAnnouncement()).severity, 'warning');
  assert.equal((await (await api.getRoot('/announcement')).json()).announcement.body, 'Tonight');
  assert.match((await listBotAudit(1))[0].detail, /^published \(warning\): Maintenance$/);

  const cleared = await api.postRoot('/personalizer/announcement/clear');
  assert.deepEqual(await cleared.json(), { announcement: null });
  assert.equal(await getAnnouncement(), null);
  assert.equal((await listBotAudit(1))[0].detail, 'cleared');

  // A blank title clears too.
  await api.postRoot('/personalizer/announcement', { title: 'Again' });
  await api.postRoot('/personalizer/announcement', { title: '  ' });
  assert.equal(await getAnnouncement(), null);
});

// --- database snapshots -----------------------------------------------------------------------

// replaces routes.misc.test.js: "POST /health/backups creates a snapshot"
test('a snapshot is created, listed on the health page, and deleted', async () => {
  const made = await api.postRoot('/health/backups');
  assert.equal(made.status, 200);
  const { name } = await made.json();
  assert.match(name, /^sylo-manual-.*\.db$/);
  assert.ok(existsSync(join(backupDir(), name)), 'the file exists');

  const health = await (await api.getRoot('/health')).json();
  assert.ok(
    health.backups.some((b) => b.name === name),
    'the snapshot is in the list'
  );

  const gone = await api.postRoot(`/health/backups/${name}/delete`);
  assert.equal(gone.status, 200);
  assert.ok(!existsSync(join(backupDir(), name)), 'the file is gone');
  assert.ok(!(await (await api.getRoot('/health')).json()).backups.some((b) => b.name === name));
});

test('snapshot names that are not snapshot file names are refused, and nothing outside the folder is touched', async () => {
  const outside = join(backupDir(), '..', 'sylo-outside.db');
  writeFileSync(outside, 'keep me');
  try {
    for (const bad of ['notes.txt', 'sylo-x.exe', '..%2Fsylo-outside.db', 'sylo-%2e%2e%2Fsylo-outside.db']) {
      const download = await api.getRoot(`/health/backups/${bad}`);
      assert.equal(download.status, 400, `download ${bad}`);
      const del = await api.postRoot(`/health/backups/${bad}/delete`);
      assert.equal(del.status, 200, `delete ${bad} is a quiet no-op`);
    }
    assert.ok(existsSync(outside), 'a file outside the snapshot folder survives');
    assert.equal((await api.getRoot('/health/backups/sylo-manual-nope.db')).status, 404);
  } finally {
    rmSync(outside, { force: true });
  }
});

// --- composed messages and tickets ------------------------------------------------------------

// replaces routes.misc.test.js: "POST /guilds/:id/messages/new saves a draft"
test('a composed message is saved as a draft, listed, and not posted until it is published', async () => {
  app.sink.messages.length = 0;
  const res = await api.post('/messages/new', {
    name: 'Harness draft',
    action: 'save',
    spec: { content: 'hello from the harness' },
  });
  assert.equal(res.status, 200);
  const { rec, status } = await res.json();
  assert.equal(status, 'saved');
  assert.equal(rec.name, 'Harness draft');
  assert.equal(rec.messageId, null);
  assert.equal(rec.spec.content, 'hello from the harness');
  assert.deepEqual(app.sink.messages, [], 'a draft is not posted');

  const stored = await getComposed(GID, rec.id);
  assert.equal(stored.name, 'Harness draft');
  const listed = await (await api.get('/messages')).json();
  assert.ok(listed.items.some((i) => i.id === rec.id));

  // Publishing without a channel is refused, the draft is kept.
  const noChannel = await api.post(`/messages/${rec.id}`, { action: 'publish', spec: rec.spec });
  assert.equal(noChannel.status, 400);
  assert.deepEqual(app.sink.messages, []);

  assert.equal(
    (await api.post('/messages/new', { name: 'x', action: 'save' })).status,
    400,
    'a spec is required'
  );
  assert.equal((await api.post('/messages/999999', { action: 'save', spec: {} })).status, 404);
});

// replaces routes.misc.test.js: "POST /guilds/:id/tickets/:id/close on an unknown ticket bounces to the list"
test('closing a ticket that does not exist is a 404', async () => {
  const res = await api.post('/tickets/999999/close');
  assert.equal(res.status, 404);
});

// --- member data ------------------------------------------------------------------------------

// replaces dashboardRoutes.test.js: "POST /member-data/forget deletes the data, DMs the member, and redirects"
// (also: "POST /member-data/forget without the confirm box does nothing")
test('forgetting a member deletes their data, keeps moderation cases, DMs them and is audited', async () => {
  const member = '900000000000007777';
  await setAfk(GID, member, { reason: 'brb', oldNick: null });
  await addWarning({ guildId: GID, userId: member, moderatorId: 'mod', reason: 'x' });
  app.sink.dms.length = 0;

  const lookup = await (await api.get(`/member-data?user=${member}`)).json();
  assert.equal(lookup.lookup.profile.id, member);

  const noConfirm = await api.post('/member-data/forget', { userId: member });
  assert.equal(noConfirm.status, 400);
  assert.ok(await getAfk(GID, member), 'nothing is deleted without the confirmation');

  const res = await api.post('/member-data/forget', {
    userId: member,
    confirm: true,
    reason: 'at their request',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dmDelivered, true);
  assert.equal(await getAfk(GID, member), null);
  assert.equal((await listWarnings(GID, member)).length, 1, 'moderation cases are safety records and stay');
  assert.equal(app.sink.dms.length, 1);
  assert.equal(app.sink.dms[0].id, member);
  assert.match(
    (await auditRows(GID, 'privacy:member-data'))[0].detail,
    /^deleted data for 900000000000007777/
  );
});
