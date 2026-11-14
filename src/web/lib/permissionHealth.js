// The permission and role-hierarchy health check of a server: for every module that is switched on, what
// Sylo itself needs in the places the module is set up to use (the channels it posts in, the roles it
// gives or takes away, the server-wide permissions its actions rely on), compared with what Sylo's role
// can do there now. "The bot doesn't work" is mostly one of these.
//
// Every problem is one check: `{ module, moduleName, severity, code, message, fix, href, ... }`.
// `severity` is 'error' when the module cannot do that part of its job at all, and 'warning' when it
// still works but something it does on the side fails (an optional log channel, a ping that will not
// ping). `fix` is a plain instruction for a server admin; `href` is the module's page in the dashboard.
//
// The check is read-only and answers only what the platform can tell: a permission the platform does not
// have (Fluxer has no timeouts or thread permissions) is skipped, never reported as missing. The report
// is cached per server for a minute and dropped when settings are saved (src/lib/healthCache.js).
import { MODULES, getModule } from '../../modules/registry.js';
import { getGuildModules } from '../../db/modules.js';
import { getGuildSettings } from '../../db/guildSettings.js';
import { listScheduled } from '../../db/scheduledMessages.js';
import { listCleanupSchedules } from '../../db/channelCleanup.js';
import { listGithubWatches } from '../../db/githubWatches.js';
import { listItems } from '../../db/economyShop.js';
import { listForms } from '../../db/applications.js';
import { guildSupports, platformOfGuild, rawGuildId } from '../../platform/platformOf.js';
import { healthFor } from '../../lib/healthCache.js';
import { v2CardHref } from './overviewSummary.js';
import { log } from '../../lib/log.js';

const ERROR = 'error';
const WARNING = 'warning';

/** What a module needs in a channel it posts an embed in. */
export const POST = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

const LABELS = {
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  AddReactions: 'Add Reactions',
  ManageMessages: 'Manage Messages',
  ReadMessageHistory: 'Read Message History',
  ManageRoles: 'Manage Roles',
  ManageChannels: 'Manage Channels',
  ManageNicknames: 'Manage Nicknames',
  ManageGuild: 'Manage Server',
  ModerateMembers: 'Timeout Members',
  KickMembers: 'Kick Members',
  BanMembers: 'Ban Members',
  MoveMembers: 'Move Members',
  Connect: 'Connect',
  CreatePublicThreads: 'Create Public Threads',
  SendMessagesInThreads: 'Send Messages in Threads',
  MentionEveryone: 'Mention Everyone',
};
const labelOf = (perm) => LABELS[perm] ?? perm;
const list = (perms) => perms.map(labelOf).join(', ');

const isId = (v) => /^\d{17,20}$/.test(String(v ?? ''));
const arr = (v) => (Array.isArray(v) ? v : []);
const ids = (v) => [...new Set(arr(v).map(String).filter(isId))];

// --- what a module needs, as plain data -----------------------------------------------------------
// A need is one of:
//   { type: 'guild',   perm, why }                          a server-wide permission
//   { type: 'channel', id, label, perms, severity, ... }    permissions in one channel
//   { type: 'role',    id, label, action, channelId? }      a role Sylo gives ('give'), takes away
//                                                           ('remove') or pings ('ping')

const guildPerm = (perm, why, severity = ERROR) => ({ type: 'guild', perm, why, severity });
const inChannel = (id, label, perms, { severity = ERROR, field } = {}) =>
  isId(id) ? { type: 'channel', id: String(id), label, perms, severity, field } : null;
/** A channel Sylo posts embeds in; `optional` makes a failure a warning (a log channel, an extra copy). */
const post = (id, label, { optional = false, extra = [], field } = {}) =>
  inChannel(id, label, [...POST, ...extra], { severity: optional ? WARNING : ERROR, field });
const give = (id, label, field) =>
  isId(id) ? { type: 'role', id: String(id), label, action: 'give', field } : null;
const take = (id, label, field) =>
  isId(id) ? { type: 'role', id: String(id), label, action: 'remove', field } : null;
const ping = (id, label, channelId, field) =>
  isId(id) ? { type: 'role', id: String(id), label, action: 'ping', channelId, field } : null;

/** One alert list (streamers, feeds ...): a channel to post in and an optional role to ping. */
const alertNeeds = (rows, { channelKey, nameOf }) =>
  arr(rows).flatMap((a) => [
    post(a?.[channelKey], `The channel for ${nameOf(a)}`, { field: channelKey }),
    ping(a?.roleId, `The ping role for ${nameOf(a)}`, a?.[channelKey], 'roleId'),
  ]);

const ACTION_PERM = {
  timeout: ['ModerateMembers', 'time members out'],
  kick: ['KickMembers', 'kick members'],
  ban: ['BanMembers', 'ban members'],
};
const actionNeeds = (actions) =>
  [...new Set(actions)].filter((a) => ACTION_PERM[a]).map((a) => guildPerm(...ACTION_PERM[a]));

/**
 * Module id -> a function that lists the needs of the module from its stored config.
 * `x` holds what the module keeps outside its config (see `loadExtras`).
 * Only settings that make Sylo act are listed: a role that is only allowed in or exempted is not.
 * @type {Record<string, (cfg: any, x: any, guild: any) => Array<object|null>>}
 */
export const NEEDS = {
  moderation: (cfg, x) => [
    post(x.settings?.modlog_channel_id, 'The mod-log channel', { optional: true }),
    ...actionNeeds(arr(cfg.warnThresholds).map((r) => r?.action)),
  ],
  logging: (cfg) => [post(cfg.channel, 'The log channel', { field: 'channel' })],
  tickets: (cfg) => [post(cfg.notifyChannel, 'The notification channel', { optional: true })],
  roles: (cfg) => {
    const needs = [
      ...ids(cfg.autoroles).map((r) => give(r, 'An autorole', 'autoroles')),
      ...arr(cfg.reactionMessages).flatMap((rm) => [
        post(rm?.channelId, 'A reaction-role message channel', {
          extra:
            rm?.style === 'buttons' || rm?.style === 'select' ? [] : ['AddReactions', 'ReadMessageHistory'],
        }),
        ...arr(rm?.pairs).map((p) => give(p?.roleId, 'A reaction role', 'roleId')),
      ]),
    ];
    return needs;
  },
  verification: (cfg) => [
    give(cfg.verifiedRoleId, 'The verified role', 'verifiedRoleId'),
    post(cfg.channelId, 'The verification channel', { field: 'channelId' }),
    post(cfg.logChannelId, 'The log channel', { optional: true, field: 'logChannelId' }),
    ...(Number(cfg.kickAfterMinutes) > 0
      ? [guildPerm('KickMembers', 'kick members who do not verify in time')]
      : []),
  ],
  welcome: (cfg) => [
    cfg.joinEnabled
      ? post(cfg.joinChannel, 'The welcome channel', {
          extra: cfg.card ? ['AttachFiles'] : [],
          field: 'joinChannel',
        })
      : null,
    cfg.leaveEnabled ? post(cfg.leaveChannel, 'The leave channel', { field: 'leaveChannel' }) : null,
  ],
  birthdays: (cfg) => [
    post(cfg.channel, 'The birthday channel', { field: 'channel' }),
    give(cfg.roleId, 'The birthday role', 'roleId'),
  ],
  'welcome-channel': (cfg) => [post(cfg.channelId, 'The welcome channel', { field: 'channelId' })],
  'custom-commands': (cfg) =>
    arr(cfg.commands).flatMap((c) =>
      arr(c?.actions).map((a) => {
        if (a?.type === 'send') return post(a.channelId, `The channel of /${c.name}`, { field: 'channelId' });
        if (a?.type === 'add-role') return give(a.roleId, `The role of /${c.name}`, 'roleId');
        if (a?.type === 'remove-role') return take(a.roleId, `The role of /${c.name}`, 'roleId');
        return null;
      })
    ),
  'auto-react': (cfg) => [
    post(cfg.logChannelId, 'The log channel', { optional: true, field: 'logChannelId' }),
    ...arr(cfg.rules).flatMap((r) => [
      inChannel(
        r?.channelId,
        'An auto-react channel',
        ['ViewChannel', 'AddReactions', 'ReadMessageHistory'],
        {
          severity: WARNING,
          field: 'channelId',
        }
      ),
      r?.roleAction === 'remove'
        ? take(r?.roleId, 'An auto-react role', 'roleId')
        : give(r?.roleId, 'An auto-react role', 'roleId'),
    ]),
  ],
  'auto-threads': (cfg, _x, guild) =>
    // Thread permissions do not exist on every platform: where they do not, there is nothing to check.
    guildSupports(guild, 'threads')
      ? arr(cfg.rules).map((r) =>
          inChannel(
            r?.channelId,
            'An auto-thread channel',
            ['ViewChannel', 'CreatePublicThreads', 'SendMessagesInThreads'],
            {
              field: 'channelId',
            }
          )
        )
      : [],
  counting: (cfg) => [
    post(cfg.channelId, 'The counting channel', {
      extra: cfg.react ? ['AddReactions'] : [],
      field: 'channelId',
    }),
    give(cfg.penaltyRoleId, 'The penalty role', 'penaltyRoleId'),
  ],
  leveling: (cfg) => [
    cfg.announce === 'channel' && cfg.announceChannel
      ? post(cfg.announceChannel, 'The level-up channel', { field: 'announceChannel' })
      : null,
    ...arr(cfg.rewards).map((r) => give(r?.roleId, 'A reward role', 'roleId')),
  ],
  economy: (cfg, x) => [
    post(cfg.logChannelId, 'The log channel', { optional: true, field: 'logChannelId' }),
    post(cfg.shopChannelId, 'The shop channel', { optional: true, field: 'shopChannelId' }),
    post(cfg.collectibleChannelId, 'The collectibles channel', {
      optional: true,
      field: 'collectibleChannelId',
    }),
    ...arr(x.shopItems)
      .filter((i) => i.enabled && (i.type === 'role' || i.type === 'temp_role'))
      .map((i) => give(i.roleId, `The role of the shop item "${i.name}"`, 'roleId')),
  ],
  starboard: (cfg) =>
    arr(cfg.boards).map((b) =>
      post(b?.channelId, `The channel of ${b?.name || 'a starboard'}`, { field: 'channelId' })
    ),
  introductions: (cfg) => [
    post(cfg.channelId, 'The introductions channel', { extra: ['ReadMessageHistory'], field: 'channelId' }),
    post(cfg.promptChannelId, 'The prompt channel', { optional: true, field: 'promptChannelId' }),
  ],
  applications: (cfg, x) => [
    post(cfg.panelChannelId, 'The panel channel', { optional: true, field: 'panelChannelId' }),
    ...arr(x.forms)
      .filter((f) => f.enabled)
      .flatMap((f) => {
        const c = f.config ?? {};
        const name = f.name || 'an application form';
        const more = { extra: ['ReadMessageHistory'] };
        return [
          post(c.pendingChannelId, `The staff channel of "${name}"`, more),
          post(c.acceptedChannelId, `The accepted channel of "${name}"`, { ...more, optional: true }),
          post(c.deniedChannelId, `The denied channel of "${name}"`, { ...more, optional: true }),
          give(c.pendingRoleId, `The pending role of "${name}"`, 'pendingRoleId'),
          ...ids(c.acceptAddRoleIds).map((r) => give(r, `An accepted role of "${name}"`, 'acceptAddRoleIds')),
          ...ids(c.denyAddRoleIds).map((r) => give(r, `A denied role of "${name}"`, 'denyAddRoleIds')),
          ...ids(c.removeOnSubmitRoleIds).map((r) =>
            take(r, `A role "${name}" takes away`, 'removeOnSubmitRoleIds')
          ),
          ...ids(c.acceptRemoveRoleIds).map((r) =>
            take(r, `A role "${name}" takes away`, 'acceptRemoveRoleIds')
          ),
          ...ids(c.denyRemoveRoleIds).map((r) => take(r, `A role "${name}" takes away`, 'denyRemoveRoleIds')),
          ...ids(c.pingRoleIds).map((r) =>
            ping(r, `The ping role of "${name}"`, c.pendingChannelId, 'pingRoleIds')
          ),
        ];
      }),
  ],
  appeals: (cfg) => [
    post(cfg.reviewChannelId, 'The review channel', { field: 'reviewChannelId' }),
    ...(cfg.autoUnbanOnAccept !== false
      ? [guildPerm('BanMembers', 'lift the ban when an appeal is accepted', WARNING)]
      : []),
  ],
  suggestions: (cfg) => [
    post(cfg.channel, 'The suggestions channel', { field: 'channel' }),
    post(cfg.logChannel, 'The log channel', { optional: true, field: 'logChannel' }),
  ],
  sticky: (cfg) =>
    arr(cfg.stickies).map((s) =>
      inChannel(s?.channelId, 'A sticky message channel', s?.embed ? POST : ['ViewChannel', 'SendMessages'], {
        field: 'channelId',
      })
    ),
  events: (cfg) => [post(cfg.channel, 'The events channel', { optional: true, field: 'channel' })],
  'server-stats': (cfg) =>
    arr(cfg.channels).map((c) =>
      inChannel(c?.channelId, 'A statistics channel', ['ViewChannel', 'ManageChannels'], {
        field: 'channelId',
      })
    ),
  'temp-voice': (cfg, _x, guild) => [
    guildPerm('ManageChannels', 'create and delete temporary channels'),
    ...(guildSupports(guild, 'moveMembers')
      ? [guildPerm('MoveMembers', 'move members into their new channel')]
      : []),
    ...arr(cfg.hubs).flatMap((h) => [
      inChannel(h?.hubChannelId, 'A hub channel', ['ViewChannel', 'Connect'], { field: 'hubChannelId' }),
      inChannel(h?.categoryId, 'A temporary-channel category', ['ViewChannel', 'ManageChannels'], {
        field: 'categoryId',
      }),
    ]),
  ],
  honeypot: (cfg) => [
    ...arr(cfg.channels).flatMap((c) => [
      inChannel(
        c?.channelId,
        'A honeypot channel',
        [...POST, 'ReadMessageHistory', ...(c?.deleteMessage ? ['ManageMessages'] : [])],
        {
          field: 'channelId',
        }
      ),
      ...actionNeeds([c?.action]),
    ]),
    ...arr(cfg.messages).flatMap((m) => [
      inChannel(m?.channelId, 'A honeypot bait channel', [...POST, 'ReadMessageHistory'], {
        field: 'channelId',
      }),
      ...actionNeeds([m?.action]),
    ]),
  ],
  'channel-cleanup': (_cfg, x) =>
    arr(x.cleanup)
      .filter((s) => s.enabled === 1 || s.enabled === true)
      .map((s) =>
        inChannel(s.channel_id ?? s.channelId, 'A cleanup channel', [
          'ViewChannel',
          'ManageMessages',
          'ReadMessageHistory',
        ])
      ),
  reminders: (_cfg, x) =>
    arr(x.reminders)
      .filter((r) => r.enabled === 1 || r.enabled === true)
      .map((r) => post(r.channel_id ?? r.channelId, `The channel of the reminder "${r.name}"`)),
  automod: (cfg) => {
    const rules = Object.values(cfg.rules && typeof cfg.rules === 'object' ? cfg.rules : {}).filter(
      (r) => r?.enabled
    );
    return [
      ...(rules.length && cfg.deleteMessage !== false
        ? [guildPerm('ManageMessages', 'delete messages that break a rule')]
        : []),
      ...actionNeeds(rules.some((r) => r.action === 'timeout') ? ['timeout'] : []),
    ];
  },
  afk: (cfg) => (cfg.setNickname ? [guildPerm('ManageNicknames', 'put [AFK] in nicknames', WARNING)] : []),
  'invite-tracker': (cfg) => [
    guildPerm('ManageGuild', 'read the server invites', WARNING),
    inChannel(cfg.joinLogChannelId, 'The join-log channel', ['ViewChannel', 'SendMessages'], {
      severity: WARNING,
      field: 'joinLogChannelId',
    }),
  ],
  'free-games': (cfg) => [
    post(cfg.channelId, 'The channel for free games', { field: 'channelId' }),
    ping(cfg.roleId, 'The ping role', cfg.channelId, 'roleId'),
  ],
  'twitch-alerts': (cfg) =>
    alertNeeds(cfg.alerts, { channelKey: 'channelId', nameOf: (a) => a?.login || 'a streamer' }),
  'kick-alerts': (cfg) =>
    alertNeeds(cfg.alerts, { channelKey: 'channelId', nameOf: (a) => a?.slug || 'a streamer' }),
  'youtube-alerts': (cfg) =>
    alertNeeds(cfg.alerts, { channelKey: 'discordChannelId', nameOf: (a) => a?.name || 'a YouTube channel' }),
  rss: (cfg) =>
    alertNeeds(cfg.feeds, { channelKey: 'channelId', nameOf: (f) => f?.name || f?.url || 'a feed' }),
  github: (_cfg, x) =>
    arr(x.githubWatches)
      .filter((w) => w.enabled === 1 || w.enabled === true)
      .flatMap((w) => [
        post(w.channel_id ?? w.channelId, `The channel for ${w.repo}`),
        ping(w.role_id ?? w.roleId, `The ping role for ${w.repo}`, w.channel_id ?? w.channelId, 'roleId'),
      ]),
  'apple-connect': (cfg) => [
    post(cfg.channelId, 'The channel', { field: 'channelId' }),
    ping(cfg.roleId, 'The ping role', cfg.channelId, 'roleId'),
    ...Object.values(cfg.events && typeof cfg.events === 'object' ? cfg.events : {}).map((e) =>
      e && typeof e === 'object' && e.enabled
        ? post(e.channelId, 'An alert channel', { field: 'channelId' })
        : null
    ),
  ],
};

/** What a module keeps outside its stored config, loaded only for the modules that are on. */
const EXTRAS = {
  moderation: async (guildId) => ({ settings: await getGuildSettings(guildId) }),
  economy: async (guildId) => ({ shopItems: await listItems(guildId) }),
  applications: async (guildId) => ({ forms: await listForms(guildId) }),
  'channel-cleanup': async (guildId) => ({ cleanup: await listCleanupSchedules(guildId) }),
  reminders: async (guildId) => ({ reminders: await listScheduled(guildId) }),
  github: async (guildId) => ({ githubWatches: await listGithubWatches(guildId) }),
};

// --- comparing a need with what Sylo can do ---------------------------------------------------

/** true / false, or null when this platform cannot tell (an unknown permission name, no permission data). */
function can(perms, name) {
  if (!perms || typeof perms.has !== 'function') return null;
  try {
    return Boolean(perms.has(name));
  } catch {
    return null;
  }
}

/** The permissions of the list that Sylo lacks in a place; the ones this platform cannot answer are left out. */
function lacking(perms, wanted) {
  return wanted.filter((p) => can(perms, p) === false);
}

const isTextChannel = (c) =>
  Boolean(c?.isTextBased?.()) && !(typeof c.isThread === 'function' && c.isThread()) && !c.isVoiceBased?.();

/** Why Sylo cannot give or take away a role, or null when it can: 'everyone', 'managed' or 'above'. */
export function roleBlock(guild, me, role) {
  if (!role) return null;
  if (role.id === rawGuildId(guild)) return 'everyone';
  if (role.managed) return 'managed';
  if (guild.ownerId && guild.ownerId === me?.id) return null;
  const top = me?.roles?.highest?.position ?? 0;
  return (role.position ?? 0) >= top ? 'above' : null;
}

const channelName = (c) => `#${c.name ?? c.id}`;

function guildCheck(base, need, me) {
  if (can(me.permissions, need.perm) !== false) return null;
  return {
    ...base,
    severity: need.severity,
    kind: 'guild-permission',
    code: 'missing-guild-permission',
    permission: need.perm,
    message: `Sylo is missing ${labelOf(need.perm)}, which ${base.moduleName} needs to ${need.why}.`,
    fix: `Give Sylo's role ${labelOf(need.perm)} in the server's role settings.`,
  };
}

function channelCheck(base, need, guild, me) {
  const channel = guild.channels?.cache?.get(need.id);
  // A channel that no longer exists is reported by the "needs attention" setup check, not here.
  if (!channel) return null;
  const perms = typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
  const missing = lacking(perms, need.perms);
  if (!missing.length) return null;
  const where = channelName(channel);
  return {
    ...base,
    severity: need.severity,
    kind: 'channel-permission',
    code: 'missing-channel-permission',
    targetKind: 'channel',
    targetId: need.id,
    targetName: channel.name ?? null,
    permissions: missing,
    message: `${need.label} (${where}): Sylo is missing ${list(missing)}.`,
    fix: `In ${where}'s permissions, allow Sylo's role ${list(missing)}, or pick another channel.`,
  };
}

const ROLE_REASON = {
  above: (name) => ({
    message: `Sylo can't give ${name}: Sylo's role is not above it.`,
    fix: `In the server's role settings, move Sylo's role above ${name}.`,
  }),
  managed: (name) => ({
    message: `${name} is managed by an integration, so Sylo can't give it.`,
    fix: 'Pick a role that is not managed by a bot or an integration.',
  }),
  everyone: () => ({
    message: "@everyone can't be given to a member.",
    fix: 'Pick a normal role instead.',
  }),
};

function roleCheck(base, need, guild, me) {
  const role = guild.roles?.cache?.get(need.id);
  // A deleted role is reported by the setup check; a platform with no role cache cannot tell.
  if (!role) return null;
  const name = role.name ?? 'this role';
  if (need.action === 'ping') {
    // Anyone can mention a mentionable role; otherwise the poster needs Mention Everyone in the channel.
    if (role.mentionable !== false) return null;
    const channel = guild.channels?.cache?.get(need.channelId);
    const perms = typeof channel?.permissionsFor === 'function' ? channel.permissionsFor(me) : me.permissions;
    if (can(perms, 'MentionEveryone') !== false) return null;
    return {
      ...base,
      severity: WARNING,
      kind: 'role-ping',
      code: 'role-not-pingable',
      targetKind: 'role',
      targetId: need.id,
      targetName: name,
      message: `${need.label}: Sylo can't ping ${name}, because the role is not mentionable.`,
      fix: `Allow anyone to mention ${name} in its role settings, or give Sylo's role Mention Everyone.`,
    };
  }
  const block = roleBlock(guild, me, role);
  if (!block) return null;
  const why = ROLE_REASON[block](name);
  const verb = need.action === 'remove' ? 'take away' : 'give';
  return {
    ...base,
    severity: ERROR,
    kind: block === 'above' ? 'role-hierarchy' : 'role-unavailable',
    code: `role-${block}`,
    targetKind: 'role',
    targetId: need.id,
    targetName: name,
    message: need.action === 'remove' ? why.message.replace("can't give", "can't take away") : why.message,
    fix: why.fix,
    detail: `${need.label}: Sylo has to ${verb} this role.`,
  };
}

// --- the report -------------------------------------------------------------------------------

const SEVERITY_ORDER = { error: 0, warning: 1 };

/**
 * Which roles and channels of the whole server Sylo cannot use, for the pickers: a role it cannot give
 * (with the reason) and a channel it cannot post in (with the permissions it lacks). Only the ones that
 * fail are listed, so a healthy server sends almost nothing.
 */
export function pickerTargets(guild, me) {
  const roles = { blockedAll: null, blocked: {} };
  if (can(me.permissions, 'ManageRoles') === false)
    roles.blockedAll = "Sylo can't give roles: it is missing Manage Roles.";
  for (const role of guild.roles?.cache?.values?.() ?? []) {
    const block = roleBlock(guild, me, role);
    if (block && block !== 'everyone') roles.blocked[role.id] = block;
  }
  const channels = { blocked: {} };
  for (const channel of guild.channels?.cache?.values?.() ?? []) {
    if (!isTextChannel(channel) || typeof channel.permissionsFor !== 'function') continue;
    const missing = lacking(channel.permissionsFor(me), POST);
    if (missing.length) channels.blocked[channel.id] = missing.map(labelOf);
  }
  return { roles, channels };
}

/**
 * Build the whole report for a server. Pure apart from the reads of the module rows, the few
 * tables a module keeps outside its config and the guild's own caches.
 * @param {any} guild  the platform guild (its `.id` is the server key)
 * @param {{ modules?: Array<{ id: string, enabled: boolean, config: object }> }} [opts]
 */
export async function buildHealthReport(guild, { modules } = {}) {
  const platform = platformOfGuild(guild);
  const me = guild.members?.me;
  const base = { platform, checkedAt: Date.now() };
  if (!me) return { ...base, available: false, checks: [], targets: null };

  const rows = new Map((modules ?? (await getGuildModules(guild.id))).map((m) => [m.id, m]));
  const checks = [];
  for (const def of MODULES) {
    const row = rows.get(def.id);
    if (!(row?.enabled ?? def.defaultEnabled)) continue;
    const needsOf = NEEDS[def.id];
    if (!needsOf) continue;
    const mod = getModule(def.id);
    const cfg = row?.config && typeof row.config === 'object' ? row.config : {};
    let needs;
    try {
      const x = EXTRAS[def.id] ? await EXTRAS[def.id](guild.id) : {};
      needs = needsOf(cfg, x, guild).filter(Boolean);
    } catch (err) {
      log.warn('health', `could not read the settings of ${def.id} (${guild.id})`, err);
      continue;
    }
    const moduleBase = {
      module: def.id,
      moduleName: mod.name,
      href: v2CardHref(def.id, guild.id),
      ...(def.ownerOnly ? { ownerOnly: true } : {}),
    };
    const seen = new Set();
    for (const need of needs) {
      const key = `${need.type}|${need.id ?? need.perm}|${need.action ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const check =
        need.type === 'guild'
          ? guildCheck(moduleBase, need, me)
          : need.type === 'channel'
            ? channelCheck(moduleBase, need, guild, me)
            : roleCheck(moduleBase, need, guild, me);
      if (check) {
        if (need.field) check.field = need.field;
        checks.push(check);
      }
    }
    // A role to give or take away also needs Manage Roles, once per module, not once per role.
    if (needs.some((n) => n.type === 'role' && n.action !== 'ping')) {
      const missing = guildCheck(moduleBase, guildPerm('ManageRoles', 'give and take away roles'), me);
      if (missing && !checks.some((c) => c.module === def.id && c.permission === 'ManageRoles'))
        checks.push(missing);
    }
  }
  checks.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  return { ...base, available: true, checks, targets: pickerTargets(guild, me) };
}

/**
 * The cached report of a server (see src/lib/healthCache.js). It holds every module; use
 * `reportFor` to cut it down for the person asking.
 * @param {any} guild
 * @param {{ fresh?: boolean, modules?: any[] }} [opts]  `fresh` ignores the cached copy
 */
export function getHealthReport(guild, { fresh = false, modules } = {}) {
  return healthFor(guild.id, () => buildHealthReport(guild, { modules }), { fresh });
}

/**
 * The report as one person may see it: a module only the bot's operator may use (registry `ownerOnly`)
 * is left out for anyone else, with the counts to match.
 * @param {Awaited<ReturnType<typeof buildHealthReport>>} report
 * @param {{ owner?: boolean }} [viewer]
 */
export function reportFor(report, { owner = true } = {}) {
  const checks = report.checks.filter((c) => owner || !c.ownerOnly).map(({ ownerOnly: _o, ...rest }) => rest);
  return {
    available: report.available,
    platform: report.platform,
    checkedAt: report.checkedAt,
    summary: {
      errors: checks.filter((c) => c.severity === ERROR).length,
      warnings: checks.filter((c) => c.severity === WARNING).length,
    },
    checks,
    targets: report.targets,
  };
}
