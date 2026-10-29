// Shared by the v2.permissions*.test.js files: browsers signed in with chosen rights, and the lists
// of routes that must refuse everyone else. Call startOAuthApp() in the test file first.
import { browser, profiles, setProfiles, signIn } from './oauthApp.js';

export const OPERATOR_ID = '111111111111111111'; // OWNER_IDS in helpers/oauthApp.js
export const SNOWFLAKE = '900000000000009999';

/** A browser signed in with the given Discord server rights; returns JSON GET/POST helpers. */
export async function session({ discordId, guilds } = {}) {
  setProfiles({ discordId });
  if (guilds) profiles.discord.guilds = guilds;
  const b = browser();
  await signIn(b, 'discord');
  const token = (await (await b.get('/api/v2/csrf')).json()).token;
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': token };
  return {
    get: (path) => b.get(`/api/v2${path}`, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) =>
      b.get(`/api/v2${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
}

export const anonymous = () => {
  const b = browser();
  const headers = { accept: 'application/json', 'content-type': 'application/json' };
  return {
    get: (path) => b.get(`/api/v2${path}`, { headers: { accept: 'application/json' } }),
    post: (path, body = {}) =>
      b.get(`/api/v2${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
  };
};

// Every per-server route the ported tests call, with a body that would do something if it were allowed.
export const SERVER_WRITES = (g) => [
  [`/guilds/${g}/settings`, { botMasterRoleIds: [], modlogChannelId: '', embedColor: '#112233' }],
  [`/guilds/${g}/modules/bulk`, { ids: ['polls', 'afk'], enabled: true }],
  [`/guilds/${g}/modules/afk`, { enabled: true }],
  [`/guilds/${g}/modules/welcome/config`, { joinEnabled: true, joinChannel: SNOWFLAKE, joinMessage: 'hi' }],
  [`/guilds/${g}/modules/sticky/config`, { stickies: [{ channelId: SNOWFLAKE, content: 'x' }] }],
  [`/guilds/${g}/modules/kick-alerts/config`, { alerts: [{ slug: 'xqc', channelId: SNOWFLAKE }] }],
  [`/guilds/${g}/modules/rss/config`, { feeds: [{ type: 'reddit', ref: 'r/x', channelId: SNOWFLAKE }] }],
  [`/guilds/${g}/modules/automod/config`, { native: { enabled: true, words: true } }],
  [`/guilds/${g}/modules/automod/immunity`, { exemptRoles: [SNOWFLAKE] }],
  [`/guilds/${g}/modules/github/watches`, { repo: 'o/r', channelId: SNOWFLAKE, events: ['push'] }],
  [
    `/guilds/${g}/modules/roles/rr`,
    { channelId: SNOWFLAKE, style: 'buttons', pairs: [{ roleId: SNOWFLAKE }] },
  ],
  [`/guilds/${g}/modules/events/config`, { channel: SNOWFLAKE, staffRoles: [SNOWFLAKE] }],
  [`/guilds/${g}/modules/events/events`, { title: 'x', start: '2999-01-01 10:00', channelId: SNOWFLAKE }],
  [`/guilds/${g}/modules/events/events/1`, { title: 'x', start: '2999-01-01 10:00' }],
  [`/guilds/${g}/modules/events/events/1/cancel`, {}],
  [`/guilds/${g}/modules/suggestions/config`, { channel: SNOWFLAKE, staffRoles: [SNOWFLAKE] }],
  [`/guilds/${g}/modules/suggestions/1/decision`, { action: 'approve', reason: 'x' }],
  [`/guilds/${g}/modules/suggestions/1/delete`, {}],
  [`/guilds/${g}/leaderboard/public`, { publicLeaderboard: true }],
  [`/guilds/${g}/leaderboard/vanity`, { slug: 'not-yours' }],
  [`/guilds/${g}/insights/refresh`, {}],
  [`/guilds/${g}/moderation/warn`, { userId: SNOWFLAKE, reason: 'x' }],
  [`/guilds/${g}/moderation/lock-all`, {}],
  [`/guilds/${g}/moderation/unlock-all`, {}],
  [`/guilds/${g}/moderation/unlock-channel`, { channelId: SNOWFLAKE }],
  [`/guilds/${g}/moderation/unban`, { userId: SNOWFLAKE }],
  [`/guilds/${g}/moderation/cases/1/delete`, {}],
  [`/guilds/${g}/moderation/warnings/clear`, { userId: SNOWFLAKE }],
  [`/guilds/${g}/appeals/1/decide`, { decision: 'accept' }],
  [`/guilds/${g}/commands/ping`, { enabled: false }],
];

export const SERVER_READS = (g) => [
  `/guilds/${g}/moderation`,
  `/guilds/${g}/appeals`,
  `/guilds/${g}/commands`,
  `/guilds/${g}/leaderboard`,
  `/guilds/${g}/insights?range=7`,
  `/guilds/${g}/modules/welcome/config`,
  `/guilds/${g}/modules/github/watches`,
  `/guilds/${g}/modules/events/config`,
  `/guilds/${g}/modules/suggestions/config`,
  `/guilds/${g}/modules/suggestions/list?status=open&sort=top`,
];

export const BOT_WRITES = [
  ['/personalizer/presence', { status: 'dnd', type: 'Playing', text: 'hijacked' }],
  ['/personalizer/identity', { username: 'hijacked' }],
  ['/personalizer/announcement', { title: 'hijacked' }],
  ['/personalizer/announcement/clear', {}],
  ['/health/backups', {}],
  ['/health/backups/sylo-manual-keep.db/delete', {}],
  ['/health/dev-log-test', {}],
];
