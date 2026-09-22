// Registry of module ids with a real V2 settings form. Overview links a
// module's row here when it has an entry, and to V1's own config page
// (already given by the overview API as each card's `href`) otherwise —
// every module is configurable from V2 today, just not all with a V2 page
// yet. Add an entry here (and its two backend routes in v2Api.js) whenever
// a new module gets built out.
import Afk from './Afk.jsx';
import Welcome from './Welcome.jsx';
import Birthdays from './Birthdays.jsx';
import Verification from './Verification.jsx';
import FreeGames from './FreeGames.jsx';
import Counting from './Counting.jsx';
import AutoReact from './AutoReact.jsx';
import Logging from './Logging.jsx';
import Tickets from './Tickets.jsx';
import Appeals from './Appeals.jsx';
import Giveaways from './Giveaways.jsx';
import Moderation from './Moderation.jsx';
import Automod from './Automod.jsx';
import Sticky from './Sticky.jsx';
import ServerStats from './ServerStats.jsx';
import Autoresponder from './Autoresponder.jsx';

export const MODULE_FORMS = {
  afk: Afk,
  moderation: Moderation,
  automod: Automod,
  sticky: Sticky,
  'server-stats': ServerStats,
  autoresponder: Autoresponder,
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
};

export function hasV2Page(card) {
  return Boolean(MODULE_FORMS[card.id]) || Boolean(SPECIAL_V2_PATHS[card.id]);
}

export function v2Href(card, guildId) {
  return SPECIAL_V2_PATHS[card.id] ? SPECIAL_V2_PATHS[card.id](guildId) : `/guilds/${guildId}/m/${card.id}`;
}
