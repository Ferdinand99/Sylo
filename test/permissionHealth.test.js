import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { runtime } from '../src/runtime.js';
import {
  POST,
  buildHealthReport,
  getHealthReport,
  pickerTargets,
  reportFor,
  roleBlock,
} from '../src/web/lib/permissionHealth.js';
import { invalidateHealth, resetHealthCache } from '../src/lib/healthCache.js';

const G = '700000000000000888';
const CH = '111111111111111111';
const CH2 = '111111111111111112';
const ROLE_OK = '222222222222222221';
const ROLE_HIGH = '222222222222222222';
const ROLE_MANAGED = '222222222222222223';
const ROLE_PING = '222222222222222224';

const perms = (list) => new PermissionsBitField(list);
const ALL_CHANNEL = [
  ...POST,
  'AttachFiles',
  'ManageMessages',
  'ReadMessageHistory',
  'AddReactions',
  'ManageChannels',
];

/**
 * A guild stub: Sylo's own permissions, a role at position 10 and a few channels. `channelPerms` maps a
 * channel id to what Sylo may do there; the rest allows everything.
 */
function stubGuild({
  me = PermissionsBitField.All,
  channelPerms = {},
  client,
  extraRoles = [],
  channelIds = [CH, CH2],
} = {}) {
  const guild = {
    id: G,
    client,
    ownerId: 'someone-else',
    members: {
      me: { id: 'bot', permissions: new PermissionsBitField(me), roles: { highest: { position: 10 } } },
    },
    channels: { cache: new Map() },
    roles: {
      cache: new Map(
        [
          { id: G, name: '@everyone', position: 0 },
          { id: ROLE_OK, name: 'Member', position: 3 },
          { id: ROLE_HIGH, name: 'Verified', position: 20 },
          { id: ROLE_MANAGED, name: 'Booster', position: 2, managed: true },
          { id: ROLE_PING, name: 'Alerts', position: 1, mentionable: false },
          ...extraRoles,
        ].map((r) => [r.id, r])
      ),
    },
  };
  for (const id of channelIds) {
    guild.channels.cache.set(id, {
      id,
      name: id === CH ? 'welcome' : 'general',
      isTextBased: () => true,
      isVoiceBased: () => false,
      permissionsFor: () => perms(channelPerms[id] ?? ALL_CHANNEL),
    });
  }
  return guild;
}

const on = (id, config = {}) => ({ id, enabled: true, config });
const build = (guild, modules) => buildHealthReport(guild, { modules });

test('a healthy server has no checks', async () => {
  const report = await build(stubGuild(), [
    on('verification', { verifiedRoleId: ROLE_OK, channelId: CH }),
    on('logging', { channel: CH2 }),
  ]);
  assert.equal(report.available, true);
  assert.deepEqual(report.checks, []);
});

test('a module that is switched off is not checked', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: ['ViewChannel'] } });
  const report = await build(guild, [{ id: 'logging', enabled: false, config: { channel: CH } }]);
  assert.deepEqual(report.checks, []);
});

test('a channel Sylo cannot post in is an error naming the missing permissions', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: ['ViewChannel', 'SendMessages'] } });
  const { checks } = await build(guild, [on('logging', { channel: CH })]);
  assert.equal(checks.length, 1);
  const [c] = checks;
  assert.equal(c.module, 'logging');
  assert.equal(c.severity, 'error');
  assert.equal(c.code, 'missing-channel-permission');
  assert.equal(c.targetId, CH);
  assert.deepEqual(c.permissions, ['EmbedLinks']);
  assert.match(c.message, /#welcome/);
  assert.match(c.message, /Embed Links/);
  assert.match(c.fix, /allow Sylo's role Embed Links/);
  assert.match(c.href, /\/m\/logging$/);
  assert.equal(c.field, 'channel');
});

test('an optional channel is only a warning', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: [] } });
  const { checks } = await build(guild, [on('verification', { channelId: CH2, logChannelId: CH })]);
  assert.deepEqual(
    checks.map((c) => [c.targetId, c.severity]),
    [[CH, 'warning']]
  );
});

test('a channel or role that no longer exists is left to the setup check', async () => {
  const gone = '999999999999999999';
  const { checks } = await build(stubGuild(), [
    on('verification', { verifiedRoleId: gone, channelId: gone }),
  ]);
  assert.deepEqual(checks, []);
});

test('a role above Sylo, a managed role and @everyone cannot be given', async () => {
  const guild = stubGuild();
  const { checks } = await build(guild, [
    on('leveling', {
      rewards: [
        { level: 1, roleId: ROLE_OK },
        { level: 2, roleId: ROLE_HIGH },
        { level: 3, roleId: ROLE_MANAGED },
        { level: 4, roleId: G },
      ],
    }),
  ]);
  assert.deepEqual(
    checks.map((c) => [c.targetId, c.code]),
    [
      [ROLE_HIGH, 'role-above'],
      [ROLE_MANAGED, 'role-managed'],
      [G, 'role-everyone'],
    ],
    'a role Sylo can reach raises nothing'
  );
  assert.match(checks[0].message, /Sylo can't give Verified/);
  assert.match(checks[0].fix, /move Sylo's role above Verified/);
  assert.equal(checks[0].kind, 'role-hierarchy');
  assert.equal(checks[0].severity, 'error');
});

test('a role Sylo takes away says so', async () => {
  const { checks } = await build(stubGuild(), [
    on('custom-commands', {
      commands: [{ name: 'x', actions: [{ type: 'remove-role', roleId: ROLE_HIGH }] }],
    }),
  ]);
  assert.match(checks[0].message, /can't take away Verified/);
});

test('missing Manage Roles is reported once per module, however many roles it gives', async () => {
  const guild = stubGuild({ me: ['ViewChannel'] });
  const { checks } = await build(guild, [
    on('leveling', {
      rewards: [
        { level: 1, roleId: ROLE_OK },
        { level: 2, roleId: ROLE_OK },
      ],
    }),
    on('verification', { verifiedRoleId: ROLE_OK }),
  ]);
  const manage = checks.filter((c) => c.permission === 'ManageRoles');
  assert.deepEqual(manage.map((c) => c.module).sort(), ['leveling', 'verification']);
  assert.match(manage[0].message, /Sylo is missing Manage Roles/);
});

test('moderation needs the permission of each action a warning threshold takes', async () => {
  const guild = stubGuild({ me: ['ViewChannel', 'KickMembers'] });
  const { checks } = await build(guild, [
    on('moderation', {
      warnThresholds: [
        { count: 2, action: 'timeout' },
        { count: 3, action: 'kick' },
        { count: 5, action: 'ban' },
      ],
    }),
  ]);
  assert.deepEqual(checks.map((c) => c.permission).sort(), ['BanMembers', 'ModerateMembers']);
});

test('auto-moderation needs Manage Messages for deleting and Timeout Members for timeouts', async () => {
  const guild = stubGuild({ me: ['ViewChannel'] });
  const rules = { spam: { enabled: true, action: 'timeout' }, caps: { enabled: false, action: 'delete' } };
  const { checks } = await build(guild, [on('automod', { deleteMessage: true, rules })]);
  assert.deepEqual(checks.map((c) => c.permission).sort(), ['ManageMessages', 'ModerateMembers']);
  const quiet = await build(guild, [on('automod', { deleteMessage: true, rules: {} })]);
  assert.deepEqual(quiet.checks, [], 'no rule on, nothing to delete');
});

test('temporary voice needs Manage Channels; the hub category needs it too', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: ['ViewChannel'] }, me: ['ViewChannel'] });
  const { checks } = await build(guild, [
    on('temp-voice', { hubs: [{ hubChannelId: CH2, categoryId: CH }] }),
  ]);
  assert.ok(checks.some((c) => c.permission === 'ManageChannels' && c.kind === 'guild-permission'));
  assert.ok(checks.some((c) => c.targetId === CH && c.permissions.includes('ManageChannels')));
});

test('a ping role that is not mentionable warns, unless Sylo may mention everyone', async () => {
  const cfg = { channelId: CH, roleId: ROLE_PING };
  const blocked = await build(stubGuild({ channelPerms: { [CH]: POST } }), [on('free-games', cfg)]);
  assert.deepEqual(
    blocked.checks.map((c) => [c.code, c.severity]),
    [['role-not-pingable', 'warning']]
  );
  const allowed = await build(stubGuild({ channelPerms: { [CH]: [...POST, 'MentionEveryone'] } }), [
    on('free-games', cfg),
  ]);
  assert.deepEqual(allowed.checks, []);
});

test('a permission the platform does not know is skipped, not reported as missing', async () => {
  // Fluxer's permission object throws for a name it does not have (no timeouts there).
  const fluxer = { isReady: () => true };
  runtime.clients.fluxer = fluxer;
  try {
    const guild = stubGuild({ client: fluxer });
    guild.members.me.permissions = {
      has: (name) => {
        if (name === 'ModerateMembers') throw new RangeError('Invalid permission');
        return false;
      },
    };
    const { checks, platform } = await build(guild, [
      on('moderation', {
        warnThresholds: [
          { count: 2, action: 'timeout' },
          { count: 4, action: 'ban' },
        ],
      }),
    ]);
    assert.equal(platform, 'fluxer');
    assert.deepEqual(
      checks.map((c) => c.permission),
      ['BanMembers']
    );
  } finally {
    runtime.clients.fluxer = null;
  }
});

test('a platform without thread permissions skips the auto-thread check', async () => {
  const fluxer = { isReady: () => true };
  runtime.clients.fluxer = fluxer;
  try {
    const guild = stubGuild({ client: fluxer, channelPerms: { [CH]: ['ViewChannel'] } });
    const { checks } = await build(guild, [on('auto-threads', { rules: [{ channelId: CH }] })]);
    assert.deepEqual(checks, []);
    const discord = await build(stubGuild({ channelPerms: { [CH]: ['ViewChannel'] } }), [
      on('auto-threads', { rules: [{ channelId: CH }] }),
    ]);
    assert.deepEqual(discord.checks[0].permissions, ['CreatePublicThreads', 'SendMessagesInThreads']);
  } finally {
    runtime.clients.fluxer = null;
  }
});

test('a guild whose bot member is not cached is reported as unavailable, not as broken', async () => {
  const guild = stubGuild();
  guild.members.me = null;
  const report = await build(guild, [on('logging', { channel: CH })]);
  assert.equal(report.available, false);
  assert.deepEqual(report.checks, []);
});

test('the server owner may give any role', () => {
  const guild = stubGuild();
  guild.ownerId = 'bot';
  assert.equal(roleBlock(guild, guild.members.me, guild.roles.cache.get(ROLE_HIGH)), null);
});

test('checks come errors first, and the same need is only reported once', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: [], [CH2]: [] } });
  const { checks } = await build(guild, [
    on('verification', { verifiedRoleId: ROLE_OK, channelId: CH, logChannelId: CH2 }),
    on('custom-commands', {
      commands: [
        {
          name: 'x',
          actions: [
            { type: 'send', channelId: CH2 },
            { type: 'send', channelId: CH2 },
          ],
        },
      ],
    }),
  ]);
  assert.deepEqual(
    checks.map((c) => `${c.module}:${c.severity}`),
    ['verification:error', 'custom-commands:error', 'verification:warning']
  );
});

test('pickerTargets lists only the roles and channels Sylo cannot use', () => {
  const guild = stubGuild({ channelPerms: { [CH]: ['ViewChannel'] } });
  const t = pickerTargets(guild, guild.members.me);
  assert.equal(t.roles.blockedAll, null);
  assert.deepEqual(t.roles.blocked, { [ROLE_HIGH]: 'above', [ROLE_MANAGED]: 'managed' });
  assert.deepEqual(t.channels.blocked, { [CH]: ['Send Messages', 'Embed Links'] });
  const noRoles = stubGuild({ me: ['ViewChannel'] });
  assert.match(pickerTargets(noRoles, noRoles.members.me).roles.blockedAll, /Manage Roles/);
});

test('reportFor hides the modules only the operator may use, with the counts to match', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: [] } });
  const report = await build(guild, [on('apple-connect', { channelId: CH }), on('logging', { channel: CH })]);
  assert.deepEqual(report.checks.map((c) => c.module).sort(), ['apple-connect', 'logging']);
  const operator = reportFor(report, { owner: true });
  const admin = reportFor(report, { owner: false });
  assert.equal(operator.summary.errors, 2);
  assert.deepEqual(
    admin.checks.map((c) => c.module),
    ['logging']
  );
  assert.equal(admin.summary.errors, 1);
  assert.ok(admin.checks.every((c) => !('ownerOnly' in c)));
});

test('the report is cached per server and dropped when settings change', async () => {
  resetHealthCache();
  const guild = stubGuild();
  const modules = [on('logging', { channel: CH })];
  const first = await getHealthReport(guild, { modules });
  assert.equal(first.checks.length, 0);
  // Sylo loses a permission: the cached copy is still served for a minute.
  guild.channels.cache.get(CH).permissionsFor = () => perms(['ViewChannel']);
  assert.equal((await getHealthReport(guild, { modules })).checks.length, 0);
  invalidateHealth(G);
  assert.equal((await getHealthReport(guild, { modules })).checks.length, 1);
  // A re-check ignores the cache.
  guild.channels.cache.get(CH).permissionsFor = () => perms(ALL_CHANNEL);
  assert.equal((await getHealthReport(guild, { modules })).checks.length, 1);
  assert.equal((await getHealthReport(guild, { modules, fresh: true })).checks.length, 0);
  resetHealthCache();
});

test('a save that lands while a report is built is not overwritten by that older report', async () => {
  resetHealthCache();
  const { healthFor } = await import('../src/lib/healthCache.js');
  let release;
  const slow = healthFor(G, () => new Promise((resolve) => (release = () => resolve('old'))));
  invalidateHealth(G);
  release();
  assert.equal(await slow, 'old');
  assert.equal(await healthFor(G, async () => 'new'), 'new', 'the old report was not kept');
  resetHealthCache();
});

test('a cached report expires after a minute', async () => {
  resetHealthCache();
  const { healthFor, HEALTH_TTL_MS } = await import('../src/lib/healthCache.js');
  const t0 = 1_000_000;
  assert.equal(await healthFor(G, async () => 'a', { now: t0 }), 'a');
  assert.equal(await healthFor(G, async () => 'b', { now: t0 + HEALTH_TTL_MS - 1 }), 'a');
  assert.equal(await healthFor(G, async () => 'c', { now: t0 + HEALTH_TTL_MS }), 'c');
  resetHealthCache();
});
