// Thin fetch wrapper for /api/v2/*. Same-origin, so the existing cookie-
// session from V1's Discord login is sent automatically — no separate V2
// auth. The access checks answer /api/ requests with JSON (401 when signed
// out); a redirect or non-JSON answer is still handled, for safety.
export class ApiError extends Error {
  constructor(message, { status, notAuthenticated = false } = {}) {
    super(message);
    this.status = status;
    this.notAuthenticated = notAuthenticated;
  }
}

/**
 * A server id for an API path. The id comes from the page URL, so a crafted link must not be
 * able to steer the dashboard's requests to another API path ("../account/…").
 */
function gid(guildId) {
  const id = String(guildId ?? '');
  if (!/^(fluxer:)?\d{17,20}$/.test(id)) throw new ApiError('Unknown server', { status: 400 });
  return encodeURIComponent(id);
}

let csrfTokenPromise = null;

/** The session's CSRF token, fetched once. `fresh: true` re-fetches it (a sign-in in another tab rotates it). */
export async function getCsrfToken({ fresh = false } = {}) {
  if (fresh) csrfTokenPromise = null;
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch('/api/v2/csrf', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { token: null }))
      .then((d) => d.token);
    // A failed fetch or a missing token must not stick for the life of the page.
    csrfTokenPromise.then(
      (token) => {
        if (!token) csrfTokenPromise = null;
      },
      () => {
        csrfTokenPromise = null;
      }
    );
  }
  return csrfTokenPromise;
}

export async function apiFetch(path, options = {}, retried = false) {
  const headers = { ...options.headers };
  const writing = options.method && options.method !== 'GET';
  if (writing) {
    const token = await getCsrfToken().catch(() => null);
    if (token) headers['x-csrf-token'] = token;
  }
  const res = await fetch(path, { ...options, headers, credentials: 'same-origin' });

  if (res.redirected && /\/auth\/(login|discord\/login|fluxer\/login)/.test(res.url)) {
    throw new ApiError('Not signed in', { status: 401, notAuthenticated: true });
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(`Unexpected response (HTTP ${res.status})`, { status: res.status });
  }

  const data = await res.json();
  // The session's CSRF token changed (signed in again in another tab): fetch it again, once.
  if (writing && !retried && res.status === 403 && /CSRF/.test(data?.error ?? '')) {
    csrfTokenPromise = null;
    return apiFetch(path, options, true);
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (HTTP ${res.status})`, {
      status: res.status,
      notAuthenticated: res.status === 401,
    });
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
export const getOverview = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/overview`);
export const setModuleEnabled = (guildId, moduleId, enabled) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/${moduleId}`, { enabled });
export const setModulesEnabledBulk = (guildId, ids, enabled) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/bulk`, { ids, enabled });
export const getPlatformInfo = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/platform`);

// The setting limits of every module (see components/useModuleLimits.js).
export const getModuleLimits = () => apiFetch('/api/v2/modules/limits');

// Generic per-module config load/save — every module's V2 form (web-v2/src/
// moduleForms/) uses these same two calls, one dedicated backend route per
// module (see v2Api.js's "Per-module config" section) behind them.
export const getModuleConfig = (guildId, moduleId) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/${moduleId}/config`);
// The welcome image preview is a PNG, used as an <img src>. `v` busts the browser's 60 s cache.
export const welcomeCardPreviewUrl = (guildId, v = Date.now()) =>
  `/api/v2/guilds/${gid(guildId)}/modules/welcome/card-preview?v=${v}`;
export const saveModuleConfig = (guildId, moduleId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/${moduleId}/config`, body);
export const setCountingCount = (guildId, current) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/counting/count`, { current });
export const resetCountingCount = (guildId) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/counting/count`, { reset: true });
export const releaseCountingPenalty = (guildId, userId) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/counting/penalty/release`, { userId });
export const endGiveaway = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/giveaways/${id}/end`, {});
export const rerollGiveaway = (guildId, id, count) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/giveaways/${id}/reroll`, { count });
export const setInviteBonus = (guildId, userId, bonus) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/invite-tracker/bonus`, { userId, bonus });

export const getComposedMessages = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/messages`);
export const getComposedMessage = (guildId, id) => apiFetch(`/api/v2/guilds/${gid(guildId)}/messages/${id}`);
export const saveComposedMessage = (guildId, id, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/messages/${id}`, body);
export const unpublishComposedMessage = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/messages/${id}/unpublish`, {});
export const deleteComposedMessage = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/messages/${id}/delete`, {});

export const getInsights = (guildId, range) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/insights?range=${range}`);
export const refreshInsights = (guildId) => postJson(`/api/v2/guilds/${gid(guildId)}/insights/refresh`, {});

export const getLeaderboard = (guildId, period) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/leaderboard?period=${period}`);
export const setLeaderboardPublic = (guildId, publicLeaderboard) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/leaderboard/public`, { publicLeaderboard });
export const setLeaderboardVanity = (guildId, slug) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/leaderboard/vanity`, { slug });

export const getGuildSettings = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/settings`);
export const saveGuildSettings = (guildId, body) => postJson(`/api/v2/guilds/${gid(guildId)}/settings`, body);

export const getPersonalizer = () => apiFetch('/api/v2/personalizer');
export const getPersonalizerPresence = () => apiFetch('/api/v2/personalizer/presence');
export const savePersonalizerIdentity = (body) => postJson('/api/v2/personalizer/identity', body);
export const savePersonalizerPresence = (body) => postJson('/api/v2/personalizer/presence', body);

// Readable by anyone signed in; saving/clearing is owner-only (enforced server-side).
export const getAnnouncement = () => apiFetch('/api/v2/announcement');
export const savePersonalizerAnnouncement = (body) => postJson('/api/v2/personalizer/announcement', body);
export const clearPersonalizerAnnouncement = () => postJson('/api/v2/personalizer/announcement/clear', {});

export const getHealth = () => apiFetch('/api/v2/health');
export const getStats = () => apiFetch('/api/v2/stats');
// A snapshot download is a plain link (the browser saves the file), not a fetch.
export const backupDownloadUrl = (name) => `/api/v2/health/backups/${encodeURIComponent(name)}`;
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

// Read without signing in: the public pages (command list, roadmap) use these, so a visitor
// without a session never calls an endpoint that answers 401. The roadmap view carries the
// signed-in person's own votes when there is a session.
export const getPublicSession = () => apiFetch('/api/v2/public/session');
export const getPublicCommands = () => apiFetch('/api/v2/public/commands');
export const getRoadmap = () => apiFetch('/api/v2/public/roadmap');
export const voteRoadmapPost = (id) => postJson(`/api/v2/roadmap/${id}/vote`, {});
export const suggestRoadmapPost = (title, description) =>
  postJson('/api/v2/roadmap/suggest', { title, description });
export const getRoadmapAdmin = () => apiFetch('/api/v2/roadmap/admin');
export const createRoadmapPost = (title, description) =>
  postJson('/api/v2/roadmap/admin', { title, description });
export const approveRoadmapPost = (id) => postJson(`/api/v2/roadmap/admin/${id}/approve`, {});
export const rejectRoadmapPost = (id) => postJson(`/api/v2/roadmap/admin/${id}/reject`, {});
export const setRoadmapPostStatus = (id, status) =>
  postJson(`/api/v2/roadmap/admin/${id}/status`, { status });
export const editRoadmapPost = (id, title, description) =>
  postJson(`/api/v2/roadmap/admin/${id}/edit`, { title, description });
export const deleteRoadmapPost = (id) => postJson(`/api/v2/roadmap/admin/${id}/delete`, {});

export const getCleanupSchedules = (guildId) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/channel-cleanup/schedules`);
export const createCleanupSchedule = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/channel-cleanup/schedules`, body);
export const updateCleanupSchedule = (guildId, id, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/channel-cleanup/schedules/${id}`, body);
export const deleteCleanupSchedule = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/channel-cleanup/schedules/${id}/delete`, {});
export const toggleCleanupSchedule = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/channel-cleanup/schedules/${id}/toggle`, {});

export const getGithubWatches = (guildId) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/github/watches`);
export const createGithubWatch = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/github/watches`, body);
export const updateGithubWatch = (guildId, id, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/github/watches/${id}`, body);
export const deleteGithubWatch = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/github/watches/${id}/delete`, {});
export const toggleGithubWatch = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/github/watches/${id}/toggle`, {});
export const regenGithubSecret = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/github/watches/${id}/regen-secret`, {});

export const getReminders = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/reminders/list`);
export const createReminder = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/reminders/new`, body);
export const updateReminder = (guildId, id, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/reminders/${id}`, body);
export const deleteReminder = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/reminders/${id}/delete`, {});
export const toggleReminder = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/reminders/${id}/toggle`, {});
export const testReminder = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/reminders/test`, body);

export const getWelcomeChannel = (guildId) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/welcome-channel/config`);
export const saveWelcomeChannel = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/welcome-channel/config`, body);
export const publishWelcomeChannel = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/welcome-channel/publish`, body);
export const unpublishWelcomeChannel = (guildId) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/welcome-channel/unpublish`, {});
export const createWelcomeReadOnlyChannel = (guildId) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/welcome-channel/create-channel`, {});

export const getGuildEmojis = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/emojis`);
export const getRoles = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/roles/list`);
export const saveAutoroles = (guildId, autoroles) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/roles/autoroles`, { autoroles });
export const saveReactionRole = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/roles/rr`, body);
export const deleteReactionRole = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/roles/rr/${id}/delete`, {});

export const getCustomCommands = (guildId) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/modules/custom-commands/list`);
export const saveCustomCommand = (guildId, body) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/custom-commands/cmd`, body);
export const deleteCustomCommand = (guildId, id) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/custom-commands/cmd/${id}/delete`, {});

// Staff pages that used to exist only in V1 (see src/web/routes/v2Staff.js).
const g = (guildId) => `/api/v2/guilds/${gid(guildId)}`;
export const getTickets = (guildId) => apiFetch(`${g(guildId)}/tickets`);
export const getTicket = (guildId, id) => apiFetch(`${g(guildId)}/tickets/${id}`);
export const pollTicket = (guildId, id, after) =>
  apiFetch(`${g(guildId)}/tickets/${id}/messages?after=${after}`);
export const replyToTicket = (guildId, id, content) =>
  postJson(`${g(guildId)}/tickets/${id}/reply`, { content });
export const closeTicket = (guildId, id, content) =>
  postJson(`${g(guildId)}/tickets/${id}/close`, { content });
export const ticketTranscriptUrl = (guildId, id) => `${g(guildId)}/tickets/${id}/transcript`;

export const getAppealsReview = (guildId) => apiFetch(`${g(guildId)}/appeals`);
export const decideAppeal = (guildId, id, decision, reason) =>
  postJson(`${g(guildId)}/appeals/${id}/decide`, { decision, reason });

export const getCommands = (guildId) => apiFetch(`${g(guildId)}/commands`);
export const saveCommand = (guildId, name, body) => postJson(`${g(guildId)}/commands/${name}`, body);

export const getModeration = (guildId) => apiFetch(`${g(guildId)}/moderation`);
export const unbanMember = (guildId, userId) => postJson(`${g(guildId)}/moderation/unban`, { userId });
export const lockAllChannels = (guildId) => postJson(`${g(guildId)}/moderation/lock-all`, {});
export const unlockAllChannels = (guildId) => postJson(`${g(guildId)}/moderation/unlock-all`, {});
export const unlockChannel = (guildId, channelId) =>
  postJson(`${g(guildId)}/moderation/unlock-channel`, { channelId });
export const warnMember = (guildId, userId, reason) =>
  postJson(`${g(guildId)}/moderation/warn`, { userId, reason });
export const clearMemberWarnings = (guildId, userId) =>
  postJson(`${g(guildId)}/moderation/warnings/clear`, { userId });
export const editCaseReason = (guildId, n, reason) =>
  postJson(`${g(guildId)}/moderation/cases/${n}/reason`, { reason });
export const setCaseDeleted = (guildId, n, deleted) =>
  postJson(`${g(guildId)}/moderation/cases/${n}/${deleted ? 'delete' : 'restore'}`, {});
export const saveAutomodImmunity = (guildId, exemptRoles) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/modules/automod/immunity`, { exemptRoles });

export const getAccount = () => apiFetch('/api/v2/account');
export const disconnectAccount = (platform) => postJson(`/api/v2/account/disconnect/${platform}`, {});
export const deleteAccount = () => postJson('/api/v2/account/delete', { confirm: true });
export const revokeDevice = (id) => postJson(`/api/v2/account/devices/${encodeURIComponent(id)}/revoke`, {});
export const getInvites = () => apiFetch('/api/v2/invites').then((d) => d.invites);

// "Send test message" for a module (posts to its channel from the saved config).
export const sendModuleTest = (guildId, moduleId) =>
  postJson(`${g(guildId)}/modules/${encodeURIComponent(moduleId)}/test`, {});

// Server data: audit log, config export, member data (see src/web/routes/v2GuildData.js).
export const getAuditLog = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/audit`);
export const exportGuildConfig = (guildId) => apiFetch(`/api/v2/guilds/${gid(guildId)}/export`);
export const getMemberData = (guildId, user) =>
  apiFetch(`/api/v2/guilds/${gid(guildId)}/member-data?user=${encodeURIComponent(user ?? '')}`);
export const forgetMemberData = (guildId, userId, reason) =>
  postJson(`/api/v2/guilds/${gid(guildId)}/member-data/forget`, { userId, reason, confirm: true });
