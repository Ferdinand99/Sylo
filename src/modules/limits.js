// Every module's setting limits in one map, served to the dashboard at GET /api/v2/modules/limits
// so the forms read them instead of keeping their own copies.
//
// Each module that has a normalise…Config exports `LIMITS`, used by the normaliser itself:
//   { 'field.path': { maxLength?, min?, max?, maxItems? } }
// Nested fields use dotted paths and `[]` marks array items ('stickies[].content').
// The imports are explicit (no glob) so bundling and linting stay simple.
//
// `_embed` is a pseudo-module: the limits of one embed spec (normaliseEmbedSpec), shared by every
// module that stores an embed.
import { EMBED_LIMITS } from './welcomeChannel.js';
import { LIMITS as afk } from './afk.js';
import { LIMITS as appeals } from './appeals.js';
import { LIMITS as appleConnect } from './appleConnect.js';
import { LIMITS as autoReact } from './autoReact.js';
import { LIMITS as autoThreads } from './autoThreads.js';
import { LIMITS as automod } from './automod.js';
import { LIMITS as autoresponder } from './autoresponder.js';
import { LIMITS as birthdays } from './birthdays.js';
import { LIMITS as channelCleanup } from './channelCleanup.js';
import { LIMITS as counting } from './counting.js';
import { LIMITS as customCommands } from './customCommands.js';
import { LIMITS as events } from './events.js';
import { LIMITS as giveaways } from './giveaways.js';
import { LIMITS as githubAlerts } from './githubAlerts.js';
import { LIMITS as honeypot } from './honeypot.js';
import { LIMITS as inviteTracker } from './inviteTracker.js';
import { LIMITS as kickAlerts } from './kickAlerts.js';
import { LIMITS as leveling } from './leveling.js';
import { LIMITS as moderation } from './moderation.js';
import { LIMITS as polls } from './polls.js';
import { LIMITS as scheduledMessages } from './scheduledMessages.js';
import { LIMITS as roles } from './roles.js';
import { LIMITS as rss } from './rss.js';
import { LIMITS as serverStats } from './serverStats.js';
import { LIMITS as starboard } from './starboard.js';
import { LIMITS as sticky } from './sticky.js';
import { LIMITS as suggestions } from './suggestions.js';
import { LIMITS as quoteBoard } from './quoteBoard.js';
import { LIMITS as tempRoles } from './tempRoles.js';
import { LIMITS as tempVoice } from './tempVoice.js';
import { LIMITS as tickets } from './tickets.js';
import { LIMITS as twitchAlerts } from './twitchAlerts.js';
import { LIMITS as verification } from './verification.js';
import { LIMITS as welcome } from './welcome.js';
import { LIMITS as welcomeChannel } from './welcomeChannel.js';
import { LIMITS as youtubeAlerts } from './youtubeAlerts.js';

export const MODULE_LIMITS = Object.freeze({
  _embed: EMBED_LIMITS,
  afk,
  appeals,
  'apple-connect': appleConnect,
  'auto-react': autoReact,
  'auto-threads': autoThreads,
  automod,
  autoresponder,
  birthdays,
  'channel-cleanup': channelCleanup,
  counting,
  'custom-commands': customCommands,
  events,
  giveaways,
  github: githubAlerts,
  honeypot,
  'invite-tracker': inviteTracker,
  'kick-alerts': kickAlerts,
  leveling,
  moderation,
  polls,
  'quote-board': quoteBoard,
  reminders: scheduledMessages,
  roles,
  rss,
  'server-stats': serverStats,
  starboard,
  sticky,
  suggestions,
  'temp-roles': tempRoles,
  'temp-voice': tempVoice,
  tickets,
  'twitch-alerts': twitchAlerts,
  verification,
  welcome,
  'welcome-channel': welcomeChannel,
  'youtube-alerts': youtubeAlerts,
});
