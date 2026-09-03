// RuneScape player-stats adapter — Old School RuneScape (OSRS) and RuneScape 3
// (RS3), backed by Jagex's official Hiscores "lite" JSON endpoints. No API key.
//
//   OSRS: https://secure.runescape.com/m=hiscore_oldschool[_ironman
//           |_hardcore_ironman|_ultimate]/index_lite.json?player=<name>
//   RS3:  https://secure.runescape.com/m=hiscore/index_lite.json?player=<name>
//
// Both return { skills:     [{ id, name, rank, level, xp }],
//               activities: [{ id, name, rank, score }] }
// where a rank / level / xp / score of -1 means "unranked". Combat level is not
// in the feed, so it's computed from the combat skills.
//
// The adapter reuses the `platform` slot for the account type: 'main' (default),
// 'ironman', 'hardcore', 'ultimate' (OSRS only). This keeps the shared cache
// key, the registry and runStatsLookup() untouched. Any upstream failure is a
// friendly AdapterError, never a crash.
import {
  InvalidPlatformError,
  PlayerNotFoundError,
  RateLimitedError,
  UnsupportedGameError,
  UpstreamUnavailableError,
} from './gameAdapter.js';

const USER_AGENT = 'Sylo-Discord-Bot (+https://github.com/Ferdinand99/Sylo)';
const REQUEST_TIMEOUT_MS = 10_000;

const TITLES = {
  osrs: { label: 'Old School RuneScape' },
  rs3: { label: 'RuneScape 3' },
};

/** OSRS account type -> the `m=` path segment on secure.runescape.com. */
const OSRS_MODES = {
  main: 'hiscore_oldschool',
  ironman: 'hiscore_oldschool_ironman',
  hardcore: 'hiscore_oldschool_hardcore_ironman',
  ultimate: 'hiscore_oldschool_ultimate',
};
const MODE_LABEL = { ironman: 'Ironman', hardcore: 'Hardcore Ironman', ultimate: 'Ultimate Ironman' };

/** Numeric coercion; -1 (Jagex's "unranked" sentinel) and NaN both become -1. */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

/** Display an integer with thousands separators, or null when unranked. */
function fmt(n) {
  return n < 0 ? null : n.toLocaleString('en-US');
}

/** OSRS combat level from a skill-level lookup. Classic formula. */
function osrsCombat(lvl) {
  const base = 0.25 * (lvl('defence') + lvl('hitpoints') + Math.floor(lvl('prayer') / 2));
  const melee = 0.325 * (lvl('attack') + lvl('strength'));
  const range = 0.325 * Math.floor((lvl('ranged') * 3) / 2);
  const mage = 0.325 * Math.floor((lvl('magic') * 3) / 2);
  return Math.floor(base + Math.max(melee, range, mage));
}

/** RS3 (post-EoC) combat level from a skill-level lookup. */
function rs3Combat(lvl) {
  const multiplier = Math.max(lvl('attack') + lvl('strength'), 2 * lvl('magic'), 2 * lvl('ranged'));
  return Math.floor(
    ((13 / 10) * multiplier +
      lvl('defence') +
      lvl('constitution') +
      Math.floor(lvl('prayer') / 2) +
      Math.floor(lvl('summoning') / 2)) /
      4
  );
}

/**
 * Map a raw hiscores payload onto the normalized PlayerStats shape plus the
 * RuneScape-specific fields the embed reads.
 * @param {any} body
 * @param {{ title: string, mode: string, requestedName: string }} ctx
 */
function normalize(body, { title, mode, requestedName }) {
  const skills = (Array.isArray(body.skills) ? body.skills : []).map((s) => ({
    name: String(s.name ?? ''),
    rank: num(s.rank),
    level: num(s.level),
    xp: num(s.xp),
  }));
  const overall = skills.find((s) => s.name.toLowerCase() === 'overall') ?? {};
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  // Hitpoints/Constitution start at 10; everything else at 1.
  const lvl = (name) => {
    const l = byName.get(name)?.level ?? -1;
    if (l > 0) return l;
    return name === 'hitpoints' || name === 'constitution' ? 10 : 1;
  };

  const activities = (Array.isArray(body.activities) ? body.activities : [])
    .map((a) => ({ name: String(a.name ?? ''), rank: num(a.rank), score: num(a.score) }))
    .filter((a) => a.name && a.score > 0);

  const combat = title === 'rs3' ? rs3Combat(lvl) : osrsCombat(lvl);
  const path = title === 'rs3' ? 'hiscore' : OSRS_MODES[mode];
  const label =
    title === 'rs3'
      ? TITLES.rs3.label
      : `${TITLES.osrs.label}${MODE_LABEL[mode] ? ` (${MODE_LABEL[mode]})` : ''}`;

  return {
    game: 'runescape',
    title,
    titleLabel: label,
    username: requestedName,
    platform: mode,
    profileUrl: `https://secure.runescape.com/m=${path}/hiscorepersonal?user1=${encodeURIComponent(requestedName)}`,
    avatar:
      title === 'rs3'
        ? `https://secure.runescape.com/m=avatar-rs/${encodeURIComponent(requestedName)}/chat.png`
        : null,
    fetchedAt: Date.now(),
    // RuneScape-specific (see the PlayerStats typedef note in gameAdapter.js).
    combatLevel: combat > 0 ? String(combat) : null,
    totalLevel: fmt(num(overall.level)),
    totalXp: fmt(num(overall.xp)),
    overallRank: num(overall.rank) > 0 ? `#${num(overall.rank).toLocaleString('en-US')}` : null,
    skills: skills.filter((s) => s.name.toLowerCase() !== 'overall'),
    activities,
  };
}

export const runescapeAdapter = {
  id: 'runescape',

  titles() {
    return Object.keys(TITLES);
  },

  platformsFor(title) {
    if (title === 'osrs') return Object.keys(OSRS_MODES);
    if (title === 'rs3') return ['main'];
    return [];
  },

  /**
   * Fetch and normalize a player's hiscores.
   * @param {string} username
   * @param {string} platform  account type ('main' | 'ironman' | 'hardcore' | 'ultimate')
   * @param {{ title: string }} options
   * @returns {Promise<import('./gameAdapter.js').PlayerStats>}
   */
  async getPlayerStats(username, platform, { title } = {}) {
    if (!TITLES[title]) throw new UnsupportedGameError(title ?? '(none)');
    const modes = this.platformsFor(title);
    const mode = platform || 'main';
    if (!modes.includes(mode)) throw new InvalidPlatformError(mode, title, modes);

    const path = title === 'rs3' ? 'hiscore' : OSRS_MODES[mode];
    const url = new URL(`https://secure.runescape.com/m=${path}/index_lite.json`);
    url.searchParams.set('player', username);

    let response;
    try {
      response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new UpstreamUnavailableError(err instanceof Error ? err.message : String(err));
    }

    // The hiscores return 404 (often with an HTML body) for an unknown player.
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

    if (!body || !Array.isArray(body.skills) || body.skills.length === 0) {
      throw new PlayerNotFoundError(username);
    }

    return normalize(body, { title, mode, requestedName: username });
  },
};
