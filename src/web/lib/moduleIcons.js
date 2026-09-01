// Single source of truth for which inline SVG symbol (`#i-<name>` in
// partials/header.ejs) represents each module. Used by both the left sidebar
// (sidebarNav.js) and the overview plugin grid (overviewSummary.js) so the two
// never drift. Keys are module ids plus the three synthetic overview cards
// ('general', 'commands', 'messages').
export const MODULE_ICONS = {
  moderation: 'shield',
  logging: 'file-text',
  automod: 'filter',
  verification: 'shield-check',
  appeals: 'gavel',
  tickets: 'ticket',
  welcome: 'users',
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
  afk: 'moon',
  'server-stats': 'activity',
  'temp-voice': 'mic',
  'free-games': 'gamepad',
  reminders: 'bell',
  giveaways: 'gift',
  'game-stats': 'target',
  'twitch-alerts': 'twitch',
  'youtube-alerts': 'youtube',
  // synthetic overview cards
  general: 'gear',
  commands: 'command',
  messages: 'message-square',
};

/** Symbol name for a module id, with a neutral fallback. */
export function moduleIcon(id) {
  return MODULE_ICONS[id] || 'sliders';
}
