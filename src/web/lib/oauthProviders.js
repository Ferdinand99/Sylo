// The OAuth side of "Log in with Discord / Fluxer": where to send the browser, how to
// trade the returned code for a token, and how to turn the token into an identity —
// who the person is on that platform and which guilds they administer (as guild keys).
//
// Both platforms speak the same OAuth2 dialect (and Fluxer's permission bits match
// Discord's), so a provider is a small table of URLs plus a profile reader.
import { config } from '../../config.js';
import { guildByKey } from '../../platform/platformOf.js';

export const OAUTH_SCOPES = 'identify guilds';

// Permission bits (the same on both platforms). Admin or Manage Server, or being the owner, counts.
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;

function hasAdminPerms(permissionsString) {
  try {
    const p = BigInt(permissionsString ?? '0');
    return (p & PERM_ADMINISTRATOR) !== 0n || (p & PERM_MANAGE_GUILD) !== 0n;
  } catch {
    return false;
  }
}

/**
 * Reduce the OAuth "current user guilds" payload to the ids worth storing: only
 * guilds the user owns or has Administrator / Manage Server on.
 * @param {Array<{ id: string, owner?: boolean, permissions?: string }>} guilds
 * @returns {string[]}
 */
export function adminGuildIdsFromOAuth(guilds) {
  if (!Array.isArray(guilds)) return [];
  return guilds.filter((g) => g.owner || hasAdminPerms(g.permissions)).map((g) => g.id);
}

/**
 * Fluxer's /users/@me/guilds may omit `owner` and `permissions` (both optional in its
 * API). For those guilds ask the bot instead: is this user the owner, or do they hold
 * Administrator / Manage Server in the bot's own member data?
 * @param {string} userId
 * @param {string[]} rawGuildIds
 * @returns {Promise<string[]>}
 */
export async function adminGuildIdsFromBot(userId, rawGuildIds) {
  const out = [];
  for (const id of rawGuildIds) {
    const guild = guildByKey(`fluxer:${id}`);
    if (!guild) continue;
    if (guild.ownerId === userId) {
      out.push(id);
      continue;
    }
    const member = guild.members.get?.(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    const perms = member?.permissions;
    if (perms && (perms.has(PERM_ADMINISTRATOR) || perms.has(PERM_MANAGE_GUILD))) out.push(id);
  }
  return out;
}

// --- origins -------------------------------------------------------------------

const DISCORD_API = 'https://discord.com/api/v10';

/** Fluxer's web app and API origins: hosted Fluxer by default, or the configured instance. */
export function fluxerOrigins() {
  const web = config.fluxerWebUrl ?? 'https://web.fluxer.app';
  const api =
    config.fluxerApiUrl ?? (config.fluxerWebUrl ? `${config.fluxerWebUrl}/api` : 'https://api.fluxer.app');
  return { web, api: `${api}/v1` };
}

// --- shared OAuth2 plumbing --------------------------------------------------------

async function exchangeCode({ tokenUrl, clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`token exchange failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

async function getJson(base, path, accessToken) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

export const discordAvatarUrl = (id, hash, size = 64) =>
  hash ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=${size}` : null;

/**
 * @typedef {object} Provider
 * @property {'discord' | 'fluxer'} platform
 * @property {string} label
 * @property {() => boolean} enabled
 * @property {string} callbackPath
 * @property {(redirectUri: string, state: string) => string} authorizeUrl
 * @property {(code: string, redirectUri: string) => Promise<string>} exchange  -> access token
 * @property {(accessToken: string) => Promise<{ platform: string, platformUserId: string, username: string, avatar: string | null, guildIds: string[] }>} fetchIdentity
 */

/** @type {Record<'discord' | 'fluxer', Provider>} */
export const providers = {
  discord: {
    platform: 'discord',
    label: 'Discord',
    enabled: () => config.discordAuthEnabled,
    callbackPath: '/auth/discord/callback',
    authorizeUrl: (redirectUri, state) =>
      `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: config.discordClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        state,
      })}`,
    exchange: (code, redirectUri) =>
      exchangeCode({
        tokenUrl: `${DISCORD_API}/oauth2/token`,
        clientId: config.discordClientId,
        clientSecret: config.discordClientSecret,
        code,
        redirectUri,
      }),
    async fetchIdentity(accessToken) {
      const [user, guilds] = await Promise.all([
        getJson(DISCORD_API, '/users/@me', accessToken),
        getJson(DISCORD_API, '/users/@me/guilds', accessToken),
      ]);
      return {
        platform: 'discord',
        platformUserId: user.id,
        username: user.global_name || user.username,
        avatar: discordAvatarUrl(user.id, user.avatar),
        guildIds: adminGuildIdsFromOAuth(guilds),
      };
    },
  },

  fluxer: {
    platform: 'fluxer',
    label: 'Fluxer',
    enabled: () => config.fluxerAuthEnabled,
    callbackPath: '/auth/fluxer/callback',
    authorizeUrl: (redirectUri, state) =>
      `${fluxerOrigins().web}/oauth2/authorize?${new URLSearchParams({
        client_id: config.fluxerClientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        state,
      })}`,
    exchange: (code, redirectUri) =>
      exchangeCode({
        tokenUrl: `${fluxerOrigins().api}/oauth2/token`,
        clientId: config.fluxerClientId,
        clientSecret: config.fluxerClientSecret,
        code,
        redirectUri,
      }),
    async fetchIdentity(accessToken) {
      const api = fluxerOrigins().api;
      const [user, guilds] = await Promise.all([
        getJson(api, '/users/@me', accessToken),
        getJson(api, '/users/@me/guilds', accessToken),
      ]);
      // Trust owner / permissions where Fluxer sent them; for the rest, ask the bot.
      const list = Array.isArray(guilds) ? guilds : [];
      const unknown = list.filter((g) => g.owner === undefined && g.permissions == null).map((g) => g.id);
      const adminIds = [
        ...new Set([...adminGuildIdsFromOAuth(list), ...(await adminGuildIdsFromBot(user.id, unknown))]),
      ];
      return {
        platform: 'fluxer',
        platformUserId: user.id,
        username: user.global_name || user.username,
        avatar: null,
        guildIds: adminIds.map((id) => `fluxer:${id}`),
      };
    },
  },
};

/** The providers this install offers a login for. */
export const enabledProviders = () => Object.values(providers).filter((p) => p.enabled());
