// Module settings saved through the new dashboard's API: the stored config and the audit row for
// each save, the module switches (single and bulk), the GitHub watch rules and the role-menu
// checks. The classic dashboard's tests for these are being removed, so the side effects are
// asserted here.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { listGithubWatches } from '../src/db/githubWatches.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

const lastAudit = async (action) => (await auditRows(GID, action))[0];

// --- welcome ----------------------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /m/:id/test — sends for a configured testable module"
test('welcome saves its settings, writes an audit row, and the test message goes to the saved channel', async () => {
  const res = await api.post('/modules/welcome/config', {
    joinEnabled: true,
    joinChannel: CH.general,
    joinMessage: 'hi {user}',
  });
  assert.equal(res.status, 200);
  const stored = (await getGuildModule(GID, 'welcome')).config;
  assert.equal(stored.joinEnabled, true);
  assert.equal(stored.joinChannel, CH.general);
  assert.equal(stored.joinMessage, 'hi {user}');
  const audit = await lastAudit('module:welcome');
  assert.equal(audit.detail, 'settings saved');
  assert.equal(audit.actor, 'Dashboard');

  app.sink.messages.length = 0;
  const sent = await api.post('/modules/welcome/test');
  assert.equal(sent.status, 200);
  assert.equal(app.sink.messages.length, 1);
  assert.equal(app.sink.messages[0].channel, CH.general);
});

// replaces routes.guilds.test.js: "POST /m/welcome/config — a toggle stays checked after saving with a channel but no message yet"
test('welcome: a toggle stays on after saving with a channel but no message yet (#197)', async () => {
  const res = await api.post('/modules/welcome/config', {
    leaveEnabled: true,
    leaveChannel: CH.general,
    // leaveMessage deliberately omitted
  });
  assert.equal(res.status, 200);
  assert.equal((await getGuildModule(GID, 'welcome')).config.leaveEnabled, true);
  const read = (await (await api.get('/modules/welcome/config')).json()).config;
  assert.equal(read.leaveEnabled, true);
  assert.equal(read.leaveChannel, CH.general);
  assert.equal(read.leaveMessage, '');
});

// replaces routes.guilds.test.js: 'POST /m/welcome/config — "Give roles to new members" stays checked after saving with no role picked yet'
test('welcome: "give roles to new members" stays on with no role picked, and picked roles land in the roles module', async () => {
  let res = await api.post('/modules/welcome/config', { autoroleEnabled: true });
  assert.equal(res.status, 200);
  assert.equal((await (await api.get('/modules/welcome/config')).json()).config.autoroleEnabled, true);

  res = await api.post('/modules/welcome/config', {
    autoroleEnabled: true,
    autoroles: [ROLE.member, 'junk'],
  });
  assert.equal(res.status, 200);
  const roles = await getGuildModule(GID, 'roles');
  assert.deepEqual(roles.config.autoroles, [ROLE.member]);
  assert.equal(roles.enabled, true);

  // Turning it off empties the list again.
  await api.post('/modules/welcome/config', { autoroleEnabled: false, autoroles: [ROLE.member] });
  assert.deepEqual((await getGuildModule(GID, 'roles')).config.autoroles, []);
});

// replaces routes.guilds.test.js: "POST /m/welcome/config — a toggle stays checked after saving with a channel but no message yet" (limits)
test('welcome: a long message is cut, an off section is cleared, and a card background must be https', async () => {
  await api.post('/modules/welcome/config', {
    joinEnabled: true,
    joinChannel: CH.general,
    joinMessage: 'x'.repeat(2000),
    leaveEnabled: false,
    leaveChannel: CH.general,
    leaveMessage: 'bye',
    cardBackground: 'http://insecure.example/a.png',
  });
  const stored = (await getGuildModule(GID, 'welcome')).config;
  assert.equal(stored.joinMessage.length, 1500);
  assert.equal(stored.leaveChannel, '');
  assert.equal(stored.leaveMessage, '');
  assert.equal(stored.cardBackground, '');

  await api.post('/modules/welcome/config', { cardBackground: 'https://ok.example/a.png' });
  assert.equal((await getGuildModule(GID, 'welcome')).config.cardBackground, 'https://ok.example/a.png');
});

// --- sticky, kick, rss ------------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /m/sticky/config keeps the per-channel app + cooldown options"
test('sticky keeps the per-channel bot-repost and cooldown options, and keeps the posted message id', async () => {
  await setGuildModule(GID, 'sticky', {
    config: { stickies: [{ channelId: CH.general, content: 'old', lastMessageId: '555' }] },
  });
  const res = await api.post('/modules/sticky/config', {
    stickies: [{ channelId: CH.general, content: 'read the rules', repostOnBots: true, cooldownSeconds: 90 }],
  });
  assert.equal(res.status, 200);
  const [row] = (await getGuildModule(GID, 'sticky')).config.stickies;
  assert.equal(row.channelId, CH.general);
  assert.equal(row.content, 'read the rules');
  assert.equal(row.repostOnBots, true);
  assert.equal(row.cooldownSeconds, 90);
  assert.equal(row.lastMessageId, '555', 'the bot-managed message id survives a save');
  assert.equal((await lastAudit('module:sticky')).detail, 'settings saved');
});

// replaces routes.guilds.test.js: "POST /m/kick-alerts/config stores a cleaned alert list"
test('kick alerts store a cleaned alert list', async () => {
  const res = await api.post('/modules/kick-alerts/config', {
    alerts: [
      { slug: 'xQc', channelId: CH.general, roleId: '', message: '' },
      { slug: 'no-channel', channelId: '' },
      { slug: 'xqc', channelId: CH.general },
    ],
  });
  assert.equal(res.status, 200);
  const stored = (await getGuildModule(GID, 'kick-alerts')).config;
  assert.equal(stored.alerts.length, 1, 'a row without a channel and a duplicate are dropped');
  assert.equal(stored.alerts[0].slug, 'xqc');
  assert.equal(stored.alerts[0].channelId, CH.general);
  assert.equal((await lastAudit('module:kick-alerts')).detail, 'settings saved');
});

// replaces routes.guilds.test.js: "POST /m/rss/config resolves a friendly handle to a feed URL"
test('rss resolves a friendly handle to a feed URL', async () => {
  const res = await api.post('/modules/rss/config', {
    feeds: [
      { id: '', type: 'reddit', ref: 'r/programming', channelId: CH.general, roleId: '', template: '' },
    ],
  });
  assert.equal(res.status, 200);
  const [feed] = (await getGuildModule(GID, 'rss')).config.feeds;
  assert.equal(feed.type, 'reddit');
  assert.equal(feed.ref, 'r/programming');
  assert.equal(feed.url, 'https://www.reddit.com/r/programming/new/.rss');
  assert.equal(feed.channelId, CH.general);
  assert.equal((await lastAudit('module:rss')).detail, 'settings saved');
});

// --- automod ----------------------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /m/automod/config pushes and later removes native AutoMod rules"
test('automod pushes native rules once, ignores an unchanged save, and removes them when native is turned off', async () => {
  app.sink.automodRules.length = 0;
  await setGuildModule(GID, 'automod', { config: { exemptRoles: [ROLE.member] } });
  const body = {
    timeoutMinutes: 5,
    rules: { words: { enabled: true, action: 'delete', list: 'badword, another' } },
    native: { enabled: true, words: true },
  };

  const on = await api.post('/modules/automod/config', body);
  assert.equal(on.status, 200);
  assert.match((await on.json()).nativeNote, /native rules \+1/);
  assert.equal(app.sink.automodRules.length, 1);
  assert.equal(app.sink.automodRules[0].name, 'Sylo: bad words');
  assert.deepEqual(app.sink.automodRules[0].triggerMetadata.keywordFilter, ['*badword*', '*another*']);

  const stored = (await getGuildModule(GID, 'automod')).config;
  assert.equal(stored.timeoutMinutes, 5);
  assert.deepEqual(stored.rules.words.list, ['badword', 'another']);
  assert.deepEqual(stored.exemptRoles, [ROLE.member], 'immunity roles are not touched by this form');
  assert.equal((await lastAudit('module:automod')).detail, 'settings saved');

  // Saving again with no change is a no-op.
  await api.post('/modules/automod/config', body);
  assert.equal(app.sink.automodRules.length, 1);

  // Turning native enforcement off tears the rule down.
  await api.post('/modules/automod/config', { ...body, native: { enabled: false } });
  assert.equal(app.sink.automodRules.length, 0);
});

// --- module switches --------------------------------------------------------------------------

// replaces routes.guilds.test.js: "POST /modules/:id single toggle (htmx grid path) returns the CTA fragment"
test('a single module switch stores the state and writes an audit row; an unknown module is a 404', async () => {
  const on = await api.post('/modules/afk', { enabled: true });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { enabled: true });
  assert.equal((await getGuildModule(GID, 'afk')).enabled, true);
  assert.equal((await lastAudit('module:afk')).detail, 'enabled');

  await api.post('/modules/afk', { enabled: false });
  assert.equal((await getGuildModule(GID, 'afk')).enabled, false);
  assert.equal((await lastAudit('module:afk')).detail, 'disabled');

  assert.equal((await api.post('/modules/made-up', { enabled: true })).status, 404);
});

// replaces routes.guilds.test.js: "POST /modules/bulk enables several and is not shadowed by :moduleId"
test('bulk switch enables several modules at once, is not read as a module id, and is audited', async () => {
  const res = await api.post('/modules/bulk', { ids: ['polls', 'afk', 'polls'], enabled: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.count, 2);
  assert.equal((await getGuildModule(GID, 'polls')).enabled, true);
  assert.equal((await getGuildModule(GID, 'afk')).enabled, true);
  assert.equal((await lastAudit('module:bulk')).detail, 'enabled 2 module(s)');

  const off = await api.post('/modules/bulk', { ids: ['polls'], enabled: false });
  assert.equal((await off.json()).enabled, false);
  assert.equal((await getGuildModule(GID, 'polls')).enabled, false);
  assert.equal((await getGuildModule(GID, 'afk')).enabled, true, 'modules not named are left alone');
});

// replaces routes.guilds.test.js: "POST /modules/bulk with only junk ids is a no-op count 0"
test('bulk switch with only junk ids changes nothing', async () => {
  const res = await api.post('/modules/bulk', { ids: ['made-up'], enabled: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).count, 0);
  assert.equal((await (await api.post('/modules/bulk', { enabled: true })).json()).count, 0);
});

// replaces routes.guilds.test.js: "POST /m/:id/test — "set a channel first" when unconfigured"
test('the test message of a module with no saved channel sends nothing', async () => {
  await api.post('/modules/free-games/config', {});
  app.sink.messages.length = 0;
  const res = await api.post('/modules/free-games/test');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).reason, 'no-channel');
  assert.deepEqual(app.sink.messages, []);
});

// replaces dashboardRoutes.test.js: "POST /m/afk/config with HX-Request returns the fragment + a toast trigger"
test('afk saves its options and an audit row', async () => {
  const res = await api.post('/modules/afk/config', {
    mentionReply: true,
    setNickname: false,
    ignoreChannels: [CH.bots, 'junk'],
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await getGuildModule(GID, 'afk')).config, {
    setNickname: false,
    mentionReply: true,
    ignoreChannels: [CH.bots],
  });
  assert.equal((await lastAudit('module:afk')).detail, 'settings saved');
});

// replaces routes.guilds.test.js: "POST /m/:id/config — no-JS redirect and htmx fragment + toast"
test('counting saves its channel and options and an audit row', async () => {
  const res = await api.post('/modules/counting/config', {
    channelId: CH.general,
    allowSameUser: true,
    penaltyMinutes: 99999,
  });
  assert.equal(res.status, 200);
  const stored = (await getGuildModule(GID, 'counting')).config;
  assert.equal(stored.channelId, CH.general);
  assert.equal(stored.allowSameUser, true);
  assert.equal(stored.penaltyMinutes, 10080);
  assert.equal((await lastAudit('module:counting')).detail, 'settings saved');
});

// --- GitHub watch rules -----------------------------------------------------------------------

const watch = (repo) => listGithubWatches(GID).then((rows) => rows.find((w) => w.repo === repo));

// replaces routes.githubDashboard.test.js: "saving a watch with no events checked and no changelog path is rejected"
test('a GitHub watch with no events and no changelog path is rejected and not stored', async () => {
  const res = await api.post('/modules/github/watches', { repo: 'o/r1', channelId: CH.general, events: [] });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /at least one event/);
  assert.equal(await watch('o/r1'), undefined);

  assert.equal(
    (await api.post('/modules/github/watches', { repo: 'nope', channelId: CH.general })).status,
    400
  );
  assert.equal(
    (await api.post('/modules/github/watches', { repo: 'o/r1' })).status,
    400,
    'a channel is needed'
  );
});

// replaces routes.githubDashboard.test.js: "saving a watch with only a changelog path (no events checked) succeeds"
test('a GitHub watch with only a changelog path is stored and audited', async () => {
  const res = await api.post('/modules/github/watches', {
    repo: 'o/r2',
    channelId: CH.general,
    changelogPath: 'CHANGELOG.md',
  });
  assert.equal(res.status, 200);
  const row = await watch('o/r2');
  assert.ok(row);
  assert.deepEqual(row.events, []);
  assert.equal(row.changelog_path, 'CHANGELOG.md');
  assert.equal((await lastAudit('module:github')).detail, 'added watch for o/r2');

  // A path that climbs out of the repo is refused.
  const bad = await api.post('/modules/github/watches', {
    repo: 'o/r2b',
    channelId: CH.general,
    changelogPath: '../secret',
    events: ['push'],
  });
  assert.equal(bad.status, 400);
  assert.equal(await watch('o/r2b'), undefined);
});

// replaces routes.githubDashboard.test.js: "saving a watch with only an event checked (no changelog path) still succeeds"
test('a GitHub watch with only an event is stored without a changelog path', async () => {
  const res = await api.post('/modules/github/watches', {
    repo: 'o/r3',
    channelId: CH.general,
    events: ['release'],
  });
  assert.equal(res.status, 200);
  const row = await watch('o/r3');
  assert.deepEqual(row.events, ['release']);
  assert.equal(row.changelog_path, null);
});

// replaces routes.githubDashboard.test.js: "editing an existing watch down to zero events but keeping a changelog path still succeeds"
test('a GitHub watch can be edited down to zero events while it keeps a changelog path', async () => {
  const created = await api.post('/modules/github/watches', {
    repo: 'o/r4',
    channelId: CH.general,
    roleId: ROLE.member,
    changelogPath: 'CHANGELOG.md',
    events: ['push'],
  });
  const { watch: made } = await created.json();

  const res = await api.post(`/modules/github/watches/${made.id}`, {
    repo: 'o/r4',
    channelId: CH.general,
    roleId: ROLE.member,
    changelogPath: 'CHANGELOG.md',
    // no events at all this time
  });
  assert.equal(res.status, 200);
  const row = await watch('o/r4');
  assert.deepEqual(row.events, []);
  assert.equal(row.changelog_path, 'CHANGELOG.md');
  assert.equal(row.role_id, ROLE.member);
  assert.equal((await lastAudit('module:github')).detail, 'updated watch for o/r4');

  // ... but not down to nothing at all.
  const empty = await api.post(`/modules/github/watches/${made.id}`, { repo: 'o/r4', channelId: CH.general });
  assert.equal(empty.status, 400);
  assert.equal((await watch('o/r4')).changelog_path, 'CHANGELOG.md', 'the refused save changed nothing');

  assert.equal(
    (await api.post('/modules/github/watches/99999', { repo: 'o/r4', channelId: CH.general })).status,
    404
  );
});

// --- role menus: validation errors -----------------------------------------------------------

const rr = (body) => api.post('/modules/roles/rr', { channelId: CH.general, style: 'reaction', ...body });
const rrError = async (res) => {
  assert.equal(res.status, 400);
  return (await res.json()).error;
};
const savedMenus = async () => (await getGuildModule(GID, 'roles')).config.reactionMessages ?? [];

// replaces routes.rrBuilder.test.js: "POST /m/roles/rr — missing channel re-renders the form with the typed row preserved, not a redirect"
test('a role menu with no channel is refused with a field error and stores nothing', async () => {
  const before = (await savedMenus()).length;
  const res = await api.post('/modules/roles/rr', {
    style: 'reaction',
    pairs: [{ emoji: '👍', roleId: ROLE.member }],
  });
  assert.match(await rrError(res), /Pick a channel\./);
  assert.equal((await savedMenus()).length, before);
});

// replaces routes.rrBuilder.test.js: "POST /m/roles/rr — a role picked with no emoji (reaction style) reports which row, keeps the role picked"
test('a role with no emoji in the reaction style names the row at fault', async () => {
  const res = await rr({ pairs: [{ emoji: '', roleId: ROLE.member }] });
  assert.match(await rrError(res), /Row 1: enter a valid emoji/);
});

// replaces routes.rrBuilder.test.js: "POST /m/roles/rr — a second row with only a role (no emoji) is flagged without dropping the valid first row"
test('only the second row is flagged when the first one is valid, and nothing is published', async () => {
  const before = app.sink.messages.length;
  const res = await rr({
    pairs: [
      { emoji: '👍', roleId: ROLE.member },
      { emoji: '', roleId: ROLE.admin },
    ],
  });
  const error = await rrError(res);
  assert.match(error, /Row 2: enter a valid emoji/);
  assert.doesNotMatch(error, /Row 1/);
  assert.equal(app.sink.messages.length, before, 'nothing was posted to the channel');
});

// replaces routes.rrBuilder.test.js: 'POST /m/roles/rr — no rows at all is reported as "add at least one role"'
test('a role menu with no rows is refused with "add at least one role"', async () => {
  assert.match(await rrError(await rr({ pairs: [] })), /Add at least one role\./);
  assert.match(await rrError(await rr({})), /Add at least one role\./);
});

// replaces routes.rrBuilder.test.js: "POST /m/roles/rr — a fully valid submission is not re-rendered with errors"
test('a valid role menu is stored, audited and posted to the channel', async () => {
  const before = app.sink.messages.length;
  const res = await rr({ style: 'buttons', pairs: [{ roleId: ROLE.member, label: 'Member' }] });
  assert.equal(res.status, 200);
  const { reactionMessage } = await res.json();
  assert.equal(reactionMessage.channelId, CH.general);
  assert.equal(reactionMessage.pairs[0].roleId, ROLE.member);
  assert.equal(app.sink.messages.length, before + 1);

  const [saved] = await savedMenus();
  assert.equal(saved.id, reactionMessage.id);
  assert.equal((await getGuildModule(GID, 'roles')).enabled, true);
  assert.equal((await lastAudit('module:roles')).detail, 'created reaction-role set');
});
