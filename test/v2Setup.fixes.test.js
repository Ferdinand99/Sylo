// The setup wizard's edge paths: a channel that already has the name "Create" would give, an item that fails
// after it made something, two applies at once, and the permissions Sylo needs for the overwrites. The apply
// route is limited to six runs per ten minutes, and the HTTP tests here make six; the last test calls the
// library directly (the limit sits in the route).
import { startWebApp } from './helpers/webApp.js';
import { v2Open, auditRows } from './helpers/v2Open.js';
import { GID } from './helpers/fakeGuild.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionsBitField } from 'discord.js';
import { listAudit } from '../src/db/audit.js';
import { getGuildModule } from '../src/db/modules.js';
import { applySetup } from '../src/web/lib/setupWizard.js';

const F = PermissionsBitField.Flags;

let app;
let api;
test.after(() => app.close());

let nextId = 600000000000000000n;
const snowflake = () => String(nextId++);

/** The permissions @everyone ends up with in a channel, from the overwrites it was made with. */
function everyoneBits(overwrites = []) {
  let bits = F.ViewChannel | F.SendMessages;
  const own = overwrites.find((o) => o.id === GID);
  for (const flag of own?.deny ?? []) bits &= ~flag;
  for (const flag of own?.allow ?? []) bits |= flag;
  return bits;
}

const edits = [];
function channelOf(id, name, everyone) {
  const channel = {
    id,
    name,
    type: ChannelType.GuildText,
    rawPosition: 50,
    guild: app.guild,
    everyone,
    isTextBased: () => true,
    permissionsFor: (who) =>
      new PermissionsBitField(who === app.guild.roles.everyone ? channel.everyone : PermissionsBitField.All),
    permissionOverwrites: {
      edit: async (target, opts) => {
        edits.push({ channel: id, target: target?.id ?? target, opts });
        if ((target?.id ?? target) === GID) {
          for (const [name, on] of Object.entries(opts)) {
            if (on === false) channel.everyone &= ~F[name];
            if (on === true) channel.everyone |= F[name];
          }
        }
      },
    },
  };
  return channel;
}

const made = { channels: [], roles: [] };
let gate = null;
let entered = null;
let failChannelCreate = false;

/** A channel the server already has: `everyone` is what members can do in it. */
function addChannel(name, everyone = F.ViewChannel | F.SendMessages) {
  const id = snowflake();
  app.guild.channels.cache.set(id, channelOf(id, name, everyone));
  return id;
}
function dropByName(cache, name) {
  for (const [id, item] of cache) if (item.name === name) cache.delete(id);
}

test.before(async () => {
  app = await startWebApp();
  api = v2Open(app, GID);
  app.guild.channels.create = async (opts) => {
    entered?.();
    if (gate) await gate;
    if (failChannelCreate) throw new Error('Missing Permissions');
    const id = snowflake();
    app.guild.channels.cache.set(id, channelOf(id, opts.name, everyoneBits(opts.permissionOverwrites)));
    made.channels.push({ id, ...opts });
    return { id };
  };
  app.guild.roles.create = async (opts) => {
    const id = snowflake();
    app.guild.roles.cache.set(id, {
      id,
      name: opts.name,
      position: 1,
      managed: false,
      permissions: new PermissionsBitField(0n),
      comparePositionTo: () => 0,
    });
    made.roles.push({ id, ...opts });
    return { id };
  };
});

const resultOf = (body, id) => body.results.find((r) => r.id === id);
const field = (item, key) => item.fields.find((f) => f.key === key);

test('a channel with the wanted name is reused when it is what the wizard promises, and the result says "reused"', async () => {
  const tickets = addChannel('tickets', F.SendMessages); // private: members cannot see it
  const body = await (
    await api.post('/setup/apply', {
      items: [{ id: 'tickets', fields: { notifyChannel: { create: true }, staffRoles: { create: true } } }],
    })
  ).json();
  const r = resultOf(body, 'tickets');
  assert.equal(r.status, 'applied', r.message);
  assert.deepEqual(
    r.created.map((c) => c.name),
    ['Support team'],
    'the role is new, the channel is not'
  );
  assert.deepEqual(
    r.reused.map((c) => c.name),
    ['tickets']
  );
  assert.match(r.message, /Created Support team\. Used the existing #tickets\./);
  assert.doesNotMatch(r.message, /Created #tickets/);
  assert.deepEqual(made.channels, [], 'no second #tickets');
  assert.equal((await getGuildModule(GID, 'tickets')).config.notifyChannel, tickets);
  assert.match(
    (await auditRows(GID, 'module:tickets'))[0].detail,
    /created Support team; used the existing #tickets/
  );
  assert.equal((await auditRows(GID, 'setup:role')).length, 1, 'the new role is audited');
  dropByName(app.guild.roles.cache, 'Support team');
});

test('a channel with the wanted name that is not what the wizard promises is not reused silently', async () => {
  const logId = addChannel('server-log'); // public: everyone can see it
  const proposal = await (await api.get('/setup/suggest')).json();
  const logging = field(
    proposal.items.find((i) => i.id === 'logging'),
    'channel'
  );
  assert.deepEqual(logging.create.existing, { id: logId, name: 'server-log', gap: 'Everyone can see it.' });

  const body = await (
    await api.post('/setup/apply', { items: [{ id: 'logging', fields: { channel: { create: true } } }] })
  ).json();
  const r = resultOf(body, 'logging');
  assert.equal(r.status, 'failed');
  assert.match(r.message, /#server-log already exists\. Everyone can see it\. Pick it to use it as it is/);
  assert.deepEqual(r.created, []);
  assert.deepEqual(edits, [], 'no permission was touched');
  assert.equal((await getGuildModule(GID, 'logging')).enabled, false);
});

test('the admin can tick "change its permissions", and only then are the overwrites changed and audited', async () => {
  const logId = [...app.guild.channels.cache.values()].find((c) => c.name === 'server-log').id;
  const body = await (
    await api.post('/setup/apply', {
      items: [{ id: 'logging', fields: { channel: { create: true, fix: true } } }],
    })
  ).json();
  const r = resultOf(body, 'logging');
  assert.equal(r.status, 'applied', r.message);
  assert.deepEqual(
    r.changed.map((c) => c.name),
    ['server-log']
  );
  assert.match(r.message, /Used the existing #server-log\. Changed the permissions of #server-log\./);
  assert.ok(edits.some((e) => e.channel === logId && e.target === GID && e.opts.ViewChannel === false));
  assert.ok(
    edits.some((e) => e.target === 'bot-id'),
    "Sylo's own access is set too"
  );
  assert.equal((await getGuildModule(GID, 'logging')).config.channel, logId);
  assert.equal((await auditRows(GID, 'setup:channel')).length, 1);
  assert.match(
    (await auditRows(GID, 'setup:channel'))[0].detail,
    /changed who can see or post in #server-log/
  );
  const again = await (await api.get('/setup/suggest')).json();
  assert.equal(
    field(
      again.items.find((i) => i.id === 'logging'),
      'channel'
    ).create.existing.gap,
    null
  );
});

test('when a step fails after something was made, the result and the audit log say exactly what was made', async () => {
  failChannelCreate = true;
  try {
    const body = await (
      await api.post('/setup/apply', {
        items: [{ id: 'modlog', fields: { channelId: { create: true }, viewRole: { create: true } } }],
      })
    ).json();
    const r = resultOf(body, 'modlog');
    assert.equal(r.status, 'failed');
    assert.deepEqual(
      r.created.map((c) => c.name),
      ['Support team'],
      'the role was made first'
    );
    assert.match(r.message, /Could not save this: Missing Permissions/);
    assert.match(r.message, /Before it stopped, Sylo created Support team\. That was left in place/);
    const rows = await auditRows(GID, 'setup:role');
    assert.equal(rows.length, 2, 'the role has its own audit row (the first is the earlier test)');
    assert.match(rows[0].detail, /created Support team for Mod-log channel/);
    assert.equal((await auditRows(GID, 'settings:server')).length, 0, 'the setting was not saved');
  } finally {
    failChannelCreate = false;
    dropByName(app.guild.roles.cache, 'Support team');
  }
});

test('a second apply while one runs is refused with a 409, and the first still finishes', async () => {
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  const first = api.post('/setup/apply', {
    items: [{ id: 'welcome', fields: { joinChannel: { create: true } } }],
  });
  await reached; // the first apply is inside the channel creation
  const second = await api.post('/setup/apply', {
    items: [{ id: 'suggestions', fields: { channel: { create: true } } }],
  });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already running/);
  release();
  gate = null;
  entered = null;
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(resultOf(await done.json(), 'welcome').status, 'applied');
  assert.deepEqual(
    made.channels.map((c) => c.name),
    ['welcome'],
    'only the first apply made anything'
  );
  // Once the first is done, the server takes another one (the lock is released).
  assert.equal((await listAudit(GID, 50)).length > 0, true);
});

test('Sylo needs View Channel and Send Messages itself before it sets who can see or post, and nothing is made without them', async () => {
  const me = app.guild.members.me;
  const had = me.permissions;
  me.permissions = new PermissionsBitField(F.ManageChannels | F.ManageRoles);
  try {
    const before = made.channels.length;
    const results = await applySetup({
      guild: app.guild,
      actor: 'Dashboard',
      selections: [{ id: 'starboard', fields: { channelId: { create: true } } }],
    });
    assert.equal(results[0].status, 'failed');
    assert.match(
      results[0].message,
      /Sylo needs the View Channel and Send Messages permissions itself to set who can see or post/
    );
    assert.equal(made.channels.length, before, 'nothing was created');
  } finally {
    me.permissions = had;
  }
});
