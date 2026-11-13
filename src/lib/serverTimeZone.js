// The IANA zone this process counts local time in. Reminder weekdays and repeat times, the wall-clock
// start and end times from the dashboard, and the channel cleanup days and time of day are all read
// with the local-time Date methods (getDay, getHours, new Date("2026-11-13T10:00")), which follow the
// process zone: the TZ environment variable, else the system zone. The runtime exposes that same zone
// through Intl, so this is what the scheduling code really uses. Nothing is configured per server.

const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * The zone name local time follows right now ("Europe/Oslo", or "UTC" when the process has none).
 * Null when the runtime cannot name it (an unknown TZ value), so a caller can leave it out instead
 * of sending a name nobody can resolve. Read on every call: it is cheap, and TZ can change at run time.
 * @returns {string | null}
 */
export function serverTimeZone() {
  let name;
  try {
    name = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (typeof name !== 'string' || !IANA_NAME.test(name) || name === 'Etc/Unknown') return null;
  return name;
}
