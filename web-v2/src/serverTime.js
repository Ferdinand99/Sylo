// The zone the server counts a schedule's weekdays and clock times in. The API sends it as an IANA
// name (`timeZone`); a server that does not say leaves it out, and nothing is added.

/** " (server time: Europe/Oslo)" with a leading space, or "" when the server did not say its zone. */
export function serverTimeNote(timeZone) {
  return typeof timeZone === 'string' && timeZone.trim() ? ` (server time: ${timeZone.trim()})` : '';
}

/** Whether this browser knows `timeZone` as a zone name. */
export function isKnownZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * A stored instant (ms) as the "YYYY-MM-DDTHH:mm" text a datetime-local input holds, on the wall clock
 * of `timeZone`. The server reads the text a user types in its own zone, so the input has to show that
 * zone's clock or an edit shifts the time. Without a usable zone it is the browser's own clock.
 */
export function msToWallClock(ms, timeZone) {
  if (!ms) return '';
  const pad = (n) => String(n).padStart(2, '0');
  if (!isKnownZone(timeZone)) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const parts = {};
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone.trim(),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  for (const p of format.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
