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
// moderation.js has no event handlers (called from the warn flow) — not imported here.
