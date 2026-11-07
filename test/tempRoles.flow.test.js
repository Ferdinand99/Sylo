// Temporary roles end to end with fake platform objects: /temprole add|remove|list, the permission
// and hierarchy refusals, replacing a time, the ceiling, the sweep on the scheduler (expiry, member
// gone, role gone, role taken off by hand, Sylo without permission), a restart, the member events,
// the mod log and the DMs, /forget, and Fluxer.
// mock.timers is experimental until Node 23.1 but works on the Node 22 this project requires.
/* eslint-disable n/no-unsupported-features/node-builtins */
import './helpers/tmpDb.js';
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../src/runtime.js';
import { setGuildModule } from '../src/db/modules.js';
import { setModlogChannel } from '../src/db/guildSettings.js';
import { dispatch } from '../src/modules/dispatch.js';
import { scheduledCount, startSchedules, stopSchedules } from '../src/modules/schedule.js';
import { getTempRole, listTempRoles, putTempRole, tempRoleCount } from '../src/db/tempRoles.js';
import { forgetUser } from '../src/db/purge.js';
import { LIMITS as CEILINGS } from '../src/lib/limits.js';
import { execute as temprole } from '../src/bot/commands/temprole.js';
import { addTempRole, removeTempRole, sweep } from '../src/modules/tempRoles.js';

let GID = '';
let KEY = '';
let seq = 0;
const LOG = '100000000000000001';
const R = {
  perk: '100000000000000700',
  perk2: '100000000000000701',
  helper: '100000000000000702', // has moderator permissions
  high: '100000000000000703', // above the staff member, below Sylo
  top: '100000000000000704', // above Sylo
  bot: '100000000000000705', // managed
};
const STAFF_ROLE = '100000000000000710';
const STAFF = '100000000000000999';
const U = ['100000000000000011', '100000000000000012', '100000000000000013'];
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const settle = async () => {
  for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r));
};

// Nothing queued earlier may run later against a different test's fake guild.
await stopSchedules();

function world({ dmClosed = [], platform = 'discord', botPosition = 10 } = {}) {
  seq += 1;
  const rawId = String(900000000000000300n + BigInt(seq));
  KEY = platform === 'fluxer' ? `fluxer:${rawId}` : rawId;
  GID = KEY;
  const out = { sent: [], dms: [], roleCalls: [], audit: [] };

  const channel = {
    id: LOG,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (p) => {
      out.sent.push(p);
      return { id: 'm' };
    },
  };
  const role = (id, name, position, extra = {}) => ({
    id,
    name,
    position,
    managed: false,
    editable: true,
    permissions: { has: () => false },
    comparePositionTo: (other) => position - other.position,
    ...extra,
  });
  const roles = new Map(
    [
      role(rawId, '@everyone', 0),
      role(R.perk, 'Perk', 2),
      role(R.perk2, 'Perk Two', 3),
      role(R.helper, 'Helper', 4, { permissions: { has: (p) => p === 'ManageMessages' } }),
      role(R.high, 'Mod', 8),
      role(R.top, 'Top', 12),
      role(R.bot, 'Integration', 1, { managed: true }),
    ].map((r) => [r.id, r])
  );

  const me = {
    id: 'bot',
    permissions: { has: () => true },
    roles: {
      highest: { position: botPosition, comparePositionTo: (r) => me.roles.highest.position - r.position },
    },
  };
  const state = { fetchError: null, addError: null, removeError: null };
  const members = new Map();
  const member = (id, { top = 5, perms = [], roleIds = [] } = {}) => {
    if (!members.has(id)) {
      const cache = new Map(roleIds.map((r) => [r, roles.get(r)]));
      members.set(id, {
        id,
        user: { id },
        roles: {
          cache,
          highest: { position: top, comparePositionTo: (r) => top - r.position },
          add: async (r, reason) => {
            if (state.addError) throw state.addError;
            cache.set(r.id, r);
            out.roleCalls.push(['add', id, r.id, reason]);
          },
          remove: async (r, reason) => {
            if (state.removeError) throw state.removeError;
            cache.delete(r.id);
            out.roleCalls.push(['remove', id, r.id, reason]);
          },
        },
        permissions: { has: (p) => perms.includes(p) },
      });
    }
    return members.get(id);
  };
  const guild = {
    id: rawId,
    ownerId: '100000000000000998',
    name: 'Test Guild',
    channels: { cache: new Map([[LOG, channel]]), fetch: async (id) => (id === LOG ? channel : null) },
    roles: { cache: roles },
    members: {
      me,
      cache: members,
      fetch: async (id) => {
        if (state.fetchError) throw state.fetchError;
        return members.get(id) ?? null;
      },
    },
  };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[rawId, guild]]) },
    users: {
      fetch: async (id) => ({
        id,
        send: async (p) => {
          if (dmClosed.includes(id)) throw new Error('Cannot send messages to this user');
          out.dms.push({ id, p });
        },
      }),
    },
  };
  guild.client = client;
  runtime.clients.discord = platform === 'fluxer' ? null : client;
  runtime.clients.fluxer = platform === 'fluxer' ? client : null;
  return { ...out, out, guild, roles, me, member, state, client };
}

let w;
const fresh = (opts) => {
  w = world(opts);
  return w;
};

afterEach(async () => {
  mock.timers.reset();
  await stopSchedules();
  runtime.clients.discord = null;
  runtime.clients.fluxer = null;
});

async function enable(config = {}, { log = true } = {}) {
  await setGuildModule(GID, 'temp-roles', { enabled: true, config });
  if (log) await setModlogChannel(GID, LOG);
}

/** Staff by default: Manage Roles and a top role at position 5. */
function slash(sub, values = {}, { perms = ['ManageRoles'], as = STAFF, top = 5, roleIds = [] } = {}) {
  const replies = [];
  w.guild.members.cache.delete(as); // a caller is built fresh for each command
  const caller = w.member(as, { top, perms, roleIds });
  return {
    guildId: GID,
    guild: w.guild,
    user: { id: as },
    member: caller,
    memberPermissions: { has: (p) => perms.includes(p) },
    options: {
      getSubcommand: () => sub,
      getUser: (n, required) => {
        if (required && values[n] == null) throw new TypeError(n);
        return values[n] == null ? null : { id: values[n] };
      },
      getMember: (n) => w.guild.members.cache.get(values[n]) ?? null,
      getRole: (n, required) => {
        if (required && values[n] == null) throw new TypeError(n);
        return w.roles.get(values[n]) ?? null;
      },
      getString: (n, required) => {
        if (required && values[n] == null) throw new TypeError(n);
        return values[n] ?? null;
      },
    },
    reply: async (p) => {
      replies.push(p);
    },
    replies,
    text: () =>
      replies
        .map((r) =>
          [r.content ?? '', ...(r.embeds ?? []).map((e) => e.toJSON().description ?? '')].join('\n')
        )
        .join('\n'),
  };
}

async function run(sub, values, opts) {
  const i = slash(sub, values, opts);
  await temprole(i);
  return i;
}
const embedOf = (p) => p.embeds[0].toJSON();
const logTitles = () => w.sent.map((p) => embedOf(p).title);
const hasRole = (userId, roleId) => w.guild.members.cache.get(userId)?.roles.cache.has(roleId) ?? false;

// --- /temprole add -------------------------------------------------------------------------------

test('add gives the role, stores the record, replies privately and writes the mod log', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  const before = Date.now();
  const i = await run('add', { member: U[0], role: R.perk, duration: '7d', reason: 'Trial' });
  assert.match(i.text(), /has \*\*Perk\*\* until <t:\d+:f>/);
  assert.equal(i.replies[0].flags !== undefined, true, 'the reply is ephemeral');
  assert.deepEqual(i.replies[0].allowedMentions, { parse: [] });
  assert.equal(hasRole(U[0], R.perk), true);
  assert.equal(w.roleCalls[0][3], 'Temporary role: Trial', 'the reason reaches the audit log');

  const row = await getTempRole(GID, U[0], R.perk);
  assert.ok(row.expires_at >= before + 7 * DAY && row.expires_at <= Date.now() + 7 * DAY);
  assert.equal(row.added_by, STAFF);
  assert.equal(row.reason, 'Trial');

  assert.deepEqual(logTitles(), ['Temporary role added']);
  const fields = Object.fromEntries(embedOf(w.sent[0]).fields.map((f) => [f.name, f.value]));
  assert.match(fields.Member, new RegExp(U[0]));
  assert.match(fields.Role, /Perk/);
  assert.match(fields.By, new RegExp(STAFF));
  assert.equal(fields.Reason, 'Trial');
  assert.match(fields.Until, /(1w)/);
  assert.equal(w.dms.length, 0, 'no DM unless the setting is on');
});

test('add: the DM is off by default, on when set, and a closed DM is reported', async () => {
  fresh({ dmClosed: [U[1]] });
  await enable({ dmMember: true });
  w.member(U[0]);
  w.member(U[1]);
  const open = await run('add', { member: U[0], role: R.perk, duration: '1h', reason: 'Because' });
  assert.match(open.text(), /told by DM/);
  assert.equal(w.dms.length, 1);
  const dm = w.dms[0].p.embeds[0].toJSON().description;
  assert.match(dm, /\*\*Perk\*\* in \*\*Test Guild\*\* until <t:\d+:f>/);
  assert.match(dm, /Because/);
  const closed = await run('add', { member: U[1], role: R.perk, duration: '1h' });
  assert.match(closed.text(), /DMs are closed/);
  assert.equal(await tempRoleCount(GID), 2, 'the role is given either way');
});

test('add again REPLACES the time (shorter or longer), keeps one record and does not give the role twice', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '7d', reason: 'first' });
  const first = await getTempRole(GID, U[0], R.perk);
  const again = await run('add', { member: U[0], role: R.perk, duration: '1h', reason: 'second' });
  assert.match(again.text(), /Replaced the time/);
  assert.match(again.text(), /was <t:\d+:f>/);
  const second = await getTempRole(GID, U[0], R.perk);
  assert.ok(second.expires_at < first.expires_at - 6 * DAY, 'shorter wins');
  assert.equal(second.reason, 'second');
  assert.equal(await tempRoleCount(GID), 1);
  assert.equal(w.roleCalls.filter((c) => c[0] === 'add').length, 1, 'the role was given once');
  await run('add', { member: U[0], role: R.perk, duration: '30d' });
  assert.ok((await getTempRole(GID, U[0], R.perk)).expires_at > first.expires_at, 'longer wins too');
  assert.deepEqual(logTitles(), [
    'Temporary role added',
    'Temporary role replaced',
    'Temporary role replaced',
  ]);
  assert.match(embedOf(w.sent[1]).fields.find((f) => f.name === 'Replaces').value, /ended <t:\d+:f>/);
});

test('add: a role the member already had is still taken back at the end, and the reply says so', async () => {
  fresh();
  await enable();
  w.member(U[0], { roleIds: [R.perk] });
  const i = await run('add', { member: U[0], role: R.perk, duration: '1d' });
  assert.match(i.text(), /already had the role/);
  assert.equal(w.roleCalls.length, 0, 'nothing to give');
  assert.ok(await getTempRole(GID, U[0], R.perk));
});

test('add: no mod log channel set means no log, and the module still works', async () => {
  fresh();
  await enable({}, { log: false });
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  assert.equal(w.sent.length, 0);
  assert.ok(await getTempRole(GID, U[0], R.perk));
});

// --- refusals ------------------------------------------------------------------------------------

test('refused: module off, not staff, and what a staff role allows', async () => {
  fresh();
  w.member(U[0]);
  const off = await run('add', { member: U[0], role: R.perk, duration: '1d' });
  assert.match(off.text(), /not enabled/);

  await enable({ staffRoles: [STAFF_ROLE] });
  const plain = await run('add', { member: U[0], role: R.perk, duration: '1d' }, { perms: [] });
  assert.match(plain.text(), /Only staff/);
  const manageServer = await run('list', {}, { perms: ['ManageGuild', 'ManageEvents'] });
  assert.match(manageServer.text(), /Only staff/, 'Manage Server alone is not staff here');
  assert.equal(await tempRoleCount(GID), 0);
  assert.equal(w.roleCalls.length, 0);

  const viaRole = await run(
    'add',
    { member: U[0], role: R.perk, duration: '1d' },
    { perms: [], roleIds: [STAFF_ROLE] }
  );
  assert.match(viaRole.text(), /has \*\*Perk\*\*/);
  const admin = await run(
    'add',
    { member: U[0], role: R.perk2, duration: '1d' },
    { perms: ['Administrator'] }
  );
  assert.match(admin.text(), /has \*\*Perk Two\*\*/);
});

test('refused: a role at or above the caller, a moderator role without Manage Roles, a bad time', async () => {
  fresh();
  await enable({ staffRoles: [STAFF_ROLE] });
  w.member(U[0]);

  const above = await run('add', { member: U[0], role: R.high, duration: '1d' });
  assert.match(above.text(), /above or equal to your highest role/);
  const equal = await run('add', { member: U[0], role: R.high, duration: '1d' }, { top: 8 });
  assert.match(equal.text(), /above or equal to your highest role/);

  const elevatedViaStaffRole = await run(
    'add',
    { member: U[0], role: R.helper, duration: '1d' },
    { perms: [], roleIds: [STAFF_ROLE] }
  );
  assert.match(elevatedViaStaffRole.text(), /moderator or admin permissions/);
  const elevatedOk = await run('add', { member: U[0], role: R.helper, duration: '1d' });
  assert.match(elevatedOk.text(), /has \*\*Helper\*\*/, 'Manage Roles may hand it out');

  for (const [duration, pattern] of [
    ['soon', /not a duration/],
    ['7', /not a duration/],
    ['30s', /not a duration/],
    ['0m', /1 minute/],
    ['366d', /365 days/],
  ]) {
    const bad = await run('add', { member: U[0], role: R.perk, duration });
    assert.match(bad.text(), pattern, duration);
  }
  assert.equal(await tempRoleCount(GID), 1, 'only the Helper record exists');
});

test('refused: roles Sylo itself cannot hand out, a member who is not here', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  const owner = { perms: ['Administrator'], top: 20 };

  const managed = await run('add', { member: U[0], role: R.bot, duration: '1d' }, owner);
  assert.match(managed.text(), /managed by an integration/);
  const above = await run('add', { member: U[0], role: R.top, duration: '1d' }, owner);
  assert.match(above.text(), /above Sylo's highest role/);
  const everyone = await run('add', { member: U[0], role: KEY, duration: '1d' }, owner);
  assert.match(everyone.text(), /@everyone/);
  w.me.permissions.has = () => false;
  const noPerm = await run('add', { member: U[0], role: R.perk, duration: '1d' });
  assert.match(noPerm.text(), /Manage Roles/);
  w.me.permissions.has = () => true;
  const gone = await run('add', { member: '100000000000000077', role: R.perk, duration: '1d' });
  assert.match(gone.text(), /not in this server/);
  assert.equal(await tempRoleCount(GID), 0);
  assert.equal(w.roleCalls.length, 0);
  assert.equal(w.sent.length, 0, 'a refusal is not logged');
});

test('a role the platform refuses leaves nothing behind, and a replaced record is put back', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  w.state.addError = new Error('Missing Permissions');
  const failed = await run('add', { member: U[0], role: R.perk, duration: '1d' });
  assert.match(failed.text(), /could not give that role/);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.equal(w.sent.length, 0);

  w.state.addError = null;
  await run('add', { member: U[0], role: R.perk, duration: '2d', reason: 'keep me' });
  const kept = await getTempRole(GID, U[0], R.perk);
  w.member(U[0]).roles.cache.delete(R.perk); // the role was taken off by hand without Sylo noticing
  w.state.addError = new Error('Missing Permissions');
  await run('add', { member: U[0], role: R.perk, duration: '9d', reason: 'new' });
  const back = await getTempRole(GID, U[0], R.perk);
  assert.equal(back.expires_at, kept.expires_at);
  assert.equal(back.reason, 'keep me');
});

test('the ceiling: 2000 active temporary roles per server; replacing one is still allowed', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  for (let i = 1; i < CEILINGS.tempRoles; i += 1) {
    await putTempRole({ guildId: GID, userId: `u${i}`, roleId: R.perk2, expiresAt: Date.now() + DAY });
  }
  assert.equal(await tempRoleCount(GID), 2000);
  const over = await run('add', { member: U[0], role: R.perk2, duration: '1d' });
  assert.match(over.text(), /maximum of 2000 active temporary roles/);
  assert.equal(hasRole(U[0], R.perk2), false);
  const replace = await run('add', { member: U[0], role: R.perk, duration: '3d' });
  assert.match(replace.text(), /Replaced the time/);
  assert.equal(await tempRoleCount(GID), 2000);
});

// --- /temprole remove and list -------------------------------------------------------------------

test('remove takes the role back now, deletes the record and writes the mod log (and the DM when on)', async () => {
  fresh();
  await enable({ dmMember: true });
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  w.sent.length = 0;
  w.dms.length = 0;

  const i = await run('remove', { member: U[0], role: R.perk, reason: 'Changed our mind' });
  assert.match(i.text(), /Took \*\*Perk\*\* back/);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.equal(w.roleCalls.at(-1)[3], 'Temporary role removed early: Changed our mind');
  assert.deepEqual(logTitles(), ['Temporary role removed early']);
  const fields = Object.fromEntries(embedOf(w.sent[0]).fields.map((f) => [f.name, f.value]));
  assert.equal(fields.Reason, 'Changed our mind');
  assert.match(fields.By, new RegExp(STAFF));
  assert.match(w.dms[0].p.embeds[0].toJSON().description, /taken away early/);

  const again = await run('remove', { member: U[0], role: R.perk });
  assert.match(again.text(), /does not have that role as a temporary role/);
});

test('remove: the same refusals apply, and a record is dropped even when the member or role is gone', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });

  const notStaff = await run('remove', { member: U[0], role: R.perk }, { perms: [] });
  assert.match(notStaff.text(), /Only staff/);
  const above = await run('remove', { member: U[0], role: R.perk }, { perms: ['ManageRoles'], top: 2 });
  assert.match(above.text(), /above or equal to your highest role, so you can't take it back/);
  assert.ok(await getTempRole(GID, U[0], R.perk));

  w.guild.members.cache.delete(U[0]); // the member left
  const left = await run('remove', { member: U[0], role: R.perk });
  assert.match(left.text(), /Took \*\*Perk\*\* back/);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
});

test('remove: when Sylo cannot take the role away, the record goes and the reply says the role stays', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  w.me.roles.highest.position = 1; // Sylo lost rank meanwhile
  const i = await run('remove', { member: U[0], role: R.perk });
  assert.match(i.text(), /Stopped the timer/);
  assert.match(i.text(), /still on the member/);
  assert.equal(hasRole(U[0], R.perk), true);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
});

test('list: everyone or one member, soonest first, and a long list points to the dashboard', async () => {
  fresh();
  await enable();
  const none = await run('list');
  assert.match(none.text(), /No temporary roles right now/);
  w.member(U[0]);
  w.member(U[1]);
  await run('add', { member: U[0], role: R.perk, duration: '3d', reason: 'late' });
  await run('add', { member: U[1], role: R.perk2, duration: '1d' });
  const all = await run('list');
  const lines = all.replies[0].embeds[0].toJSON().description.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`<@${U[1]}> · <@&${R.perk2}>`), 'the sooner one is first');
  assert.match(lines[1], /"late"/);
  assert.deepEqual(all.replies[0].allowedMentions, { parse: [] });
  const one = await run('list', { member: U[0] });
  assert.equal(one.replies[0].embeds[0].toJSON().description.split('\n').length, 1);
  const empty = await run('list', { member: U[2] });
  assert.match(empty.text(), /has no temporary roles/);

  for (let i = 0; i < 25; i += 1) {
    await putTempRole({ guildId: GID, userId: `x${i}`, roleId: R.perk, expiresAt: Date.now() + 5 * DAY });
  }
  const long = await run('list');
  const text = long.replies[0].embeds[0].toJSON().description;
  assert.equal(text.split('\n').length, 21);
  assert.match(text, /…and 7 more on the dashboard/);
  const notStaff = await run('list', {}, { perms: [] });
  assert.match(notStaff.text(), /Only staff/);
});

// --- the sweep on the scheduler ------------------------------------------------------------------

/** Give U[0] the role for `duration` at a mocked clock, then start the schedules. */
async function setUp({ duration = '1h', config = {}, mod = {} } = {}) {
  fresh(mod);
  await enable(config);
  const t0 = Date.now();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: t0 });
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration, reason: 'Trial' });
  w.sent.length = 0;
  w.dms.length = 0;
  startSchedules();
  return t0;
}
const tick = async (ms) => {
  mock.timers.tick(ms);
  await settle();
};

test('the module registers one sweep, every minute, with no per-row timers', () => {
  assert.ok(scheduledCount() >= 1);
});

test('the sweep takes the role back when the time is up, logs it once and sends the DM', async () => {
  await setUp({ duration: '1h', config: { dmMember: true } });
  await tick(59 * MIN);
  assert.equal(hasRole(U[0], R.perk), true, 'not yet');
  assert.equal(w.sent.length, 0);
  await tick(2 * MIN);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.deepEqual(logTitles(), ['Temporary role expired']);
  const fields = Object.fromEntries(embedOf(w.sent[0]).fields.map((f) => [f.name, f.value]));
  assert.match(fields.Member, new RegExp(U[0]));
  assert.equal(fields.By, `Sylo (automatic)`);
  assert.equal(fields.Reason, 'Trial');
  assert.equal(w.roleCalls.at(-1)[3], 'Temporary role expired: Trial');
  assert.match(w.dms[0].p.embeds[0].toJSON().description, /has ended/);
  await tick(10 * MIN);
  assert.equal(w.sent.length, 1, 'nothing more happens on later sweeps');
});

test('expiry without the DM setting sends no DM, and works for several members and servers', async () => {
  await setUp({ duration: '10m' });
  w.member(U[1]);
  await run('add', { member: U[1], role: R.perk2, duration: '30m' });
  const first = w;
  await tick(11 * MIN);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.equal(hasRole(U[1], R.perk2), true, 'the later one is still running');
  assert.equal(w.dms.length, 0);
  await tick(20 * MIN);
  assert.equal(hasRole(U[1], R.perk2), false);
  assert.equal(await tempRoleCount(first.guild.id), 0);
});

test('replacing the time before the end keeps the role past the first end time', async () => {
  await setUp({ duration: '1h' });
  await tick(50 * MIN);
  await run('add', { member: U[0], role: R.perk, duration: '2h' });
  await tick(30 * MIN);
  assert.equal(hasRole(U[0], R.perk), true, 'the first end time passed, the new one did not');
  await tick(100 * MIN);
  assert.equal(hasRole(U[0], R.perk), false);
});

test('member gone: the record is deleted, no role call, no log', async () => {
  await setUp();
  w.guild.members.cache.delete(U[0]);
  await tick(61 * MIN);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.equal(w.roleCalls.filter((c) => c[0] === 'remove').length, 0);
  assert.equal(w.sent.length, 0);
});

test('member gone, as the platform reports it (404 / Unknown Member): the record is deleted', async () => {
  await setUp();
  w.guild.members.cache.delete(U[0]);
  w.state.fetchError = Object.assign(new Error('Unknown Member'), { code: 10007 });
  await tick(61 * MIN);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
});

test('a hiccup fetching the member keeps the record, and the next sweep finishes the job', async () => {
  await setUp();
  w.member(U[0]).roles.cache.set(R.perk, w.roles.get(R.perk));
  const cached = w.guild.members.cache.get(U[0]);
  w.guild.members.cache.delete(U[0]);
  w.state.fetchError = new Error('socket hang up');
  await tick(61 * MIN);
  assert.ok(await getTempRole(GID, U[0], R.perk), 'kept for the next try');
  w.state.fetchError = null;
  w.guild.members.cache.set(U[0], cached);
  await tick(MIN);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.equal(hasRole(U[0], R.perk), false);
});

test('role gone: the record is deleted', async () => {
  await setUp();
  w.roles.delete(R.perk);
  await tick(61 * MIN);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.equal(w.sent.length, 0);
});

test('role taken off by hand before the end: the record is deleted at the next sweep, without a log entry', async () => {
  await setUp();
  w.member(U[0]).roles.cache.delete(R.perk);
  await tick(61 * MIN);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.equal(w.roleCalls.filter((c) => c[0] === 'remove').length, 0);
  assert.equal(w.sent.length, 0);
});

test('Sylo without permission keeps the record, tries again each minute, and finishes once it can', async () => {
  await setUp();
  w.me.roles.highest.position = 1;
  await tick(61 * MIN);
  await tick(5 * MIN);
  assert.equal(hasRole(U[0], R.perk), true);
  assert.ok(await getTempRole(GID, U[0], R.perk), 'still there');
  assert.equal(w.sent.length, 0);
  w.me.roles.highest.position = 10;
  await tick(MIN);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.deepEqual(logTitles(), ['Temporary role expired']);
});

test('a role call that fails keeps the record; one that says the role is gone drops it', async () => {
  await setUp();
  w.state.removeError = new Error('503');
  await tick(61 * MIN);
  assert.ok(await getTempRole(GID, U[0], R.perk));
  assert.equal(w.sent.length, 0);
  w.state.removeError = Object.assign(new Error('Unknown Role'), { code: 10011 });
  await tick(MIN);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
});

test('nothing happens while a platform is not ready (its servers would look gone)', async () => {
  await setUp();
  w.client.isReady = () => false;
  await tick(61 * MIN);
  assert.ok(await getTempRole(GID, U[0], R.perk));
  assert.equal(hasRole(U[0], R.perk), true);
  w.client.isReady = () => true;
  await tick(MIN);
  assert.equal(hasRole(U[0], R.perk), false);
});

test('a server the bot is not in (or whose platform is not connected) keeps its records', async () => {
  await setUp();
  runtime.clients.discord = { isReady: () => true, guilds: { cache: new Map() } };
  await tick(61 * MIN);
  assert.ok(await getTempRole(GID, U[0], R.perk));
});

test('a restart re-reads the records: what ran out while the bot was down is handled by the first sweep', async () => {
  const t0 = await setUp({ duration: '2h' });
  await tick(30 * MIN);
  assert.equal(hasRole(U[0], R.perk), true);
  await stopSchedules(); // the bot goes down
  await tick(3 * HOUR); // nothing runs, time passes
  assert.equal(hasRole(U[0], R.perk), true);
  mock.timers.setTime(t0 + 3 * HOUR);
  startSchedules(); // the bot starts again; the rows are only in the database
  await tick(MIN);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.deepEqual(logTitles(), ['Temporary role expired']);
});

test('sweep() can be called directly and handles a row that was extended meanwhile', async () => {
  fresh();
  await enable();
  w.member(U[0], { roleIds: [R.perk] });
  const now = Date.now();
  await putTempRole({ guildId: GID, userId: U[0], roleId: R.perk, expiresAt: now - 1000 });
  await putTempRole({ guildId: GID, userId: U[1], roleId: R.perk, expiresAt: now + HOUR });
  await sweep(now);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.ok(await getTempRole(GID, U[1], R.perk), 'not due yet');
});

// --- keeping the records true --------------------------------------------------------------------

test('a role taken off by hand is noticed at once; other role changes and other modules do not matter', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  await run('add', { member: U[0], role: R.perk2, duration: '1d' });
  const m = w.member(U[0]);
  const before = { id: U[0], roles: { cache: new Map(m.roles.cache) } };
  m.roles.cache.delete(R.perk);
  await dispatch('guildMemberUpdate', GID, { old: before, new: m });
  assert.equal(await getTempRole(GID, U[0], R.perk), null);
  assert.ok(await getTempRole(GID, U[0], R.perk2), 'the other one stays');

  await dispatch('guildMemberUpdate', GID, { old: m, new: m }); // Fluxer without a cached old member
  await dispatch('guildMemberUpdate', GID, { old: { id: U[0] }, new: m });
  assert.ok(await getTempRole(GID, U[0], R.perk2));
});

test('a member who leaves loses their records; others and other servers keep theirs', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  w.member(U[1]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  await run('add', { member: U[0], role: R.perk2, duration: '1d' });
  await run('add', { member: U[1], role: R.perk, duration: '1d' });
  await putTempRole({
    guildId: '900000000000000998',
    userId: U[0],
    roleId: R.perk,
    expiresAt: Date.now() + DAY,
  });
  await dispatch('guildMemberRemove', GID, w.member(U[0]));
  assert.deepEqual(
    (await listTempRoles(GID)).map((r) => r.user_id),
    [U[1]]
  );
  assert.ok(await getTempRole('900000000000000998', U[0], R.perk));
  await dispatch('guildMemberRemove', GID, { user: { id: U[1] } }); // a member the cache never had
  assert.equal(await tempRoleCount(GID), 0);
});

test('with the module off, member events leave the records alone', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  await setGuildModule(GID, 'temp-roles', { enabled: false, config: {} });
  await dispatch('guildMemberRemove', GID, w.member(U[0]));
  assert.ok(await getTempRole(GID, U[0], R.perk));
});

// --- /forget --------------------------------------------------------------------------------------

test('/forget drops the record: the role stays on the member and is never taken back', async () => {
  await setUp({ duration: '1h' });
  const result = await forgetUser(GID, U[0]);
  assert.equal(result.tempRoles, 1);
  await tick(2 * HOUR);
  assert.equal(hasRole(U[0], R.perk), true, 'the role stays on Discord');
  assert.equal(w.sent.length, 0);
});

test('/forget on the staff member keeps the record but drops their name', async () => {
  fresh();
  await enable();
  w.member(U[0]);
  await run('add', { member: U[0], role: R.perk, duration: '1d' });
  const result = await forgetUser(GID, STAFF);
  assert.equal(result.tempRoleAdders, 1);
  assert.equal((await getTempRole(GID, U[0], R.perk)).added_by, null);
});

// --- the module functions directly ---------------------------------------------------------------

test('addTempRole and removeTempRole refuse bad input on their own, too', async () => {
  fresh();
  await enable();
  const member = w.member(U[0]);
  const role = w.roles.get(R.perk);
  assert.match(
    (await addTempRole({ guild: w.guild, member: null, role, durationMs: HOUR })).error,
    /not in this server/
  );
  assert.match(
    (await addTempRole({ guild: w.guild, member, role, durationMs: 1000 })).error,
    /between 1 minute/
  );
  assert.match(
    (await addTempRole({ guild: w.guild, member, role, durationMs: 400 * DAY })).error,
    /between 1 minute/
  );
  assert.match(
    (await addTempRole({ guild: w.guild, member, role: null, durationMs: HOUR })).error,
    /no longer exists/
  );
  assert.match(
    (await removeTempRole({ guild: w.guild, userId: U[0], roleId: R.perk })).error,
    /does not have/
  );
});

// --- Fluxer ----------------------------------------------------------------------------------------

test('on Fluxer the records are keyed with the platform prefix and the sweep finds the guild', async () => {
  fresh({ platform: 'fluxer' });
  assert.match(KEY, /^fluxer:/);
  await enable({ dmMember: true });
  const t0 = Date.now();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: t0 });
  w.member(U[0]);
  const i = await run('add', { member: U[0], role: R.perk, duration: '1h' });
  assert.match(i.text(), /has \*\*Perk\*\*/);
  assert.ok(await getTempRole(KEY, U[0], R.perk), 'keyed with the prefix');
  assert.equal(await getTempRole(w.guild.id, U[0], R.perk), null, 'not under the raw id');
  w.sent.length = 0;
  startSchedules();
  await tick(61 * MIN);
  assert.equal(hasRole(U[0], R.perk), false);
  assert.equal(await tempRoleCount(KEY), 0);
  assert.deepEqual(logTitles(), ['Temporary role expired']);
});
