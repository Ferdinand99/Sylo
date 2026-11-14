import './helpers/tmpDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client, PermissionFlagsBits as Flag, PermissionsBitField } from 'discord.js';
import { keyedGuild } from '../src/platform/platformOf.js';
import { runtime } from '../src/runtime.js';
import {
  NEEDS,
  POST,
  POST_TEXT,
  buildHealthReport,
  getHealthReport,
  mergeNeeds,
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
  voiceIds = [],
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
  for (const id of voiceIds) {
    guild.channels.cache.set(id, {
      id,
      name: 'members',
      isTextBased: () => false,
      isVoiceBased: () => true,
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

test('Fluxer is checked for timeouts like Discord, and a permission name it does not know is skipped', async () => {
  const fluxer = { isReady: () => true };
  runtime.clients.fluxer = fluxer;
  try {
    const guild = stubGuild({ client: fluxer });
    guild.members.me.permissions = {
      has: (name) => {
        // Fluxer's permission object throws for a name it does not have.
        if (name === 'ManageNicknames') throw new RangeError('Invalid permission');
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
      on('afk', { setNickname: true }),
    ]);
    assert.equal(platform, 'fluxer');
    assert.deepEqual(checks.map((c) => c.permission).sort(), ['BanMembers', 'ModerateMembers']);
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
  assert.deepEqual(t.channels.blocked, { [CH]: ['Send Messages'] });
  assert.deepEqual(t.channels.noEmbed, []);
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

test('a channel without Embed Links is only a picker problem for a module that sends embeds', () => {
  const guild = stubGuild({ channelPerms: { [CH]: POST_TEXT } });
  const t = pickerTargets(guild, guild.members.me);
  assert.deepEqual(t.channels.blocked, {});
  assert.deepEqual(t.channels.noEmbed, [CH]);
});

// --- plain text does not need Embed Links ------------------------------------------------------

const TEXT_ONLY = { channelPerms: { [CH]: POST_TEXT } };

test('modules that send plain text work in a channel without Embed Links', async () => {
  const guild = stubGuild(TEXT_ONLY);
  const { checks } = await build(guild, [
    on('welcome', { joinEnabled: true, joinChannel: CH, leaveEnabled: true, leaveChannel: CH }),
    on('leveling', { announce: 'channel', announceChannel: CH }),
    on('counting', { channelId: CH, penaltyMinutes: 0 }),
    on('welcome-channel', { channelId: CH, spec: { content: 'Rules', embeds: [] } }),
    on('twitch-alerts', { alerts: [{ login: 'a', channelId: CH, plainText: true }] }),
    on('kick-alerts', { alerts: [{ slug: 'a', channelId: CH, plainText: true }] }),
    on('custom-commands', {
      commands: [
        {
          name: 'hi',
          actions: [{ type: 'send', channelId: CH, messages: [{ content: 'hi', embed: null }] }],
        },
      ],
    }),
  ]);
  assert.deepEqual(checks, []);
});

test('the same modules ask for Embed Links once they send an embed', async () => {
  const guild = stubGuild(TEXT_ONLY);
  const { checks } = await build(guild, [
    on('welcome', { joinEnabled: true, joinChannel: CH, useEmbed: true }),
    on('welcome-channel', { channelId: CH, spec: { content: '', embeds: [{ title: 'Rules' }] } }),
    on('twitch-alerts', { alerts: [{ login: 'a', channelId: CH }] }),
    on('custom-commands', {
      commands: [
        {
          name: 'hi',
          actions: [{ type: 'send', channelId: CH, messages: [{ content: '', embed: { title: 'x' } }] }],
        },
      ],
    }),
  ]);
  assert.deepEqual(checks.map((c) => c.module).sort(), [
    'custom-commands',
    'twitch-alerts',
    'welcome',
    'welcome-channel',
  ]);
  for (const c of checks) assert.deepEqual(c.permissions, ['EmbedLinks']);
});

test('a text reminder needs no Embed Links, an embed reminder does', () => {
  const guild = stubGuild();
  const need = (embeds) =>
    NEEDS.reminders(
      {},
      { reminders: [{ enabled: 1, channel_id: CH, name: 'r', spec: { embeds } }] },
      guild
    )[0];
  assert.deepEqual(need([]).perms, POST_TEXT);
  assert.deepEqual(need([{ title: 'x' }]).perms, POST);
});

test('the welcome card image is a warning: the message goes out without it', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: POST_TEXT } });
  const { checks } = await build(guild, [on('welcome', { joinEnabled: true, joinChannel: CH, card: true })]);
  assert.deepEqual(
    checks.map((c) => [c.severity, c.permissions]),
    [['warning', ['AttachFiles']]]
  );
});

// --- voice channels ----------------------------------------------------------------------------

test('the temporary-voice hub needs no Connect: Sylo only watches it', async () => {
  const guild = stubGuild({ channelPerms: { [CH2]: ['ViewChannel', 'MoveMembers'] } });
  const { checks } = await build(guild, [on('temp-voice', { hubs: [{ hubChannelId: CH2 }] })]);
  assert.deepEqual(checks, []);
  const blind = stubGuild({ channelPerms: { [CH2]: [] } });
  const seen = await build(blind, [on('temp-voice', { hubs: [{ hubChannelId: CH2 }] })]);
  assert.deepEqual(seen.checks[0].permissions, ['ViewChannel', 'MoveMembers']);
});

test('a statistics voice channel needs Connect: Sylo can only rename a channel it can manage', async () => {
  const VOICE = '111111111111111199';
  const guild = stubGuild({
    voiceIds: [VOICE],
    channelPerms: { [VOICE]: ['ViewChannel', 'ManageChannels'] },
  });
  const { checks } = await build(guild, [on('server-stats', { channels: [{ channelId: VOICE }] })]);
  assert.deepEqual(checks[0].permissions, ['Connect']);
  // The same permissions on a text channel are enough.
  const text = stubGuild({ channelPerms: { [CH]: ['ViewChannel', 'ManageChannels'] } });
  assert.deepEqual((await build(text, [on('server-stats', { channels: [{ channelId: CH }] })])).checks, []);
});

// --- one need per place -----------------------------------------------------------------------

test('a place listed twice is checked once, with every permission and the stronger severity', () => {
  const need = (over) => ({ type: 'channel', id: CH, perms: [], severity: 'error', voice: [], ...over });
  const merged = mergeNeeds([
    need({ label: 'The log channel', perms: ['ViewChannel'], severity: 'warning' }),
    need({ label: 'A rule channel', perms: ['AddReactions'] }),
    need({ label: 'card', perms: ['AttachFiles'], severity: 'warning', part: 'card' }),
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].perms, ['ViewChannel', 'AddReactions']);
  assert.equal(merged[0].severity, 'error');
  assert.equal(merged[0].label, 'A rule channel');
});

test('an optional log channel that is also a rule channel still gets the rule channel permissions', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: POST } });
  const { checks } = await build(guild, [
    on('auto-react', { logChannelId: CH, rules: [{ channelId: CH, roleId: '', roleAction: 'add' }] }),
  ]);
  assert.deepEqual(checks[0].permissions, ['AddReactions', 'ReadMessageHistory']);
});

test('an optional channel listed before a required one with the same id is not downgraded', async () => {
  const guild = stubGuild({ channelPerms: { [CH]: [] } });
  const { checks } = await build(guild, [on('verification', { channelId: CH, logChannelId: CH })]);
  assert.deepEqual(
    checks.map((c) => c.severity),
    ['error']
  );
});

test('the counting penalty role is only checked when a penalty time is set', async () => {
  const cfg = { penaltyRoleId: ROLE_HIGH };
  assert.equal((await build(stubGuild(), [on('counting', { ...cfg, penaltyMinutes: 0 })])).checks.length, 0);
  assert.equal((await build(stubGuild(), [on('counting', { ...cfg, penaltyMinutes: 15 })])).checks.length, 1);
});

// --- the hierarchy and the overwrites, for real ----------------------------------------------

test('a role at exactly the position of Sylo is not one it can give', () => {
  const guild = stubGuild({ extraRoles: [{ id: '222222222222222230', name: 'Peer', position: 10 }] });
  const me = guild.members.me;
  assert.equal(roleBlock(guild, me, guild.roles.cache.get('222222222222222230')), 'above');
  assert.equal(roleBlock(guild, me, guild.roles.cache.get(ROLE_OK)), null);
});

/** A real discord.js guild, so channel permissions come from discord.js's own overwrite resolution. */
function realGuild({ everyone, sylo = 0n, channels }) {
  const client = new Client({ intents: [] });
  client.user = { id: '900000000000000001' };
  const gid = '800000000000000001';
  const syloRole = '800000000000000010';
  const idOf = (i) => String(800000000000000100n + BigInt(i));
  const guild = client.guilds._add({
    id: gid,
    name: 'g',
    roles: [
      { id: gid, name: '@everyone', permissions: String(everyone), position: 0 },
      { id: syloRole, name: 'Sylo', permissions: String(sylo), position: 5 },
    ],
    channels: channels.map((c, i) => ({
      id: idOf(i),
      type: ChannelType.GuildText,
      name: c.name,
      guild_id: gid,
      position: i,
      permission_overwrites: c.overwrites.map((o) => ({
        id: o.role === 'everyone' ? gid : syloRole,
        type: 0,
        allow: String(o.allow ?? 0n),
        deny: String(o.deny ?? 0n),
      })),
    })),
    members: [
      { user: { id: '900000000000000001', username: 'sylo' }, roles: [syloRole], joined_at: '2020-01-01' },
    ],
  });
  return { guild, ids: channels.map((_c, i) => idOf(i)) };
}

test('real overwrites: an @everyone deny is lifted by an allow for Sylo, and a plain deny is not', async () => {
  const base = Flag.ViewChannel | Flag.SendMessages | Flag.EmbedLinks;
  const { guild, ids } = realGuild({
    everyone: base,
    channels: [
      {
        name: 'lifted',
        overwrites: [
          { role: 'everyone', deny: Flag.EmbedLinks },
          { role: 'sylo', allow: Flag.EmbedLinks },
        ],
      },
      { name: 'denied', overwrites: [{ role: 'everyone', deny: Flag.SendMessages }] },
      { name: 'open', overwrites: [] },
    ],
  });
  const [lifted, denied, open] = ids;
  const { checks } = await build(guild, [
    on('logging', { channel: lifted }),
    on('suggestions', { channel: denied }),
    on('verification', { channelId: open }),
  ]);
  assert.deepEqual(
    checks.map((c) => [c.module, c.targetId, c.permissions]),
    [['suggestions', denied, ['SendMessages']]]
  );
});

test('real overwrites: Administrator may do everything whatever a channel denies', async () => {
  const { guild, ids } = realGuild({
    everyone: Flag.ViewChannel,
    sylo: Flag.Administrator,
    channels: [
      { name: 'closed', overwrites: [{ role: 'everyone', deny: Flag.SendMessages | Flag.EmbedLinks }] },
    ],
  });
  const { checks } = await build(guild, [on('logging', { channel: ids[0] })]);
  assert.deepEqual(checks, []);
});

// --- Fluxer: the keyed guild --------------------------------------------------------------------

test('on a keyed Fluxer guild the @everyone role is the raw id, not the "fluxer:" key', async () => {
  const fluxer = { isReady: () => true };
  runtime.clients.fluxer = fluxer;
  try {
    const raw = stubGuild({ client: fluxer });
    const guild = keyedGuild(raw);
    assert.equal(guild.id, `fluxer:${G}`);
    assert.equal(guild.rawId, G);
    const everyone = guild.roles.cache.get(G);
    assert.equal(roleBlock(guild, guild.members.me, everyone), 'everyone');
    const { checks, targets } = await build(guild, [on('verification', { verifiedRoleId: G })]);
    assert.deepEqual(
      checks.map((c) => c.code),
      ['role-everyone']
    );
    assert.equal(checks[0].href, `/v2/guilds/fluxer:${G}/m/verification`);
    assert.equal(targets.roles.blocked[G], undefined, '@everyone is never offered by a picker');
  } finally {
    runtime.clients.fluxer = null;
  }
});
