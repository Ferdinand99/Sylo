// JSON calls against /api/v2 for an app started with startWebApp() (open mode: no login, no
// CSRF token needed), plus a reader for the audit log the dashboard writes.
import { listAudit } from '../../src/db/audit.js';

const json = { accept: 'application/json', 'content-type': 'application/json' };

/**
 * @param {{ base: string }} app  from startWebApp()
 * @param {string} guildId
 */
export function v2Open(app, guildId) {
  const url = (path) => `${app.base}/api/v2${path}`;
  const guild = (path) => url(`/guilds/${guildId}${path}`);
  return {
    get: (path) => fetch(guild(path), { headers: { accept: 'application/json' } }),
    post: (path, body = {}) =>
      fetch(guild(path), { method: 'POST', headers: json, body: JSON.stringify(body) }),
    /** For the bot-wide routes (/personalizer, /health) that are not under a server. */
    getRoot: (path) => fetch(url(path), { headers: { accept: 'application/json' } }),
    postRoot: (path, body = {}) =>
      fetch(url(path), { method: 'POST', headers: json, body: JSON.stringify(body) }),
  };
}

/** Audit rows of a server whose action matches, newest first. */
export async function auditRows(guildId, action) {
  return (await listAudit(guildId, 200)).filter((r) => r.action === action);
}
