// Import of a configuration export (GET /guilds/:id/export) into a server.
//
// Nothing here writes the file's JSON into the database. Every module config goes through the
// module's own normaliser (the one its settings route uses) and the same writer the settings
// routes use (db/modules.js setGuildModule, which runs the role-grant guard), so the stored
// result is what saving the same values in the dashboard would store.
//
// The file comes from another server, so before it reaches a normaliser:
//   * channel, role, category and emoji ids that this server does not have are cleared;
//   * ids of posted messages (messageId, lastMessageId) are cleared, they belong to the other server;
//   * <#id> and <@&id> mentions of channels and roles this server does not have are removed from text.
//
// The preview (planImport) changes nothing. applyImport reads the file again, plans against the
// server as it is now, and applies only the items the person ticked.
import { getModule, MODULES } from '../../modules/registry.js';
import { getGuildModule, setGuildModule } from '../../db/modules.js';
import {
  getGuildSettings,
  setModlogChannel,
  setEmbedColor,
  getCommandPrefix,
  setCommandPrefix,
  withoutEveryone,
} from '../../db/guildSettings.js';
import { getCommandOverrides, setCommandOverride } from '../../db/commandOverrides.js';
import { recordAudit } from '../../db/audit.js';
import { platformOfGuild, primaryClient } from '../../platform/platformOf.js';
import { commandPrefixError } from '../../lib/commandPrefix.js';
import { canPostInChannel } from './modlogChannel.js';
import { log } from '../../lib/log.js';
import { normaliseAfkConfig } from '../../modules/afk.js';
import { normaliseAppealsConfig } from '../../modules/appeals.js';
import { normaliseApplicationsConfig } from '../../modules/lib/applicationsForm.js';
import { normaliseAutoReact } from '../../modules/autoReact.js';
import { normaliseAutoThreadsConfig } from '../../modules/autoThreads.js';
import { normaliseAutomodConfig } from '../../modules/automod.js';
import { normaliseAutoresponder } from '../../modules/autoresponder.js';
import { normaliseBirthdaysConfig } from '../../modules/birthdays.js';
import { normaliseCountingConfig } from '../../modules/counting.js';
import { normaliseEconomyConfig } from '../../modules/lib/economyConfig.js';
import { normaliseEventsConfig, refreshPagePosts } from '../../modules/events.js';
import { normaliseGiveawaysConfig } from '../../modules/giveaways.js';
import { normaliseHoneypotConfig, ensureHoneypotMessages } from '../../modules/honeypot.js';
import { normaliseIntroductionsConfig, cancelIntroductionSessions } from '../../modules/introductions.js';
import { normaliseInviteTrackerConfig, primeGuild as primeInviteCache } from '../../modules/inviteTracker.js';
import { normaliseKickConfig } from '../../modules/kickAlerts.js';
import { normaliseLevelingConfig } from '../../modules/leveling.js';
import { LOG_EVENTS } from '../../modules/logging.js';
import { normaliseModerationConfig } from '../../modules/moderation.js';
import { normalisePollsConfig } from '../../modules/polls.js';
import { normaliseQuoteBoardConfig } from '../../modules/quoteBoard.js';
import { normaliseRssConfig } from '../../modules/rss.js';
import { normaliseAutoroles } from '../../modules/roles.js';
import { normaliseServerStats } from '../../modules/serverStats.js';
import { normaliseStarboard } from '../../modules/starboard.js';
import { normaliseStickyConfig } from '../../modules/sticky.js';
import { normaliseSuggestionsConfig } from '../../modules/suggestions.js';
import { normaliseTempRolesConfig } from '../../modules/tempRoles.js';
import { normaliseTempVoiceConfig } from '../../modules/tempVoice.js';
import { normaliseTicketsConfig } from '../../modules/tickets.js';
import { normaliseTwitchConfig } from '../../modules/twitchAlerts.js';
import { normaliseVerificationConfig, ensureVerifyMessage } from '../../modules/verification.js';
import { normaliseWelcomeChannelConfig } from '../../modules/welcomeChannel.js';
import { normaliseWelcomeConfig } from '../../modules/welcome.js';
import { syncGuildAutomod } from '../../bot/lib/automodSync.js';
import { cancelApplicationSessions } from '../../modules/applications.js';
import { clearScope } from '../../db/postedKeys.js';

/** The word a person types to confirm an import. */
export const IMPORT_CONFIRM_WORD = 'IMPORT';

export const EXPORT_KIND = 'guild-config-export';
export const EXPORT_VERSION = 1;

// Bounds on what a file may hold. The body is capped at 256 KB by the server; these keep a small but
// deeply nested file from costing much to walk.
const MAX_MODULES = 100;
const MAX_OVERRIDES = 300;
const MAX_NODES = 20_000;
const MAX_DEPTH = 12;
const MAX_MODULE_BYTES = 128 * 1024;

// How much of a diff the preview carries per item.
const MAX_CHANGES = 40;
const MAX_SHOWN_VALUE = 120;
const MAX_CLEARED_PATHS = 12;

const SNOWFLAKE = /^\d{17,20}$/;
const MENTION = /<(#|@&)(\d{17,20})>/g;
const SECRET_KEY = /secret|token|password|passwd|api[-_]?key|private/i;

/** An error the person caused (a bad file); the route answers it with a 400. */
export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
    this.status = 400;
  }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- Clearing ids from another server ------------------------------------------------------------

/** What an id under this property name is, or null when it is not one this server must own. */
function idKind(key) {
  const k = String(key).toLowerCase();
  if (/message_?id$/.test(k)) return 'message';
  if (k.includes('role')) return 'role';
  if (k.includes('channel') || k.includes('category') || k.includes('parent')) return 'channel';
  if (k.includes('emoji')) return 'emoji';
  return null;
}

const DROP = Symbol('drop');

/**
 * A copy of `value` without the ids this server cannot own (see the top of the file). A cleared id in a
 * list leaves the list, a cleared id in a field leaves the field empty. Prototype keys are dropped and the
 * walk is bounded.
 * @param {object} guild  the platform guild
 * @param {unknown} value
 * @returns {{ value: unknown, cleared: Record<string, number>, paths: string[] }}
 */
export function clearForeignIds(guild, value) {
  const cleared = { channel: 0, role: 0, message: 0, emoji: 0, mention: 0 };
  const paths = [];
  let nodes = 0;
  const owns = {
    channel: (id) => guild.channels?.cache?.has?.(id) ?? true,
    role: (id) => guild.roles?.cache?.has?.(id) ?? true,
    // A platform that does not list its emojis cannot say: keep them.
    emoji: (id) => (guild.emojis?.cache ? guild.emojis.cache.has(id) : true),
  };
  const note = (kind, path) => {
    cleared[kind] += 1;
    if (paths.length < MAX_CLEARED_PATHS) paths.push(path);
  };

  // `key` is the property the value hangs under, and stays the key for the items of an array.
  const walk = (v, key, path, depth, inList) => {
    nodes += 1;
    if (nodes > MAX_NODES) throw new ImportError('The file is too large to import.');
    if (depth > MAX_DEPTH) throw new ImportError('The file is nested too deeply to import.');
    if (Array.isArray(v)) {
      const out = [];
      v.forEach((item, i) => {
        const r = walk(item, key, `${path}[${i}]`, depth + 1, true);
        if (r !== DROP) out.push(r);
      });
      return out;
    }
    if (isPlain(v)) {
      const out = {};
      for (const [k, item] of Object.entries(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        const r = walk(item, k, path ? `${path}.${k}` : k, depth + 1, false);
        if (r !== DROP) out[k] = r;
      }
      return out;
    }
    if (typeof v !== 'string') return v;
    if (SNOWFLAKE.test(v)) {
      const kind = idKind(key);
      if (kind === 'message' || (kind && !owns[kind](v))) {
        note(kind, path);
        return inList ? DROP : '';
      }
      return v;
    }
    return v.replace(MENTION, (whole, sign, id) => {
      const kind = sign === '#' ? 'channel' : 'role';
      if (owns[kind](id)) return whole;
      note('mention', path);
      return '';
    });
  };

  return { value: walk(value, '', '', 0, false), cleared, paths };
}

/** The warning for what was cleared, or null when nothing was. */
function clearedWarning(cleared) {
  const count = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
  const missing = [
    count(cleared.channel, 'channel', 'channels'),
    count(cleared.role, 'role', 'roles'),
    count(cleared.emoji, 'custom emoji', 'custom emojis'),
    count(cleared.mention, 'channel or role mention', 'channel or role mentions'),
  ].filter(Boolean);
  const total = cleared.channel + cleared.role + cleared.emoji + cleared.mention;
  const out = [];
  if (total) {
    out.push(
      `${missing.join(', ')} from the file ${total === 1 ? 'is' : 'are'} not in this server and ${total === 1 ? 'was' : 'were'} cleared.`
    );
  }
  if (cleared.message) {
    const one = cleared.message === 1;
    out.push(
      `${one ? 'A posted message' : `${cleared.message} posted messages`} of the other server ${one ? 'is' : 'are'} not carried over; post ${one ? 'it' : 'them'} again here.`
    );
  }
  return out.length ? out.join(' ') : null;
}

// --- The diff ------------------------------------------------------------------------------------

/** "joinChannel" -> "Join channel"; "rules[0].name" -> "Rules 1 › Name". */
export function humanisePath(path) {
  const word = (s) => {
    const spaced = s
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim()
      .toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  };
  return path
    .split('.')
    .map((seg) => {
      const m = /^([^[]*)((?:\[\d+\])*)$/.exec(seg);
      if (!m) return word(seg);
      const base = word(m[1]);
      const idx = [...m[2].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]) + 1);
      return idx.length ? `${base} ${idx.join('.')}` : base;
    })
    .join(' › ');
}

function show(path, v) {
  if (v === undefined || v === null || v === '') return '(empty)';
  if (SECRET_KEY.test(path)) return '••••••';
  if (Array.isArray(v))
    return v.length
      ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')
      : '(none)';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > MAX_SHOWN_VALUE ? `${s.slice(0, MAX_SHOWN_VALUE)}…` : s;
}

/** Every leaf of a value as { 'a.b[0].c': leaf }; a list of plain values is one leaf. */
function leaves(value, path = '', out = new Map(), depth = 0) {
  if (depth > MAX_DEPTH) return out;
  if (Array.isArray(value) && value.some((x) => isPlain(x) || Array.isArray(x))) {
    value.forEach((x, i) => leaves(x, `${path}[${i}]`, out, depth + 1));
  } else if (isPlain(value)) {
    for (const [k, v] of Object.entries(value)) leaves(v, path ? `${path}.${k}` : k, out, depth + 1);
  } else if (path) {
    out.set(path, value);
  }
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What changes when `after` replaces `before`: one line per changed field, at most MAX_CHANGES, and the
 * number of lines left out. Values of secret-looking fields are masked.
 * @returns {{ changes: { path: string, label: string, before: string, after: string }[], more: number }}
 */
export function diffConfig(before, after) {
  const a = leaves(before);
  const b = leaves(after);
  const lines = [];
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    if (same(a.get(path), b.get(path))) continue;
    lines.push({
      path,
      label: humanisePath(path),
      before: show(path, a.get(path)),
      after: show(path, b.get(path)),
    });
  }
  return { changes: lines.slice(0, MAX_CHANGES), more: Math.max(0, lines.length - MAX_CHANGES) };
}

// --- The modules that can be imported ---------------------------------------------------------------

/**
 * How each importable module turns a config from the file into the config to store, through the
 * normaliser of its settings route:
 *   prepare(cfg, prev, guild) -> the config to store (`prev` is what is stored now);
 *   after(guild, { config, enabled, previous }) -> work the settings route does after saving.
 * Fields the bot keeps itself (the ids of its own posts, trigger counters) come from `prev`, never the file.
 * A module that is not listed here is shown in the preview as "not imported" with the reason in SKIPPED.
 */
const background = (what, p) =>
  p.catch((err) => log.warn('config-import', `${what} after import failed:`, err.message));

const IMPORTERS = {
  afk: { prepare: (c) => normaliseAfkConfig(c) },
  birthdays: { prepare: (c) => normaliseBirthdaysConfig(c) },
  counting: { prepare: (c) => normaliseCountingConfig(c) },
  moderation: { prepare: (c) => normaliseModerationConfig(c) },
  'auto-threads': { prepare: (c) => normaliseAutoThreadsConfig(c) },
  autoresponder: { prepare: (c) => normaliseAutoresponder(c) },
  'twitch-alerts': { prepare: (c) => normaliseTwitchConfig(c) },
  'kick-alerts': { prepare: (c) => normaliseKickConfig(c) },
  rss: {
    prepare: (c) => normaliseRssConfig(c),
    // Dedup state of a feed that is gone, so adding the same address again starts fresh.
    after: async (guild, { config, previous }) => {
      const kept = new Set((config.feeds ?? []).map((f) => f.id));
      for (const f of previous.feeds ?? []) if (!kept.has(f.id)) await clearScope(guild.id, `rss:${f.id}`);
    },
  },
  appeals: { prepare: (c) => normaliseAppealsConfig(c) },
  giveaways: { prepare: (c) => normaliseGiveawaysConfig(c) },
  tickets: {
    prepare: (c, _prev, guild) => {
      const config = normaliseTicketsConfig(c);
      config.staffRoles = withoutEveryone(guild.id, config.staffRoles);
      return config;
    },
  },
  'server-stats': { prepare: (c) => normaliseServerStats(c) },
  'invite-tracker': {
    prepare: (c) => normaliseInviteTrackerConfig(c),
    after: (guild, { enabled }) =>
      enabled ? background('invite cache', primeInviteCache(guild)) : undefined,
  },
  leveling: {
    // The public leaderboard switch lives on the Leaderboard page, like in the settings route.
    prepare: (c, prev) =>
      normaliseLevelingConfig({ ...c, publicLeaderboard: prev.publicLeaderboard !== false }),
  },
  polls: { prepare: (c) => normalisePollsConfig(c) },
  'temp-voice': { prepare: (c) => normaliseTempVoiceConfig(c) },
  'quote-board': { prepare: (c) => normaliseQuoteBoardConfig(c) },
  suggestions: {
    prepare: (c, prev) => normaliseSuggestionsConfig({ ...c, logMode: c.logMode ?? prev.logMode }),
  },
  'temp-roles': { prepare: (c) => normaliseTempRolesConfig(c) },
  economy: { prepare: (c) => normaliseEconomyConfig(c) },
  events: {
    prepare: (c) => normaliseEventsConfig(c),
    after: (guild, { previous, config }) =>
      previous.publicPages !== config.publicPages
        ? background('event posts', refreshPagePosts(guild.id))
        : undefined,
  },
  introductions: {
    prepare: (c, prev) =>
      normaliseIntroductionsConfig({
        ...c,
        promptChannelId: prev.promptChannelId,
        promptMessageId: prev.promptMessageId,
      }),
  },
  applications: {
    prepare: (c, prev) =>
      normaliseApplicationsConfig({
        ...c,
        panelChannelId: prev.panelChannelId,
        panelMessageId: prev.panelMessageId,
      }),
  },
  starboard: { prepare: (c) => normaliseStarboard(c) },
  sticky: { prepare: (c, prev) => normaliseStickyConfig(c, prev) },
  'auto-react': { prepare: (c) => normaliseAutoReact(c) },
  automod: {
    prepare: (c) => normaliseAutomodConfig(c),
    after: (guild, { config, enabled }) =>
      background(
        'native automod sync',
        syncGuildAutomod(
          guild,
          enabled ? config : { ...config, native: { ...config.native, enabled: false } }
        )
      ),
  },
  verification: {
    prepare: (c, prev) => normaliseVerificationConfig({ ...c, messageId: prev.messageId }),
    after: (guild, { config }) => background('verification message', ensureVerifyMessage(guild, config)),
  },
  honeypot: {
    prepare: (c, prev) => {
      const byChannel = new Map((prev.messages ?? []).map((m) => [m.channelId, m]));
      const counts = new Map((prev.channels ?? []).map((ch) => [ch.channelId, ch]));
      return normaliseHoneypotConfig({
        exemptRoles: c.exemptRoles,
        channels: (Array.isArray(c.channels) ? c.channels : []).map((ch) => ({
          ...ch,
          triggerCount: counts.get(ch.channelId)?.triggerCount ?? 0,
        })),
        messages: (Array.isArray(c.messages) ? c.messages : []).map((m) => ({
          ...m,
          messageId: byChannel.get(m.channelId)?.messageId ?? '',
          triggerCount: byChannel.get(m.channelId)?.triggerCount ?? 0,
        })),
      });
    },
    after: (guild, { config }) => background('honeypot messages', ensureHoneypotMessages(guild, config)),
  },
  logging: {
    prepare: (c) => ({
      channel: SNOWFLAKE.test(c.channel ?? '') ? c.channel : '',
      events: Object.fromEntries(LOG_EVENTS.map(([key]) => [key, Boolean(c.events?.[key])])),
    }),
  },
  'free-games': {
    prepare: (c) => ({
      channelId: SNOWFLAKE.test(c.channelId ?? '') ? c.channelId : '',
      roleId: SNOWFLAKE.test(c.roleId ?? '') ? c.roleId : '',
    }),
  },
  'welcome-channel': {
    // The message the other server posted is not this server's; publishing it here is a separate step.
    prepare: (c, prev) => normaliseWelcomeChannelConfig({ ...c, messageId: prev.messageId }),
  },
  welcome: {
    prepare: (c, prev, guild) => normaliseWelcomeConfig(c, guild, { prev }),
  },
  roles: {
    // Only the roles given to new members: a reaction-role set is a posted message with its own buttons.
    prepare: (c, prev) => ({ ...prev, autoroles: normaliseAutoroles(c.autoroles) }),
  },
};

/** Why a module of the file is not imported, by module id; the rest is "not available here". */
const SKIPPED = {
  'custom-commands': 'Custom commands are registered with the platform one by one; build them in the module.',
  reminders: 'Reminders live in their own list, which this export does not carry.',
  'youtube-alerts': 'YouTube channels are looked up when you add them; add them in the module.',
  insights: 'Server insights has nothing to configure.',
  'game-stats': 'Game stats has nothing to configure.',
  'channel-cleanup': 'Cleanup schedules live in their own list, which this export does not carry.',
  github: 'GitHub watches hold secrets and live in their own list; add them in the module.',
};

/** The part of the roles module the export carries and this import leaves alone, for a note. */
const ROLES_NOTE =
  'Reaction-role sets are posted messages and are not imported; only the roles for new members are.';

// --- Reading the file ------------------------------------------------------------------------------------

/**
 * The parts of an export file this import reads, checked. Throws an ImportError for a file that is not a
 * Sylo configuration export.
 * @param {unknown} doc
 */
export function readExport(doc) {
  if (!isPlain(doc) || doc.sylo !== EXPORT_KIND) {
    throw new ImportError('This is not a Sylo configuration export.');
  }
  if (doc.version !== EXPORT_VERSION) {
    throw new ImportError(
      `This export has version ${String(doc.version).slice(0, 20)}, which this Sylo cannot import.`
    );
  }
  const modules = Array.isArray(doc.modules) ? doc.modules : [];
  if (modules.length > MAX_MODULES) throw new ImportError(`The file lists more than ${MAX_MODULES} modules.`);
  const overrides = Array.isArray(doc.commandOverrides) ? doc.commandOverrides : [];
  if (overrides.length > MAX_OVERRIDES) {
    throw new ImportError(`The file lists more than ${MAX_OVERRIDES} command limits.`);
  }
  const seen = new Set();
  const cleanModules = [];
  for (const m of modules) {
    if (!isPlain(m) || typeof m.moduleId !== 'string' || !m.moduleId || m.moduleId.length > 64) continue;
    if (seen.has(m.moduleId)) throw new ImportError(`The module ${m.moduleId.slice(0, 40)} is listed twice.`);
    seen.add(m.moduleId);
    const config = isPlain(m.config) ? m.config : {};
    if (JSON.stringify(config).length > MAX_MODULE_BYTES) {
      throw new ImportError(`The settings of ${m.moduleId.slice(0, 40)} are too large to import.`);
    }
    cleanModules.push({
      moduleId: m.moduleId,
      enabled: typeof m.enabled === 'boolean' ? m.enabled : null,
      config,
    });
  }
  return {
    sourceGuildId: typeof doc.guildId === 'string' ? doc.guildId.slice(0, 40) : null,
    exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt.slice(0, 40) : null,
    settings: isPlain(doc.settings) ? doc.settings : null,
    modules: cleanModules,
    overrides: overrides.filter((o) => isPlain(o) && typeof o.command === 'string' && o.command.length <= 64),
  };
}

// --- Planning -------------------------------------------------------------------------------------------

/**
 * One item of the plan. `todo` (what applying it needs) is kept out of what the preview sends.
 * @typedef {object} PlanItem
 * @property {string} key         'settings', 'module:<id>' or 'command:<name>'
 * @property {'settings'|'module'|'command'} kind
 * @property {string} label
 * @property {'change'|'same'|'skip'} status
 * @property {string[]} notes     warnings and reasons, plain sentences
 * @property {{ path: string, label: string, before: string, after: string }[]} changes
 * @property {number} more        changed fields beyond the ones listed
 */

const toItem = (key, kind, label, rest) => ({ key, kind, label, notes: [], changes: [], more: 0, ...rest });

async function planSettings(guild, file) {
  const raw = file.settings;
  if (!raw) return null;
  const notes = [];
  const stored = (await getGuildSettings(guild.id)) ?? {};
  const before = {
    modlogChannel: stored.modlog_channel_id ?? '',
    embedColor: Number.isInteger(stored.embed_color)
      ? `#${stored.embed_color.toString(16).padStart(6, '0')}`
      : '',
    commandPrefix: stored.command_prefix ?? '',
  };
  const after = { ...before };
  const todo = {};

  if (SNOWFLAKE.test(raw.modlog_channel_id ?? '')) {
    if (
      guild.channels?.cache?.has?.(raw.modlog_channel_id) &&
      canPostInChannel(guild, raw.modlog_channel_id)
    ) {
      after.modlogChannel = raw.modlog_channel_id;
      todo.modlog = raw.modlog_channel_id;
    } else {
      notes.push(
        'The mod-log channel from the file is not in this server, or Sylo cannot post there, so it stays as it is.'
      );
    }
  }
  if (Number.isInteger(raw.embed_color) && raw.embed_color >= 0 && raw.embed_color <= 0xffffff) {
    after.embedColor = `#${raw.embed_color.toString(16).padStart(6, '0')}`;
    todo.color = raw.embed_color;
  }
  if (typeof raw.command_prefix === 'string' && raw.command_prefix.trim()) {
    const prefix = raw.command_prefix.trim();
    if (platformOfGuild(guild) === 'discord') {
      notes.push('The command prefix is for Fluxer servers; Discord uses slash commands, so it is left out.');
    } else if (commandPrefixError(prefix)) {
      notes.push(`The command prefix from the file is not allowed: ${commandPrefixError(prefix)}`);
    } else {
      after.commandPrefix = prefix;
      todo.prefix = prefix;
    }
  }
  const { changes, more } = diffConfig(before, after);
  return toItem('settings', 'settings', 'Server settings', {
    status: changes.length ? 'change' : 'same',
    notes,
    changes,
    more,
    todo,
  });
}

async function planModule(guild, entry) {
  const { moduleId } = entry;
  const label = getModule(moduleId)?.name ?? moduleId;
  const key = `module:${moduleId}`;
  const skip = (why) => toItem(key, 'module', label, { status: 'skip', notes: [why] });
  const mod = getModule(moduleId);
  if (!mod) return skip('This Sylo has no module with this name.');
  if (mod.ownerOnly) return skip('Only a Sylo operator can set this module up.');
  if (SKIPPED[moduleId]) return skip(SKIPPED[moduleId]);
  const importer = IMPORTERS[moduleId];
  if (!importer) return skip('This module cannot be imported yet.');

  const current = await getGuildModule(guild.id, moduleId);
  const stored = isPlain(current.config) ? current.config : {};
  const { value: cleaned, cleared, paths } = clearForeignIds(guild, entry.config);
  let config;
  try {
    config = importer.prepare(cleaned, stored, guild);
  } catch (err) {
    // A shape the normaliser cannot read at all: the item is reported, the rest of the file still imports.
    log.warn('config-import', `${moduleId} could not be read from the file:`, err.message);
    return skip('The settings of this module in the file could not be read.');
  }
  const enabled = entry.enabled ?? current.enabled;

  // Both sides through the normaliser, so a module that was never saved compares as its defaults.
  const before = {
    enabled: current.enabled,
    ...flatConfig(moduleId, importer.prepare(stored, stored, guild)),
  };
  const after = { enabled, ...flatConfig(moduleId, config) };
  const { changes, more } = diffConfig(before, after);
  const notes = [];
  const warning = clearedWarning(cleared);
  if (warning) notes.push(warning);
  if (moduleId === 'roles') notes.push(ROLES_NOTE);
  return toItem(key, 'module', label, {
    status: changes.length ? 'change' : 'same',
    notes,
    changes,
    more,
    cleared,
    clearedPaths: paths,
    todo: { config, enabled, importer, previous: stored },
  });
}

/** What the diff compares of a stored config: the roles module's reaction sets are left out of it. */
function flatConfig(moduleId, config) {
  if (moduleId === 'roles') return { autoroles: config?.autoroles ?? [] };
  return isPlain(config) ? config : {};
}

async function planOverride(guild, entry, current) {
  const name = String(entry.command).slice(0, 64);
  const key = `command:${name}`;
  const label = `/${name}`;
  if (!primaryClient()?.commands?.has(name)) {
    return toItem(key, 'command', label, { status: 'skip', notes: ['This Sylo has no such command.'] });
  }
  const { value, cleared, paths } = clearForeignIds(guild, {
    allowedChannels: Array.isArray(entry.allowedChannels) ? entry.allowedChannels : [],
    allowedRoles: Array.isArray(entry.allowedRoles) ? entry.allowedRoles : [],
  });
  const keepIds = (list) => list.filter((id) => SNOWFLAKE.test(String(id))).map(String);
  const next = {
    enabled: entry.enabled !== false,
    allowedChannels: keepIds(value.allowedChannels),
    allowedRoles: keepIds(value.allowedRoles),
  };
  const now = current.get(name) ?? { enabled: true, allowedChannels: [], allowedRoles: [] };
  const { changes, more } = diffConfig(
    { enabled: now.enabled, allowedChannels: now.allowedChannels, allowedRoles: now.allowedRoles },
    next
  );
  const notes = [];
  const warning = clearedWarning(cleared);
  if (warning) notes.push(warning);
  return toItem(key, 'command', label, {
    status: changes.length ? 'change' : 'same',
    notes,
    changes,
    more,
    cleared,
    clearedPaths: paths,
    todo: { name, next },
  });
}

/**
 * What importing `doc` into `guild` would do, item by item. Changes nothing.
 * @param {object} guild
 * @param {unknown} doc  the parsed export
 */
export async function planImport(guild, doc) {
  const file = readExport(doc);
  const items = [];
  const settings = await planSettings(guild, file);
  if (settings) items.push(settings);
  for (const entry of file.modules) items.push(await planModule(guild, entry));
  const overrides = await getCommandOverrides(guild.id);
  for (const entry of file.overrides) items.push(await planOverride(guild, entry, overrides));
  return {
    source: {
      guildId: file.sourceGuildId,
      exportedAt: file.exportedAt,
      sameServer: file.sourceGuildId === guild.id,
    },
    notCarried:
      'Not in the file, so not imported: reminders, reaction-role sets, custom commands, embed messages, the shop and any member data.',
    items,
  };
}

/** The plan as the preview sends it: no internals. */
export function publicPlan(plan) {
  return {
    source: plan.source,
    notCarried: plan.notCarried,
    confirmWord: IMPORT_CONFIRM_WORD,
    items: plan.items.map(({ todo, ...item }) => {
      void todo;
      return item;
    }),
  };
}

// --- Applying ---------------------------------------------------------------------------------------

async function applyItem(guild, item, actor) {
  const t = item.todo;
  if (item.kind === 'settings') {
    if (t.modlog) await setModlogChannel(guild.id, t.modlog);
    if (t.color !== undefined) await setEmbedColor(guild.id, t.color);
    if (t.prefix !== undefined && t.prefix !== ((await getCommandPrefix(guild.id)) ?? '')) {
      await setCommandPrefix(guild.id, t.prefix);
    }
    await recordAudit(guild.id, { actor, action: 'settings:server', detail: 'imported from a file' });
    return;
  }
  if (item.kind === 'command') {
    await setCommandOverride(guild.id, t.name, t.next);
    await recordAudit(guild.id, { actor, action: `command:/${t.name}`, detail: 'imported from a file' });
    return;
  }
  const moduleId = item.key.slice('module:'.length);
  const wasEnabled = (await getGuildModule(guild.id, moduleId)).enabled;
  // Both go through setGuildModule, so the role-grant guard sees the roles this import would hand out.
  await setGuildModule(guild.id, moduleId, { config: t.config, enabled: t.enabled });
  await recordAudit(guild.id, {
    actor,
    action: `module:${moduleId}`,
    detail: `settings imported from a file${t.enabled !== wasEnabled ? (t.enabled ? ', turned on' : ', turned off') : ''}`,
  });
  // What a toggle does besides the flag.
  if (!t.enabled && moduleId === 'introductions') cancelIntroductionSessions(guild.id);
  if (!t.enabled && moduleId === 'applications') cancelApplicationSessions(guild.id);
  await t.importer.after?.(guild, { config: t.config, enabled: t.enabled, previous: t.previous });
}

/**
 * Apply the ticked items of `doc`. Each item is planned again against the server as it is now. One item
 * failing does not stop the others; its result says why (a role the person may not hand out, for one).
 * @param {object} guild
 * @param {unknown} doc
 * @param {string[]} keys  the item keys to apply
 * @param {{ actor: string }} opts
 * @returns {Promise<{ results: { key: string, label: string, ok: boolean, error?: string }[] }>}
 */
export async function applyImport(guild, doc, keys, { actor }) {
  const plan = await planImport(guild, doc);
  const wanted = new Set(keys);
  const results = [];
  let applied = 0;
  for (const item of plan.items) {
    if (!wanted.has(item.key)) continue;
    if (item.status !== 'change') {
      results.push({
        key: item.key,
        label: item.label,
        ok: false,
        error: item.status === 'skip' ? (item.notes[0] ?? 'Not imported.') : 'Nothing to change.',
      });
      continue;
    }
    try {
      await applyItem(guild, item, actor);
      applied += 1;
      results.push({ key: item.key, label: item.label, ok: true });
    } catch (err) {
      if (!err?.status || err.status >= 500) log.error('config-import', `${item.key} failed:`, err);
      results.push({
        key: item.key,
        label: item.label,
        ok: false,
        error: err?.status && err.status < 500 ? err.message : 'Could not be saved.',
      });
    }
  }
  const unknown = [...wanted].filter((k) => !plan.items.some((i) => i.key === k));
  for (const k of unknown) results.push({ key: k, label: k, ok: false, error: 'Not in the file.' });
  if (applied) {
    await recordAudit(guild.id, {
      actor,
      action: 'import:config',
      detail: `imported ${applied} item${applied === 1 ? '' : 's'} from a configuration file`,
    });
  }
  return { results };
}

/** Module ids the import can write, for tests and the docs. */
export const IMPORTABLE_MODULES = Object.keys(IMPORTERS);
export const KNOWN_MODULE_IDS = MODULES.map((m) => m.id);
