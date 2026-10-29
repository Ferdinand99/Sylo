// Single source of truth for which icon name (Lucide-style, like "shield") represents each
// module on the overview cards (overviewSummary.js). The Sylo app maps each name to an SF Symbol
// (ModuleSymbol.swift; test/moduleIcons.test.js keeps the two in step). Keys are module ids plus
// the three synthetic overview cards ('general', 'commands', 'messages').
export const MODULE_ICONS = {
  moderation: 'shield',
  logging: 'file-text',
  automod: 'filter',
  honeypot: 'target',
  verification: 'shield-check',
  appeals: 'gavel',
  tickets: 'ticket',
  welcome: 'users',
  birthdays: 'cake',
  'welcome-channel': 'megaphone',
  roles: 'smile',
  counting: 'hash',
  leveling: 'trending-up',
  starboard: 'star',
  sticky: 'pin',
  'custom-commands': 'command',
  'invite-tracker': 'user-plus',
  polls: 'bar-chart',
  autoresponder: 'message-circle',
  'auto-react': 'zap',
  afk: 'moon',
  'server-stats': 'activity',
  'temp-voice': 'mic',
  'free-games': 'gamepad',
  reminders: 'bell',
  giveaways: 'gift',
  events: 'calendar',
  suggestions: 'lightbulb',
  'temp-roles': 'hourglass',
  'auto-threads': 'threads',
  'game-stats': 'target',
  'twitch-alerts': 'twitch',
  'youtube-alerts': 'youtube',
  'kick-alerts': 'kick',
  rss: 'rss',
  'apple-connect': 'activity',
  insights: 'trending-up',
  'channel-cleanup': 'trash-2',
  github: 'github',
  // synthetic overview cards
  general: 'gear',
  commands: 'command',
  messages: 'message-square',
};

/** Symbol name for a module id, with a neutral fallback. */
export function moduleIcon(id) {
  return MODULE_ICONS[id] || 'sliders';
}
