// What needs a server admin's attention on the dashboard overview: modules that are switched on but
// cannot do their job yet (a channel or role that is missing or was deleted), the permissions Sylo is
// missing, and the work that is waiting for a person (open tickets, appeals, applications and
// suggestions). Every module item carries the dashboard address of the page where it is fixed.
import { MODULES, getModule } from '../../modules/registry.js';
import { getGuildModules } from '../../db/modules.js';
import { countOpenAppeals } from '../../db/appeals.js';
import { openTicketCount } from '../../db/tickets.js';
import { pendingCount } from '../../db/applications.js';
import { openSuggestionCount } from '../../db/suggestions.js';
import { missingPermissions, v2CardHref } from './overviewSummary.js';
import { validTriggerRoleIds, welcomeTrigger } from '../../modules/welcome.js';

const CHANNEL = 'channel';
const ROLE = 'role';
const LIST = 'list';

// What a module must have before it does anything: [kind, config key, what it is called].
// Only settings without which the module does nothing at all are listed; the optional ones
// (a log channel for tickets, a ping role, ...) are not problems.
export const REQUIRED = {
  logging: [[CHANNEL, 'channel', 'The log channel']],
  verification: [
    [ROLE, 'verifiedRoleId', 'The verified role'],
    [CHANNEL, 'channelId', 'The verification channel'],
  ],
  'welcome-channel': [[CHANNEL, 'channelId', 'The channel']],
  introductions: [[CHANNEL, 'channelId', 'The introductions channel']],
  counting: [[CHANNEL, 'channelId', 'The counting channel']],
  birthdays: [[CHANNEL, 'channel', 'The birthday channel']],
  suggestions: [[CHANNEL, 'channel', 'The suggestions channel']],
  'free-games': [[CHANNEL, 'channelId', 'The channel for free games']],
  events: [[CHANNEL, 'channel', 'The events channel']],
  starboard: [[LIST, 'boards', 'Starboards']],
  sticky: [[LIST, 'stickies', 'Sticky messages']],
  autoresponder: [[LIST, 'responders', 'Responders']],
  'auto-threads': [[LIST, 'rules', 'Auto-thread rules']],
  'auto-react': [[LIST, 'rules', 'Auto-react rules']],
  'custom-commands': [[LIST, 'commands', 'Commands']],
  'temp-voice': [[LIST, 'hubs', 'Hub channels']],
  'server-stats': [[LIST, 'channels', 'Statistics channels']],
  honeypot: [[LIST, 'channels', 'Honeypot channels']],
  'twitch-alerts': [[LIST, 'alerts', 'Streamers']],
  'kick-alerts': [[LIST, 'alerts', 'Streamers']],
  'youtube-alerts': [[LIST, 'alerts', 'YouTube channels']],
  rss: [[LIST, 'feeds', 'Feeds']],
};

const hasChannel = (guild, id) => Boolean(guild.channels?.cache?.get(id));
// A stub or partial guild without a role cache cannot tell, so it never reports a role as deleted.
const hasRole = (guild, id) => (guild.roles?.cache ? Boolean(guild.roles.cache.get(id)) : true);

/**
 * What is missing from one module's settings, as short sentences for a person (empty when it is fine).
 * Pure: the module's stored config and the guild's channel and role caches are the only inputs.
 * @param {string} id  module id
 * @param {object} cfg  the stored config of the module (may be empty)
 * @param {any} guild
 * @returns {string[]}
 */
export function moduleProblems(id, cfg, guild) {
  const config = cfg && typeof cfg === 'object' ? cfg : {};
  const out = [];
  for (const [kind, key, label] of REQUIRED[id] ?? []) {
    const value = config[key];
    if (kind === LIST) {
      if (!Array.isArray(value) || value.length === 0) out.push(`${label}: none added yet`);
    } else if (!value) {
      out.push(`${label} is not set`);
    } else if (kind === CHANNEL ? !hasChannel(guild, value) : !hasRole(guild, value)) {
      out.push(`${label} no longer exists`);
    }
  }
  if (id === 'welcome') {
    const { trigger, roleIds } = welcomeTrigger(config);
    if (trigger === 'role' && validTriggerRoleIds(guild, roleIds).length === 0) {
      out.push('No role is picked to start the welcome');
    }
    if (config.joinEnabled && !config.joinChannel) out.push('The welcome message has no channel');
    if (config.leaveEnabled && !config.leaveChannel) out.push('The leave message has no channel');
  }
  return out;
}

/**
 * The overview's "needs attention" data for a server.
 * @param {any} guild
 * @param {{ owner?: boolean }} [viewer]  a non-owner never sees an owner-only module
 */
export async function buildAttention(guild, { owner = true } = {}) {
  const rows = new Map((await getGuildModules(guild.id)).map((m) => [m.id, m]));
  const problems = [];
  for (const def of MODULES) {
    if (!owner && def.ownerOnly) continue;
    const row = rows.get(def.id);
    if (!(row?.enabled ?? def.defaultEnabled)) continue;
    const issues = moduleProblems(def.id, row?.config ?? {}, guild);
    if (issues.length) {
      problems.push({ id: def.id, name: getModule(def.id).name, href: v2CardHref(def.id, guild.id), issues });
    }
  }
  return {
    problems,
    missingPermissions: missingPermissions(guild),
    waiting: {
      tickets: await openTicketCount(guild.id),
      appeals: await countOpenAppeals(guild.id),
      applications: await pendingCount(guild.id),
      suggestions: await openSuggestionCount(guild.id),
    },
  };
}
