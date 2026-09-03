// Shared interface and error types for all game-stats integrations.
//
// Every game adapter implements the same shape:
//
//   {
//     id: string,                       // stable adapter id, e.g. "battlefield"
//     titles: () => string[],           // supported title ids, e.g. ["bf1", "bf4"]
//     platformsFor: (title) => string[],// valid platform ids for a given title
//     getPlayerStats: (username, platform, { title }) => Promise<PlayerStats>,
//   }
//
// Adding a new game means adding one adapter file and registering it in
// ./index.js — no changes to the bot or web layers.

/**
 * Normalized stats returned by every adapter. String fields are display-ready
 * (the upstream API is queried with format_values=true), so the bot/web layers
 * can render them without further formatting.
 *
 * @typedef {Object} PlayerStats
 * @property {string} game            Adapter id, e.g. "battlefield".
 * @property {string} title           Title id, e.g. "bf4".
 * @property {string} titleLabel      Human label, e.g. "Battlefield 4".
 * @property {string} username        Player name as resolved upstream.
 * @property {string} platform        Platform id, e.g. "pc".
 * @property {string | null} profileUrl  Link to a web profile, if any.
 * @property {string | null} avatar   Avatar image URL, if any.
 * @property {string | null} rank     Rank number or name (display string).
 * @property {string | null} kd       Kill/death ratio (display string).
 * @property {string | null} winRate  Win percentage (display string).
 * @property {string | null} timePlayed  Total time played (display string).
 * @property {string | null} killsPerMinute
 * @property {string | null} scorePerMinute
 * @property {string | null} kills
 * @property {string | null} deaths
 * @property {string | null} wins
 * @property {string | null} losses
 * @property {string | null} bestClass
 * @property {string | null} accuracy
 * @property {string | null} headshots
 * @property {number} fetchedAt       Epoch ms when this was fetched upstream.
 *
 * Adapters may also set fields specific to their genre; consumers check the game
 * id before reading them. The RuneScape adapter adds:
 * @property {string | null} [combatLevel]
 * @property {string | null} [totalLevel]
 * @property {string | null} [totalXp]
 * @property {string | null} [overallRank]
 * @property {{ name: string, level: number, xp: number, rank: number }[]} [skills]
 * @property {{ name: string, score: number, rank: number }[]} [activities]
 */

/** Base class for errors that carry a user-friendly message for Discord replies. */
export class AdapterError extends Error {
  /**
   * @param {string} message      Developer-facing message (logged).
   * @param {string} userMessage  Safe, friendly message shown to the user.
   */
  constructor(message, userMessage) {
    super(message);
    this.name = new.target.name;
    this.userMessage = userMessage;
  }
}

/** The requested game/title has no adapter or is not supported yet. */
export class UnsupportedGameError extends AdapterError {
  constructor(title) {
    super(`Unsupported game/title: ${title}`, `That title isn't available yet.`);
  }
}

/** The platform is not valid for the requested title. */
export class InvalidPlatformError extends AdapterError {
  constructor(platform, title, allowed) {
    super(
      `Invalid platform "${platform}" for ${title}`,
      `\`${platform}\` isn't a valid platform for that title. Try one of: ${allowed.join(', ')}.`
    );
  }
}

/** No player matched the given username/platform. */
export class PlayerNotFoundError extends AdapterError {
  constructor(username) {
    super(`Player not found: ${username}`, `No player named **${username}** was found on that platform.`);
  }
}

/** The upstream API rate-limited us. */
export class RateLimitedError extends AdapterError {
  constructor() {
    super(
      'Upstream rate limit hit',
      `The stats service is rate-limiting requests right now. Please try again in a minute.`
    );
  }
}

/** The upstream API is down, timed out, or returned an unexpected error. */
export class UpstreamUnavailableError extends AdapterError {
  constructor(detail) {
    super(
      `Upstream unavailable: ${detail}`,
      `The stats service is unavailable right now. Please try again later.`
    );
  }
}
