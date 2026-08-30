// Registry of dashboard modules. A module is a feature group that can be
// toggled and configured per guild (like MEE6/Dyno plugins). Phase 1 defines
// the catalogue and enable state; later phases attach behaviour (event
// handlers, commands) and richer settings.
import { config } from '../config.js';

/**
 * @typedef {Object} ModuleDef
 * @property {string} id                Stable id, used as the DB key and URL slug.
 * @property {string} name              Display name.
 * @property {string} description       One-line summary for the module list.
 * @property {string} icon             Emoji shown in the sidebar.
 * @property {string[]} requiredIntents Privileged intents the module needs
 *   ("GuildMembers", "MessageContent"). Empty = works with the base intents.
 * @property {boolean} defaultEnabled   Whether it is on by default in a new guild.
 * @property {boolean} configurable     Whether it has a settings panel yet.
 */

/** @type {ModuleDef[]} */
export const MODULES = [
  {
    id: 'moderation',
    name: 'Moderation',
    description: 'Mod-log channel, warning thresholds, mute role, ban manager.',
    icon: '🛡️',
    requiredIntents: [],
    defaultEnabled: true,
    configurable: true,
  },
  {
    id: 'logging',
    name: 'Server logging',
    description: 'Send member, message, role and channel events to log channels.',
    icon: '📝',
    requiredIntents: ['GuildMembers', 'MessageContent'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'tickets',
    name: 'Tickets (modmail)',
    description: 'Members DM the bot; staff read and reply from this dashboard.',
    icon: '🎫',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'roles',
    name: 'Reaction roles & autoroles',
    description: 'Self-assign roles from a message; roles automatically on join.',
    icon: '🎭',
    requiredIntents: ['GuildMembers'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'welcome',
    name: 'Welcome & leave',
    description: 'Greet new members and announce departures.',
    icon: '👋',
    requiredIntents: ['GuildMembers'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'custom-commands',
    name: 'Custom commands',
    description: 'Per-server prefix commands that reply with text or an embed.',
    icon: '⌨️',
    requiredIntents: ['MessageContent'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'scheduled-messages',
    name: 'Scheduled messages',
    description: 'Post a message to a channel on a repeating interval.',
    icon: '⏰',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'sticky',
    name: 'Sticky messages',
    description: 'Keep a message pinned to the bottom of a channel by re-posting it.',
    icon: '📌',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'counting',
    name: 'Counting',
    description: 'Members count upward one number at a time in a dedicated channel.',
    icon: '🔢',
    requiredIntents: ['MessageContent'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'leveling',
    name: 'Leveling',
    description: 'XP and levels from activity, with role rewards and a leaderboard.',
    icon: '📈',
    requiredIntents: ['GuildMembers'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'automod',
    name: 'Auto-moderation',
    description: 'Filter invites, links, spam, caps and banned words automatically.',
    icon: '🚦',
    requiredIntents: ['MessageContent'],
    defaultEnabled: false,
    configurable: true,
  },
];

const BY_ID = new Map(MODULES.map((m) => [m.id, m]));

/** @param {string} id */
export function getModule(id) {
  return BY_ID.get(id) ?? null;
}

/** Whether every intent a module needs is currently enabled in config. */
export function intentsSatisfied(mod) {
  return mod.requiredIntents.every((i) => {
    if (i === 'GuildMembers') return config.intentGuildMembers;
    if (i === 'MessageContent') return config.intentMessageContent;
    return true;
  });
}

/** Human list of the intents a module is missing, for the UI. */
export function missingIntents(mod) {
  return mod.requiredIntents.filter((i) => {
    if (i === 'GuildMembers') return !config.intentGuildMembers;
    if (i === 'MessageContent') return !config.intentMessageContent;
    return false;
  });
}
