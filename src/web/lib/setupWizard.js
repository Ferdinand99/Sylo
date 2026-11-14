// The setup wizard for a server that has little configured: it looks at the channels and roles, proposes
// a starter set per goal (suggestSetup), and applies the admin's choices one module at a time (applySetup).
//
// Nothing is created or overwritten on its own:
//   - a channel or role is created only when the admin ticked "Create" for that field, and only after
//     Sylo's own permission for it was checked;
//   - a module that is already set up is left alone unless the admin ticked "Replace" for it, and then
//     the text the admin wrote is kept (only the channels, roles and switches are set).
// Every module is saved through the same normaliser and the same write path (setGuildModule, with the
// role-grant check) as its own settings page, and writes its own audit entry.
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildModule, getGuildModules, setGuildModule } from '../../db/modules.js';
import { getGuildSettings, setModlogChannel, withoutEveryone } from '../../db/guildSettings.js';
import { recordAudit } from '../../db/audit.js';
import { checkModuleGrants } from '../middleware/roleGrants.js';
import { getModule, missingIntents } from '../../modules/registry.js';
import { createGuildChannel } from '../../platform/channels.js';
import { createGuildRole } from '../../platform/roles.js';
import { platformOfGuild, rawGuildId } from '../../platform/platformOf.js';
import { assignableRoles } from './guildContext.js';
import { guildTextChannels } from './discord.js';
import { withRowIds } from './rowIds.js';
import { log } from '../../lib/log.js';
import { normaliseWelcomeConfig } from '../../modules/welcome.js';
import { normaliseVerificationConfig, ensureVerifyMessage } from '../../modules/verification.js';
import { normaliseModerationConfig } from '../../modules/moderation.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { normaliseTicketsConfig } from '../../modules/tickets.js';
import { normaliseLevelingConfig } from '../../modules/leveling.js';
import { normaliseStarboard, boardsToRescan, scheduleRescan } from '../../modules/starboard.js';
import { normaliseSuggestionsConfig } from '../../modules/suggestions.js';

/** The most a single apply creates, so a script cannot use Sylo to fill a server with channels. */
const MAX_CREATED_CHANNELS = 8;
const MAX_CREATED_ROLES = 3;

export const GOALS = [
  { id: 'welcome', label: 'Welcome new members', description: 'Greet people in a channel when they join.' },
  {
    id: 'verify',
    label: 'Verify members',
    description: 'New members press a button to get a role that shows they are verified.',
  },
  {
    id: 'moderation',
    label: 'Moderation and logging',
    description: 'A mod-log, a server log and timeouts for members who keep getting warned.',
  },
  {
    id: 'tickets',
    label: 'Support tickets',
    description: 'Members message Sylo, and staff answer from the dashboard.',
  },
  {
    id: 'community',
    label: 'Community engagement',
    description: 'Levels and XP, a starboard for the best messages and a place for suggestions.',
  },
];

const DEFAULT_WELCOME = 'Welcome to {server}, {user}! Glad to have you here.';
const DEFAULT_THRESHOLDS = [
  { count: 3, action: 'timeout', durationMinutes: 60 },
  { count: 5, action: 'timeout', durationMinutes: 1440 },
];
// Everything except nickname changes, which are the noisiest line of a log.
const LOGGED_EVENTS = LOG_EVENTS.map(([key]) => key).filter((key) => key !== 'nickChange');

// --- matching names ---------------------------------------------------------------------------------

/**
 * A name with case, spaces, emoji and separators removed: "📜│Mod-Log" and "mod_log" are both "modlog".
 * NFKC first, so a name in a fancy Unicode font ("𝗺𝗼𝗱-𝗹𝗼𝗴") reads as plain letters.
 */
const squash = (name) =>
  String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
const words = (name) =>
  String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * The first item whose name is one of `names` (the order of `names` is the order of preference), else
 * the first whose name has one of `loose` as a whole word ("welcome-and-rules" has "welcome").
 * @param {Array<{ id: string, name: string }>} items
 */
export function matchByName(items, names, loose = []) {
  for (const wanted of names) {
    const hit = items.find((item) => squash(item.name) === wanted);
    if (hit) return hit;
  }
  for (const wanted of loose) {
    const hit = items.find((item) => words(item.name).includes(wanted));
    if (hit) return hit;
  }
  return null;
}

// --- what the wizard can set up ----------------------------------------------------------------------

/**
 * @typedef {Object} FieldSpec
 * @property {string} key
 * @property {'channel'|'role'} kind
 * @property {string} label
 * @property {boolean} [optional]   the module works without it
 * @property {boolean} [post]       Sylo posts in this channel (View Channel, Send Messages, Embed Links)
 * @property {boolean} [give]       Sylo gives this role to members (it must sit below Sylo's role)
 * @property {boolean} [staffOnly]  the channel carries things only staff should see
 * @property {string[]} names       squashed names that match, best first
 * @property {string[]} [loose]     whole words that also match
 * @property {boolean} [viewer]     the role may see the private channels of this item (staff access)
 * @property {{ name: string, access?: 'private'|'readonly'|'public-readonly' }} [create]  what "Create" makes.
 *   private: only admins, Sylo and the viewer role see it. readonly: members may not post, and View Channel is
 *   inherited, so a server that hides channels from unverified members keeps them hidden. public-readonly:
 *   everyone may read it (the verify channel, which unverified members must see).
 */

const STAFF_NAMES = [
  'support',
  'supportteam',
  'staff',
  'staffteam',
  'moderator',
  'moderators',
  'mod',
  'mods',
];

/** The optional role that may see a private channel, so moderators without Administrator can open it. */
const viewerField = {
  key: 'viewRole',
  kind: 'role',
  label: 'Role that can see this channel',
  optional: true,
  viewer: true,
  // Used only for the channel's permissions: it is saved nowhere, so it does something only when Sylo creates
  // the channel or changes its permissions.
  viewerOnly: true,
  names: STAFF_NAMES,
  create: { name: 'Support team' },
};

/** Every item the wizard can set up, in the order they are applied. `module` is the registry id. */
const SPECS = [
  {
    id: 'welcome',
    goal: 'welcome',
    module: 'welcome',
    name: 'Welcome & leave',
    does: ['Posts a welcome message in the channel when someone joins.'],
    fields: [
      {
        key: 'joinChannel',
        kind: 'channel',
        label: 'Welcome channel',
        post: true,
        names: ['welcome', 'welcomes', 'welcomechannel', 'greetings', 'arrivals', 'newmembers', 'joins'],
        loose: ['welcome', 'welcomes'],
        create: { name: 'welcome', access: 'readonly' },
      },
    ],
    configured: (cfg) => Boolean(cfg.joinChannel || cfg.leaveChannel || String(cfg.dmMessage ?? '').trim()),
    build(f, { prev, guild }) {
      return normaliseWelcomeConfig(
        {
          ...prev,
          joinEnabled: true,
          joinChannel: f.joinChannel,
          joinMessage: String(prev.joinMessage ?? '').trim() ? prev.joinMessage : DEFAULT_WELCOME,
        },
        guild,
        { prev }
      );
    },
  },
  {
    id: 'verification',
    goal: 'verify',
    module: 'verification',
    name: 'Verification',
    does: [
      'Posts a Verify button in the channel.',
      'Members who press it get the role.',
      'Hiding the other channels from members without the role is up to you.',
    ],
    fields: [
      {
        key: 'channelId',
        kind: 'channel',
        label: 'Channel for the Verify button',
        post: true,
        names: ['verify', 'verification', 'verifyhere', 'getverified', 'starthere', 'rules', 'serverrules'],
        loose: ['verify', 'verification', 'rules'],
        create: { name: 'verify', access: 'public-readonly' },
      },
      {
        key: 'verifiedRoleId',
        kind: 'role',
        label: 'Role for verified members',
        give: true,
        names: ['verified', 'verifiedmember', 'verifiedmembers', 'member', 'members'],
        create: { name: 'Verified' },
      },
    ],
    configured: (cfg) => Boolean(cfg.verifiedRoleId || cfg.channelId),
    build(f, { prev }) {
      return normaliseVerificationConfig({
        ...prev,
        verifiedRoleId: f.verifiedRoleId,
        channelId: f.channelId,
        // The Verify message is posted again when the channel changes.
        messageId: prev.channelId === f.channelId ? prev.messageId : '',
      });
    },
    afterSave: (guild, config) =>
      ensureVerifyMessage(guild, config).catch((err) =>
        log.error('verification', 'ensure message after the setup wizard failed:', err.message)
      ),
  },
  {
    id: 'modlog',
    goal: 'moderation',
    module: null,
    name: 'Mod-log channel',
    does: ['Every moderation action posts an embed in this channel.'],
    fields: [
      {
        key: 'channelId',
        kind: 'channel',
        label: 'Mod-log channel',
        post: true,
        staffOnly: true,
        names: ['modlog', 'modlogs', 'moderationlog', 'moderationlogs', 'modactions', 'modactionlog'],
        create: { name: 'mod-log', access: 'private' },
      },
      viewerField,
    ],
    // Not a module: the channel is a setting of the server (Server settings).
    configured: (_cfg, settings) => Boolean(settings?.modlog_channel_id),
    // Filed like the Server settings save, so the history lists it like one.
    audit: { action: 'settings:server', detail: 'saved; mod-log channel set by the setup wizard' },
  },
  {
    id: 'moderation',
    goal: 'moderation',
    module: 'moderation',
    name: 'Moderation',
    does: [
      'Members are told by DM when they are punished.',
      'Timeout after 3 warnings (1 hour) and after 5 warnings (1 day).',
    ],
    botPerms: [['ModerateMembers', 'Timeout Members']],
    fields: [],
    configured: (cfg) => Array.isArray(cfg.warnThresholds) && cfg.warnThresholds.length > 0,
    build(_f, { prev }) {
      const kept = Array.isArray(prev.warnThresholds) && prev.warnThresholds.length;
      return normaliseModerationConfig({
        ...prev,
        dmOnPunish: prev.dmOnPunish !== false,
        warnThresholds: kept ? prev.warnThresholds : DEFAULT_THRESHOLDS,
      });
    },
  },
  {
    id: 'logging',
    goal: 'moderation',
    module: 'logging',
    name: 'Server logging',
    does: ['Logs joins, leaves, bans, timeouts, role changes and edited or deleted messages.'],
    fields: [
      {
        key: 'channel',
        kind: 'channel',
        label: 'Log channel',
        post: true,
        staffOnly: true,
        names: ['logs', 'log', 'serverlog', 'serverlogs', 'auditlog', 'auditlogs', 'eventlog', 'eventlogs'],
        create: { name: 'server-log', access: 'private' },
      },
      viewerField,
    ],
    configured: (cfg) => Boolean(cfg.channel || Object.values(cfg.events ?? {}).some(Boolean)),
    build(f, { prev }) {
      const hasEvents = Object.values(prev.events ?? {}).some(Boolean);
      return {
        channel: f.channel,
        events: Object.fromEntries(
          LOG_EVENTS.map(([key]) => [
            key,
            hasEvents ? Boolean(prev.events?.[key]) : LOGGED_EVENTS.includes(key),
          ])
        ),
      };
    },
  },
  {
    id: 'tickets',
    goal: 'tickets',
    module: 'tickets',
    name: 'Tickets (modmail)',
    does: [
      'Members message Sylo, and staff read and reply from the dashboard.',
      'Sylo posts an alert in the channel when a ticket opens.',
    ],
    fields: [
      {
        key: 'notifyChannel',
        kind: 'channel',
        label: 'Channel for new-ticket alerts',
        post: true,
        staffOnly: true,
        names: ['tickets', 'ticket', 'support', 'modmail', 'helpdesk', 'supporttickets'],
        loose: ['tickets', 'support', 'modmail'],
        create: { name: 'tickets', access: 'private' },
      },
      {
        key: 'staffRoles',
        kind: 'role',
        label: 'Staff role',
        optional: true,
        viewer: true,
        names: STAFF_NAMES,
        create: { name: 'Support team' },
      },
    ],
    configured: (cfg) =>
      Boolean(cfg.notifyChannel || (Array.isArray(cfg.staffRoles) && cfg.staffRoles.length)),
    build(f, { prev, guild }) {
      const prevStaff = Array.isArray(prev.staffRoles) ? prev.staffRoles : [];
      const config = normaliseTicketsConfig({
        ...prev,
        notifyChannel: f.notifyChannel,
        staffRoles: f.staffRoles ? [...new Set([...prevStaff, f.staffRoles])] : prevStaff,
      });
      config.staffRoles = withoutEveryone(guild.id, config.staffRoles);
      return config;
    },
  },
  {
    id: 'leveling',
    goal: 'community',
    module: 'leveling',
    name: 'Leveling',
    does: [
      'Members earn XP for chatting and level up.',
      'Level-up messages appear in the channel below, or where they chat.',
    ],
    fields: [
      {
        key: 'announceChannel',
        kind: 'channel',
        label: 'Channel for level-up messages',
        optional: true,
        post: true,
        names: ['levelup', 'levelups', 'levels', 'level', 'ranks', 'rankups'],
      },
    ],
    configured: (cfg) => Object.keys(cfg).length > 0,
    build(f, { prev }) {
      return normaliseLevelingConfig({
        ...prev,
        announce: prev.announce ?? 'channel',
        announceChannel: f.announceChannel || prev.announceChannel || '',
      });
    },
  },
  {
    id: 'starboard',
    goal: 'community',
    module: 'starboard',
    name: 'Starboard',
    does: ['Messages that get 3 ⭐ reactions are copied to the starboard channel.'],
    fields: [
      {
        key: 'channelId',
        kind: 'channel',
        label: 'Starboard channel',
        post: true,
        names: ['starboard', 'highlights', 'halloffame', 'bestof', 'hallofstars'],
        loose: ['starboard'],
        create: { name: 'starboard', access: 'readonly' },
      },
    ],
    configured: (cfg) => Array.isArray(cfg.boards) && cfg.boards.length > 0,
    build(f, { prev }) {
      const boards = Array.isArray(prev.boards) ? prev.boards : [];
      const own = { name: 'Starboard', channelId: f.channelId, emojis: ['⭐'], threshold: 3 };
      return normaliseStarboard({
        boards: withRowIds(boards.some((b) => b.channelId === f.channelId) ? boards : [...boards, own]),
      });
    },
    afterSave: (guild, config, prev) => {
      for (const board of boardsToRescan(normaliseStarboard(prev).boards, config.boards)) {
        scheduleRescan(guild, board);
      }
    },
  },
  {
    id: 'suggestions',
    goal: 'community',
    module: 'suggestions',
    name: 'Suggestions',
    does: [
      'Members post suggestions to the channel, and others vote.',
      'Staff approve or deny from the dashboard.',
    ],
    fields: [
      {
        key: 'channel',
        kind: 'channel',
        label: 'Suggestions channel',
        post: true,
        names: ['suggestions', 'suggestion', 'suggest', 'ideas', 'feedback', 'suggestionbox'],
        loose: ['suggestions', 'suggestion', 'ideas'],
        create: { name: 'suggestions', access: 'readonly' },
      },
    ],
    configured: (cfg) => Boolean(cfg.channel),
    build(f, { prev }) {
      return normaliseSuggestionsConfig({ ...prev, channel: f.channel });
    },
  },
];

const SPEC_BY_ID = new Map(SPECS.map((s) => [s.id, s]));

// --- reading the server ----------------------------------------------------------------------------------

/** The bot's own member, or null when the platform cannot say. */
const botMember = (guild) => guild.members?.me ?? null;

/** Whether Sylo holds `permission` server-wide: true, false, or null when the platform cannot answer. */
function botHas(guild, permission) {
  try {
    const me = botMember(guild);
    return me?.permissions ? Boolean(me.permissions.has(permission)) : null;
  } catch {
    return null;
  }
}

/** Why Sylo cannot post in a channel, or null. */
function postProblem(guild, channel) {
  try {
    const perms = channel?.permissionsFor?.(botMember(guild));
    if (!perms) return null;
    const missing = [
      ['ViewChannel', 'View Channel'],
      ['SendMessages', 'Send Messages'],
      ['EmbedLinks', 'Embed Links'],
    ].filter(([flag]) => !perms.has(flag));
    return missing.length
      ? `Sylo needs ${missing.map(([, label]) => label).join(', ')} in this channel.`
      : null;
  } catch {
    return null;
  }
}

/** Whether @everyone holds `flag` in a channel: true, false, or null when the platform cannot say. */
function everyoneCan(guild, channel, flag) {
  try {
    const perms = channel?.permissionsFor?.(guild.roles.everyone);
    return perms ? Boolean(perms.has(flag)) : null;
  } catch {
    return null;
  }
}

/**
 * The roles, besides @everyone, that can see a channel. Not counted: the roles in `skip` (the staff role the
 * channel is for), Sylo's own roles, roles that belong to an integration, and roles with Administrator (they see
 * everything). discord.js answers `permissionsFor(role)` with the role's permissions and the overwrites for
 * @everyone and that role, so a role that only holds View at role level counts until @everyone is denied.
 */
function rolesThatSee(guild, channel, skip = []) {
  try {
    const skipIds = new Set(skip.filter(Boolean));
    for (const id of botMember(guild)?.roles?.cache?.keys?.() ?? []) skipIds.add(id);
    const out = [];
    for (const role of guild.roles.cache.values()) {
      if (role.id === rawGuildId(guild) || role.managed || skipIds.has(role.id)) continue;
      if (role.permissions?.has?.('Administrator')) continue;
      if (channel?.permissionsFor?.(role)?.has('ViewChannel')) out.push(role);
    }
    return out;
  } catch {
    return [];
  }
}

const roleNames = (roles) =>
  roles.length > 3
    ? `${roles
        .slice(0, 3)
        .map((r) => r.name)
        .join(', ')} and ${roles.length - 3} more`
    : roles.map((r) => r.name).join(', ');

/** What each kind of channel the wizard makes means, in words. */
const ACCESS_WORDS = {
  private: 'private (only admins and Sylo, and the staff role if there is one)',
  readonly: 'read-only for members (only Sylo posts)',
  'public-readonly': 'readable by everyone and read-only (only Sylo posts)',
};

/**
 * Why a channel does not match what the wizard promises for `access`, or null when it does. A permission the
 * platform cannot report is not held against it. "Private" means nobody but admins, Sylo and the staff roles
 * in `viewerIds` can see it: @everyone, and every other role, is looked at.
 */
function accessGap(guild, channel, access, viewerIds = []) {
  const view = everyoneCan(guild, channel, 'ViewChannel');
  const send = everyoneCan(guild, channel, 'SendMessages');
  if (access === 'private') {
    if (view === true) return 'Everyone can see it.';
    const seen = rolesThatSee(guild, channel, viewerIds);
    if (!seen.length) return null;
    return `Members with the ${roleNames(seen)} role${seen.length > 1 ? 's' : ''} can see it.`;
  }
  if (access === 'public-readonly' && view === false) return 'Members cannot see it.';
  return send === true ? 'Everyone can post in it.' : null;
}

/** Why Sylo cannot give a role to members, or null. */
function giveProblem(guild, role) {
  if (!role) return null;
  if (role.managed) return 'This role belongs to an integration, so Sylo cannot give it.';
  const top = botMember(guild)?.roles?.highest;
  if (top && (role.position ?? 0) >= (top.position ?? 0)) {
    return "Sylo can't give this role: move Sylo's role above it.";
  }
  if (botHas(guild, 'ManageRoles') === false)
    return 'Sylo needs the Manage Roles permission to give this role.';
  return null;
}

/** The intents a module still lacks on this platform (Fluxer has none to switch on). */
function blockedBy(guild, spec) {
  const def = spec.module ? getModule(spec.module) : null;
  return def && platformOfGuild(guild) === 'discord' ? missingIntents(def) : [];
}

async function currentState(guild, spec) {
  if (spec.module)
    return { config: (await getGuildModule(guild.id, spec.module)).config ?? {}, settings: null };
  return { config: {}, settings: await getGuildSettings(guild.id) };
}

/** The channel or role that already has the name "Create" would give, and how it differs from the promise. */
function existingOf(guild, field, pool, viewerIds) {
  const found = pool.find((item) => squash(item.name) === squash(field.create.name));
  if (!found) return null;
  const gap =
    field.kind === 'channel'
      ? accessGap(guild, guild.channels.cache.get(found.id), field.create.access, viewerIds)
      : field.give
        ? giveProblem(guild, guild.roles.cache.get(found.id))
        : null;
  return { id: found.id, name: found.name, gap };
}

/**
 * What the wizard proposes for a server: the goals, and per item the channel and role found by name (or
 * what "Create" would make), whether the item is already set up, and anything that would not work.
 * Reads only: nothing is created or saved.
 * @param {any} guild  the keyed guild of the request
 */
export async function suggestSetup(guild) {
  const channels = guildTextChannels(guild);
  const roles = assignableRoles(guild);
  const settings = await getGuildSettings(guild.id);
  const stored = new Map((await getGuildModules(guild.id)).map((m) => [m.id, m]));

  const items = SPECS.map((spec) => {
    const config = spec.module ? (stored.get(spec.module)?.config ?? {}) : {};
    const blocked = blockedBy(guild, spec);
    const warnings = [];
    for (const [flag, label] of spec.botPerms ?? []) {
      if (botHas(guild, flag) === false)
        warnings.push(`Sylo needs the ${label} permission for this to work.`);
    }
    const viewerIds = spec.fields
      .filter((f) => f.viewer)
      .map((f) => matchByName(roles, f.names, f.loose)?.id);
    return {
      id: spec.id,
      goal: spec.goal,
      name: spec.name,
      does: spec.does,
      configured: spec.configured(config, settings),
      enabled: spec.module ? Boolean(stored.get(spec.module)?.enabled) : null,
      blocked,
      warnings,
      fields: spec.fields.map((field) => {
        const pool = field.kind === 'channel' ? channels : roles;
        const hit = matchByName(pool, field.names, field.loose);
        const channel = hit && field.kind === 'channel' ? guild.channels.cache.get(hit.id) : null;
        // A channel for staff only is not offered if anyone but the staff can see it: it is shown with why,
        // and the admin has to pick it (and tick the permission change) or pick another.
        const exposed = channel && field.staffOnly ? accessGap(guild, channel, 'private', viewerIds) : null;
        return {
          key: field.key,
          kind: field.kind,
          label: field.label,
          optional: Boolean(field.optional),
          // Whether a problem flagged on a channel or role matters here: Sylo posts in it, or gives the role.
          post: Boolean(field.post),
          give: Boolean(field.give),
          match: hit && !exposed ? { id: hit.id, name: hit.name } : null,
          unsafeMatch: hit && exposed ? { id: hit.id, name: hit.name, gap: exposed } : null,
          // A problem stops the field from being applied; a warning is only shown.
          problem:
            !hit || exposed
              ? null
              : field.kind === 'channel'
                ? field.post
                  ? postProblem(guild, channel)
                  : null
                : field.give
                  ? giveProblem(guild, guild.roles.cache.get(hit.id))
                  : null,
          viewer: Boolean(field.viewer),
          viewerOnly: Boolean(field.viewerOnly),
          create: field.create
            ? {
                name: field.create.name,
                kind: field.kind,
                private: field.create.access === 'private',
                readOnly: field.create.access !== undefined && field.create.access !== 'private',
                everyoneCanView: field.create.access === 'public-readonly',
                // A channel or role of that name is already there: "Create" would use it, and only when it is
                // what the wizard promises. `gap` says how it is not (null: it is, or cannot be told).
                existing: existingOf(guild, field, pool, viewerIds),
              }
            : null,
        };
      }),
    };
  });

  return {
    platform: platformOfGuild(guild),
    inspected: { channels: channels.length, roles: roles.length, members: guild.memberCount ?? 0 },
    // null: the platform cannot say, so Sylo tries and reports what the platform answers.
    botCan: { createChannels: botHas(guild, 'ManageChannels'), createRoles: botHas(guild, 'ManageRoles') },
    goals: GOALS,
    channels: channels.map((c) => ({ ...c, problem: postProblem(guild, guild.channels.cache.get(c.id)) })),
    roles: roles.map((r) => ({ ...r, problem: giveProblem(guild, guild.roles.cache.get(r.id)) })),
    items,
  };
}

// --- applying ----------------------------------------------------------------------------------------------

/**
 * Passed with the audit rows for a created channel or role or a permission change: they are not a saved
 * setting, so a history that captures the settings a request changed must not attach one to them.
 */
const NO_CHANGE = { before: {}, after: {} };

/** A role id that stands for a role that does not exist yet, while the module's config is checked in advance. */
const NOT_YET = '000000000000000001';

// What Sylo needs for itself to say who may see or post in a channel. The platform refuses a permission
// overwrite that allows or denies something the bot does not hold.
const CRITICAL = [
  ['ViewChannel', 'View Channel'],
  ['SendMessages', 'Send Messages'],
];

/** The permission overwrites of a channel the wizard creates. Flags Sylo does not hold itself are left out. */
function overwritesFor(guild, access, viewerRoleId = '') {
  const me = botMember(guild);
  const held = (flags) => flags.filter((flag) => botHas(guild, flag) !== false);
  const F = PermissionFlagsBits;
  const everyoneId = rawGuildId(guild);
  let everyone;
  if (access === 'private') {
    everyone = { id: everyoneId, deny: held([F.ViewChannel]) };
  } else {
    everyone = {
      id: everyoneId,
      // Only the verify channel says View Channel outright: the unverified must see it. The others inherit it,
      // so a server that hides its channels from unverified members keeps them hidden.
      ...(access === 'public-readonly' ? { allow: held([F.ViewChannel, F.ReadMessageHistory]) } : {}),
      // Reactions stay open: members vote with them (and on Fluxer buttons are reactions).
      deny: held([F.SendMessages, F.CreatePublicThreads, F.CreatePrivateThreads]),
    };
  }
  const viewer =
    access === 'private' && viewerRoleId
      ? { id: viewerRoleId, allow: held([F.ViewChannel, F.ReadMessageHistory]) }
      : null;
  const bot = me
    ? {
        id: me.id,
        allow: held([F.ViewChannel, F.SendMessages, F.EmbedLinks, F.ReadMessageHistory, F.AddReactions]),
      }
    : null;
  return [everyone, viewer, bot].filter(Boolean);
}

/** The overwrites of a channel that are for a role other than @everyone, Sylo and the viewer, and allow View. */
function viewGrants(guild, channel, keep) {
  const out = [];
  try {
    for (const ov of channel.permissionOverwrites?.cache?.values?.() ?? []) {
      if (keep.has(ov.id) || ov.id === rawGuildId(guild)) continue;
      if (ov.type !== undefined && ov.type !== 0 && ov.type !== 'role') continue; // a member, not a role
      const allows =
        typeof ov.allow?.has === 'function'
          ? ov.allow.has('ViewChannel')
          : (BigInt(ov._allow ?? 0n) & PermissionFlagsBits.ViewChannel) !== 0n;
      if (allows) out.push(ov.id);
    }
  } catch {
    // The platform does not list them: the check afterwards still looks at every role.
  }
  return out;
}

/**
 * Change an existing channel's overwrites to what the wizard promises, one edit at a time; `onEdit` is called
 * after each edit that was made, so a failure halfway can still say what changed. Flags Sylo does not hold
 * itself are left out (the platform refuses an overwrite for a permission the bot lacks). Sylo's own access is
 * set first. A private channel ends up closed to every role but the viewer: @everyone is denied, and a role
 * overwrite that allows View is cleared; if any other role can still see it afterwards this throws, so a channel
 * is never called private when it is not.
 */
async function fixAccess(guild, channelId, access, viewerRoleId, reason, onEdit = () => {}) {
  const channel = guild.channels.cache.get(channelId);
  const everyone = rawGuildId(guild);
  const me = botMember(guild);
  const held = (opts) =>
    Object.fromEntries(Object.entries(opts).filter(([flag]) => botHas(guild, flag) !== false));
  const edit = async (target, opts) => {
    await channel.permissionOverwrites.edit(target, held(opts), { reason });
    onEdit();
  };
  if (me) await edit(me.id, { ViewChannel: true, SendMessages: true, EmbedLinks: true });
  if (access === 'private') {
    await edit(everyone, { ViewChannel: false });
    if (viewerRoleId) await edit(viewerRoleId, { ViewChannel: true, ReadMessageHistory: true });
    const keep = new Set([viewerRoleId, me?.id].filter(Boolean));
    for (const id of viewGrants(guild, channel, keep)) await edit(id, { ViewChannel: null });
    const still = rolesThatSee(guild, channel, [viewerRoleId]);
    if (everyoneCan(guild, channel, 'ViewChannel') === true || still.length) {
      throw new Error(
        `#${channel.name} is still not private: ${
          still.length ? `members with the ${roleNames(still)} role${still.length > 1 ? 's' : ''}` : 'members'
        } can see it. Remove their access in your server, or pick another channel.`
      );
    }
    return;
  }
  await edit(everyone, {
    SendMessages: false,
    CreatePublicThreads: false,
    CreatePrivateThreads: false,
    ...(access === 'public-readonly' ? { ViewChannel: true } : {}),
  });
}

const fail = (res, message) => Object.assign(res, { status: 'failed', message });
const label = (kind, name) => (kind === 'channel' ? `#${name}` : name);
const list = (things) => things.map((t) => label(t.kind, t.name)).join(', ');

/**
 * Apply the admin's choices, one item at a time. Everything that can be checked is checked before the first
 * channel or role of an item is created (who the choices are, Sylo's own permissions, whether the person may
 * hand out the roles); what was created is audited as it is made and named in the result, even when a later
 * step fails.
 * @param {{ guild: any, selections: Array<{ id: string, replace?: boolean, fields?: Record<string, { id?: string, create?: boolean, fix?: boolean }> }>, actor: string }} opts
 * @returns {Promise<Array<{ id: string, name: string, status: 'applied'|'skipped'|'failed', message: string, warnings: string[], created: Array<{ kind: string, name: string, id: string }>, reused: Array<{ kind: string, name: string, id: string }>, changed: Array<{ kind: string, name: string, id: string }> }>>}
 */
export async function applySetup({ guild, selections, actor }) {
  const byId = new Map(selections.map((s) => [s.id, s]));
  const channelsNow = () => guildTextChannels(guild);
  const rolesNow = () => assignableRoles(guild);
  const made = { channels: 0, roles: 0 };
  const results = [];

  for (const spec of SPECS) {
    const sel = byId.get(spec.id);
    if (!sel) continue;
    const res = {
      id: spec.id,
      name: spec.name,
      status: 'applied',
      message: '',
      warnings: [],
      created: [],
      reused: [],
      changed: [],
    };
    results.push(res);
    try {
      await applyOne(spec, sel, res);
    } catch (err) {
      // A refused role grant says why in plain words; anything else is the platform's own answer.
      log.warn('setup', `${spec.id} failed:`, err.message);
      fail(res, err.name === 'RoleGrantError' ? err.message : `Could not save this: ${err.message}`);
    }
    // Whatever was made before the failure stays, and the admin is told exactly what it is.
    if (res.status === 'failed' && (res.created.length || res.changed.length)) {
      const parts = [];
      if (res.created.length) parts.push(`created ${list(res.created)}`);
      if (res.changed.length) parts.push(`changed who can see or post in ${list(res.changed)}`);
      res.message += ` Before it stopped, Sylo ${parts.join(' and ')}. That was left in place; check it in your server and undo it if you do not want it.`;
    }
  }
  return results;

  async function applyOne(spec, sel, res) {
    const { config: prev, settings } = await currentState(guild, spec);
    if (spec.configured(prev, settings) && !sel.replace) {
      return Object.assign(res, {
        status: 'skipped',
        message: 'Already set up, so it was left as it is.',
      });
    }
    const blocked = blockedBy(guild, spec);
    if (blocked.length) {
      return Object.assign(res, {
        status: 'skipped',
        message: "Sylo can't run this module yet. The bot owner has to allow a permission for it first.",
      });
    }

    // 1. Read the choices and refuse what would not work. Nothing is created until every check has passed.
    const viewerKey = spec.fields.find((f) => f.viewer)?.key;
    const resolved = {};
    const wantCreate = [];
    const fixes = [];
    for (const field of spec.fields) {
      const pick = sel.fields?.[field.key];
      if (pick?.create === true && field.create) {
        wantCreate.push({ field, fix: pick.fix === true });
        continue;
      }
      const id = typeof pick?.id === 'string' ? pick.id : '';
      if (!id) {
        if (!field.optional) return fail(res, `Pick a ${field.label.toLowerCase()}, or tick Create.`);
        resolved[field.key] = '';
        continue;
      }
      if (field.kind === 'channel') {
        if (!channelsNow().some((c) => c.id === id))
          return fail(res, `${field.label}: that channel no longer exists.`);
        const why = field.post ? postProblem(guild, guild.channels.cache.get(id)) : null;
        if (why) return fail(res, `${field.label}: ${why}`);
        if (pick?.fix === true && field.create?.access) fixes.push(field);
      } else {
        if (!rolesNow().some((r) => r.id === id))
          return fail(res, `${field.label}: that role no longer exists.`);
        const why = field.give ? giveProblem(guild, guild.roles.cache.get(id)) : null;
        if (why) return fail(res, `${field.label}: ${why}`);
      }
      resolved[field.key] = id;
    }

    // 2. A channel or role of the wanted name that is already there is used instead of a second one, but only
    // when it is what the wizard promises (a private channel that is public is not "reused" silently).
    const toCreate = [];
    for (const { field, fix } of wantCreate) {
      const wanted = field.create.name;
      const existing = (field.kind === 'channel' ? channelsNow() : rolesNow()).find(
        (item) => squash(item.name) === squash(wanted)
      );
      if (!existing) {
        toCreate.push(field);
        continue;
      }
      if (field.kind === 'role') {
        const why = field.give ? giveProblem(guild, guild.roles.cache.get(existing.id)) : null;
        if (why) return fail(res, `${field.label}: the role ${existing.name} already exists. ${why}`);
      } else {
        const channel = guild.channels.cache.get(existing.id);
        const why = field.post ? postProblem(guild, channel) : null;
        if (why) return fail(res, `${field.label}: #${existing.name} already exists. ${why}`);
        const gap = accessGap(guild, channel, field.create.access, [viewerKey ? resolved[viewerKey] : '']);
        if (gap && !fix) {
          return fail(
            res,
            `${field.label}: #${existing.name} already exists. ${gap} Pick it to use it as it is, or tick the box that changes its permissions to ${ACCESS_WORDS[field.create.access]}.`
          );
        }
        if (gap) fixes.push(field);
      }
      resolved[field.key] = existing.id;
      res.reused.push({ kind: field.kind, name: existing.name, id: existing.id });
    }

    // 3. Sylo's own permissions, and the caps.
    const newChannels = toCreate.filter((f) => f.kind === 'channel').length;
    const newRoles = toCreate.filter((f) => f.kind === 'role').length;
    if ((newChannels || fixes.length) && botHas(guild, 'ManageChannels') === false) {
      return fail(
        res,
        newChannels
          ? 'Sylo needs the Manage Channels permission to create a channel.'
          : 'Sylo needs the Manage Channels permission to change a channel.'
      );
    }
    if (newRoles && botHas(guild, 'ManageRoles') === false) {
      return fail(res, 'Sylo needs the Manage Roles permission to create a role.');
    }
    if (fixes.length && botHas(guild, 'ManageRoles') === false) {
      return fail(res, "Sylo needs the Manage Roles permission to change a channel's permissions.");
    }
    if (newChannels || fixes.length) {
      const lacking = CRITICAL.filter(([flag]) => botHas(guild, flag) === false).map(([, text]) => text);
      if (lacking.length) {
        return fail(
          res,
          `Sylo needs the ${lacking.join(' and ')} permission${lacking.length > 1 ? 's' : ''} itself to set who can see or post in a channel. Give Sylo ${lacking.length > 1 ? 'those permissions' : 'that permission'}, or pick a channel that exists.`
        );
      }
    }
    if (made.channels + newChannels > MAX_CREATED_CHANNELS || made.roles + newRoles > MAX_CREATED_ROLES) {
      return fail(
        res,
        'Too many channels or roles would be created at once. Apply the rest in a second run.'
      );
    }

    // 4. May this person hand out the roles the module will give? Checked on the config as it will be saved,
    // with a stand-in for a role that is not made yet, so a refusal comes before anything exists.
    if (spec.module) {
      const standIn = { ...resolved };
      for (const field of toCreate) standIn[field.key] = NOT_YET;
      await checkModuleGrants(spec.module, prev, spec.build(standIn, { prev, guild }));
    }

    // 5. Create what was ticked, roles first (a private channel can name the staff role made a moment ago).
    // Each one is audited as it is made, so a later failure still leaves a record.
    const reason = `Created by the setup wizard (${spec.name})`;
    for (const field of [...toCreate].sort(
      (a, b) => (a.kind === 'role' ? -1 : 0) - (b.kind === 'role' ? -1 : 0)
    )) {
      const wanted = field.create.name;
      const thing =
        field.kind === 'channel'
          ? await createGuildChannel(guild, {
              name: wanted,
              type: ChannelType.GuildText,
              reason,
              permissionOverwrites: overwritesFor(
                guild,
                field.create.access,
                viewerKey ? resolved[viewerKey] : ''
              ),
            })
          : await createGuildRole(guild, { name: wanted, reason });
      if (field.kind === 'channel') made.channels += 1;
      else made.roles += 1;
      resolved[field.key] = thing.id;
      res.created.push({ kind: field.kind, name: wanted, id: thing.id });
      await recordAudit(guild.id, {
        actor,
        action: `setup:${field.kind}`,
        detail: `created ${label(field.kind, wanted)} for ${spec.name} (setup wizard)`,
        change: NO_CHANGE,
      });
    }

    // 6. Change the permissions of an existing channel, only where the admin ticked it.
    for (const field of fixes) {
      const id = resolved[field.key];
      const channel = guild.channels.cache.get(id);
      const entry = { kind: 'channel', name: channel?.name ?? id, id };
      let touched = false;
      let done = false;
      try {
        await fixAccess(guild, id, field.create.access, viewerKey ? resolved[viewerKey] : '', reason, () => {
          // The first edit that was made: the change is on record from then on, even if a later one fails.
          if (!touched) res.changed.push(entry);
          touched = true;
        });
        done = true;
      } finally {
        if (touched) {
          await recordAudit(guild.id, {
            actor,
            action: 'setup:channel',
            detail: `${done ? 'changed' : 'partly changed'} who can see or post in #${entry.name} to ${ACCESS_WORDS[field.create.access]} for ${spec.name} (setup wizard)`,
            change: NO_CHANGE,
          }).catch((err) => log.warn('setup', 'audit of a permission change failed:', err.message));
        }
      }
    }
    // A role picked only to see the channel does something only when Sylo sets the channel's permissions.
    const viewerField = spec.fields.find((f) => f.viewerOnly);
    if (
      viewerField &&
      resolved[viewerField.key] &&
      !res.created.some((c) => c.kind === 'channel') &&
      !fixes.length
    ) {
      const picked = rolesNow().find((r) => r.id === resolved[viewerField.key]);
      res.warnings.push(
        `${picked?.name ?? 'The role you picked'} was not given access to the channel: Sylo only sets who can see a channel when it creates it or when you tick the box that changes its permissions.`
      );
    }

    // 7. Save through the module's own normaliser and write path.
    const extras = [
      res.created.length ? `created ${list(res.created)}` : '',
      res.reused.length ? `used the existing ${list(res.reused)}` : '',
      res.changed.length ? `changed the permissions of ${list(res.changed)}` : '',
    ].filter(Boolean);
    const detailEnd = extras.length ? `; ${extras.join('; ')}` : '';
    if (!spec.module) {
      const before = settings?.modlog_channel_id ?? '';
      await setModlogChannel(guild.id, resolved.channelId);
      await recordAudit(guild.id, {
        actor,
        action: spec.audit.action,
        detail: `${spec.audit.detail}${detailEnd}`,
        // For the change history when it keeps what changed (ignored until then).
        change: { before: { modlogChannelId: before }, after: { modlogChannelId: resolved.channelId } },
      });
    } else {
      const config = spec.build(resolved, { prev, guild });
      await setGuildModule(guild.id, spec.module, { enabled: true, config });
      await spec.afterSave?.(guild, config, prev);
      await recordAudit(guild.id, {
        actor,
        action: `module:${spec.module}`,
        detail: `configured by the setup wizard${detailEnd}`,
      });
    }

    for (const [flag, text] of spec.botPerms ?? []) {
      if (botHas(guild, flag) === false)
        res.warnings.push(`Sylo needs the ${text} permission for this to work.`);
    }
    const said = [
      res.created.length ? `Created ${list(res.created)}.` : '',
      res.reused.length ? `Used the existing ${list(res.reused)}.` : '',
      res.changed.length ? `Changed the permissions of ${list(res.changed)}.` : '',
    ].filter(Boolean);
    res.message = ['Set up.', ...said].join(' ');
  }
}

export const setupItemIds = () => SPECS.map((s) => s.id);
export const setupItem = (id) => SPEC_BY_ID.get(id) ?? null;
