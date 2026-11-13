// The zone the server counts a schedule's weekdays and clock times in. The API sends it as an IANA
// name (`timeZone`); a server that does not say leaves it out, and nothing is added.

/** " (server time: Europe/Oslo)" with a leading space, or "" when the server did not say its zone. */
export function serverTimeNote(timeZone) {
  return typeof timeZone === 'string' && timeZone.trim() ? ` (server time: ${timeZone.trim()})` : '';
}
