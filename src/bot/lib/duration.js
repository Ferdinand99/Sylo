// Parse and format short human durations like "10m", "2h30m", "1d", "1w".

const UNIT_MS = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const TOKEN = /(\d+)\s*(w|d|h|m|s)/gi;

/**
 * Parse a duration string into milliseconds. Accepts one or more
 * `<number><unit>` tokens (units: w, d, h, m, s), e.g. "1h", "1h30m", "90s".
 * A bare number is treated as minutes.
 * @param {string} input
 * @returns {number | null} milliseconds, or null if nothing valid parsed
 */
export function parseDuration(input) {
  if (input == null) return null;
  const trimmed = String(input).trim().toLowerCase();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * UNIT_MS.m;

  let total = 0;
  let matched = false;
  for (const [, amount, unit] of trimmed.matchAll(TOKEN)) {
    total += Number(amount) * UNIT_MS[unit];
    matched = true;
  }
  return matched ? total : null;
}

/**
 * Format a millisecond duration back to a compact string, e.g. "1d 3h 20m".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const parts = [];
  let remaining = Math.floor(ms / 1000);
  for (const [unit, unitMs] of [
    ['w', 604_800],
    ['d', 86_400],
    ['h', 3_600],
    ['m', 60],
    ['s', 1],
  ]) {
    const value = Math.floor(remaining / unitMs);
    if (value > 0) {
      parts.push(`${value}${unit}`);
      remaining -= value * unitMs;
    }
  }
  return parts.join(' ');
}
