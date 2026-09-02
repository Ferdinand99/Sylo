// Loads every module implementation for its side-effect handler registration.
// Imported once from bot/events/moduleEvents.js.
import './logging.js';
import './welcome.js';
import './roles.js';
import './sticky.js';
import './counting.js';
import './automod.js';
import './customCommands.js';
import './scheduledMessages.js';
import './leveling.js';
import './autoresponder.js';
import './verification.js';
import './afk.js';
import './serverStats.js';
import './freeGames.js';
import './appeals.js';
import './tempVoice.js';
import './starboard.js';
import './inviteTracker.js';
import './polls.js';
import './twitchAlerts.js';
import './youtubeAlerts.js';
import './kickAlerts.js';
import './rss.js';
import './giveaways.js';
import './messageCreator.js'; // registers the role-button / role-select component handlers
import './moderation.js'; // no gateway handlers, but runs the temporary-ban expiry loop
import './birthdays.js'; // no gateway handlers, but runs the daily birthday sweep
