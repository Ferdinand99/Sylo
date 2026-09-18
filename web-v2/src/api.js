// Thin fetch wrapper for /api/v2/*. Same-origin, so the existing cookie-
// session from V1's Discord login is sent automatically — no separate V2
// auth. requireGuildAdmin's failure paths are shared, unmodified V1 code
// and render an HTML redirect/error page rather than JSON, so this checks
// content-type/redirect status before parsing instead of assuming JSON.
export class ApiError extends Error {
  constructor(message, { status, notAuthenticated = false } = {}) {
    super(message);
    this.status = status;
    this.notAuthenticated = notAuthenticated;
  }
}

let csrfTokenPromise = null;

async function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch('/api/v2/csrf', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { token: null }))
      .then((d) => d.token);
  }
  return csrfTokenPromise;
}

export async function apiFetch(path, options = {}) {
  const headers = { ...options.headers };
  if (options.method && options.method !== 'GET') {
    const token = await getCsrfToken();
    if (token) headers['x-csrf-token'] = token;
  }
  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });

  if (res.redirected && res.url.includes('/auth/discord/login')) {
    throw new ApiError('Not signed in', { status: 401, notAuthenticated: true });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(`Unexpected response (HTTP ${res.status})`, { status: res.status });
  }

  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (HTTP ${res.status})`, { status: res.status });
  }
  return data;
}

const postJson = (path, body) =>
  apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

export const getGuilds = () => apiFetch('/api/v2/guilds').then((d) => d.guilds);
export const getOverview = (guildId) => apiFetch(`/api/v2/guilds/${guildId}/overview`);
export const setModuleEnabled = (guildId, moduleId, enabled) =>
  postJson(`/api/v2/guilds/${guildId}/modules/${moduleId}`, { enabled });
// Generic per-module config load/save — every module's V2 form (web-v2/src/
// moduleForms/) uses these same two calls, one dedicated backend route per
// module (see v2Api.js's "Per-module config" section) behind them.
export const getModuleConfig = (guildId, moduleId) =>
  apiFetch(`/api/v2/guilds/${guildId}/modules/${moduleId}/config`);
export const saveModuleConfig = (guildId, moduleId, body) =>
  postJson(`/api/v2/guilds/${guildId}/modules/${moduleId}/config`, body);
export const getPrefs = () => apiFetch('/api/v2/prefs');
export const setDashboardVersion = (dashboardVersion) => postJson('/api/v2/prefs', { dashboardVersion });

export const getLeaderboard = (guildId, period) =>
  apiFetch(`/api/v2/guilds/${guildId}/leaderboard?period=${period}`);
export const setLeaderboardPublic = (guildId, publicLeaderboard) =>
  postJson(`/api/v2/guilds/${guildId}/leaderboard/public`, { publicLeaderboard });
export const setLeaderboardVanity = (guildId, slug) =>
  postJson(`/api/v2/guilds/${guildId}/leaderboard/vanity`, { slug });

export const getGuildSettings = (guildId) => apiFetch(`/api/v2/guilds/${guildId}/settings`);
export const saveGuildSettings = (guildId, body) => postJson(`/api/v2/guilds/${guildId}/settings`, body);

export const getPersonalizer = () => apiFetch('/api/v2/personalizer');
export const getPersonalizerPresence = () => apiFetch('/api/v2/personalizer/presence');
export const savePersonalizerIdentity = (body) => postJson('/api/v2/personalizer/identity', body);
export const savePersonalizerPresence = (body) => postJson('/api/v2/personalizer/presence', body);

export const getHealth = () => apiFetch('/api/v2/health');
export const sendDevLogTest = () => postJson('/api/v2/health/dev-log-test', {});
export const sendDevLogErrorTest = () => postJson('/api/v2/health/dev-log-error-test', {});
export const createBackup = () => postJson('/api/v2/health/backups', {});
export const deleteBackup = (name) =>
  postJson(`/api/v2/health/backups/${encodeURIComponent(name)}/delete`, {});
export const restoreBackup = (name) =>
  postJson(`/api/v2/health/backups/${encodeURIComponent(name)}/restore`, {});
export const importBackup = (file) =>
  apiFetch('/api/v2/health/backups/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
