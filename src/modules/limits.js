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
import { LIMITS as appeals } from './appeals.js';
import { LIMITS as appleConnect } from './appleConnect.js';
import { LIMITS as autoReact } from './autoReact.js';
import { LIMITS as automod } from './automod.js';
import { LIMITS as autoresponder } from './autoresponder.js';
import { LIMITS as counting } from './counting.js';
import { LIMITS as giveaways } from './giveaways.js';
import { LIMITS as honeypot } from './honeypot.js';
import { LIMITS as inviteTracker } from './inviteTracker.js';
import { LIMITS as kickAlerts } from './kickAlerts.js';
import { LIMITS as leveling } from './leveling.js';
import { LIMITS as moderation } from './moderation.js';
import { LIMITS as serverStats } from './serverStats.js';
import { LIMITS as tickets } from './tickets.js';
import { LIMITS as twitchAlerts } from './twitchAlerts.js';
import { LIMITS as verification } from './verification.js';
import { LIMITS as welcomeChannel } from './welcomeChannel.js';
import { LIMITS as youtubeAlerts } from './youtubeAlerts.js';
import { LIMITS as rss } from './rss.js';
import { LIMITS as polls } from './polls.js';
import { LIMITS as sticky } from './sticky.js';
import { LIMITS as welcome } from './welcome.js';

export const MODULE_LIMITS = Object.freeze({
  _embed: EMBED_LIMITS,
  appeals,
  'apple-connect': appleConnect,
  'auto-react': autoReact,
  automod,
  autoresponder,
  counting,
  giveaways,
  honeypot,
  'invite-tracker': inviteTracker,
  'kick-alerts': kickAlerts,
  leveling,
  moderation,
  'server-stats': serverStats,
  tickets,
  'twitch-alerts': twitchAlerts,
  verification,
  'welcome-channel': welcomeChannel,
  'youtube-alerts': youtubeAlerts,
  rss,
  polls,
  sticky,
  welcome,
});
