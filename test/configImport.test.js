// Import of a configuration export (routes/v2ConfigImport.js, lib/configImport.js): the preview changes
// nothing, ids of another server are cleared, every module goes through its own normaliser, the apply
// needs the typed word and is audited.
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID, CH, ROLE } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getGuildSettings } from '../src/db/guildSettings.js';
import { getCommandOverride } from '../src/db/commandOverrides.js';
import { IMPORTABLE_MODULES, diffConfig, ImportError, readExport } from '../src/web/lib/configImport.js';

let app;
let api;
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
});
test.after(() => app.close());

const FOREIGN_CH = '700000000000000001';
const FOREIGN_ROLE = '700000000000000002';
const FOREIGN_MSG = '700000000000000003';

const file = (over = {}) => ({
  sylo: 'guild-config-export',
  version: 1,
  exportedAt: '2026-11-01T00:00:00.000Z',
  guildId: '700000000000000099',
  settings: null,
  modules: [],
  commandOverrides: [],
  scheduledMessages: [],
  counting: null,
  ...over,
});
const preview = async (doc) => {
  const res = await api.post('/import/preview', { export: doc });
  return { res, body: await res.json() };
};
const apply = async (doc, items, confirm = 'IMPORT') => {
  const res = await api.post('/import/apply', { export: doc, items, confirm });
  return { res, body: await res.json() };
};
const item = (plan, key) => plan.items.find((i) => i.key === key);

test('the preview lists what changes, clears ids this server does not have, and writes nothing', async () => {
  await setGuildModule(GID, 'counting', { enabled: false, config: {} });
  const doc = file({
    modules: [
      {
        moduleId: 'counting',
        enabled: true,
        config: { channelId: FOREIGN_CH, react: false, penaltyRoleId: ROLE.member, penaltyMinutes: 30 },
      },
    ],
  });
  const { res, body } = await preview(doc);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.confirmWord, 'IMPORT');
  const counting = item(body, 'module:counting');
  assert.equal(counting.status, 'change');
  assert.equal(counting.cleared.channel, 1);
  assert.match(counting.notes.join(' '), /1 channel from the file is not in this server and was cleared/);
  const paths = counting.changes.map((c) => c.path);
  assert.deepEqual(paths.sort(), ['enabled', 'penaltyMinutes', 'penaltyRoleId']);
  assert.ok(!paths.includes('channelId'), 'the foreign channel is not a change');
  // nothing was written
  const stored = await getGuildModule(GID, 'counting');
  assert.equal(stored.enabled, false);
  assert.deepEqual(stored.config, {});
  assert.deepEqual(await auditRows(GID, 'import:config'), []);
});

test('apply needs the typed word, and without it nothing changes', async () => {
  const doc = file({ modules: [{ moduleId: 'afk', enabled: true, config: { setNickname: false } }] });
  for (const confirm of [undefined, 'import', 'IMPORT ']) {
    const res = await api.post('/import/apply', { export: doc, items: ['module:afk'], confirm });
    assert.equal(res.status, 400, `confirm ${JSON.stringify(confirm)}`);
  }
  assert.equal((await getGuildModule(GID, 'afk')).config.setNickname, undefined);
  const none = await api.post('/import/apply', { export: doc, items: [], confirm: 'IMPORT' });
  assert.equal(none.status, 400);
});

test('apply stores the normalised config, writes an audit row per item and one for the import', async () => {
  const doc = file({
    modules: [
      {
        moduleId: 'counting',
        enabled: true,
        config: {
          channelId: CH.general,
          react: false,
          allowSameUser: true,
          penaltyRoleId: FOREIGN_ROLE,
          penaltyMinutes: 99999,
          sneaky: 'not part of the config',
        },
      },
    ],
  });
  // JSON.parse makes "__proto__" an own key, which is what a hostile file would carry.
  const raw = JSON.parse(JSON.stringify(doc).replace('"sneaky"', '"__proto__":{"polluted":true},"sneaky"'));
  const { res, body } = await apply(raw, ['module:counting']);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.results, [{ key: 'module:counting', label: 'Counting', ok: true }]);
  const stored = await getGuildModule(GID, 'counting');
  assert.equal(stored.enabled, true);
  assert.equal(stored.config.channelId, CH.general);
  assert.equal(stored.config.react, false);
  assert.equal(stored.config.allowSameUser, true);
  assert.equal(stored.config.penaltyRoleId, '', 'the foreign role was cleared');
  assert.ok(stored.config.penaltyMinutes < 99999, 'a number out of range was clamped by the normaliser');
  assert.ok(!('sneaky' in stored.config), 'unknown keys are dropped by the normaliser');
  assert.equal({}.polluted, undefined);
  const audit = (await auditRows(GID, 'module:counting'))[0];
  assert.match(audit.detail, /imported from a file, turned on/);
  assert.equal(audit.actor, 'Dashboard');
  assert.match(
    (await auditRows(GID, 'import:config'))[0].detail,
    /imported 1 item from a configuration file/
  );
});

test('only the ticked items are applied, and an unchanged one is reported rather than written', async () => {
  const doc = file({
    modules: [
      { moduleId: 'birthdays', enabled: true, config: { channelId: CH.bots } },
      { moduleId: 'sticky', enabled: true, config: { stickies: [] } },
    ],
  });
  const before = await getGuildModule(GID, 'birthdays');
  const { body } = await apply(doc, ['module:sticky', 'module:nothing-here']);
  assert.equal(body.results.find((r) => r.key === 'module:sticky').ok, true);
  assert.deepEqual(
    body.results.find((r) => r.key === 'module:nothing-here'),
    { key: 'module:nothing-here', label: 'module:nothing-here', ok: false, error: 'Not in the file.' }
  );
  assert.deepEqual(await getGuildModule(GID, 'birthdays'), before, 'birthdays was not ticked');
  const again = await apply(doc, ['module:sticky']);
  assert.equal(again.body.results[0].ok, false);
  assert.equal(again.body.results[0].error, 'Nothing to change.');
});

test('the ids of posted messages of the other server are never stored', async () => {
  await setGuildModule(GID, 'verification', { enabled: false, config: { messageId: CH.announce } });
  const doc = file({
    modules: [
      {
        moduleId: 'verification',
        enabled: false,
        config: {
          mode: 'button',
          verifiedRoleId: ROLE.member,
          channelId: CH.general,
          messageId: FOREIGN_MSG,
        },
      },
    ],
  });
  const { body } = await preview(doc);
  assert.equal(item(body, 'module:verification').cleared.message, 1);
  assert.match(
    item(body, 'module:verification').notes.join(' '),
    /posted message of the other server is not carried over/
  );
  await apply(doc, ['module:verification']);
  const stored = (await getGuildModule(GID, 'verification')).config;
  // the module posts its own message after saving (as a normal save does); the other server's id is gone
  assert.notEqual(stored.messageId, FOREIGN_MSG);
  assert.equal(stored.channelId, CH.general);
});

test('channel and role mentions of another server are removed from text, the ones here stay', async () => {
  const doc = file({
    modules: [
      {
        moduleId: 'appeals',
        enabled: true,
        config: {
          appealMessage: `Vote in <#${FOREIGN_CH}> or <#${CH.general}> <@&${FOREIGN_ROLE}> <@&${ROLE.member}>`,
        },
      },
    ],
  });
  const { body } = await preview(doc);
  assert.equal(item(body, 'module:appeals').cleared.mention, 2);
  await apply(doc, ['module:appeals']);
  const stored = (await getGuildModule(GID, 'appeals')).config;
  assert.equal(stored.appealMessage, `Vote in  or <#${CH.general}>  <@&${ROLE.member}>`);
});

test('a module that cannot be imported, an unknown one and an operator-only one are skipped with a reason', async () => {
  const doc = file({
    modules: [
      { moduleId: 'custom-commands', enabled: true, config: { commands: [] } },
      { moduleId: 'reminders', enabled: true, config: {} },
      { moduleId: 'no-such-module', enabled: true, config: {} },
      { moduleId: 'apple-connect', enabled: true, config: { appId: 'x' } },
    ],
  });
  const { body } = await preview(doc);
  for (const id of ['custom-commands', 'reminders', 'no-such-module', 'apple-connect']) {
    const it = item(body, `module:${id}`);
    assert.equal(it.status, 'skip', id);
    assert.ok(it.notes[0].length > 10, id);
  }
  assert.match(item(body, 'module:apple-connect').notes[0], /operator/);
  const { body: applied } = await apply(doc, ['module:apple-connect', 'module:reminders']);
  assert.ok(applied.results.every((r) => r.ok === false));
  assert.equal((await getGuildModule(GID, 'apple-connect')).config.appId, undefined);
});

test('server settings: a colour is imported, a mod-log channel of another server is not, and Discord has no prefix', async () => {
  const doc = file({
    settings: { modlog_channel_id: FOREIGN_CH, embed_color: 0x112233, command_prefix: '!' },
  });
  const { body } = await preview(doc);
  const s = item(body, 'settings');
  assert.equal(s.status, 'change');
  assert.ok(s.notes.some((n) => /mod-log channel/.test(n)));
  assert.ok(s.notes.some((n) => /command prefix/.test(n)));
  const { body: applied } = await apply(doc, ['settings']);
  assert.equal(applied.results[0].ok, true);
  const stored = await getGuildSettings(GID);
  assert.equal(stored.embed_color, 0x112233);
  assert.ok(!stored.modlog_channel_id);
  assert.ok(!stored.command_prefix);
  assert.equal((await auditRows(GID, 'settings:server')).at(0).detail, 'imported from a file');
});

test('command limits: a known command is imported without foreign ids, an unknown one is skipped', async () => {
  const doc = file({
    commandOverrides: [
      {
        command: 'ban',
        enabled: false,
        allowedChannels: [CH.general, FOREIGN_CH],
        allowedRoles: [FOREIGN_ROLE],
      },
      { command: 'nonexistent', enabled: false, allowedChannels: [], allowedRoles: [] },
    ],
  });
  const { body } = await preview(doc);
  assert.equal(item(body, 'command:nonexistent').status, 'skip');
  assert.equal(item(body, 'command:ban').cleared.channel, 1);
  await apply(doc, ['command:ban']);
  assert.deepEqual(await getCommandOverride(GID, 'ban'), {
    command: 'ban',
    enabled: false,
    allowedChannels: [CH.general],
    allowedRoles: [],
  });
});

test('a file that is not an export, has another version, or is oversized is refused', async () => {
  for (const bad of [
    undefined,
    null,
    'text',
    [],
    {},
    { sylo: 'something-else', version: 1 },
    { sylo: 'guild-config-export', version: 2 },
    file({ modules: Array.from({ length: 101 }, (_, i) => ({ moduleId: `m${i}`, config: {} })) }),
    file({
      modules: [
        { moduleId: 'afk', config: {} },
        { moduleId: 'afk', config: {} },
      ],
    }),
    file({ modules: [{ moduleId: 'afk', config: { text: 'x'.repeat(200_000) } }] }),
    file({ commandOverrides: Array.from({ length: 301 }, (_, i) => ({ command: `c${i}` })) }),
  ]) {
    assert.throws(() => readExport(bad), ImportError, JSON.stringify(bad)?.slice(0, 60));
  }
  // the route answers it as the person's mistake
  const res = await api.post('/import/preview', { export: { sylo: 'something-else', version: 1 } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not a Sylo configuration export/);
  // nesting deeper than the walk allows
  let deep = {};
  for (let i = 0; i < 30; i += 1) deep = { a: deep };
  const nested = await api.post('/import/preview', {
    export: file({ modules: [{ moduleId: 'afk', config: deep }] }),
  });
  assert.equal(nested.status, 400);
});

test("importing a server's own export again changes nothing, for every module that can be imported", async () => {
  // Every importable module with an empty config, then exported and planned again: if a normaliser is not
  // idempotent on what it stored, that module shows up as a change.
  const empty = file({
    modules: IMPORTABLE_MODULES.map((moduleId) => ({ moduleId, enabled: false, config: {} })),
  });
  const first = await preview(empty);
  const keys = first.body.items.filter((i) => i.status === 'change').map((i) => i.key);
  const { body } = await apply(empty, keys);
  for (const r of body.results) assert.equal(r.ok, true, `${r.key}: ${r.error}`);

  const exported = await (await api.get('/export')).json();
  const again = await preview(exported);
  const changed = again.body.items.filter(
    (i) => i.status === 'change' && IMPORTABLE_MODULES.includes(i.key.slice('module:'.length))
  );
  assert.deepEqual(
    changed.map((i) => `${i.key}: ${i.changes.map((c) => c.path).join(',')}`),
    []
  );
});

test('a secret-looking field is masked in the preview', () => {
  const { changes } = diffConfig({ apiKey: 'old-value' }, { apiKey: 'new-value', note: 'hello' });
  assert.equal(changes.find((c) => c.path === 'apiKey').after, '••••••');
  assert.equal(changes.find((c) => c.path === 'note').after, 'hello');
});

test('the preview says what applying does besides saving: posting a message, syncing AutoMod', async () => {
  const doc = file({
    modules: [
      {
        moduleId: 'verification',
        enabled: true,
        config: { mode: 'button', verifiedRoleId: ROLE.member, channelId: CH.general },
      },
      {
        moduleId: 'honeypot',
        enabled: true,
        config: { messages: [{ channelId: CH.bots, bait: 'free nitro' }] },
      },
      { moduleId: 'automod', enabled: true, config: { native: { enabled: true } } },
    ],
  });
  const { body } = await preview(doc);
  assert.match(
    item(body, 'module:verification').notes.join(' '),
    /posts or updates the verification message in #general/
  );
  assert.match(
    item(body, 'module:honeypot').notes.join(' '),
    /posts or updates the bait message in 1 channel/
  );
  assert.match(item(body, 'module:automod').notes.join(' '), /native AutoMod rules/);
});

test('the importers match their settings routes: automod keeps deleteMessage on, auto-threads drops rules for non-text channels, welcome keeps its stored trigger', async () => {
  await setGuildModule(GID, 'welcome', {
    enabled: true,
    config: {
      trigger: 'role',
      triggerRoleIds: [ROLE.member],
      joinEnabled: true,
      joinChannel: CH.general,
      joinMessage: 'a',
    },
  });
  const rules = [
    { channelId: CH.voice, nameTemplate: '{words}' },
    { channelId: CH.general, nameTemplate: '{words}' },
  ];
  const doc = file({
    modules: [
      // the form cannot turn deleteMessage off, so a file cannot either
      { moduleId: 'automod', enabled: true, config: { deleteMessage: false, timeoutMinutes: 5 } },
      // a rule for a voice channel could never work
      { moduleId: 'auto-threads', enabled: true, config: { rules } },
      // a file from before the trigger fields keeps the stored trigger
      {
        moduleId: 'welcome',
        enabled: true,
        config: { joinEnabled: true, joinChannel: CH.general, joinMessage: 'b' },
      },
    ],
  });
  const { body } = await apply(doc, ['module:automod', 'module:auto-threads', 'module:welcome']);
  for (const r of body.results) assert.equal(r.ok, true, `${r.key}: ${r.error}`);
  assert.equal((await getGuildModule(GID, 'automod')).config.deleteMessage, true);
  assert.deepEqual(
    (await getGuildModule(GID, 'auto-threads')).config.rules.map((r) => r.channelId),
    [CH.general]
  );
  const welcome = (await getGuildModule(GID, 'welcome')).config;
  assert.equal(welcome.joinMessage, 'b');
  assert.equal(welcome.trigger, 'role');
  assert.deepEqual(welcome.triggerRoleIds, [ROLE.member]);
});

test('a list that is empty only because its ids were cleared is called out', async () => {
  const doc = file({
    commandOverrides: [{ command: 'ping', enabled: true, allowedChannels: [], allowedRoles: [FOREIGN_ROLE] }],
  });
  const { body } = await preview(doc);
  assert.match(
    item(body, 'command:ping').notes.join(' '),
    /became empty. An empty list can mean no restriction/
  );
});

test('the preview does not claim the export lacks what it carries', async () => {
  const { body } = await preview(file());
  assert.match(
    body.notCarried,
    /In the file but not imported yet: reminders, reaction-role sets and custom commands/
  );
  assert.doesNotMatch(body.notCarried, /Not in the file, so not imported: reminders/);
});

test('apply shares the limit of the other actions that call the platform', async () => {
  const doc = file({ modules: [{ moduleId: 'afk', enabled: true, config: {} }] });
  let limited = null;
  for (let i = 0; i < 12 && !limited; i += 1) {
    const res = await api.post('/import/apply', { export: doc, items: ['module:afk'], confirm: 'IMPORT' });
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'the apply is rate limited');
  assert.match((await limited.json()).error, /Too many/);
});
