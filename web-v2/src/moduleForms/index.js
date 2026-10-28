// Registry of module ids with a settings form. Every module has one; add an entry here (and
// its backend routes in v2Api.js) for a new module. Each form is its own file, loaded the
// first time its page opens.
import { lazy } from 'react';

const Afk = lazy(() => import('./Afk.jsx'));
const Welcome = lazy(() => import('./Welcome.jsx'));
const Birthdays = lazy(() => import('./Birthdays.jsx'));
const Verification = lazy(() => import('./Verification.jsx'));
const FreeGames = lazy(() => import('./FreeGames.jsx'));
const Counting = lazy(() => import('./Counting.jsx'));
const AutoReact = lazy(() => import('./AutoReact.jsx'));
const Logging = lazy(() => import('./Logging.jsx'));
const Tickets = lazy(() => import('./Tickets.jsx'));
const Appeals = lazy(() => import('./Appeals.jsx'));
const Giveaways = lazy(() => import('./Giveaways.jsx'));
const Moderation = lazy(() => import('./Moderation.jsx'));
const Automod = lazy(() => import('./Automod.jsx'));
const Sticky = lazy(() => import('./Sticky.jsx'));
const ServerStats = lazy(() => import('./ServerStats.jsx'));
const Autoresponder = lazy(() => import('./Autoresponder.jsx'));
const InviteTracker = lazy(() => import('./InviteTracker.jsx'));
const TwitchAlerts = lazy(() => import('./TwitchAlerts.jsx'));
const KickAlerts = lazy(() => import('./KickAlerts.jsx'));
const RssAlerts = lazy(() => import('./RssAlerts.jsx'));
const GameStats = lazy(() => import('./GameStats.jsx'));
const Honeypot = lazy(() => import('./Honeypot.jsx'));
const YoutubeAlerts = lazy(() => import('./YoutubeAlerts.jsx'));
const Leveling = lazy(() => import('./Leveling.jsx'));
const ChannelCleanup = lazy(() => import('./ChannelCleanup.jsx'));
const GithubAlerts = lazy(() => import('./GithubAlerts.jsx'));
const TempVoice = lazy(() => import('./TempVoice.jsx'));
const Starboard = lazy(() => import('./Starboard.jsx'));
const Reminders = lazy(() => import('./Reminders.jsx'));
const Polls = lazy(() => import('./Polls.jsx'));
const WelcomeChannel = lazy(() => import('./WelcomeChannel.jsx'));
const Roles = lazy(() => import('./Roles.jsx'));
const CustomCommands = lazy(() => import('./CustomCommands.jsx'));
const AppleConnect = lazy(() => import('./AppleConnect.jsx'));

export const MODULE_FORMS = {
  afk: Afk,
  moderation: Moderation,
  automod: Automod,
  honeypot: Honeypot,
  sticky: Sticky,
  'server-stats': ServerStats,
  autoresponder: Autoresponder,
  'invite-tracker': InviteTracker,
  'twitch-alerts': TwitchAlerts,
  'kick-alerts': KickAlerts,
  'youtube-alerts': YoutubeAlerts,
  leveling: Leveling,
  'channel-cleanup': ChannelCleanup,
  github: GithubAlerts,
  'temp-voice': TempVoice,
  starboard: Starboard,
  reminders: Reminders,
  polls: Polls,
  'welcome-channel': WelcomeChannel,
  roles: Roles,
  'custom-commands': CustomCommands,
  'apple-connect': AppleConnect,
  rss: RssAlerts,
  'game-stats': GameStats,
  welcome: Welcome,
  birthdays: Birthdays,
  verification: Verification,
  'free-games': FreeGames,
  counting: Counting,
  'auto-react': AutoReact,
  logging: Logging,
  tickets: Tickets,
  appeals: Appeals,
  giveaways: Giveaways,
};

// Overview/Sidebar cards with a real V2 page that isn't the standard
// /m/:id module-config route: Embed messages is its own top-level feature,
// and "Settings" (card.id 'general', the Core group's link card) is the
// same /guilds/:id/settings route Sidebar's own fixed nav item already
// points to. Centralized here (not duplicated per-component) so Overview.jsx
// and Sidebar.jsx can't drift out of sync on which cards have a V2 page —
// happened once already when 'general' was missed from both.
export const SPECIAL_V2_PATHS = {
  messages: (guildId) => `/guilds/${guildId}/messages`,
  general: (guildId) => `/guilds/${guildId}/settings`,
  insights: (guildId) => `/guilds/${guildId}/insights`,
  // The Commands overview card — V2's page is the Moderation hub's Commands tab.
  commands: (guildId) => `/guilds/${guildId}/moderation/commands`,
};

export function v2Href(card, guildId) {
  return SPECIAL_V2_PATHS[card.id] ? SPECIAL_V2_PATHS[card.id](guildId) : `/guilds/${guildId}/m/${card.id}`;
}
