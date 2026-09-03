// Boot the dashboard Express app in open mode with a faked Discord client, for
// route tests. Import order matters: tmpDb + openMode must run before config.js.
import './tmpDb.js';
import './openMode.js';
import { setGlobalDispatcher, Agent } from 'undici';
import { runtime } from '../../src/runtime.js';
import { createApp } from '../../src/web/server.js';
import { fakeGuild, makeSink } from './fakeGuild.js';

// Route tests fire many fetch()es at the local server. undici's default
// keep-alive then holds the client sockets open, so running one route file on
// its own (`node --test test/routes.*.test.js`) idles ~9s after the last test
// waiting them out. A near-zero keep-alive drops them immediately. (The full
// `node --test` run isn't affected — it uses a subprocess per file.)
setGlobalDispatcher(new Agent({ keepAliveTimeout: 10, keepAliveMaxTimeout: 100 }));

/**
 * @returns {Promise<{
 *   base: string, guild: object, client: object, sink: object, close: () => void
 * }>}
 */
export async function startWebApp() {
  const sink = makeSink();
  const { guild, client } = fakeGuild({ sink });
  runtime.client = client;

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    guild,
    client,
    sink,
    close() {
      // Drop keep-alive sockets from undici's fetch pool so the process exits
      // promptly instead of waiting out the idle timeout.
      server.closeAllConnections?.();
      server.close();
      runtime.client = null;
    },
  };
}

/** POST helper: form-encoded body, no auto-redirect. */
export function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: typeof body === 'string' ? body : new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}
