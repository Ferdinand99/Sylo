// The setup wizard's API: what it proposes for a server, and applying the choices. Nothing may be created
// or overwritten without an explicit tick, Sylo's own permission is checked first, and every saved item
// writes its own audit entry. (Who may call the routes is in v2Setup.auth.test.js, bad bodies and the rate limit in
// v2Setup.limit.test.js. The apply route is limited to six runs per ten minutes, and this file makes six.)
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { listAudit } from '../src/db/audit.js';
import { getGuildModule, setGuildModule } from '../src/db/modules.js';
import { getGuildSettings } from '../src/db/guildSettings.js';
import { matchByName } from '../src/web/lib/setupWizard.js';

let app;
let api;
test.after(() => app.close());

let nextId = 700000000000000000n;
const snowflake = () => String(nextId++);

const channelOf = (guild, id, name, perms = PermissionsBitField.All) => ({
  id,
  name,
  type: ChannelType.GuildText,
  rawPosition: 50,
  position: 50,
  guild,
  isTextBased: () => true,
  permissionsFor: () => new PermissionsBitField(perms),
});

/** A channel the server already has. */
function addChannel(name, perms) {
  const id = snowflake();
  app.guild.channels.cache.set(id, channelOf(app.guild, id, name, perms));
  return id;
}
function addRole(name, position = 3, managed = false) {
  const id = snowflake();
  app.guild.roles.cache.set(id, {
    id,
    name,
    position,
    managed,
    permissions: new PermissionsBitField(0n),
    comparePositionTo: (o) => position - (o?.position ?? 0),
  });
  return id;
}

// What Sylo makes: snowflake ids (the modules only keep ids shaped like one), and a record of the overwrites.
const made = { channels: [], roles: [] };
test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  app.guild.channels.create = async (opts) => {
    const id = snowflake();
    app.guild.channels.cache.set(id, channelOf(app.guild, id, opts.name));
    made.channels.push({ id, ...opts });
    return { id };
  };
  app.guild.roles.create = async (opts) => {
    const id = addRole(opts.name, 1);
    made.roles.push({ id, ...opts });
    return { id };
  };
});

const itemOf = (body, id) => body.items.find((i) => i.id === id);
const resultOf = (body, id) => body.results.find((r) => r.id === id);
const field = (item, key) => item.fields.find((f) => f.key === key);

test('matches names the way a person writes them: case, emoji and separators do not matter', () => {
  const items = [
    { id: '1', name: '📜│Rules' },
    { id: '2', name: 'mod_log' },
    { id: '3', name: 'welcome-and-rules' },
    { id: '4', name: 'changelogs' },
  ];
  assert.equal(matchByName(items, ['modlog']).id, '2');
  assert.equal(matchByName(items, ['verify', 'rules']).id, '1', 'the order of the names is the preference');
  assert.equal(matchByName(items, ['welcome'], ['welcome']).id, '3', 'a whole word counts as a loose match');
  assert.equal(matchByName(items, ['logs']), null, '"logs" inside another word does not match');
});

test('a server with nothing to match proposes to create, and creates nothing by asking', async () => {
  const res = await api.get('/setup/suggest');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(
    body.goals.map((g) => g.id),
    ['welcome', 'verify', 'moderation', 'tickets', 'community']
  );
  assert.equal(body.platform, 'discord');
  assert.ok(body.inspected.channels >= 3);
  assert.deepEqual(body.botCan, { createChannels: true, createRoles: true });
  const welcome = itemOf(body, 'welcome');
  assert.equal(field(welcome, 'joinChannel').match, null);
  assert.deepEqual(field(welcome, 'joinChannel').create, {
    name: 'welcome',
    kind: 'channel',
    private: false,
    readOnly: true,
  });
  assert.equal(field(itemOf(body, 'modlog'), 'channelId').create.private, true);
  assert.equal(field(itemOf(body, 'verification'), 'verifiedRoleId').create.kind, 'role');
  assert.equal(itemOf(body, 'welcome').configured, false);
  assert.deepEqual(app.sink.created, []);
  assert.equal((await listAudit(GID, 20)).length, 0);
});

test('channels and roles found by name are proposed, and what Sylo cannot use is flagged', async () => {
  const welcomeCh = addChannel('📜│welcome');
  const rules = addChannel('rules');
  const verify = addChannel('verify');
  const modlog = addChannel('mod-log');
  const logs = addChannel('logs');
  const readOnlyForBot = addChannel('suggestions', new PermissionsBitField(0n));
  const above = addRole('Verified', 99);
  const staff = addRole('Staff');

  const body = await (await api.get('/setup/suggest')).json();
  assert.equal(field(itemOf(body, 'welcome'), 'joinChannel').match.name, '📜│welcome');
  assert.equal(field(itemOf(body, 'verification'), 'channelId').match.id, verify, 'verify beats rules');
  assert.notEqual(field(itemOf(body, 'verification'), 'channelId').match.id, rules);
  assert.equal(field(itemOf(body, 'modlog'), 'channelId').match.id, modlog);
  assert.equal(field(itemOf(body, 'logging'), 'channel').match.id, logs, 'mod-log is not the server log');
  assert.equal(field(itemOf(body, 'tickets'), 'staffRoles').match.id, staff);

  const role = field(itemOf(body, 'verification'), 'verifiedRoleId');
  assert.equal(role.match.id, above);
  assert.match(role.problem, /move Sylo's role above it/);
  const sugg = field(itemOf(body, 'suggestions'), 'channel');
  assert.equal(sugg.match.id, readOnlyForBot);
  assert.match(sugg.problem, /Send Messages/);
  // The same flags are on the pickers, for a channel or role the admin picks by hand.
  assert.match(body.roles.find((r) => r.id === above).problem, /above it/);
  assert.match(body.channels.find((c) => c.id === readOnlyForBot).problem, /View Channel/);
  assert.equal(body.roles.find((r) => r.id === staff).problem, null);

  // Put the server back to bare for the next tests.
  for (const id of [welcomeCh, rules, verify, modlog, logs, readOnlyForBot])
    app.guild.channels.cache.delete(id);
  app.guild.roles.cache.delete(above);
  app.guild.roles.cache.delete(staff);
});

test('without a tick nothing is created, and a missing or unknown channel fails only that item', async () => {
  const res = await api.post('/setup/apply', {
    items: [
      { id: 'welcome', fields: {} },
      { id: 'suggestions', fields: { channel: { id: '999999999999999999' } } },
      // Not true, so not a tick.
      { id: 'starboard', fields: { channelId: { create: 'yes' } } },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(resultOf(body, 'welcome').status, 'failed');
  assert.match(resultOf(body, 'welcome').message, /Pick a welcome channel, or tick Create/);
  assert.match(resultOf(body, 'suggestions').message, /no longer exists/);
  assert.equal(resultOf(body, 'starboard').status, 'failed');
  assert.deepEqual(made.channels, []);
  assert.deepEqual(made.roles, []);
  assert.equal((await listAudit(GID, 20)).length, 0);
  assert.equal((await getGuildModule(GID, 'welcome')).enabled, false);
});

test('a ticked Create makes the channel (read-only or private), saves the module and audits each item', async () => {
  const res = await api.post('/setup/apply', {
    items: [
      { id: 'welcome', fields: { joinChannel: { create: true } } },
      { id: 'modlog', fields: { channelId: { create: true } } },
      { id: 'verification', fields: { channelId: { create: true }, verifiedRoleId: { create: true } } },
    ],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const r of body.results) assert.equal(r.status, 'applied', `${r.id}: ${r.message}`);
  assert.deepEqual(
    body.results.map((r) => r.id),
    ['welcome', 'verification', 'modlog'],
    'one at a time, in the wizard order'
  );
  assert.deepEqual(
    made.channels.map((c) => c.name),
    ['welcome', 'verify', 'mod-log']
  );
  assert.deepEqual(
    made.roles.map((r) => r.name),
    ['Verified']
  );

  const everyone = (c) => c.permissionOverwrites.find((o) => o.id === GID);
  const welcomeCh = made.channels.find((c) => c.name === 'welcome');
  assert.ok(everyone(welcomeCh).deny.includes(PermissionsBitField.Flags.SendMessages), 'read-only');
  assert.ok(
    !everyone(welcomeCh).deny.includes(PermissionsBitField.Flags.AddReactions),
    'reactions stay open: buttons are reactions on Fluxer'
  );
  const modlogCh = made.channels.find((c) => c.name === 'mod-log');
  assert.ok(everyone(modlogCh).deny.includes(PermissionsBitField.Flags.ViewChannel), 'private');
  assert.ok(
    modlogCh.permissionOverwrites.some((o) => o.id === 'bot-id'),
    'Sylo can still use it'
  );

  const welcome = await getGuildModule(GID, 'welcome');
  assert.equal(welcome.enabled, true);
  assert.equal(welcome.config.joinEnabled, true);
  assert.equal(welcome.config.joinChannel, made.channels[0].id);
  assert.match(welcome.config.joinMessage, /\{user\}/);
  const verification = await getGuildModule(GID, 'verification');
  assert.equal(verification.enabled, true);
  assert.equal(verification.config.channelId, made.channels[1].id);
  assert.equal(verification.config.verifiedRoleId, made.roles[0].id);
  assert.equal((await getGuildSettings(GID)).modlog_channel_id, made.channels[2].id);

  // One audit entry per saved item, none for the rest.
  const audit = await listAudit(GID, 20);
  assert.equal(audit.length, 3);
  assert.match((await auditRows(GID, 'module:welcome'))[0].detail, /setup wizard; created #welcome/);
  assert.match((await auditRows(GID, 'module:verification'))[0].detail, /created #verify, Verified/);
  assert.match((await auditRows(GID, 'settings'))[0].detail, /mod-log channel set by the setup wizard/);
});

test('an item that is already set up is left alone, and a second run creates nothing again', async () => {
  const again = {
    items: [
      { id: 'welcome', fields: { joinChannel: { create: true } } },
      { id: 'modlog', fields: { channelId: { create: true } } },
    ],
  };
  const body = await (await api.post('/setup/apply', again)).json();
  for (const r of body.results) {
    assert.equal(r.status, 'skipped');
    assert.match(r.message, /Already set up/);
  }
  assert.equal(made.channels.length, 3, 'no second #welcome');
  assert.equal((await listAudit(GID, 20)).length, 3, 'and no new audit entry');
});

test('"Replace" changes the channels and switches, and keeps the text the admin wrote', async () => {
  const other = addChannel('arrivals');
  await setGuildModule(GID, 'welcome', {
    config: { ...(await getGuildModule(GID, 'welcome')).config, joinMessage: 'Hello {user}, my own words' },
  });
  const body = await (
    await api.post('/setup/apply', {
      items: [{ id: 'welcome', replace: true, fields: { joinChannel: { id: other } } }],
    })
  ).json();
  assert.equal(resultOf(body, 'welcome').status, 'applied');
  const cfg = (await getGuildModule(GID, 'welcome')).config;
  assert.equal(cfg.joinChannel, other);
  assert.equal(cfg.joinMessage, 'Hello {user}, my own words');
});

test('Sylo checks its own permission first: no Manage Channels, no channel, and the other items still apply', async () => {
  const me = app.guild.members.me;
  const had = me.permissions;
  me.permissions = new PermissionsBitField(0n);
  try {
    const sugg = addChannel('suggestions');
    const star = addChannel('starboard');
    const before = made.channels.length;
    const body = await (
      await api.post('/setup/apply', {
        items: [
          { id: 'tickets', fields: { notifyChannel: { create: true } } },
          { id: 'leveling', fields: {} },
          { id: 'moderation', fields: {} },
          { id: 'starboard', fields: { channelId: { id: star } } },
          { id: 'suggestions', fields: { channel: { id: sugg } } },
        ],
      })
    ).json();
    assert.equal(resultOf(body, 'tickets').status, 'failed');
    assert.match(resultOf(body, 'tickets').message, /Manage Channels/);
    assert.equal(made.channels.length, before, 'nothing was created');
    assert.equal((await getGuildModule(GID, 'tickets')).enabled, false);
    for (const id of ['leveling', 'moderation', 'starboard', 'suggestions']) {
      assert.equal(resultOf(body, id).status, 'applied', `${id}: ${resultOf(body, id).message}`);
      assert.equal((await getGuildModule(GID, id)).enabled, true, `${id} is on`);
    }
    // Moderation says what it still needs (timeouts).
    assert.match(resultOf(body, 'moderation').warnings.join(' '), /Timeout Members/);
    const mod = (await getGuildModule(GID, 'moderation')).config;
    assert.deepEqual(
      mod.warnThresholds.map((t) => [t.count, t.action, t.durationMinutes]),
      [
        [3, 'timeout', 60],
        [5, 'timeout', 1440],
      ]
    );
    const board = (await getGuildModule(GID, 'starboard')).config.boards;
    assert.equal(board.length, 1);
    assert.equal(board[0].channelId, star);
    assert.deepEqual(board[0].emojis, ['⭐']);
    assert.equal((await getGuildModule(GID, 'suggestions')).config.channel, sugg);
    assert.equal((await auditRows(GID, 'module:starboard')).length, 1);
  } finally {
    me.permissions = had;
  }
});

test('a role Sylo cannot give is refused, and a channel Sylo cannot post in is refused', async () => {
  const high = addRole('Verified-high', 99);
  const quiet = addChannel('verify-quiet', new PermissionsBitField(0n));
  await setGuildModule(GID, 'verification', { enabled: false, config: {} });
  const body = await (
    await api.post('/setup/apply', {
      items: [{ id: 'verification', fields: { channelId: { id: quiet }, verifiedRoleId: { id: high } } }],
    })
  ).json();
  const r = resultOf(body, 'verification');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /Send Messages|View Channel/);
  assert.deepEqual((await getGuildModule(GID, 'verification')).config, {});
});
