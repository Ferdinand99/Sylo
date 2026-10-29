/**
 * A "delete after N days" setting: 0 (or anything unreadable) keeps forever, otherwise a whole
 * number of days capped at `max`.
 */
export function clampRetentionDays(raw, max) {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}
