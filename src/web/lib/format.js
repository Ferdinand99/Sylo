// Small presentation helpers shared by the dashboard views.

/**
 * Human-readable "time ago" for an epoch-ms timestamp.
 * @param {number} ms
 * @returns {string}
 */
export function timeAgo(ms) {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Human-readable byte size, e.g. "4.2 MB".
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${i === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Format a duration in seconds as e.g. "3d 04h 12m".
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatUptime(totalSeconds) {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${String(h).padStart(2, '0')}h`);
  parts.push(`${String(m).padStart(2, '0')}m`);
  if (!d && !h) parts.push(`${String(s).padStart(2, '0')}s`);
  return parts.join(' ');
}
