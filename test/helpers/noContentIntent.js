// Import this FIRST: it switches the Message Content intent off before src/config.js reads the
// environment (ES imports run before the importing file's own statements).
process.env.INTENT_MESSAGE_CONTENT = 'false';
