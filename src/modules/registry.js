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
    id: 'verification',
    name: 'Verification',
    description: 'Gate new members behind a Verify button or a captcha before they get a role.',
    icon: '✅',
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
    id: 'birthdays',
    name: 'Birthdays',
    description: 'Members save their birthday; Sylo posts a greeting and can grant a role for the day.',
    icon: '🎂',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'welcome-channel',
    name: 'Welcome channel',
    description: 'Build one rich, pinned message for a dedicated read-only welcome channel.',
    icon: '📢',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'custom-commands',
    name: 'Custom commands',
    description:
      'Build /slash commands from an ordered list of actions: reply, post to a channel, add or remove a role.',
    icon: '⌨️',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'autoresponder',
    name: 'Autoresponder',
    description: 'Automatically reply when a message matches a trigger phrase.',
    icon: '💬',
    requiredIntents: ['MessageContent'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'reminders',
    name: 'Reminders',
    description: 'Post a text or embed message to a channel — once, or on a repeating schedule.',
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
  {
    id: 'afk',
    name: 'AFK',
    description: 'Members mark themselves away; Sylo replies to anyone who mentions them.',
    icon: '💤',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'server-stats',
    name: 'Server statistics',
    description: 'Keep voice channels named with live member / role / boost counts.',
    icon: '📊',
    requiredIntents: ['GuildMembers'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'free-games',
    name: 'Free games',
    description: 'Announce games that become free to claim on the Epic Games Store.',
    icon: '🎮',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'appeals',
    name: 'Ban appeals',
    description: 'DM banned members a link to an appeal form; staff accept or deny it here.',
    icon: '⚖️',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'temp-voice',
    name: 'Temporary voice channels',
    description:
      'MEE6-style hubs: join to spawn your own voice (and text) channel, controlled with /voice-* commands.',
    icon: '🎙️',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'starboard',
    name: 'Starboard',
    description: 'Re-post messages that get enough of a reaction into a highlights channel.',
    icon: '⭐',
    requiredIntents: ['MessageContent'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'invite-tracker',
    name: 'Invite tracker',
    description: 'Track who invited each new member and rank inviters on a leaderboard.',
    icon: '📨',
    requiredIntents: ['GuildMembers'],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'polls',
    name: 'Polls',
    description: 'Members create reaction polls with /poll; they auto-close on a timer or vote cap.',
    icon: '🗳️',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'twitch-alerts',
    name: 'Twitch alerts',
    description: 'Announce in a channel when a Twitch streamer goes live.',
    icon: '📺',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'youtube-alerts',
    name: 'YouTube alerts',
    description: "Announce a channel's new uploads and when it goes live.",
    icon: '▶️',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'kick-alerts',
    name: 'Kick alerts',
    description: 'Announce in a channel when a Kick.com streamer goes live.',
    icon: '🟢',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'rss',
    name: 'RSS alerts',
    description: 'Post a message when a followed RSS or Atom feed publishes something new.',
    icon: '📰',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'giveaways',
    name: 'Giveaways',
    description: 'Run prize giveaways with an Enter button; winners drawn automatically at the end time.',
    icon: '🎉',
    requiredIntents: [],
    defaultEnabled: false,
    configurable: true,
  },
  {
    id: 'game-stats',
    name: 'Game stats',
    description:
      'Battlefield-series player stat lookups via /stats (BF1, BF3, BF4, BFV, Hardline, best-effort BF2042/BF6).',
    icon: '🎯',
    requiredIntents: [],
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
