// Battlefield-series stats adapter, backed by the public community API at
// api.gametools.network (no API key required).
//
// Endpoint shape (identical for every title, per the gametools OpenAPI spec):
//   GET {API_BASE}/{path}/stats/?name={username}&platform={platform}&format_values=true
//
// The title -> endpoint mapping is data-driven (TITLES below). BF2042 and BF6
// are wired up the same way, but their data backends are newer and can be
// flaky; the per-title `platforms` lists for them are a best guess (the spec
// declares no platform enum). Any upstream failure surfaces as a friendly
// AdapterError rather than a crash. Add/adjust a title by editing this one map.
import { config } from '../../config.js';
import {
  InvalidPlatformError,
  PlayerNotFoundError,
  RateLimitedError,
  UnsupportedGameError,
  UpstreamUnavailableError,
} from './gameAdapter.js';

const USER_AGENT = 'Sylo-Discord-Bot (+https://github.com/Ferdinand99/Sylo)';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Supported titles. `path` is the API path segment; `platforms` are the
 * platform ids the API accepts for that title.
 */
const TITLES = {
  bf1: { label: 'Battlefield 1', path: 'bf1', platforms: ['pc', 'ps4', 'xboxone'] },
  bf3: { label: 'Battlefield 3', path: 'bf3', platforms: ['pc', 'ps3', 'xbox360'] },
  bf4: { label: 'Battlefield 4', path: 'bf4', platforms: ['pc', 'ps3', 'ps4', 'xbox360', 'xboxone'] },
  bfv: { label: 'Battlefield V', path: 'bfv', platforms: ['pc', 'ps4', 'xboxone'] },
  bfh: { label: 'Battlefield Hardline', path: 'bfh', platforms: ['pc', 'ps3', 'ps4', 'xbox360', 'xboxone'] },
  // Newer titles — same endpoint shape; platform ids are a best guess (see header).
  bf2042: { label: 'Battlefield 2042', path: 'bf2042', platforms: ['pc', 'ps4', 'ps5', 'xboxone', 'xbsx'] },
  bf6: { label: 'Battlefield 6', path: 'bf6', platforms: ['pc', 'ps5', 'xbsx'] },
};

/** Pick the first present, non-empty value from the upstream payload. */
function pick(source, ...keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return typeof value === 'string' ? value : String(value);
    }
  }
  return null;
}

/**
 * Map a raw gametools payload onto the normalized PlayerStats shape.
 * @param {any} raw
 * @param {{ title: string, titleLabel: string, platform: string, requestedName: string }} ctx
 * @returns {import('./gameAdapter.js').PlayerStats}
 */
function normalize(raw, ctx) {
  const username = pick(raw, 'userName', 'name') ?? ctx.requestedName;
  return {
    game: 'battlefield',
    title: ctx.title,
    titleLabel: ctx.titleLabel,
    username,
    platform: ctx.platform,
    profileUrl: `https://gametools.network/stats/${ctx.platform}/name/${encodeURIComponent(username)}?game=${ctx.title}`,
    avatar: pick(raw, 'avatar'),
    rank: pick(raw, 'rankName', 'rank'),
    kd: pick(raw, 'killDeath', 'kd'),
    winRate: pick(raw, 'winPercent', 'winRate'),
    timePlayed: pick(raw, 'timePlayed', 'secondsPlayed'),
    killsPerMinute: pick(raw, 'killsPerMinute', 'kpm'),
    scorePerMinute: pick(raw, 'scorePerMinute', 'spm'),
    kills: pick(raw, 'kills'),
    deaths: pick(raw, 'deaths'),
    wins: pick(raw, 'wins'),
    losses: pick(raw, 'loses', 'losses'),
    bestClass: pick(raw, 'bestClass'),
    accuracy: pick(raw, 'accuracy'),
    headshots: pick(raw, 'headshots', 'headShots'),
    fetchedAt: Date.now(),
  };
}

/** @type {import('./gameAdapter.js').PlayerStats extends never ? never : any} */
export const battlefieldAdapter = {
  id: 'battlefield',

  titles() {
    return Object.keys(TITLES);
  },

  platformsFor(title) {
    return TITLES[title]?.platforms ?? [];
  },

  /**
   * Fetch and normalize a player's stats.
   * @param {string} username
   * @param {string} platform
   * @param {{ title: string }} options
   * @returns {Promise<import('./gameAdapter.js').PlayerStats>}
   */
  async getPlayerStats(username, platform, { title } = {}) {
    const spec = TITLES[title];
    if (!spec) throw new UnsupportedGameError(title ?? '(none)');
    if (!spec.platforms.includes(platform)) {
      throw new InvalidPlatformError(platform, title, spec.platforms);
    }

    const url = new URL(`${config.gametoolsApiBase}/${spec.path}/stats/`);
    url.searchParams.set('name', username);
    url.searchParams.set('platform', platform);
    url.searchParams.set('format_values', 'true');

    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure, DNS error, or timeout (AbortError).
      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }

    if (response.status === 404) throw new PlayerNotFoundError(username);
    if (response.status === 429) throw new RateLimitedError();
    if (response.status >= 500) throw new UpstreamUnavailableError(`HTTP ${response.status}`);
    if (!response.ok) throw new UpstreamUnavailableError(`HTTP ${response.status}`);

    let body;
    try {
      body = await response.json();
    } catch {
      throw new UpstreamUnavailableError('Malformed JSON response');
    }

    // Some gametools errors come back as HTTP 200 with an error envelope.
    if (body && typeof body === 'object' && (Array.isArray(body.errors) || body.error)) {
      const detail = String(body.error ?? body.errors?.[0] ?? '').toLowerCase();
      if (detail.includes('not found') || detail.includes('no ') || detail.includes('does not exist')) {
        throw new PlayerNotFoundError(username);
      }
      throw new UpstreamUnavailableError(detail || 'Unknown upstream error');
    }

    // A payload with no identifying fields almost always means "unknown player".
    if (!body || (body.userName == null && body.kills == null && body.rank == null)) {
      throw new PlayerNotFoundError(username);
    }

    return normalize(body, {
      title,
      titleLabel: spec.label,
      platform,
      requestedName: username,
    });
  },
};
