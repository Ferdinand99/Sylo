// Import before anything that loads src/config.js: the bot then runs without the Server Members intent
// (INTENT_GUILD_MEMBERS=false), so a cached member may be out of date and access checks look it up fresh.
process.env.INTENT_GUILD_MEMBERS = 'false';
