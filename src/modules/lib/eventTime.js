// Wall-clock time in an IANA time zone <-> UTC epoch ms, using only Intl (no tz database of our
// own). Events store the start as UTC ms plus the zone the creator picked; the creator types the
// time as it reads on their wall clock ("2026-11-05 19:00" in Europe/Oslo).

const FORMATTERS = new Map();

function formatterFor(timeZone) {
  let f = FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    FORMATTERS.set(timeZone, f);
  }
  return f;
}

/**
 * The canonical spelling of an IANA zone name ("europe/oslo" -> "Europe/Oslo"), or null when it is
 * not a zone this runtime knows. Fixed offsets ("+01:00") are not IANA names and are refused.
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalTimeZone(value) {
  const name = String(value ?? '').trim();
  if (!name || name.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The wall-clock parts of an instant in a zone. */
export function zonedParts(ms, timeZone) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetAt(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

const LOCAL = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/;

/**
 * Read "YYYY-MM-DD HH:mm" (or the `datetime-local` form "YYYY-MM-DDTHH:mm") as a wall-clock time in
 * `timeZone` and return the UTC epoch ms. Null when the text is malformed, the date does not exist
 * (31 February) or the wall-clock time does not exist in that zone (skipped by a clock change).
 * Where a clock change makes a time happen twice, the later one is used.
 * @param {unknown} text
 * @param {string} timeZone  a canonical zone name
 * @returns {number | null}
 */
export function localToUtc(text, timeZone) {
  const m = LOCAL.exec(String(text ?? '').trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (hour > 23 || minute > 59) return null;
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute);
  let utc = asIfUtc - offsetAt(asIfUtc, timeZone);
  utc = asIfUtc - offsetAt(utc, timeZone); // the offset at the guess can differ across a clock change
  const back = zonedParts(utc, timeZone);
  const same =
    back.year === year &&
    back.month === month &&
    back.day === day &&
    back.hour === hour &&
    back.minute === minute;
  return same ? utc : null;
}

const pad = (n) => String(n).padStart(2, '0');

/** An instant as "YYYY-MM-DDTHH:mm" on the wall clock of a zone (the value of a `datetime-local` input). */
export function utcToLocalInput(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** An instant for people: "Thu 5 Nov 2026, 19:00" on the wall clock of a zone. */
export function formatInZone(ms, timeZone) {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
  return text.replace(',', '');
}
