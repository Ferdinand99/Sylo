// Loads every module implementation for its side-effect handler registration.
// Imported once from bot/events/moduleEvents.js.
import './logging.js';
import './welcome.js';
import './roles.js';
import './sticky.js';
// moderation.js has no event handlers (called from the warn flow) — not imported here.
