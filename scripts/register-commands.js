// Standalone slash-command registration.
//
//   npm run register
//
// Registration also runs automatically on bot startup; this script is handy for
// CI, for re-syncing after a command change without a full restart, or for
// promoting guild-scoped commands to global.
import { loadCommands } from '../src/bot/loadCommands.js';
import { registerCommands } from '../src/bot/registerCommands.js';
import { closeDb } from '../src/db/index.js';

try {
  const commands = await loadCommands();
  const count = await registerCommands(commands);
  console.log(`Done - ${count} command(s) registered.`);
} catch (err) {
  console.error('Registration failed:', err);
  closeDb();
  process.exit(1);
}

// Loading the command modules opens the SQLite connection (via the cache
// layer). Close it and let the process exit naturally; a forced process.exit()
// here races with libuv teardown of the native addon on Windows.
closeDb();
